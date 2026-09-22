#!/usr/bin/env python3
"""Agent Session Hub — local console server.

Zero-dependency (stdlib only). Serves the web UI and a JSON API:
  GET  /api/state                 -> tools + sessions + ledger + engine status
  GET  /api/session?id=...        -> session detail + messages
  POST /api/refresh               -> {tool?: "claude"|"codex"|"opencode"} incremental scan
  POST /api/migrate               -> {sid, target} migrate via casr
  GET/POST /api/schedule          -> per-tool schedule config (enabled, interval_min)
  GET  /                          -> web/index.html

Scheduler runs in-thread; every due tool refresh is recorded to the ledger.
"""
import json
import os
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
                       set_star, search_messages, export_markdown)
from hub.scanners import scan_all             # noqa: E402
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
        ops.log_op(STORE, "system", "boot", "ok", detail={"version": "0.4.0"})
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
    return ran


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentSessionHub/0.4"

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
            sessions = STORE.list_sessions()
            for s in sessions:
                lin = lineage_info(STORE, s["tool"], s["sid"])
                if lin:
                    s["lid"] = lin["lid"]
                    s["migrations"] = lin["migrations"]
            return self._json({
                "tools": STORE.counts_by_tool(),
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
        try:
            return self._do_post_inner()
        except (ValueError, TypeError, KeyError) as e:
            self._json({"ok": False, "error": "无效输入: %s" % e}, 400)
        except Exception as e:
            self._json({"ok": False, "error": "服务器内部错误: %s" % e}, 500)

    def _do_post_inner(self):
        u = urlparse(self.path)
        data = self._body()
        r = self._dispatch_modules("POST", u.path, parse_qs(u.query), data)
        if r is not None:
            return self._json(r[1], r[0])
        r = self._control_routes("POST", u.path, parse_qs(u.query), data)
        if r is not None:
            return self._json(r[1], r[0])
        if u.path == "/api/refresh":
            tool = data.get("tool")
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
        if u.path == "/api/schedule":
            sched = json.loads(STORE.get_config("schedule") or "null") or dict(DEFAULT_SCHEDULE)
            # ensure keys exist (e.g. "all" added after first boot)
            for k, v in DEFAULT_SCHEDULE.items():
                sched.setdefault(k, dict(v))
            tool = data.get("tool")
            if tool in sched:
                if "enabled" in data:
                    sched[tool]["enabled"] = bool(data["enabled"])
                if "interval_min" in data:
                    try:
                        sched[tool]["interval_min"] = max(1, int(data["interval_min"]))
                    except (TypeError, ValueError):
                        return self._json({"ok": False,
                                           "error": "interval_min 必须是正整数"}, 400)
                sched[tool]["interval_min"] = max(1, int(sched[tool].get("interval_min", 30)))
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


def main():
    global STORE
    ensure_store()
    addr = ("127.0.0.1", PORT)
    httpd = ThreadingHTTPServer(addr, Handler)
    print("Agent Session Hub -> http://127.0.0.1:%d  (Ctrl-C to stop)" % PORT)
    print("hub dir: %s" % STORE.db.db if False else "hub db:  ~/.agent/hub/hub.db")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
