#!/usr/bin/env python3
"""Agent Depot — local console server.

Zero-dependency (stdlib only). Serves the web UI and a JSON API:
  GET  /api/state                 -> tools + sessions + ledger + engine status
  GET  /api/session?id=...        -> session detail + messages
  POST /api/refresh               -> {tool?: <tool id>} incremental scan
  GET/POST/PATCH/DELETE /api/tools -> 工具注册表（添加 / 启停 / 改名 / 移除）
  POST /api/migrate               -> {sid, target} migrate via casr
  GET/POST /api/schedule          -> per-tool schedule config (enabled, interval_min)
  GET  /                          -> web/index.html

Scheduler runs in-thread; every due tool refresh is recorded to the ledger.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from hub.store import (Store, now_iso, ensure_lineage_schema,   # noqa: E402
                       lineage_info, migration_history,
                       ensure_memory_schema, add_memory,
                       list_memories, delete_memory, sync_status,
                       set_star, search_messages, export_markdown,
                       session_stats, search_memories, export_memories,
                       export_batch)
from hub.scanners import scan_all             # noqa: E402
from hub import tools_registry               # noqa: E402
from hub import migrator                      # noqa: E402
from hub.core import registry as mod_registry  # noqa: E402
from hub.core import schema as core_schema     # noqa: E402
from hub.core import ops as core_ops           # noqa: E402
from hub.lib import gitsrc                     # noqa: E402
from hub.modules import mod_skills             # noqa: E402
from hub.modules import mod_mcp                # noqa: E402

MODULE_HANDLERS = (mod_skills, mod_mcp)

PORT = int(os.environ.get("HUB_PORT", "8317"))

DEFAULT_SCHEDULE = {
    "all":       {"enabled": False, "interval_min": 30},
    "claude":   {"enabled": False, "interval_min": 30},
    "codex":    {"enabled": False, "interval_min": 30},
    "opencode": {"enabled": False, "interval_min": 30},
}


class Scheduler(threading.Thread):
    daemon = True

    def __init__(self, store):
        super().__init__(name="hub-scheduler")
        self.store = store
        self.stop_event = threading.Event()
        self._last_run = {}   # tool -> epoch

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                pass
            self.stop_event.wait(20)

    def tick(self):
        scheduler_tick(self.store, self._last_run)


STORE = None       # initialized in main()
SCHED = None
REFRESH_LOCK = threading.Lock()


def ensure_store():
    """Initialize global store + schema (idempotent)."""
    global STORE, SCHED
    if STORE is None:
        STORE = Store()
        ensure_lineage_schema(STORE)
        ensure_memory_schema(STORE)
        core_schema.ensure(STORE)
        mod_skills.seed_defaults(STORE)
        mod_mcp.seed_defaults(STORE)
        ops = core_ops
        ops.log_op(STORE, "system", "boot", "ok", detail={"version": "0.5.0"})
        SCHED = Scheduler(STORE)
        SCHED.start()
    return STORE


def scheduler_tick(store, last_run):
    """One scheduler pass. Returns list of tools that ran. Testable directly."""
    raw = store.get_config("schedule")
    sched = json.loads(raw) if raw else dict(DEFAULT_SCHEDULE)
    now = time.time()
    ran = []
    for tool, cfg in sched.items():
        if not cfg.get("enabled"):
            continue
        try:
            iv = max(1, int(cfg.get("interval_min", 30))) * 60
        except (TypeError, ValueError):
            iv = 30 * 60
        if now - last_run.get(tool, 0) >= iv:
            last_run[tool] = now
            if tool == "all":
                results = scan_all(store)
            else:
                results = scan_all(store, tools=[tool])
            store.log("refresh:scheduled", {"tool": tool, "results": results})
            ran.append(tool)
    ran.extend(registry_autopull(store, last_run, now=now))
    return ran


def registry_autopull(store, last_run, now=None):
    """S3: 按源配置的 poll_min 定时拉取 registry 源（skills/mcp）。

    模块被禁用 → 跳过；poll_min<=0 或未到期 → 跳过。
    返回本次执行的 "auto:<kind>:<id>" 键列表（便于测试与诊断）。"""
    now = time.time() if now is None else now
    ran = []
    for mod, kind in ((mod_skills, "skills"), (mod_mcp, "mcp")):
        if not mod_registry.enabled(store, kind):
            continue
        try:
            srcs = mod.list_sources(store)
        except Exception:
            continue
        for s in srcs:
            try:
                pm = int(s.get("poll_min") or 0)
            except (TypeError, ValueError):
                pm = 0
            if pm <= 0 or not s.get("enabled", 1):
                continue
            key = "auto:%s:%s" % (kind, s.get("id"))
            if now - last_run.get(key, 0) < pm * 60:
                continue
            last_run[key] = now
            try:
                res = mod.pull_source(store, s.get("id"))
                core_ops.log_op(store, kind, "auto-pull", "ok" if res.get("ok") else "failed",
                                source_id=s.get("id"), item_name=s.get("name"),
                                item_version=res.get("commit"),
                                detail={"added": len(res.get("added") or []),
                                        "changed": len(res.get("changed") or [])},
                                reason=None if res.get("ok") else (res.get("error") or "")[:200])
            except Exception as e:
                core_ops.log_op(store, kind, "auto-pull", "failed",
                                source_id=s.get("id"), item_name=s.get("name"),
                                reason=str(e)[:200])
            ran.append(key)
    return ran


# ============================================================ 工具 ↔ 模块联动（v0.5.2）

def _tool_target_specs(tool):
    """工具条目 → 需要同步到 Skills / MCP 的目标规格。"""
    specs = []
    if tool.get("skills_dir"):
        specs.append({"kind": "skills_dir", "path": tool["skills_dir"],
                      "name": "%s Skills (全局)" % tool["name"], "format_key": None})
    if tool.get("mcp_config"):
        is_toml = str(tool["mcp_config"]).endswith(".toml")
        specs.append({"kind": "mcp_toml" if is_toml else "mcp_json", "path": tool["mcp_config"],
                      "name": "%s (全局)" % tool["name"],
                      "format_key": None if is_toml else (tool.get("mcp_format") or "mcpServers")})
    return specs


def _sync_tool_targets(tool):
    """把工具的 Skills / MCP 集成点同步为分发目标（幂等；origin 溯源）。"""
    tid = tool["id"]
    origin = "tool:" + tid
    specs = _tool_target_specs(tool)
    want = {(x["kind"], os.path.expanduser(x["path"])) for x in specs}
    created, removed, kept = [], [], []
    with STORE.lock:
        rows = [dict(r) for r in STORE.db.execute(
            "SELECT * FROM targets WHERE origin=?", (origin,)).fetchall()]
    for r in rows:
        if (r["kind"], os.path.expanduser(r["path"])) not in want:
            mod = mod_skills if r["kind"] == "skills_dir" else mod_mcp
            res = mod.delete_target(STORE, r["id"], force=False)
            if res.get("ok"):
                removed.append(r["name"])
            else:
                kept.append(r["name"])
    for x in specs:
        mod = mod_skills if x["kind"] == "skills_dir" else mod_mcp
        res = mod.add_target(STORE, x["name"], x["kind"], tid, x["path"], x.get("format_key"))
        if res.get("ok"):
            with STORE.lock:
                STORE.db.execute("UPDATE targets SET origin=? WHERE id=?",
                                 (origin, res.get("id")))
                STORE.db.commit()
            created.append(x["name"])
        # 同路径已有目标（非本工具创建）→ 保持原样
    return {"created": created, "removed": removed, "kept": kept}


def _prune_tool_targets(tid):
    """删除工具后：移除此前由它同步出的目标（有部署记录的保留）。"""
    origin = "tool:" + tid
    removed, kept = [], []
    with STORE.lock:
        rows = [dict(r) for r in STORE.db.execute(
            "SELECT * FROM targets WHERE origin=?", (origin,)).fetchall()]
    for r in rows:
        mod = mod_skills if r["kind"] == "skills_dir" else mod_mcp
        res = mod.delete_target(STORE, r["id"], force=False)
        if res.get("ok"):
            removed.append(r["name"])
        else:
            kept.append(r["name"])
    return {"removed": removed, "kept": kept}


def _memory_wired(cfg_path):
    """工具 MCP 配置里是否已接入 agentmemory（None = 无法判断）。"""
    try:
        path = os.path.expanduser(str(cfg_path))
        if not os.path.exists(path):
            return False
        if path.endswith(".toml"):
            return "agentmemory" in open(path, encoding="utf-8", errors="ignore").read()
        d = json.load(open(path, encoding="utf-8"))
        for key in ("mcpServers", "mcp"):
            if isinstance(d.get(key), dict) and "agentmemory" in d[key]:
                return True
        return False
    except Exception:
        return None


def _memory_entry_clone():
    """从已接线的工具配置里复制 agentmemory 服务器条目（只读）。"""
    src = os.environ.get("HUB_AGENTMEMORY_SRC") or os.path.expanduser("~/.claude.json")
    try:
        d = json.load(open(src, encoding="utf-8"))
        for key in ("mcpServers", "mcp"):
            e = (d.get(key) or {}).get("agentmemory")
            if e:
                return e
    except Exception:
        pass
    return None


def _wire_memory(tool):
    """把记忆总线（agentmemory）接入工具的 MCP 配置（JSON；先备份）。"""
    cfg = tool.get("mcp_config")
    if not cfg:
        return {"ok": False, "error": "该工具没有登记 MCP 配置，无法接入记忆总线"}
    path = os.path.expanduser(str(cfg))
    if path.endswith(".toml"):
        return {"ok": False, "error": "仅支持 JSON 格式的 MCP 配置（.toml 暂不支持）"}
    if not os.path.exists(path):
        return {"ok": False, "error": "配置文件不存在：%s" % path}
    if _memory_wired(path) is True:
        return {"ok": True, "already": True, "path": path}
    entry = _memory_entry_clone()
    if not entry:
        return {"ok": False, "error": "未找到可复制的 agentmemory 配置（来源：已接线的工具配置）"}
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {"ok": False, "error": "配置文件不是 JSON 对象"}
        key = "mcp" if ("mcp" in d and "mcpServers" not in d) else "mcpServers"
        if not isinstance(d.get(key), dict):
            d[key] = {}
        if "agentmemory" in d[key]:
            return {"ok": True, "already": True, "path": path}
        d[key]["agentmemory"] = entry
        backup = "%s.bak-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(path, backup)
        tmp = path + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        return {"ok": False, "error": "写入失败：%s" % str(e)[:160]}
    return {"ok": True, "path": path, "backup": backup, "key": key}


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentDepot/0.5"

    def _dispatch_modules(self, method, path, query, body):
        """四模块路由分发。未命中返回 None；模块禁用返回 503。"""
        for mod in MODULE_HANDLERS:
            if path.startswith(mod.PREFIX):
                r = mod.handle(STORE, method, path, query, body)
                if r is not None:
                    return r
        return None

    def _control_routes(self, method, path, query, body):
        """核心控制面：模块注册表 / 统一台账 / 诊断。"""
        if path == "/api/modules" and method == "GET":
            return 200, {"ok": True, "modules": mod_registry.snapshot(STORE)}
        if path.startswith("/api/modules/") and path.endswith("/toggle") and method == "POST":
            mid = path[len("/api/modules/"):-len("/toggle")]
            if mid not in mod_registry.MODULE_IDS:
                return 404, {"ok": False, "error": "未知模块"}
            on = bool(body.get("enabled"))
            mod_registry.set_enabled(STORE, mid, on)
            return 200, {"ok": True, "modules": mod_registry.snapshot(STORE)}
        if path == "/api/tools" and method == "GET":
            counts = STORE.counts_by_tool()
            return 200, {"ok": True,
                         "tools": tools_registry.public_list(STORE, counts),
                         "presets": tools_registry.presets(),
                         "adapters": [dict(id=k, **v) for k, v in tools_registry.ADAPTERS.items()]}
        if path == "/api/tools" and method == "POST":
            try:
                entry, warning = tools_registry.add_tool(
                    STORE, body.get("name"), body.get("adapter"), body.get("root"),
                    skills_dir=body.get("skills_dir"), mcp_config=body.get("mcp_config"),
                    mcp_format=body.get("mcp_format"))
            except ValueError as e:
                return 400, {"ok": False, "error": str(e)}
            linked = _sync_tool_targets(entry)
            core_ops.log_op(STORE, "tools", "add", "ok", item_name=entry["name"],
                            detail={"adapter": entry["adapter"], "root": entry["root"],
                                    "targets_created": linked.get("created")})
            STORE.log("config", {"tools": "add:" + entry["id"]})
            return 200, {"ok": True, "tool": entry, "warning": warning,
                         "targets_created": linked.get("created") or []}
        if (path.startswith("/api/tools/") and path.endswith("/wire-memory")
                and method == "POST"):
            tid = path[len("/api/tools/"):-len("/wire-memory")]
            tool = tools_registry.tool_by_id(STORE, tid)
            if not tool:
                return 404, {"ok": False, "error": "工具不存在：%s" % tid}
            r = _wire_memory(tool)
            if r.get("ok"):
                core_ops.log_op(STORE, "tools", "wire-memory", "ok", item_name=tool["name"],
                                detail={"path": r.get("path"), "backup": r.get("backup")})
                STORE.log("config", {"tools": "wire-memory:" + tid})
            return (200 if r.get("ok") else 400), r
        if path.startswith("/api/tools/") and method in ("PATCH", "DELETE"):
            tid = path[len("/api/tools/"):]
            if method == "PATCH":
                try:
                    t = tools_registry.update_tool(STORE, tid, body)
                except KeyError:
                    return 404, {"ok": False, "error": "工具不存在：%s" % tid}
                except ValueError as e:
                    return 400, {"ok": False, "error": str(e)}
                keys = [k for k in ("name", "enabled", "root", "skills_dir", "mcp_config")
                        if isinstance(body, dict) and k in body]
                linked = _sync_tool_targets(t)
                core_ops.log_op(STORE, "tools", "update", "ok", item_name=t["name"],
                                detail={"id": tid, "keys": keys,
                                        "targets_created": linked.get("created")})
                return 200, {"ok": True, "tool": {"id": t["id"], "name": t["name"],
                                                  "enabled": bool(t.get("enabled", True)),
                                                  "root": t.get("root"),
                                                  "skills_dir": t.get("skills_dir"),
                                                  "mcp_config": t.get("mcp_config")},
                             "targets_created": linked.get("created") or [],
                             "targets_removed": linked.get("removed") or []}
            pq = query.get("purge")
            pq = (pq[0] if isinstance(pq, list) else pq) or ""
            purge = str(pq).lower() in ("1", "true", "yes")
            try:
                t, pstats = tools_registry.remove_tool(STORE, tid, purge=purge)
            except KeyError:
                return 404, {"ok": False, "error": "工具不存在：%s" % tid}
            except ValueError as e:
                return 400, {"ok": False, "error": str(e)}
            pruned = _prune_tool_targets(tid)
            core_ops.log_op(STORE, "tools", "purge" if pstats.get("purged") else "remove",
                            "ok", item_name=t["name"],
                            detail=dict(pstats, targets_removed=pruned.get("removed"),
                                        targets_kept=pruned.get("kept")))
            STORE.log("config", {"tools": ("purge:" if pstats.get("purged") else "remove:") + tid})
            return 200, {"ok": True, "removed": tid, "purge": pstats,
                         "targets_removed": pruned.get("removed") or [],
                         "targets_kept": pruned.get("kept") or []}
        if path == "/api/ops" and method == "GET":
            def g(k, d=None):
                v = query.get(k)
                return (v[0] if isinstance(v, list) else v) if v else d
            r = core_ops.query_ops(STORE, module=g("module"), status=g("status"),
                                   target_id=int(g("target_id")) if g("target_id") else None,
                                   since=g("since"), q=g("q"),
                                   limit=int(g("limit") or 100), offset=int(g("offset") or 0))
            return 200, {"ok": True, **r}
        if path == "/api/ops/export" and method == "GET":
            fmt = (query.get("format", ["json"])[0] if isinstance(query.get("format"), list)
                   else query.get("format")) or "json"
            text, ctype = core_ops.export_ops(STORE, fmt=fmt)
            body_b = text.encode()
            self.send_response(200)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=hub-ops.%s" % fmt)
            self.send_header("Content-Length", str(len(body_b)))
            self.end_headers()
            self.wfile.write(body_b)
            return "sent"
        if path == "/api/doctor" and method == "GET":
            checks = []
            # git
            code, out, _ = gitsrc.run_git(["--version"])
            checks.append({"name": "git", "ok": code == 0, "detail": out.strip()})
            # hub dir writable
            try:
                probe = os.path.join(os.path.expanduser("~/.agent/hub"), ".doctor-probe")
                with open(probe, "w") as f:
                    f.write("x")
                os.unlink(probe)
                checks.append({"name": "hub_dir_writable", "ok": True, "detail": "~/.agent/hub"})
            except Exception as e:
                checks.append({"name": "hub_dir_writable", "ok": False, "detail": str(e)[:120]})
            # casr
            checks.append({"name": "casr", "ok": migrator.available(),
                           "detail": "会话迁移引擎"})
            # agentmemory
            checks.append({"name": "agentmemory", "ok": _agentmemory_health(),
                           "detail": "记忆总线 :3111"})
            # modules
            for m in mod_registry.snapshot(STORE):
                checks.append({"name": "module:" + m["id"], "ok": True,
                               "detail": "enabled" if m["enabled"] else "disabled"})
            # registered tools（自定义路径可用性）
            for t in tools_registry.public_list(STORE, {}):
                if t.get("root") and t.get("root_exists") is False:
                    checks.append({"name": "tool:" + t["id"], "ok": False,
                                   "detail": "路径不存在：%s" % t["root"]})
            # sources health
            with STORE.lock:
                srcs = STORE.db.execute("SELECT kind, name, last_error FROM sources").fetchall()
            for s in srcs:
                checks.append({"name": "source:%s/%s" % (s["kind"], s["name"]),
                               "ok": not s["last_error"], "detail": s["last_error"] or "ok"})
            ok = all(c["ok"] for c in checks)
            return 200, {"ok": ok, "checks": checks}
        if path == "/api/targets/seed" and method == "POST":
            c1 = mod_skills.seed_defaults(STORE)
            c2 = mod_mcp.seed_defaults(STORE)
            return 200, {"ok": True, "created": {"skills": c1, "mcp": c2}}
        if path == "/api/backup" and method == "GET":
            import time as _t
            db = os.path.join(os.path.expanduser("~/.agent/hub"), "hub.db")
            if not os.path.exists(db):
                return 404, {"ok": False, "error": "hub.db 不存在"}
            body_b = open(db, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition",
                             "attachment; filename=hub-backup-%s.db" % _t.strftime("%Y%m%d-%H%M%S"))
            self.send_header("Content-Length", str(len(body_b)))
            self.end_headers()
            self.wfile.write(body_b)
            return "sent"
        return None

    def log_message(self, fmt, *args):
        pass  # keep console quiet

    # ---------- helpers ----------
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}

    def _serve_subtree(self, subdir, rel):
        """Serve a file strictly from ROOT/<subdir>/ — traversal-proof."""
        base = os.path.realpath(os.path.join(ROOT, subdir))
        path = os.path.realpath(os.path.join(base, rel))
        if not (path == base or path.startswith(base + os.sep)):
            self._json({"error": "forbidden"}, 403)
            return
        return self._file(os.path.relpath(path, ROOT))

    def _file(self, rel, ctype=None):
        base = os.path.realpath(ROOT)
        path = os.path.realpath(os.path.join(ROOT, rel))
        if not (path == base or path.startswith(base + os.sep)):
            self._json({"error": "forbidden"}, 403)
            return
        if not os.path.exists(path) or not os.path.isfile(path):
            self._json({"error": "not found"}, 404)
            return
        if ctype is None:
            ext = os.path.splitext(path)[1].lower()
            ctype = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                     ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                     ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json"}.get(
                         ext, "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- GET ----------
    def _download(self, filename, content, mime="text/plain; charset=utf-8"):
        data = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            return self._do_get_inner()
        except Exception as e:
            self._json({"error": "服务器内部错误: %s" % e}, 500)

    def _do_get_inner(self):
        u = urlparse(self.path)
        r = self._dispatch_modules("GET", u.path, parse_qs(u.query), None)
        if r is not None:
            if r == "sent":
                return
            return self._json(r[1], r[0])
        r = self._control_routes("GET", u.path, parse_qs(u.query), None)
        if r is not None:
            if r == "sent":
                return
            return self._json(r[1], r[0])
        if u.path == "/" or u.path == "/index.html":
            return self._file("web/index.html", "text/html; charset=utf-8")
        # static assets: /assets/* -> web/ subtree only; /tests/* -> tests/ subtree only
        if u.path.startswith("/assets/"):
            return self._serve_subtree("web", u.path[len("/assets/"):])
        if u.path.startswith("/tests/"):
            return self._serve_subtree("tests", u.path[len("/tests/"):])
        if u.path == "/api/state":
            raw = STORE.get_config("schedule")
            counts = STORE.counts_by_tool()
            tool_list = tools_registry.public_list(STORE, counts)
            for _t in tool_list:
                _t["memory_wired"] = (_memory_wired(_t["mcp_config"])
                                      if _t.get("mcp_config") else None)
            sessions = STORE.list_sessions()
            for s in sessions:
                lin = lineage_info(STORE, s["tool"], s["sid"])
                if lin:
                    s["lid"] = lin["lid"]
                    s["migrations"] = lin["migrations"]
            return self._json({
                "tools": counts,
                "tool_list": tool_list,
                "sessions": sessions,
                "ledger": STORE.ledger_recent(20),
                "migrations": migration_history(STORE, limit=20),
                "schedule": json.loads(raw) if raw else DEFAULT_SCHEDULE,
                "engine": {"casr": migrator.available(),
                           "agentmemory": _agentmemory_health()},
                "memories": list_memories(STORE, limit=50),
                "now": now_iso(),
            })
        if u.path == "/api/search":
            q = parse_qs(u.query)
            query = q.get("q", [""])[0]
            if not query.strip():
                return self._json({"ok": False, "error": "q 不能为空"}, 400)
            results = search_messages(STORE, query)
            return self._json({"ok": True, "results": results})
        if u.path == "/api/export":
            sid = parse_qs(u.query).get("sid", [""])[0]
            if not sid:
                return self._json({"ok": False, "error": "sid required"}, 400)
            path, nbytes = export_markdown(STORE, sid)
            if path is None:
                return self._json({"ok": False, "error": "会话不存在"}, 404)
            STORE.log("export", {"sid": sid, "path": path, "bytes": nbytes})
            return self._json({"ok": True, "path": path, "bytes": nbytes})
        if u.path == "/api/stats":
            return self._json({"ok": True, "stats": session_stats(STORE)})
        if u.path == "/api/sessions":
            q = parse_qs(u.query)
            tool = q.get("tool", ["all"])[0]
            query = q.get("q", [""])[0]
            return self._json({"sessions": STORE.list_sessions(tool=tool, q=query)})
        if u.path == "/api/session":
            sid = parse_qs(u.query).get("id", [""])[0]
            sess = STORE.session(sid)
            if not sess:
                return self._json({"error": "not found"}, 404)
            sess["messages"] = STORE.messages(sid)
            return self._json(sess)
        if u.path == "/api/schedule":
            raw = STORE.get_config("schedule")
            return self._json(json.loads(raw) if raw else DEFAULT_SCHEDULE)
        if u.path == "/api/memories":
            return self._json({"memories": list_memories(STORE, limit=100)})
        if u.path == "/api/memory/search":
            q = parse_qs(u.query)
            query = q.get("q", [""])[0]
            if not query.strip():
                return self._json({"ok": False, "error": "q 不能为空"}, 400)
            try:
                lim = max(1, min(200, int(q.get("limit", ["50"])[0])))
            except (TypeError, ValueError):
                lim = 50
            return self._json({"ok": True, "results": search_memories(STORE, query, limit=lim)})
        if u.path == "/api/memory/export":
            fmt = parse_qs(u.query).get("format", ["md"])[0]
            if fmt not in ("md", "json"):
                return self._json({"ok": False, "error": "format 仅支持 md/json"}, 400)
            payload = export_memories(STORE, fmt)
            core_ops.log_op(STORE, "memory", "export", "ok",
                            detail={"format": fmt,
                                    "bytes": len(payload["content"].encode("utf-8"))})
            return self._download(payload["filename"], payload["content"], payload["mime"])
        if u.path == "/api/sync/preview":
            q = parse_qs(u.query)
            sid = q.get("sid", [""])[0]
            tool = q.get("tool", [""])[0]
            target = q.get("target", [""])[0]
            sess = STORE.session(sid) if sid else None
            if not sess or not target:
                return self._json({"error": "sid & target required"}, 400)
            st = sync_status(STORE, sess["tool"], sid, target)
            return self._json({"sync": st})
        if u.path == "/api/lineage":
            q = parse_qs(u.query)
            tool = q.get("tool", [""])[0]
            sid = q.get("sid", [""])[0]
            if not tool or not sid:
                return self._json({"error": "tool & sid required"}, 400)
            return self._json(lineage_info(STORE, tool, sid) or {})
        return self._json({"error": "not found"}, 404)

    def do_HEAD(self):
        u = urlparse(self.path)
        status = 200 if (u.path == "/" or u.path.startswith("/api/")) else 404
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- POST ----------
    def do_POST(self):
        return self._do_write("POST")

    def do_DELETE(self):
        return self._do_write("DELETE")

    def do_PATCH(self):
        return self._do_write("PATCH")

    def do_PUT(self):
        return self._do_write("PUT")

    def _do_write(self, method):
        try:
            return self._do_post_inner(method)
        except (ValueError, TypeError, KeyError) as e:
            self._json({"ok": False, "error": "无效输入: %s" % e}, 400)
        except Exception as e:
            self._json({"ok": False, "error": "服务器内部错误: %s" % e}, 500)

    def _do_post_inner(self, method="POST"):
        u = urlparse(self.path)
        data = self._body()
        r = self._dispatch_modules(method, u.path, parse_qs(u.query), data)
        if r is not None:
            return self._json(r[1], r[0])
        r = self._control_routes(method, u.path, parse_qs(u.query), data)
        if r is not None:
            return self._json(r[1], r[0])
        if method != "POST":
            return self._json({"error": "not found"}, 404)
        if u.path == "/api/refresh":
            tool = data.get("tool")
            if tool and not tools_registry.is_active(STORE, tool):
                return self._json({"ok": False, "error": "工具不存在或已停用：%s" % tool}, 400)
            if not REFRESH_LOCK.acquire(blocking=False):
                return self._json({"ok": False, "error": "刷新正在进行中"}, 409)
            try:
                results = scan_all(STORE, tools=[tool] if tool else None)
                STORE.log("refresh", {"manual": True, "tool": tool, "results": results})
                return self._json({"ok": True, "results": results,
                                   "tools": STORE.counts_by_tool()})
            finally:
                REFRESH_LOCK.release()
        if u.path == "/api/migrate":
            sid = data.get("sid")
            target = data.get("target")
            sess = STORE.session(sid) if sid else None
            if not sess:
                return self._json({"ok": False, "error": "会话不存在"}, 404)
            r = migrator.migrate(STORE, sid, sess["tool"], target,
                                 force=bool(data.get("force")))
            if r.get("ok") and r.get("new_id"):
                # pick up the new native session immediately
                scan_all(STORE, tools=[target])
                core_ops.log_op(STORE, "sessions", "migrate", "ok", item_name=sess.get("title"),
                                item_version=r.get("lid"), target_id=None,
                                detail={"from": sess["tool"], "to": target})
                add_memory(STORE,
                           "会话「%s」已迁移 %s → %s（lid %s，新会话 %s）。目标工具内 resume 即可继续。"
                           % (sess.get("title") or sid[:16], sess["tool"], target,
                              r.get("lid"), r.get("new_id")),
                           title="迁移记录 · " + (sess.get("title") or sid[:16])[:40],
                           kind="migration-summary",
                           refs={"lid": r.get("lid"), "sid": sid, "target": target},
                           source="migrate")
            return self._json(r)
        if u.path == "/api/star":
            sid = data.get("sid")
            if not sid:
                return self._json({"ok": False, "error": "sid required"}, 400)
            new = set_star(STORE, sid)
            if new is None:
                return self._json({"ok": False, "error": "会话不存在"}, 404)
            return self._json({"ok": True, "starred": new})
        if u.path == "/api/memory/add":
            body = (data.get("body") or "").strip()
            if not body:
                return self._json({"ok": False, "error": "内容不能为空"}, 400)
            mid = add_memory(STORE, body, title=data.get("title"),
                             kind=data.get("kind") or "note")
            core_ops.log_op(STORE, "memory", "add", "ok", item_name=data.get("title"))
            return self._json({"ok": True, "id": mid})
        if u.path == "/api/memory/delete":
            mid = data.get("id")
            if not mid:
                return self._json({"ok": False, "error": "id required"}, 400)
            ok = delete_memory(STORE, int(mid))
            if ok:
                core_ops.log_op(STORE, "memory", "delete", "ok", item_name=str(mid))
            return self._json({"ok": ok})
        if u.path == "/api/export/batch":
            sids = data.get("sids")
            if sids is not None and not isinstance(sids, list):
                return self._json({"ok": False, "error": "sids 必须是数组"}, 400)
            res = export_batch(STORE, sids if sids else None)
            core_ops.log_op(STORE, "sessions", "export-batch", "ok",
                            detail={"count": res["count"], "zip_bytes": res["zip_bytes"]})
            return self._json({"ok": True, "path": res["path"], "count": res["count"],
                               "bytes": res["bytes"], "zip_bytes": res["zip_bytes"]})
        if u.path == "/api/schedule":
            sched = json.loads(STORE.get_config("schedule") or "null") or dict(DEFAULT_SCHEDULE)
            # ensure keys exist (e.g. "all" added after first boot)
            for k, v in DEFAULT_SCHEDULE.items():
                sched.setdefault(k, dict(v))
            tool = data.get("tool")
            valid_scopes = {"all"} | {t["id"] for t in tools_registry.load_tools(STORE)}
            if tool in valid_scopes:
                sched.setdefault(tool, {"enabled": False, "interval_min": 30})
                if "enabled" in data:
                    sched[tool]["enabled"] = bool(data["enabled"])
                if "interval_min" in data:
                    try:
                        sched[tool]["interval_min"] = max(1, int(data["interval_min"]))
                    except (TypeError, ValueError):
                        return self._json({"ok": False,
                                           "error": "interval_min 必须是正整数"}, 400)
                sched[tool]["interval_min"] = max(1, int(sched[tool].get("interval_min", 30)))
            else:
                return self._json({"ok": False, "error": "未知范围：%s" % (tool or "")}, 400)
            STORE.set_config("schedule", json.dumps(sched))
            STORE.log("config", {"schedule": tool, "value": data})
            return self._json({"ok": True, "schedule": sched})
        return self._json({"error": "not found"}, 404)


def _agentmemory_health():
    """Lightweight reachability probe for the agentmemory service (optional)."""
    try:
        req = urllib.request.Request("http://127.0.0.1:3111/agentmemory/health")
        with urllib.request.urlopen(req, timeout=0.8) as resp:
            return resp.status == 200
    except Exception:
        return False


class HubServer(ThreadingHTTPServer):
    """并发加固：默认 listen backlog=5，页面加载的连接突发会溢出排队导致连接被 RST。

    抬高排队上限后，突发连接进入队列等待 accept，不再丢请求。"""
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


def main():
    global STORE
    ensure_store()
    addr = ("127.0.0.1", PORT)
    httpd = HubServer(addr, Handler)
    print("Agent Depot -> http://127.0.0.1:%d  (Ctrl-C to stop)" % PORT)
    print("hub dir: %s" % STORE.db.db if False else "hub db:  ~/.agent/hub/hub.db")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
