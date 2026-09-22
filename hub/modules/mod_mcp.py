"""一级模块：MCP 管理分发。

- 源/拉取/本地库与 skills 对称；
- 分发适配两种目标格式：mcp_json（键路径合并）与 mcp_toml（受管块标记替换）；
- 内置协议握手验证（stdio/http）；
- 冲突语义：非托管同名条目 / 托管后被外部改 → 停手（force 才覆盖，且先备份）。
"""
import json
import os
import re
import time

from hub.core import fsutil, ops
from hub.lib import catalog, gitsrc, mcpverify

MODULE = "mcp"
KIND = "mcp"
PREFIX = "/api/mcp"
BLOCK_OPEN = "# >>> hub:managed: %s >>>"
BLOCK_CLOSE = "# <<< hub:managed: %s <<<"


def _hub_dir():
    return os.environ.get("AGENT_HUB_DIR") or os.path.expanduser("~/.agent/hub")


def sources_root():
    return os.path.join(_hub_dir(), "sources")


def registry_root():
    return os.path.join(_hub_dir(), "registry", "mcp")


def versions_root(name):
    return os.path.join(_hub_dir(), "registry", ".versions", "mcp", name)


# ============================================================ sources (对称实现)
def add_source(store, name, url, branch="main", subdir="", auth_ref=None):
    name = (name or "").strip()
    url = (url or "").strip()
    if not name or not url:
        return {"ok": False, "error": "name 与 url 必填"}
    try:
        with store.lock:
            cur = store.db.execute(
                "INSERT INTO sources(kind, name, url, branch, subdir, auth_ref, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (KIND, name, url, branch or "main", subdir or "", auth_ref or None, ops.now_iso()))
            store.db.commit()
            sid = cur.lastrowid
    except Exception as e:
        return {"ok": False, "error": "源已存在或非法：%s" % e}
    ops.log_op(store, MODULE, "source:add", "ok", source_id=sid, item_name=name)
    return {"ok": True, "id": sid}


def list_sources(store):
    with store.lock:
        rows = store.db.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS item_count "
            "FROM sources s WHERE s.kind=? ORDER BY s.id", (KIND,)).fetchall()
    return [dict(r) for r in rows]


def update_source(store, source_id, fields):
    allowed = ("enabled", "branch", "subdir", "auth_ref", "poll_min", "name", "url")
    sets, args = [], []
    for k in allowed:
        if k in fields:
            sets.append("%s=?" % k)
            args.append(fields[k])
    if not sets:
        return {"ok": False, "error": "无更新字段"}
    with store.lock:
        store.db.execute("UPDATE sources SET %s WHERE id=? AND kind=?" % ",".join(sets),
                         args + [source_id, KIND])
        store.db.commit()
    ops.log_op(store, MODULE, "source:update", "ok", source_id=source_id, detail=fields)
    return {"ok": True}


def delete_source(store, source_id):
    with store.lock:
        store.db.execute("DELETE FROM items WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM sources WHERE id=? AND kind=?", (source_id, KIND))
        store.db.commit()
    ops.log_op(store, MODULE, "source:delete", "ok", source_id=source_id)
    return {"ok": True}


def pull_source(store, source_id):
    with store.lock:
        src = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?",
                               (source_id, KIND)).fetchone()
    if not src:
        return {"ok": False, "error": "源不存在"}
    src = dict(src)
    cache = os.path.join(sources_root(), "mcp-%d" % source_id)
    ok, commit, resolved_branch, err = gitsrc.ensure_cache(
        cache, src["url"], src["branch"] or "main", src["auth_ref"])
    if not ok:
        _mark_error(store, source_id, err)
        ops.log_op(store, MODULE, "pull", "failed", source_id=source_id, reason=err)
        return {"ok": False, "error": err}
    files = gitsrc.ls_tree(cache, commit)
    show = lambda p: gitsrc.show_bytes(cache, commit, p)  # noqa: E731
    items = catalog.parse_mcp(files, show, subdir=src["subdir"] or "")
    if not items:
        msg = "源中没有解析到 MCP 条目（检查 mcp.json 或 mcp/*.json）"
        _mark_error(store, source_id, msg)
        ops.log_op(store, MODULE, "pull", "failed", source_id=source_id, reason=msg)
        return {"ok": False, "error": msg}
    added, changed, removed = [], [], []
    with store.lock:
        old = {r["name"]: dict(r) for r in store.db.execute(
            "SELECT * FROM items WHERE source_id=?", (source_id,)).fetchall()}
        for it in items:
            prev = old.get(it["name"])
            if not prev:
                added.append(it["name"])
            elif prev["source_hash"] != it["source_hash"]:
                changed.append(it["name"])
            store.db.execute(
                "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) "
                "VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(source_id, name) DO UPDATE SET path=excluded.path, "
                "source_hash=excluded.source_hash, version=excluded.version, meta=excluded.meta",
                (source_id, KIND, it["name"], it["path"], it["source_hash"], commit,
                 json.dumps(it["config"], ensure_ascii=False)))
        for nm in old:
            if nm not in {i["name"] for i in items}:
                removed.append(nm)
                store.db.execute("DELETE FROM items WHERE source_id=? AND name=?", (source_id, nm))
        store.db.execute("UPDATE sources SET last_sync_at=?, last_commit=?, last_error=NULL, "
                         "branch=COALESCE(?, branch) WHERE id=?",
                         (ops.now_iso(), commit, resolved_branch, source_id))
        store.db.commit()
    ops.log_op(store, MODULE, "pull", "ok", source_id=source_id, item_version=commit,
               detail={"added": added, "changed": changed, "removed": removed})
    return {"ok": True, "commit": commit, "added": added, "changed": changed, "removed": removed}


def _mark_error(store, source_id, msg):
    with store.lock:
        store.db.execute("UPDATE sources SET last_error=? WHERE id=?", (msg, source_id))
        store.db.commit()


# ============================================================ registry
def _config_of(item_row):
    return json.loads(item_row["meta"]) if item_row["meta"] else {}


def _reg_path(name):
    return os.path.join(registry_root(), name + ".json")


def _reg_hash(name):
    p = _reg_path(name)
    if not os.path.exists(p):
        return None
    return fsutil.sha256_file(p)


def update_registry(store, names, source_id=None, force=False):
    results = []
    with store.lock:
        for name in names:
            row = store.db.execute(
                "SELECT * FROM items WHERE kind=? AND name=? " +
                ("AND source_id=? " if source_id else "") + "ORDER BY id DESC LIMIT 1",
                ([KIND, name] + ([source_id] if source_id else []))).fetchone()
            if not row:
                results.append({"item": name, "status": "failed", "reason": "源中没有该条目"})
                continue
            row = dict(row)
            reg = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                                   (KIND, name)).fetchone()
            reg = dict(reg) if reg else None
            cur_hash = _reg_hash(name)
            if reg and cur_hash and reg["hash"] and cur_hash != reg["hash"] and not force:
                results.append({"item": name, "status": "conflict-local-modified",
                                "reason": "本地库中该条目已被修改（force 覆盖）"})
                ops.log_op(store, MODULE, "update", "conflict", item_kind="mcp",
                           item_name=name, reason="local-modified")
                continue
            if reg and reg.get("source_hash_at") == row["source_hash"] and cur_hash == reg["hash"]:
                results.append({"item": name, "status": "unchanged", "version": reg["version"]})
                continue
            # materialize: registry/mcp/<name>.json（+ 旧版快照）
            cfg = _config_of(row)
            os.makedirs(registry_root(), exist_ok=True)
            dest = _reg_path(name)
            if os.path.exists(dest):
                vroot = versions_root(name)
                os.makedirs(vroot, exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                os.rename(dest, os.path.join(vroot, stamp))
            fsutil.write_json_atomic(dest, cfg)
            new_hash = fsutil.sha256_file(dest)
            store.db.execute(
                "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
                "prev_version, prev_hash, source_hash_at) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(kind, name) DO UPDATE SET source_id=excluded.source_id, "
                "version=excluded.version, hash=excluded.hash, updated_at=excluded.updated_at, "
                "prev_version=excluded.prev_version, prev_hash=excluded.prev_hash, "
                "source_hash_at=excluded.source_hash_at",
                (KIND, name, row["source_id"], row["version"], new_hash, ops.now_iso(),
                 reg["version"] if reg else None, reg["hash"] if reg else None,
                 row["source_hash"]))
            store.db.commit()
            results.append({"item": name, "status": "updated" if reg else "installed",
                            "version": row["version"][:12] if row["version"] else None})
            ops.log_op(store, MODULE, "update", "ok", item_kind="mcp", item_name=name,
                       source_id=row["source_id"])
    return results


def rollback_registry(store, name):
    vroot = versions_root(name)
    if not os.path.isdir(vroot):
        return {"ok": False, "error": "没有可回退的版本快照"}
    snaps = sorted(d for d in os.listdir(vroot) if not d.startswith("."))
    if not snaps:
        return {"ok": False, "error": "版本快照为空"}
    latest = os.path.join(vroot, snaps[-1])
    dest = _reg_path(name)
    if os.path.exists(dest):
        os.rename(dest, os.path.join(vroot, time.strftime("%Y%m%d-%H%M%S") + "-pre-rollback"))
    os.rename(latest, dest)
    new_hash = fsutil.sha256_file(dest)
    with store.lock:
        store.db.execute("UPDATE registry_items SET hash=?, updated_at=? WHERE kind=? AND name=?",
                         (new_hash, ops.now_iso(), KIND, name))
        store.db.commit()
    ops.log_op(store, MODULE, "rollback", "ok", item_kind="mcp", item_name=name)
    return {"ok": True, "hash": new_hash[:12]}


# ============================================================ targets
def add_target(store, name, kind, tool, path, format_key=None):
    if kind not in ("mcp_json", "mcp_toml"):
        return {"ok": False, "error": "kind 必须是 mcp_json / mcp_toml"}
    path = os.path.expanduser((path or "").strip())
    if not path:
        return {"ok": False, "error": "path 必填"}
    try:
        with store.lock:
            cur = store.db.execute(
                "INSERT INTO targets(name, kind, tool, path, format_key, created_at) "
                "VALUES(?,?,?,?,?,?)", (name or os.path.basename(path), kind, tool, path,
                                        format_key, ops.now_iso()))
            store.db.commit()
            tid = cur.lastrowid
    except Exception as e:
        return {"ok": False, "error": "目标已存在（同路径同类型）或非法：%s" % e}
    ops.log_op(store, MODULE, "target:add", "ok", target_id=tid, item_name=name)
    return {"ok": True, "id": tid}


def delete_target(store, target_id, force=False):
    with store.lock:
        n = store.db.execute("SELECT COUNT(*) c FROM deployments WHERE target_id=? AND status='ok'",
                             (target_id,)).fetchone()["c"]
        if n and not force:
            return {"ok": False, "error": "目标上仍有 %d 条部署记录；用 force 或先清理" % n}
        store.db.execute("DELETE FROM deployments WHERE target_id=?", (target_id,))
        store.db.execute("DELETE FROM targets WHERE id=?", (target_id,))
        store.db.commit()
    ops.log_op(store, "system", "target:delete", "ok", target_id=target_id)
    return {"ok": True}


def seed_defaults(store):
    home = os.path.expanduser("~")
    defaults = [
        ("Claude Code (全局)", "mcp_json", "claude", os.path.join(home, ".claude.json"), "mcpServers"),
        ("Codex CLI (全局)", "mcp_toml", "codex", os.path.join(home, ".codex", "config.toml"), None),
        ("OpenCode (全局)", "mcp_json", "opencode", os.path.join(home, ".config", "opencode", "opencode.json"), "mcp"),
        ("Cursor (全局)", "mcp_json", "cursor", os.path.join(home, ".cursor", "mcp.json"), "mcpServers"),
    ]
    created = []
    with store.lock:
        for nm, kind, tool, path, fkey in defaults:
            if not os.path.exists(path) and not os.path.isdir(os.path.dirname(path)):
                continue
            try:
                cur = store.db.execute(
                    "INSERT OR IGNORE INTO targets(name, kind, tool, path, format_key, created_at) "
                    "VALUES(?,?,?,?,?,?)", (nm, kind, tool, path, fkey, ops.now_iso()))
                if cur.rowcount:
                    created.append(nm)
            except Exception:
                pass
        store.db.commit()
    if created:
        ops.log_op(store, "system", "targets:seed", "ok", detail={"mcp": created})
    return created


def list_targets(store):
    with store.lock:
        rows = store.db.execute(
            "SELECT * FROM targets WHERE kind IN ('mcp_json','mcp_toml') ORDER BY id").fetchall()
    return [dict(r) for r in rows]


# ============================================================ distribute
def _toml_block(name, cfg):
    lines = [BLOCK_OPEN % name, "[mcp_servers.%s]" % name]
    if cfg.get("command"):
        lines.append("command = %s" % json.dumps(cfg["command"]))
    if cfg.get("args"):
        lines.append("args = %s" % json.dumps(cfg["args"]))
    if cfg.get("url"):
        lines.append("url = %s" % json.dumps(cfg["url"]))
    if cfg.get("env"):
        lines.append("")
        lines.append("[mcp_servers.%s.env]" % name)
        for k, v in cfg["env"].items():
            lines.append("%s = %s" % (k, json.dumps(str(v))))
    lines.append(BLOCK_CLOSE % name)
    return "\n".join(lines)


def _find_toml_block(text, name):
    pat = re.compile(re.escape(BLOCK_OPEN % name) + r".*?" + re.escape(BLOCK_CLOSE % name),
                     re.DOTALL)
    m = pat.search(text)
    return m


def _plan_mcp_json(store, name, target, force=False):
    cfg = fsutil.read_json(_reg_path(name))
    if cfg is None:
        return {"status": "failed", "reason": "本地库中不存在该条目"}
    path = os.path.expanduser(target["path"])
    fmt_key = target["format_key"] or "mcpServers"
    data = fsutil.read_json(path) if os.path.exists(path) else {}
    if data is None:
        return {"status": "failed", "reason": "目标文件不是合法 JSON：%s" % path}
    section = (data or {}).get(fmt_key) or {}
    existing = section.get(name)
    dep = _deployment(store, name, target["id"])
    injected = None
    if dep and dep["detail"]:
        try:
            injected = json.loads(dep["detail"]).get("injected")
        except Exception:
            injected = None
    if existing == cfg:
        return {"status": "skipped", "reason": "已是最新（幂等跳过）"}
    if existing is not None:
        if injected is None and not force:
            return {"status": "conflict",
                    "reason": "目标中已有未托管的同名条目（%s.%s）；确认后 force 覆盖" % (fmt_key, name)}
        if injected is not None and existing != injected and not force:
            return {"status": "conflict", "reason": "托管条目被外部修改过；force 覆盖或手动处理"}
    return {"status": "ok", "action": "create" if existing is None else "update",
            "path": path, "fmt_key": fmt_key, "config": cfg}


def _apply_mcp_json(store, name, target, plan):
    path = plan["path"]
    fmt_key = plan["fmt_key"]
    cfg = plan["config"]
    backup = fsutil.backup_file(path)
    data = fsutil.read_json(path) if os.path.exists(path) else {}
    if data is None:
        data = {}
    data.setdefault(fmt_key, {})
    data[fmt_key][name] = cfg
    fsutil.write_json_atomic(path, data)
    with store.lock:
        store.db.execute(
            "INSERT INTO deployments(item_kind, item_name, target_id, deployed_hash, "
            "deployed_at, status, detail) VALUES('mcp',?,?,?,?,?,?) "
            "ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET "
            "deployed_hash=excluded.deployed_hash, deployed_at=excluded.deployed_at, "
            "status=excluded.status, detail=excluded.detail",
            (name, target["id"], fsutil.sha256_bytes(json.dumps(cfg, sort_keys=True).encode()),
             ops.now_iso(), "ok",
             json.dumps({"injected": cfg, "format_key": fmt_key, "backup": backup})))
        store.db.commit()


def _plan_mcp_toml(store, name, target, force=False):
    cfg = fsutil.read_json(_reg_path(name))
    if cfg is None:
        return {"status": "failed", "reason": "本地库中不存在该条目"}
    path = os.path.expanduser(target["path"])
    text = ""
    if os.path.exists(path):
        text = open(path, encoding="utf-8", errors="replace").read()
    block = _find_toml_block(text, name)
    new_block = _toml_block(name, cfg)
    if block and block.group(0) == new_block:
        return {"status": "skipped", "reason": "已是最新（幂等跳过）"}
    # 未托管原生表检测
    native = re.search(r"^\[mcp_servers\.%s\]\s*$" % re.escape(name), text, re.MULTILINE)
    if native and not block and not force:
        return {"status": "conflict",
                "reason": "config.toml 中存在未托管的 [mcp_servers.%s] 表；force 覆盖（会备份）" % name}
    dep = _deployment(store, name, target["id"])
    if dep and block and not force:
        injected_txt = None
        try:
            injected_txt = json.loads(dep["detail"]).get("block_text")
        except Exception:
            pass
        if injected_txt and block.group(0) != injected_txt:
            return {"status": "conflict", "reason": "托管块被外部修改过；force 覆盖或手动处理"}
    return {"status": "ok", "action": "update" if block else "create", "path": path,
            "block": new_block, "replace": bool(block)}


def _apply_mcp_toml(store, name, target, plan):
    path = plan["path"]
    backup = fsutil.backup_file(path)
    text = ""
    if os.path.exists(path):
        text = open(path, encoding="utf-8", errors="replace").read()
    block = _find_toml_block(text, name)
    if block:
        text = text[:block.start()] + plan["block"] + text[block.end():]
    else:
        if text and not text.endswith("\n"):
            text += "\n"
        text += "\n" + plan["block"] + "\n"
    fsutil.atomic_write_text(path, text)
    with store.lock:
        store.db.execute(
            "INSERT INTO deployments(item_kind, item_name, target_id, deployed_hash, "
            "deployed_at, status, detail) VALUES('mcp',?,?,?,?,?,?) "
            "ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET "
            "deployed_hash=excluded.deployed_hash, deployed_at=excluded.deployed_at, "
            "status=excluded.status, detail=excluded.detail",
            (name, target["id"], fsutil.sha256_bytes(plan["block"].encode()),
             ops.now_iso(), "ok",
             json.dumps({"block_text": plan["block"], "backup": backup})))
        store.db.commit()


def _deployment(store, name, target_id):
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM deployments WHERE item_kind='mcp' AND item_name=? AND target_id=?",
            (name, target_id)).fetchone()
    return dict(row) if row else None


def distribute_mcp(store, names, target_ids, dry_run=False, force=False):
    results = []
    targets = [t for t in list_targets(store) if t["id"] in target_ids]
    for name in names:
        for t in targets:
            try:
                if t["kind"] == "mcp_json":
                    plan = _plan_mcp_json(store, name, t, force=force)
                else:
                    plan = _plan_mcp_toml(store, name, t, force=force)
            except Exception as e:
                plan = {"status": "failed", "reason": str(e)[:200]}
            if plan["status"] != "ok":
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": plan["status"], "reason": plan.get("reason"),
                                "dry_run": dry_run})
                if not dry_run and plan["status"] == "conflict":
                    ops.log_op(store, MODULE, "distribute", "conflict", item_kind="mcp",
                               item_name=name, target_id=t["id"], reason=plan.get("reason"))
                continue
            if dry_run:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan["action"],
                                "reason": "dry-run（未写入）", "dry_run": True})
                continue
            try:
                if t["kind"] == "mcp_json":
                    _apply_mcp_json(store, name, t, plan)
                else:
                    _apply_mcp_toml(store, name, t, plan)
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan["action"], "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "ok", item_kind="mcp",
                           item_name=name, target_id=t["id"])
            except Exception as e:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "failed", "reason": str(e)[:200], "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "failed", item_kind="mcp",
                           item_name=name, target_id=t["id"], reason=str(e)[:200])
    return results


# ============================================================ verify & views
def verify_item(store, name):
    p = _reg_path(name)
    cfg = fsutil.read_json(p)
    if cfg is None:
        return {"ok": False, "error": "本地库中不存在该条目（先更新到本地）"}
    result = mcpverify.verify(cfg)
    ops.log_op(store, MODULE, "verify", "ok" if result.get("ok") else "failed",
               item_kind="mcp", item_name=name,
               reason=None if result.get("ok") else result.get("error"),
               detail={k: result.get(k) for k in ("transport", "server_name", "tool_count",
                                                  "latency_ms")})
    return result


def catalog_view(store, source_id=None):
    with store.lock:
        if source_id:
            items = store.db.execute(
                "SELECT i.*, s.name AS source_name FROM items i JOIN sources s ON s.id=i.source_id "
                "WHERE i.kind=? AND i.source_id=? ORDER BY i.name", (KIND, source_id)).fetchall()
        else:
            items = store.db.execute(
                "SELECT i.*, s.name AS source_name FROM items i JOIN sources s ON s.id=i.source_id "
                "WHERE i.kind=? ORDER BY i.name", (KIND,)).fetchall()
        regs = {r["name"]: dict(r) for r in store.db.execute(
            "SELECT * FROM registry_items WHERE kind=?", (KIND,)).fetchall()}
    out = []
    for it in items:
        it = dict(it)
        reg = regs.get(it["name"])
        st = "not-installed"
        if reg:
            cur = _reg_hash(it["name"])
            if cur and reg["hash"] and cur != reg["hash"]:
                st = "local-modified"
            elif reg.get("source_hash_at") and it["source_hash"] != reg["source_hash_at"]:
                st = "update-available"
            else:
                st = "installed"
        cfg = json.loads(it["meta"]) if it["meta"] else {}
        out.append({"name": it["name"], "version": (it["version"] or "")[:12],
                    "source_name": it["source_name"], "source_id": it["source_id"],
                    "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                    "target": cfg.get("url") or (cfg.get("command", "") + " " + " ".join(cfg.get("args", []))).strip(),
                    "env_keys": sorted((cfg.get("env") or {}).keys()),
                    "status": st})
    return out


def registry_view(store):
    with store.lock:
        regs = [dict(r) for r in store.db.execute(
            "SELECT * FROM registry_items WHERE kind=? ORDER BY name", (KIND,)).fetchall()]
        deps = [dict(r) for r in store.db.execute(
            "SELECT d.*, t.name AS target_name FROM deployments d "
            "LEFT JOIN targets t ON t.id=d.target_id WHERE d.item_kind='mcp' AND d.status='ok'"
        ).fetchall()]
    dep_map = {}
    for d in deps:
        dep_map.setdefault(d["item_name"], []).append(
            {"target": d["target_name"], "target_id": d["target_id"]})
    out = []
    for r in regs:
        cur = _reg_hash(r["name"])
        cfg = fsutil.read_json(_reg_path(r["name"])) or {}
        out.append({"name": r["name"], "version": (r["version"] or "")[:12],
                    "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                    "target": cfg.get("url") or (cfg.get("command", "") + " " + " ".join(cfg.get("args", []))).strip(),
                    "env_keys": sorted((cfg.get("env") or {}).keys()),
                    "modified": bool(cur and r["hash"] and cur != r["hash"]),
                    "deployments": dep_map.get(r["name"], [])})
    return out


def item_detail(store, name):
    cfg = fsutil.read_json(_reg_path(name))
    if cfg is None:
        return None
    masked = {}
    for k, v in (cfg.get("env") or {}).items():
        masked[k] = fsutil.mask_secret(v)
    return {"name": name, "config": {k: v for k, v in cfg.items() if k != "env"},
            "env_masked": masked}


# ============================================================ HTTP routes
def handle(store, method, path, query, body):
    if not path.startswith(PREFIX):
        return None
    from hub.core import registry as reg
    if not reg.enabled(store, MODULE):
        return 503, {"ok": False, "error": "模块已禁用（可在模块管理中启用）"}
    q = query or {}

    if path == PREFIX + "/sources" and method == "GET":
        return 200, {"ok": True, "sources": list_sources(store)}
    if path == PREFIX + "/sources" and method == "POST":
        return _r(add_source(store, body.get("name"), body.get("url"),
                             body.get("branch", "main"), body.get("subdir", ""),
                             body.get("auth_ref")))
    if path.startswith(PREFIX + "/sources/"):
        rest = path[len(PREFIX + "/sources/"):]
        sid, _, tail = rest.partition("/")
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            return 400, {"ok": False, "error": "非法 source id"}
        if tail == "pull" and method == "POST":
            return _r(pull_source(store, sid))
        if not tail and method == "PATCH":
            return _r(update_source(store, sid, body))
        if not tail and method == "DELETE":
            return _r(delete_source(store, sid))
    if path == PREFIX + "/catalog" and method == "GET":
        return 200, {"ok": True, "items": catalog_view(store)}
    if path == PREFIX + "/registry" and method == "GET":
        return 200, {"ok": True, "items": registry_view(store)}
    if path == PREFIX + "/registry/update" and method == "POST":
        names = body.get("names") or []
        if not names:
            return 400, {"ok": False, "error": "names 不能为空"}
        return 200, {"ok": True, "results": update_registry(
            store, names, body.get("source_id"), force=bool(body.get("force")))}
    if path == PREFIX + "/registry/rollback" and method == "POST":
        if not body.get("name"):
            return 400, {"ok": False, "error": "name 必填"}
        return _r(rollback_registry(store, body["name"]))
    if path.startswith(PREFIX + "/item/") and method == "GET":
        detail = item_detail(store, path[len(PREFIX + "/item/"):])
        if not detail:
            return 404, {"ok": False, "error": "本地库中不存在"}
        return 200, {"ok": True, **detail}
    if path == PREFIX + "/targets" and method == "GET":
        return 200, {"ok": True, "targets": list_targets(store)}
    if path == PREFIX + "/targets" and method == "POST":
        return _r(add_target(store, body.get("name"), body.get("kind"), body.get("tool"),
                             body.get("path"), body.get("format_key")))
    if path.startswith(PREFIX + "/targets/") and method == "DELETE":
        try:
            tid = int(path[len(PREFIX + "/targets/"):])
        except (TypeError, ValueError):
            return 400, {"ok": False, "error": "非法 target id"}
        return _r(delete_target(store, tid, force=bool(body.get("force"))))
    if path == PREFIX + "/targets/seed" and method == "POST":
        return 200, {"ok": True, "created": seed_defaults(store)}
    if path == PREFIX + "/distribute" and method == "POST":
        names = body.get("names") or []
        tids = body.get("target_ids") or []
        if not names or not tids:
            return 400, {"ok": False, "error": "names 与 target_ids 必填"}
        return 200, {"ok": True, "results": distribute_mcp(
            store, names, tids, dry_run=bool(body.get("dry_run")),
            force=bool(body.get("force")))}
    if path == PREFIX + "/verify" and method == "POST":
        name = body.get("name")
        if not name:
            return 400, {"ok": False, "error": "name 必填"}
        r = verify_item(store, name)
        r["ok"] = bool(r.get("ok"))
        return 200, r
    return 404, {"ok": False, "error": "mcp: 未知路由 %s %s" % (method, path)}


def _r(res):
    if res.get("ok"):
        return 200, res
    return 400, res
