"""一级模块：记忆分发线（工具记忆文件 ↔ hub 中间体）。

数据流：各工具记忆文件 →（能力探测+扫描）→ hub 中间体（登记表 + memstore 内容文件）
→（编辑 / 分发写回）→ 各工具记忆文件。
约定：
- 中间体是权威源；工具端自己改了记忆文件 → 扫描标记 drifted，绝不静默覆盖；
- 工具记忆路径采用探测制：布局表探不到的槽位即视为不可读 / 不可写，不报错不阻塞；
- 单工具扫描带时间预算（默认 3 秒），超时降级为「手动刷新」，不拖累其他工具；
- 写回前先备份目标文件，逐文件原子写；部署记录是漂移检测的基准。
"""
import json
import os
import time

from hub.core import fsutil, ops

MODULE = "memory"
PREFIX = "/api/memory"

SCAN_BUDGET_S = 3.0        # 单工具扫描时间预算（秒），超时降级手动刷新
MAX_FILE_BYTES = 2 * 1024 * 1024   # 单个记忆文件导入上限

KIND_LABELS = {
    "user_profile": "用户画像",
    "project_memory": "项目记忆",
    "topics": "topics",
}

# 各工具记忆布局（探测制候选位；探不到的槽位自动视为不可读/不可写）
LAYOUTS = {
    "trae-cn": {
        "global": "~/.trae-cn/memory/user_profile.md",
        "projects_dir": "~/.trae-cn/memory/projects",
        "project_file": "project_memory.md",
        "topics_file": "topics.md",
    },
    "claude": {"global": "~/.claude/CLAUDE.md"},
    "codex": {"global": "~/.codex/AGENTS.md"},
    "opencode": {"global": "~/.config/opencode/AGENTS.md"},
    "workbuddy": {"global": "~/.workbuddy/MEMORY.md"},
    "zcode": {"projects_dir": "~/.zcode/cli/memories/projects",
              "project_file": "memory/MEMORY.md"},
    # autoclaw / agents 无已知记忆路径（无布局条目）→ 路径为空，记忆页不显示
}


def _hub_dir():
    return os.environ.get("AGENT_HUB_DIR") or os.path.expanduser("~/.agent/hub")


def memstore_root():
    """中间体内容库：~/.agent/hub/memory/store/<scope>/<tool>__<kind>.md。"""
    return os.path.join(_hub_dir(), "memory", "store")


def _expand(p):
    return os.path.expanduser(str(p))


def _safe_scope(scope):
    """scope 清洗为安全的目录名（白名单字符，其余转 -）。"""
    s = "".join(ch if (ch.isalnum() or ch in "._@-") else "-" for ch in str(scope or "global"))
    s = s.strip("-.") or "global"
    return s[:120]


def memstore_path(item_row):
    return os.path.join(memstore_root(), _safe_scope(item_row["scope"]),
                        "%s__%s.md" % (item_row["source_tool"], item_row["kind"]))


# ============================================================ 能力探测
def _global_slots(tool_id):
    lay = LAYOUTS.get(tool_id) or {}
    g = lay.get("global")
    if not g:
        return []
    return [{"kind": "user_profile", "scope": "global", "path": _expand(g),
             "name": os.path.basename(g), "project": False}]


def _project_slots(tool_id, deadline):
    """项目级记忆槽位：扫描 projects 目录（超预算即止，返回 None 表示超时）。"""
    lay = LAYOUTS.get(tool_id) or {}
    pdir = lay.get("projects_dir")
    if not pdir:
        return []
    pdir = _expand(pdir)
    if not os.path.isdir(pdir):
        return []
    slots = []
    for slug in sorted(os.listdir(pdir)):
        if time.monotonic() > deadline:
            return None
        if slug.startswith("."):
            continue
        for key, kind in (("project_file", "project_memory"), ("topics_file", "topics")):
            rel = lay.get(key)
            if not rel:
                continue
            p = os.path.join(pdir, slug, rel)
            if os.path.isfile(p):
                slots.append({"kind": kind, "scope": slug, "path": p,
                              "name": os.path.basename(p), "project": True})
    return slots


def _slots_for_tool(tool_id, deadline):
    """某工具的全部可读候选槽位（global + projects）；超时返回 (None, True)。"""
    slots = _global_slots(tool_id)
    proj, timed_out = _project_slots(tool_id, deadline), False
    if proj is None:
        proj, timed_out = [], True
    return slots + proj, timed_out


def _probe_caps(tool_id):
    """探测工具读/写能力：readable=有可读文件；writable=有可写的槽位（父目录存在）。"""
    deadline = time.monotonic() + SCAN_BUDGET_S
    slots, _to = _slots_for_tool(tool_id, deadline)
    readable = any(os.path.isfile(s["path"]) for s in slots)
    writable = False
    lay = LAYOUTS.get(tool_id) or {}
    g = lay.get("global")
    if g and os.path.isdir(os.path.dirname(_expand(g))):
        writable = True
    if not writable and lay.get("projects_dir") and os.path.isdir(_expand(lay["projects_dir"])):
        writable = True
    return {"readable": readable, "writable": writable}


# ============================================================ 扫描采集
def _read_file(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) > MAX_FILE_BYTES:
        return None
    return data.decode("utf-8", "replace")


def _upsert_item(store, tool_id, slot, content):
    """扫描一个槽位 → 首次导入 / 漂移对账。返回 imported | unchanged | drifted。"""
    src_hash = fsutil.sha256_bytes(content.encode())
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM memory_items WHERE source_tool=? AND kind=? AND scope=?",
            (tool_id, slot["kind"], slot["scope"])).fetchone()
        if row is None:
            cur = store.db.execute(
                "INSERT INTO memory_items(source_tool, kind, scope, name, version, hash, "
                "prev_hash, last_source_hash, source_path, updated_at, status) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (tool_id, slot["kind"], slot["scope"], slot["name"], 1, src_hash, None,
                 src_hash, slot["path"], ops.now_iso(), "ok"))
            item_id = cur.lastrowid
            store.db.commit()
            fsutil.atomic_write_text(memstore_path({
                "scope": slot["scope"], "source_tool": tool_id, "kind": slot["kind"]}), content)
            ops.log_op(store, MODULE, "scan-import", "ok", item_kind=slot["kind"],
                       item_name=slot["name"], detail={"tool": tool_id, "scope": slot["scope"]})
            return "imported"
        row = dict(row)
        if row["last_source_hash"] == src_hash and row["hash"] == src_hash:
            return "unchanged"
        if row["last_source_hash"] != src_hash:
            # 工具端自己改了记忆文件 → 标记漂移，hub 内容不动（人工选边）
            store.db.execute(
                "UPDATE memory_items SET status='drifted', source_path=?, updated_at=? WHERE id=?",
                (slot["path"], ops.now_iso(), row["id"]))
            store.db.commit()
            ops.log_op(store, MODULE, "scan-drift", "warn", item_kind=slot["kind"],
                       item_name=slot["name"], detail={"tool": tool_id, "scope": slot["scope"]})
            return "drifted"
        return "unchanged"


def _reconcile_deployments(store, tool_id):
    """对账该工具的写回记录：目标文件被外部改动 → deployment 标 drifted。返回漂移条数。"""
    n = 0
    with store.lock:
        deps = [dict(r) for r in store.db.execute(
            "SELECT d.* FROM memory_deployments d JOIN memory_items i ON i.id=d.item_id "
            "WHERE d.tool=? AND d.status!='removed'", (tool_id,)).fetchall()]
    for dep in deps:
        cur = fsutil.sha256_file(dep["path"]) if os.path.isfile(dep["path"]) else None
        new_status = "ok" if cur == dep["deployed_hash"] else "drifted"
        if new_status != dep["status"]:
            with store.lock:
                store.db.execute("UPDATE memory_deployments SET status=? WHERE id=?",
                                 (new_status, dep["id"]))
                store.db.commit()
            if new_status == "drifted":
                n += 1
                ops.log_op(store, MODULE, "target-drift", "warn", detail={
                    "tool": tool_id, "item_id": dep["item_id"], "path": dep["path"]})
    return n


def _caps_config_key():
    return "memory_line.caps"


def _save_caps(store, tool_id, caps, degraded, error):
    with store.lock:
        raw = store.get_config(_caps_config_key())
        try:
            caps_all = json.loads(raw) if raw else {}
        except Exception:
            caps_all = {}
        caps_all[tool_id] = dict(caps, degraded=degraded, error=error, at=ops.now_iso())
        store.set_config(_caps_config_key(), json.dumps(caps_all, ensure_ascii=False))


def load_caps(store):
    raw = store.get_config(_caps_config_key())
    try:
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


def scan_tools(store, tool_ids=None):
    """扫描采集：逐工具探测槽位 → 导入/对账中间体 + 对账写回漂移。

    超预算的工具标记 degraded（前端显示手动刷新），不影响其余工具。"""
    from hub import tools_registry
    tools = [t for t in tools_registry.load_tools(store)
             if t.get("enabled", True) and (tool_ids is None or t["id"] in tool_ids)]
    results = []
    for t in tools:
        tid = t["id"]
        started = time.monotonic()
        deadline = started + SCAN_BUDGET_S
        r = {"tool": tid, "name": t["name"], "readable": False, "writable": False,
             "imported": 0, "unchanged": 0, "drifted": 0, "target_drift": 0,
             "degraded": False, "error": None, "elapsed_ms": 0}
        try:
            slots, timed_out = _slots_for_tool(tid, deadline)
            r["degraded"] = bool(timed_out)
            for s in slots:
                if not os.path.isfile(s["path"]):
                    continue
                content = _read_file(s["path"])
                if content is None:
                    continue
                r["readable"] = True
                st = _upsert_item(store, tid, s, content)
                if st == "imported":
                    r["imported"] += 1
                elif st == "drifted":
                    r["drifted"] += 1
                else:
                    r["unchanged"] += 1
                if time.monotonic() > deadline:
                    r["degraded"] = True
                    break
            if not r["degraded"]:
                r["target_drift"] = _reconcile_deployments(store, tid)
            caps = _probe_caps(tid)
            r["readable"], r["writable"] = caps["readable"], caps["writable"]
        except Exception as e:
            r["error"] = str(e)[:200]
        _save_caps(store, tid, {"readable": r["readable"], "writable": r["writable"]},
                   r["degraded"], r["error"])
        r["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        ops.log_op(store, MODULE, "scan", "ok" if not r["error"] else "failed",
                   detail={k: r[k] for k in ("tool", "imported", "unchanged", "drifted",
                                             "target_drift", "degraded", "elapsed_ms")})
        results.append(r)
    return results


# ============================================================ 中间体操作
def _get_item(store, item_id):
    with store.lock:
        row = store.db.execute("SELECT * FROM memory_items WHERE id=?", (item_id,)).fetchone()
    return dict(row) if row else None


def item_content(item_row):
    p = memstore_path(item_row)
    if not os.path.isfile(p):
        return None
    return _read_file(p)


def edit_item(store, item_id, content):
    """编辑中间体（hub 权威）：更新 memstore 文件 + hash/version；源文件不动。"""
    row = _get_item(store, item_id)
    if not row:
        return {"ok": False, "error": "条目不存在"}
    content = (content or "")
    if len(content.encode()) > MAX_FILE_BYTES:
        return {"ok": False, "error": "内容超过 2MB 上限"}
    new_hash = fsutil.sha256_bytes(content.encode())
    with store.lock:
        store.db.execute(
            "UPDATE memory_items SET hash=?, prev_hash=?, version=version+1, "
            "updated_at=?, status=CASE WHEN status='drifted' THEN 'drifted' ELSE 'ok' END "
            "WHERE id=?",
            (new_hash, row["hash"], ops.now_iso(), item_id))
        store.db.commit()
    fsutil.atomic_write_text(memstore_path(row), content)
    ops.log_op(store, MODULE, "edit", "ok", item_kind=row["kind"], item_name=row["name"],
               detail={"item_id": item_id, "hash": new_hash[:12]})
    return {"ok": True, "hash": new_hash[:12], "version": row["version"] + 1}


def adopt_source(store, item_id):
    """漂移条目「以此为准」：把工具端源文件内容重新导入 hub（人工选边动作之一）。"""
    row = _get_item(store, item_id)
    if not row:
        return {"ok": False, "error": "条目不存在"}
    src = row["source_path"]
    if not src or not os.path.isfile(src):
        return {"ok": False, "error": "源文件不存在：%s" % (src or "-")}
    content = _read_file(src)
    if content is None:
        return {"ok": False, "error": "源文件不可读或超限"}
    src_hash = fsutil.sha256_bytes(content.encode())
    with store.lock:
        store.db.execute(
            "UPDATE memory_items SET hash=?, prev_hash=?, version=version+1, "
            "last_source_hash=?, updated_at=?, status='ok' WHERE id=?",
            (src_hash, row["hash"], src_hash, ops.now_iso(), item_id))
        store.db.commit()
    fsutil.atomic_write_text(memstore_path(row), content)
    ops.log_op(store, MODULE, "adopt", "ok", item_kind=row["kind"], item_name=row["name"],
               detail={"item_id": item_id, "hash": src_hash[:12]})
    return {"ok": True, "hash": src_hash[:12]}


def _target_path(store, item_row, tool_id):
    """(item, 目标工具) → 写回路径；映射不到返回 None（不可写去向）。"""
    lay = LAYOUTS.get(tool_id) or {}
    kind, scope = item_row["kind"], item_row["scope"]
    if scope == "global":
        return _expand(lay["global"]) if lay.get("global") else None
    # 项目级条目：项目 slug 只在源工具体系内有意义 → 仅支持写回源工具（自愈/回写）
    if tool_id != item_row["source_tool"] or not lay.get("projects_dir"):
        return None
    rel = lay.get("project_file" if kind == "project_memory" else "topics_file")
    if kind not in ("project_memory", "topics") or not rel:
        return None
    if scope.startswith("/") or scope.endswith("/") or "/../" in scope:
        return None
    # scope 即扫描时的真实项目目录名（不可再清洗，否则对不上路径）
    return os.path.join(_expand(lay["projects_dir"]), scope, rel)


def distribute(store, item_ids, tool_ids, force=False):
    """中间体 → 目标工具记忆文件。冲突（目标被外部改动 / 未托管内容）不覆盖，force 才写。"""
    results = []
    for iid in item_ids:
        row = _get_item(store, iid)
        if not row:
            results.append({"item_id": iid, "status": "failed", "reason": "条目不存在"})
            continue
        content = item_content(row)
        if content is None:
            results.append({"item_id": iid, "item": row["name"], "status": "failed",
                            "reason": "中间体内容缺失"})
            continue
        item_hash = fsutil.sha256_bytes(content.encode())
        for tid in tool_ids:
            base = {"item_id": iid, "item": row["name"], "kind": row["kind"],
                    "scope": row["scope"], "tool": tid}
            tpath = _target_path(store, row, tid)
            if not tpath:
                results.append(dict(base, status="failed",
                                    reason="该工具没有对应的记忆写入位"))
                continue
            parent = os.path.dirname(tpath)
            if not os.path.isdir(parent):
                results.append(dict(base, status="failed",
                                    reason="目标目录不存在：%s" % parent))
                continue
            cur_hash = fsutil.sha256_file(tpath) if os.path.isfile(tpath) else None
            with store.lock:
                dep = store.db.execute(
                    "SELECT * FROM memory_deployments WHERE item_id=? AND tool=?",
                    (iid, tid)).fetchone()
                dep = dict(dep) if dep else None
            if cur_hash == item_hash:
                # 已是目标内容 → 幂等对齐部署记录
                _record_deployment(store, iid, tid, tpath, item_hash)
                results.append(dict(base, status="skipped", reason="已是最新"))
                continue
            conflict = None
            if dep and dep["deployed_hash"] and cur_hash != dep["deployed_hash"]:
                conflict = "目标文件在上次写回后被改动"
            elif not dep and cur_hash is not None:
                conflict = "目标位置已存在未托管内容"
            if conflict and not force:
                results.append(dict(base, status="conflict", reason=conflict))
                ops.log_op(store, MODULE, "distribute", "conflict",
                           item_kind=row["kind"], item_name=row["name"],
                           detail=dict(base, reason=conflict))
                continue
            try:
                fsutil.backup_file(tpath) if cur_hash else None
                fsutil.atomic_write_text(tpath, content)
                _record_deployment(store, iid, tid, tpath, item_hash)
                results.append(dict(base, status="ok", path=tpath))
                ops.log_op(store, MODULE, "distribute", "ok", item_kind=row["kind"],
                           item_name=row["name"],
                           detail=dict(base, path=tpath, force=bool(force)))
            except Exception as e:
                results.append(dict(base, status="failed", reason=str(e)[:200]))
                ops.log_op(store, MODULE, "distribute", "failed",
                           item_kind=row["kind"], item_name=row["name"],
                           detail=dict(base, reason=str(e)[:200]))
    return results


def _record_deployment(store, item_id, tool_id, path, item_hash):
    with store.lock:
        store.db.execute(
            "INSERT INTO memory_deployments(item_id, tool, path, deployed_hash, deployed_at, status) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(item_id, tool) DO UPDATE SET "
            "path=excluded.path, deployed_hash=excluded.deployed_hash, "
            "deployed_at=excluded.deployed_at, status='ok'",
            (item_id, tool_id, path, item_hash, ops.now_iso(), "ok"))
        store.db.commit()


# ============================================================ 视图
def overview(store):
    """总览：工具能力（探测缓存）+ 中间条目 + 逐目标部署状态（供记忆页左右栏）。"""
    from hub import tools_registry
    caps = load_caps(store)
    tools = []
    for t in tools_registry.load_tools(store):
        if not t.get("enabled", True):
            continue
        if not LAYOUTS.get(t["id"]):
            continue  # 无记忆路径布局的工具（路径为空）不在记忆页显示
        c = caps.get(t["id"]) or {}
        tools.append({
            "id": t["id"], "name": t["name"], "color": int(t.get("color") or 0),
            "readable": bool(c.get("readable")), "writable": bool(c.get("writable")),
            "degraded": bool(c.get("degraded")), "error": c.get("error"),
            "has_layout": bool(LAYOUTS.get(t["id"])),
            "scanned": bool(c.get("at")),
        })
    with store.lock:
        items = [dict(r) for r in store.db.execute(
            "SELECT * FROM memory_items ORDER BY source_tool, kind, scope").fetchall()]
        deps = [dict(r) for r in store.db.execute(
            "SELECT * FROM memory_deployments WHERE status!='removed'").fetchall()]
    dep_map = {}
    for d in deps:
        dep_map.setdefault(d["item_id"], []).append({
            "tool": d["tool"], "path": d["path"], "status": d["status"],
            "deployed_at": d["deployed_at"]})
    out = []
    for it in items:
        it["kind_label"] = KIND_LABELS.get(it["kind"], it["kind"])
        it["deployments"] = dep_map.get(it["id"], [])
        out.append(it)
    return {"tools": tools, "items": out, "memstore": memstore_root()}


# ============================================================ HTTP routes
def handle(store, method, path, query, body):
    """模块路由（server.py 分发）。只拦截自有子路由，其余放行（legacy 记忆笔记路由）。"""
    if not path.startswith(PREFIX + "/"):
        return None
    if not _is_own_route(path, method):
        return None  # /api/memory/search|export|add|delete 等由 server 承载
    if not ops_module_enabled(store):
        return 503, {"ok": False, "error": "记忆模块已禁用（可在设置中启用）"}

    if path == "/api/memory/overview" and method == "GET":
        return 200, {"ok": True, **overview(store)}
    if path == "/api/memory/scan" and method == "POST":
        tool = body.get("tool")
        ids = [tool] if tool else None
        return 200, {"ok": True, "results": scan_tools(store, ids)}
    if path == "/api/memory/distribute" and method == "POST":
        item_ids = [int(x) for x in (body.get("item_ids") or [])]
        tool_ids = body.get("tools") or []
        if not item_ids or not tool_ids:
            return 400, {"ok": False, "error": "item_ids 与 tools 必填"}
        return 200, {"ok": True,
                     "results": distribute(store, item_ids, tool_ids,
                                           force=bool(body.get("force")))}
    if path.startswith("/api/memory/item/"):
        rest = path[len("/api/memory/item/"):]
        iid, _, tail = rest.partition("/")
        try:
            iid = int(iid)
        except ValueError:
            return 400, {"ok": False, "error": "非法条目 id"}
        if not tail and method == "GET":
            row = _get_item(store, iid)
            if not row:
                return 404, {"ok": False, "error": "条目不存在"}
            content = item_content(row) or ""
            src = row.get("source_path") or ""
            src_hash = fsutil.sha256_file(src) if (src and os.path.isfile(src)) else None
            return 200, {"ok": True, **row, "content": content,
                         "source_changed": bool(src_hash and src_hash != row["last_source_hash"]),
                         "source_hash": src_hash}
        if not tail and method == "PUT":
            return _r(edit_item(store, iid, body.get("content")))
        if tail == "adopt" and method == "POST":
            return _r(adopt_source(store, iid))
    return 404, {"ok": False, "error": "memory: 未知路由 %s %s" % (method, path)}


_OWN_ROUTES = {"/api/memory/overview", "/api/memory/scan", "/api/memory/distribute"}


def _is_own_route(path, method):
    """本模块自有路由判定；/api/memory/item/<id> 的 GET/PUT 与 adopt 也归本模块。"""
    if path in _OWN_ROUTES:
        return True
    if path.startswith("/api/memory/item/"):
        rest = path[len("/api/memory/item/"):]
        if "/" not in rest and method in ("GET", "PUT"):
            return True
        if rest.endswith("/adopt") and method == "POST":
            return True
    return False


def ops_module_enabled(store):
    from hub.core import registry
    return registry.enabled(store, MODULE)


def _r(res):
    return (200, res) if res.get("ok") else (400, res)
