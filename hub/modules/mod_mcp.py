"""一级模块：MCP 管理分发。

- 源/拉取/本地库与 skills 对称；
- 分发适配两种目标格式：mcp_json（键路径合并）与 mcp_toml（受管块标记替换）；
- 内置协议握手验证（stdio/http）；
- 冲突语义：非托管同名条目 / 托管后被外部改 → 停手（force 才覆盖，且先备份）。
"""
import json
import os
import re
import shutil
import time

from hub import paths
from hub.core import fsutil, ops, remote_repos, local_dirs
from hub.lib import catalog, gitsrc, mcpverify

MODULE = "mcp"
KIND = "mcp"
PREFIX = "/api/mcp"
BLOCK_OPEN = "# >>> hub:managed: %s >>>"
BLOCK_CLOSE = "# <<< hub:managed: %s <<<"


def _hub_dir():
    return paths.hub_dir()


def _source_cache(store, source_id):
    """按来源记录取缓存目录（与拉取时同一套命名）。"""
    with store.lock:
        row = store.db.execute("SELECT url, branch, subdir FROM sources WHERE id=?",
                               (source_id,)).fetchone()
    if not row:
        return None
    return paths.source_cache_dir(KIND, row["url"], row["branch"], row["subdir"])


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
    remote_repos.link_source(store, KIND, sid)      # 同步到 设置 → 远程仓库
    ops.log_op(store, MODULE, "source:add", "ok", source_id=sid, item_name=name)
    return {"ok": True, "id": sid}


def list_sources(store):
    with store.lock:
        rows = store.db.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS item_count, "
            "(SELECT COUNT(*) FROM registry_items r WHERE r.kind='" + KIND + "' AND r.source_id=s.id) AS registry_count "
            "FROM sources s WHERE s.kind=? ORDER BY s.id", (KIND,)).fetchall()
    return [dict(r) for r in rows]


def update_source(store, source_id, fields):
    allowed = ("enabled", "branch", "subdir", "auth_ref", "poll_min", "name", "url")
    payload = {k: v for k, v in (fields or {}).items() if k in allowed}
    if not payload:
        return {"ok": False, "error": "无更新字段"}
    # 共享字段同步主表与另一模块的同仓库记录；重名/重址冲突在这里拦下
    err = remote_repos.update_from_source(store, KIND, source_id, payload)
    if err:
        return {"ok": False, "error": err}
    ops.log_op(store, MODULE, "source:update", "ok", source_id=source_id, detail=payload)
    return {"ok": True}


def delete_source(store, source_id):
    """移除源：删 items/源记录 + git 缓存目录；registry 与已写入配置不动。"""
    with store.lock:
        src = store.db.execute("SELECT name, url, branch, subdir, repo_id FROM sources "
                               "WHERE id=? AND kind=?", (source_id, KIND)).fetchone()
        store.db.execute("DELETE FROM items WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM sources WHERE id=? AND kind=?", (source_id, KIND))
        store.db.commit()
    if src:
        import shutil as _sh
        cache = paths.source_cache_dir(KIND, src["url"], src["branch"], src["subdir"])
        if os.path.isdir(cache):
            _sh.rmtree(cache, ignore_errors=True)
        remote_repos.prune_repo(store, src["repo_id"])   # 没有模块再用它 → 设置页也移除
    ops.log_op(store, MODULE, "source:delete", "ok", source_id=source_id,
               item_name=src["name"] if src else None)
    return {"ok": True}


def pull_source(store, source_id, removed_action=None):
    """fetch + 差分。返回 {ok, commit, added, changed, removed, error}。

    removed 非空时：removed_action=None → needs_action（不应用同步，交 UI 询问）；
    "delete" → 清 registry 配置与行；"localize" → 脱离源转为手动条目。"""
    with store.lock:
        src = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?",
                               (source_id, KIND)).fetchone()
    if not src:
        return {"ok": False, "error": "源不存在"}
    src = dict(src)
    cache = paths.source_cache_dir(KIND, src["url"], src["branch"], src["subdir"])
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
        removed = [nm for nm in old if nm not in {i["name"] for i in items}]
        if removed and not removed_action:
            detail = []
            for nm in removed:
                reg = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                       (KIND, nm)).fetchone()
                dep = store.db.execute(
                    "SELECT COUNT(*) c FROM deployments WHERE item_kind='mcp' AND item_name=? AND status='ok'",
                    (nm,)).fetchone()["c"]
                detail.append({"name": nm, "in_registry": bool(reg), "deployed_count": dep})
            store.db.commit()
            return {"ok": True, "needs_action": True, "commit": commit,
                    "added": added, "changed": changed, "removed": removed,
                    "removed_detail": detail}
        for it in items:
            store.db.execute(
                "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) "
                "VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(source_id, name) DO UPDATE SET path=excluded.path, "
                "source_hash=excluded.source_hash, version=excluded.version, meta=excluded.meta",
                (source_id, KIND, it["name"], it["path"], it["source_hash"], commit,
                 json.dumps(it["config"], ensure_ascii=False)))
        for nm in removed:
            if removed_action == "localize":
                with store.lock:
                    store.db.execute(
                        "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL "
                        "WHERE kind=? AND name=?", (KIND, nm))
            else:
                if os.path.exists(_reg_path(nm)):
                    vroot = versions_root(nm)
                    os.makedirs(vroot, exist_ok=True)
                    os.rename(_reg_path(nm), os.path.join(
                        vroot, time.strftime("%Y%m%d-%H%M%S") + "-source-deleted"))
                store.db.execute("DELETE FROM registry_items WHERE kind=? AND name=?", (KIND, nm))
            store.db.execute("DELETE FROM items WHERE source_id=? AND name=?", (source_id, nm))
        store.db.execute("UPDATE sources SET last_sync_at=?, last_commit=?, last_error=NULL, "
                         "branch=COALESCE(?, branch) WHERE id=?",
                         (ops.now_iso(), commit, resolved_branch, source_id))
        store.db.commit()
    ops.log_op(store, MODULE, "pull", "ok", source_id=source_id, item_version=commit,
               detail={"added": added, "changed": changed, "removed": removed,
                       "removed_action": removed_action})
    return {"ok": True, "commit": commit, "added": added, "changed": changed, "removed": removed,
            "removed_action": removed_action}


def _mark_error(store, source_id, msg):
    with store.lock:
        store.db.execute("UPDATE sources SET last_error=? WHERE id=?", (msg, source_id))
        store.db.commit()


# ============================================================ manual items
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _normalize_config(cfg, name=None):
    """手动创建的 config 走与拉取一致的归一化白名单。

    name 优先取接口显式传入值（前端表单把名字放外层 {name, config}），
    其次取 config 内嵌 name，都没有才兜底 "_"——否则名字丢失会让
    registry 文件写入 name:"_" 并污染写入工具的配置。
    """
    if not isinstance(cfg, dict):
        return None
    inner = cfg.pop("name", None)
    return catalog._normalize_mcp_entry((name or "").strip() or inner or "_", cfg)


def _name_conflict(store, name, root=None):
    if not _NAME_RE.match(name or ""):
        return "名称非法（字母数字开头，允许 . _ -，≤64 字符）"
    with store.lock:
        src_row = store.db.execute(
            "SELECT s.name FROM items i JOIN sources s ON s.id=i.source_id "
            "WHERE i.kind=? AND i.name=? LIMIT 1", (KIND, name)).fetchone()
        reg = store.db.execute("SELECT source_id FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
    if src_row:
        return "已存在同名条目（来自源仓库 %s）；重名会被拦截" % src_row["name"]
    if reg:
        return "已存在同名条目（%s）" % ("本地" if reg["source_id"] is None else "远程")
    if os.path.exists(os.path.join(root or registry_root(), name + ".json")):
        return "已存在同名配置文件"
    return None


def _manual_reg(store, name):
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM registry_items WHERE kind=? AND name=? AND source_id IS NULL",
            (KIND, name)).fetchone()
    return dict(row) if row else None


def _write_manual(store, name, cfg, action, dir_id=None):
    # 显式 dir_id 优先；未指定但条目已登记在目录 → 保持原目录（编辑语义）；否则默认库
    if dir_id:
        d = local_dirs.get_dir(store, dir_id)
        if not d:
            return {"ok": False, "error": "本地目录不存在（id=%s）" % dir_id}
        root = _container_root(d, KIND)   # 容器目录：写进其 mcp 集合文件夹
    elif _manual_reg(store, name):
        root = _item_root(store, name)
    else:
        root = registry_root()
    os.makedirs(root, exist_ok=True)
    dest = _reg_path(name, root=root)
    if os.path.exists(dest):
        vroot = versions_root(name)
        os.makedirs(vroot, exist_ok=True)
        os.rename(dest, os.path.join(vroot, time.strftime("%Y%m%d-%H%M%S")))
    fsutil.write_json_atomic(dest, cfg)
    new_hash = fsutil.sha256_file(dest)
    with store.lock:
        prev = store.db.execute("SELECT version, hash FROM registry_items WHERE kind=? AND name=?",
                                (KIND, name)).fetchone()
        store.db.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
            "prev_version, prev_hash, source_hash_at, dir_id) VALUES(?,?,NULL,?,?,?,?,?,NULL,?) "
            "ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, "
            "updated_at=excluded.updated_at, prev_version=excluded.prev_version, "
            "prev_hash=excluded.prev_hash, source_hash_at=NULL, dir_id=excluded.dir_id",
            (KIND, name, "v2", new_hash, ops.now_iso(),
             prev["version"] if prev else None, prev["hash"] if prev else None,
             dir_id or None))
        store.db.commit()
    ops.log_op(store, MODULE, action, "ok", item_kind="mcp", item_name=name,
               detail={"transport": cfg.get("type"), "hash": new_hash[:12], "dir": root})
    return {"ok": True, "name": name, "hash": new_hash[:12]}


def create_manual(store, name, config=None, dir_id=None):
    name = (name or "").strip()
    cfg = _normalize_config(dict(config or {}), name=name)
    if cfg is None:
        return {"ok": False, "error": "config 非法：需要 command 或 url（键白名单：command/args/env/url/headers/type/transport/cwd）"}
    if dir_id:
        d = local_dirs.get_dir(store, dir_id)
        if not d:
            return {"ok": False, "error": "本地目录不存在（id=%s）" % dir_id}
        err = _name_conflict(store, name, root=d["path"])
    else:
        err = _name_conflict(store, name)
    if err:
        return {"ok": False, "error": err}
    return _write_manual(store, name, cfg, "create", dir_id=dir_id)


def update_manual(store, name, config=None):
    name = (name or "").strip()
    if not _manual_reg(store, name):
        return {"ok": False, "error": "只支持编辑本地手动条目（该条目来自远程源，请用「更新到本地」）"}
    cfg = _normalize_config(dict(config or {}), name=name)
    if cfg is None:
        return {"ok": False, "error": "config 非法：需要 command 或 url"}
    return _write_manual(store, name, cfg, "edit")


def delete_manual(store, name, force=False):
    reg = _manual_reg(store, name)
    if not reg:
        with store.lock:
            remote = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                      (KIND, name)).fetchone()
        return {"ok": False, "error": "远程条目不能在此删除（用「移除源」）" if remote
                else "条目不存在"}
    with store.lock:
        deps = [dict(r) for r in store.db.execute(
            "SELECT * FROM deployments WHERE item_kind='mcp' AND item_name=? AND status='ok'",
            (name,)).fetchall()]
    if deps and not force:
        return {"ok": False, "error": "已写入 %d 个目标配置；确认后连同写入内容一起移除" % len(deps)}
    removed_targets = []
    for dep in deps:
        t = store.db.execute("SELECT * FROM targets WHERE id=?", (dep["target_id"],)).fetchone()
        if not t:
            continue
        t = dict(t)
        path = os.path.expanduser(t["path"])
        try:
            if t["kind"] == "mcp_json":
                data = fsutil.read_json(path)
                if isinstance(data, dict):
                    d = json.loads(dep["detail"]) if dep["detail"] else {}
                    fmt_key = d.get("format_key") or "mcpServers"
                    section = _section_get(data, fmt_key)
                    if name in section:
                        if d.get("injected") is None or section[name] == d.get("injected"):
                            del section[name]
                            fsutil.write_json_atomic(path, data)
                            removed_targets.append(t["name"])
            else:
                text = ""
                if os.path.exists(path):
                    text = open(path, encoding="utf-8", errors="replace").read()
                block = _find_toml_block(text, name)
                if block:
                    text = text[:block.start()] + text[block.end():]
                    fsutil.atomic_write_text(path, text)
                    removed_targets.append(t["name"])
        except Exception:
            continue
    reg_file = _reg_path(name, root=_item_root(store, name))
    if os.path.exists(reg_file):
        vroot = versions_root(name)
        os.makedirs(vroot, exist_ok=True)
        os.rename(reg_file, os.path.join(vroot, time.strftime("%Y%m%d-%H%M%S") + "-deleted"))
    with store.lock:
        store.db.execute("DELETE FROM deployments WHERE item_kind='mcp' AND item_name=?", (name,))
        store.db.execute("DELETE FROM registry_items WHERE kind=? AND name=?", (KIND, name))
        store.db.commit()
    ops.log_op(store, MODULE, "delete", "ok", item_kind="mcp", item_name=name,
               detail={"removed_from_targets": removed_targets})
    return {"ok": True, "name": name, "removed_from_targets": removed_targets}


# ============================================================ registry
# ============================================================ 工具来源（反向提取）
def _mcp_tools(store):
    """启用了 mcp_config 且格式已知的工具清单（工具来源的扫描范围）。"""
    from hub import tools_registry
    return [t for t in tools_registry.load_tools(store)
            if t.get("enabled") and t.get("mcp_config") and t.get("mcp_format")]


def _read_tool_servers(tool):
    """读工具 mcp_config 解析出 {server_name: cfg}；文件缺失/解析失败返回空表。"""
    path = os.path.expanduser(tool["mcp_config"])
    if not os.path.isfile(path):
        return {}
    try:
        if path.endswith(".toml"):
            import tomllib
            with open(path, "rb") as f:
                data = tomllib.load(f)
        else:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        sec = _section_get(data, tool.get("mcp_format")) or {}
        return {k: v for k, v in sec.items() if isinstance(v, dict)}
    except Exception:
        return {}


def _reg_cfg(store, name):
    """本地库条目的可比较形态（去内嵌 name）；不存在返回 None。"""
    cur = fsutil.read_json(_reg_path(name, root=_item_root(store, name)))
    if cur is None:
        return None
    cur.pop("name", None)
    return cur


def tool_items(store, tool_id=None):
    """扫描各启用工具的 MCP 配置并与本地库对齐，条目名做键分三态。

    synced=归一化后与本地库一致 / diff=同名不同内容 / local_only=未收编。
    tool_id 缺省聚合全部工具，同一条目跨工具按 name 聚合（tools 列出出现它的工具）。
    """
    tools = _mcp_tools(store)
    if tool_id:
        tools = [t for t in tools if t["id"] == tool_id]
    reg_names = {r["name"] for r in store.db.execute(
        "SELECT name FROM registry_items WHERE kind=?", (KIND,)).fetchall()}
    agg = {}
    for t in tools:
        meta = {"id": t["id"], "name": t["name"]}
        for name, raw in sorted(_read_tool_servers(t).items()):
            cur = agg.get(name)
            if cur is None:
                cur = {"name": name, "state": "synced" if name in reg_names else "local_only",
                       "tools": []}
                agg[name] = cur
            if name not in reg_names:
                cur["state"] = "local_only"
            else:
                cfg = _normalize_config(dict(raw), name=name)
                cfg.pop("name", None) if cfg else None
                if cfg is None or cfg != _reg_cfg(store, name):
                    cur["state"] = "diff"
            cur["tools"].append(meta)
    order = {"local_only": 0, "diff": 1, "synced": 2}
    return {"ok": True,
            "items": sorted(agg.values(), key=lambda x: (order[x["state"]], x["name"]))}


def extract(store, tool_id, names):
    """把工具 MCP 配置中指定 server 收编进本地库。

    local_only 新建；synced 跳过；diff 仅当本地条目是手动条目时以工具为准
    覆盖（远程源条目提示走源更新，避免覆盖后被下次拉取冲掉）。工具配置文件
    保留不动。逐条返回结果。
    """
    tools = [t for t in _mcp_tools(store) if t["id"] == tool_id]
    if not tools:
        return {"ok": False, "error": "工具不存在、未启用或没有已知 MCP 配置格式"}
    servers = _read_tool_servers(tools[0])
    out = []
    for raw_name in names or []:
        name = str(raw_name).strip()
        raw = servers.get(name)
        if not isinstance(raw, dict):
            out.append({"name": name, "ok": False, "error": "工具配置中不存在该条目"})
            continue
        cfg = _normalize_config(dict(raw), name=name)
        if cfg is None:
            out.append({"name": name, "ok": False, "error": "配置非法：缺 command 或 url"})
            continue
        cur = _reg_cfg(store, name)
        if cur is not None:
            if cur == cfg:
                out.append({"name": name, "ok": True, "skipped": "已与本地库一致"})
                continue
            if not _manual_reg(store, name):
                out.append({"name": name, "ok": False,
                            "error": "本地条目来自远程源，请通过源更新而不是提取覆盖"})
                continue
        r = _write_manual(store, name, cfg, "提取自工具覆盖" if cur is not None else "提取自工具")
        r.update({"name": name})
        out.append(r)
    store.log("mcp.extract", {"tool": tool_id, "names": names, "results": out})
    return {"ok": True, "items": out}


def sync_to_targets(store, tool_id, names, target_ids):
    """把一个工具 MCP 配置中的 server 一键同步到其它工具（同名覆盖）。

    复用「提取 + 写入」同一条资产管线：先以工具内实际配置为准收编进本地库，
    再以 force 写到所选目标（同名 server 先备份配置后覆盖）。
    源工具自己的目标会被剔除；返回 {ok, extracted, results}。
    """
    if not tool_id:
        return {"ok": False, "error": "tool 必填"}
    names = [str(n).strip() for n in (names or []) if str(n).strip()]
    ids = []
    for x in (target_ids or []):
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            continue
    if not names or not ids:
        return {"ok": False, "error": "names 与 target_ids 必填"}
    with store.lock:
        own = {r["id"] for r in store.db.execute(
            "SELECT id FROM targets WHERE tool=? AND kind IN ('mcp_json','mcp_toml')",
            (tool_id,)).fetchall()}
        valid = {r["id"] for r in store.db.execute(
            "SELECT id FROM targets WHERE kind IN ('mcp_json','mcp_toml')").fetchall()}
    tids = [t for t in ids if t in valid and t not in own]
    if not tids:
        return {"ok": False, "error": "没有可用的目标工具（源工具自身不作为目标）"}
    ex = extract(store, tool_id, names)
    if not ex.get("ok"):
        return ex
    extracted = ex.get("items") or []
    outgoing = [x["name"] for x in extracted if x.get("ok")]
    results = distribute_mcp(store, outgoing, tids, force=True) if outgoing else []
    ops.log_op(store, MODULE, "tool-sync", "ok", item_kind="mcp",
               detail={"tool": tool_id, "names": outgoing, "target_ids": tids})
    return {"ok": True, "extracted": extracted, "results": results}


def _config_of(item_row):
    return json.loads(item_row["meta"]) if item_row["meta"] else {}


def _container_root(d, kind):
    """目录的写入根：容器目录（layout 有该 kind 的子文件夹）→ 第一个集合子文件夹；
    普通目录 → 目录自身。避免写进容器根后扫描发现不到。"""
    try:
        layout = json.loads(d.get("layout") or "null") or {}
    except Exception:
        layout = {}
    subs = layout.get(kind) or []
    if subs:
        return os.path.join(d["path"], subs[0].replace("/", os.sep))
    return d["path"]


def _item_root(store, name):
    """手动条目的落盘根：登记在本地目录（local_dirs）→ 该目录（再拼集合子文件夹）；
    否则默认库 registry/mcp。"""
    with store.lock:
        row = store.db.execute(
            "SELECT d.path AS p, r.sub_path AS sub FROM registry_items r "
            "JOIN local_dirs d ON d.id=r.dir_id WHERE r.kind=? AND r.name=?",
            (KIND, name)).fetchone()
    if row and row["p"]:
        sub = (row["sub"] or "").replace("/", os.sep)
        return os.path.join(row["p"], sub) if sub else row["p"]
    return registry_root()


def _dir_root(store, dir_id):
    """新建指定的目标目录根；dir_id 为空 → 默认库。非法目录返回 (None, 错误)。"""
    if not dir_id:
        return registry_root(), None
    d = local_dirs.get_dir(store, dir_id)
    if not d:
        return None, "本地目录不存在（id=%s）" % dir_id
    return d["path"], None


def _reg_path(name, root=None):
    return os.path.join(root or registry_root(), name + ".json")


def _reg_hash(store, name):
    p = _reg_path(name, root=_item_root(store, name))
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
            cur_hash = _reg_hash(store, name)
            if reg and cur_hash and reg["hash"] and cur_hash != reg["hash"] and not force:
                results.append({"item": name, "status": "conflict-local-modified",
                                "reason": "本地库中该条目已被修改（force 覆盖）"})
                ops.log_op(store, MODULE, "update", "conflict", item_kind="mcp",
                           item_name=name, reason="local-modified")
                continue
            if reg and reg.get("source_hash_at") == row["source_hash"] and cur_hash == reg["hash"]:
                results.append({"item": name, "status": "unchanged", "version": reg["version"]})
                continue
            # materialize：登记在本地目录的条目写回其目录（容器目录进集合子文件夹），
            # 否则 registry/mcp/<name>.json（+ 旧版快照）。
            # 此前固定写 registry_root：链接目录条目 force 更新会写错位置、之后永远 stale。
            cfg = _config_of(row)
            root = _item_root(store, name) if (reg and reg.get("dir_id")) else registry_root()
            os.makedirs(root, exist_ok=True)
            dest = _reg_path(name, root=root)
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
    dest = _reg_path(name, root=_item_root(store, name))
    if os.path.exists(dest):
        # 同秒多次回退 → -n 后缀去碰撞（shutil.move 落到已存在目录会静默嵌套，必须显式避开）
        stamp = time.strftime("%Y%m%d-%H%M%S") + "-pre-rollback"
        target_snap = os.path.join(vroot, stamp)
        n = 1
        while os.path.exists(target_snap):
            target_snap = os.path.join(vroot, "%s.%d" % (stamp, n))
            n += 1
        shutil.move(dest, target_snap)
    shutil.move(latest, dest)            # 链接目录可能在另一卷：move 自带跨设备兜底
    new_hash = fsutil.sha256_file(dest)
    new_version = None
    with store.lock:
        row = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
        if row:
            row = dict(row)
            new_version = row["prev_version"] or row["version"]
            store.db.execute(
                "UPDATE registry_items SET version=?, hash=?, updated_at=?, "
                "prev_version=?, prev_hash=? WHERE kind=? AND name=?",
                (new_version, new_hash, ops.now_iso(),
                 row["version"], row["hash"], KIND, name))
            store.db.commit()
    ops.log_op(store, MODULE, "rollback", "ok", item_kind="mcp", item_name=name,
               item_version=new_version, detail={"restored_from": snaps[-1]})
    return {"ok": True, "hash": new_hash[:12], "version": new_version,
            "restored_from": snaps[-1]}


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
        ("WorkBuddy (全局)", "mcp_json", "workbuddy", os.path.join(home, ".workbuddy", "mcp.json"), "mcpServers"),
        ("ZCode (全局)", "mcp_json", "zcode", os.path.join(home, ".zcode", "cli", "config.json"), "mcp.servers"),
        ("AutoClaw (全局)", "mcp_json", "autoclaw", os.path.join(home, ".openclaw-autoclaw", "openclaw.json"), "mcp.servers"),
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


def _key_path(fmt_key):
    """format_key 支持点号嵌套：'mcpServers' → 单层；'mcp.servers' → 两层。

    ZCode / AutoClaw 的 MCP 配置是 {"mcp":{"servers":{...}}} 结构。
    """
    return [s for s in str(fmt_key or "mcpServers").split(".") if s]


def _section_get(data, fmt_key):
    """按键路径取子对象；途中任一层缺失或非对象则返回 {}。"""
    cur = data if isinstance(data, dict) else {}
    for k in _key_path(fmt_key):
        cur = cur.get(k)
        if not isinstance(cur, dict):
            return {}
    return cur


def _section_put(data, fmt_key, name, cfg):
    """按键路径逐层建对象后写入条目（原地修改 data）。"""
    cur = data
    for k in _key_path(fmt_key):
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[name] = cfg


def _plan_mcp_json(store, name, target, force=False):
    cfg = fsutil.read_json(_reg_path(name, root=_item_root(store, name)))
    if cfg is None:
        return {"status": "failed", "reason": "本地库中不存在该条目"}
    # server 名由 mcpServers 下的 key 表达，内嵌 name 字段是冗余 → 写入前剔除
    cfg.pop("name", None)
    path = os.path.expanduser(target["path"])
    fmt_key = target["format_key"] or "mcpServers"
    data = fsutil.read_json(path) if os.path.exists(path) else {}
    if data is None:
        return {"status": "failed", "reason": "目标文件不是合法 JSON：%s" % path}
    section = _section_get(data or {}, fmt_key)
    existing = section.get(name)
    dep = _deployment(store, name, target["id"])
    injected = None
    if dep and dep["detail"]:
        try:
            injected = json.loads(dep["detail"]).get("injected")
        except Exception:
            injected = None
    if existing == cfg and not force:
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
    _section_put(data, fmt_key, name, cfg)
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
    cfg = fsutil.read_json(_reg_path(name, root=_item_root(store, name)))
    if cfg is None:
        return {"status": "failed", "reason": "本地库中不存在该条目"}
    path = os.path.expanduser(target["path"])
    text = ""
    if os.path.exists(path):
        text = open(path, encoding="utf-8", errors="replace").read()
    block = _find_toml_block(text, name)
    new_block = _toml_block(name, cfg)
    if block and block.group(0) == new_block and not force:
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
        # 防穿越门禁：name 直接参与 _reg_path 拼接
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", str(name) or ""):
            results.append({"item": name, "target": None, "target_id": None,
                            "status": "failed", "reason": "非法条目名", "dry_run": dry_run})
            continue
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
        items = []
        if not source_id:
            for r in store.db.execute(
                    "SELECT r.*, d.name AS dir_name FROM registry_items r "
                    "LEFT JOIN local_dirs d ON d.id=r.dir_id "
                    "WHERE r.kind=? AND r.source_id IS NULL ORDER BY r.name",
                    (KIND,)).fetchall():
                items.append({"name": r["name"], "version": r["version"], "path": None,
                              "source_hash": None, "meta": None, "source_name": "本地",
                              "dir_id": r["dir_id"], "dir_name": r["dir_name"]})
        if source_id:
            rows = store.db.execute(
                "SELECT i.*, s.name AS source_name FROM items i JOIN sources s ON s.id=i.source_id "
                "WHERE i.kind=? AND i.source_id=? ORDER BY i.name", (KIND, source_id)).fetchall()
        else:
            rows = store.db.execute(
                "SELECT i.*, s.name AS source_name FROM items i JOIN sources s ON s.id=i.source_id "
                "WHERE i.kind=? ORDER BY i.name", (KIND,)).fetchall()
            rows = list(rows)
        regs = {r["name"]: dict(r) for r in store.db.execute(
            "SELECT * FROM registry_items WHERE kind=?", (KIND,)).fetchall()}
    for it in rows:
        items.append(dict(it))
    out = []
    for it in items:
        it = dict(it)
        manual = it.get("source_name") == "本地" or it.get("path") is None
        reg = regs.get(it["name"])
        cfg = {}
        if it.get("meta"):
            cfg = json.loads(it["meta"]) if isinstance(it["meta"], str) else it["meta"]
        elif manual and reg:
            cfg = fsutil.read_json(_reg_path(it["name"], root=_item_root(store, it["name"]))) or {}
        st = "installed" if manual and reg else "not-installed"
        if not manual and reg:
            cur = _reg_hash(store, it["name"])
            if cur and reg["hash"] and cur != reg["hash"]:
                st = "local-modified"
            elif reg.get("source_hash_at") and it["source_hash"] != reg["source_hash_at"]:
                st = "update-available"
            else:
                st = "installed"
        out.append({"name": it["name"], "version": (it["version"] or "")[:12],
                    "source_name": it.get("source_name") or ("本地" if manual else ""),
                    "source_id": None if manual else it.get("source_id"),
                    "manual": bool(manual),
                    "dir_id": it.get("dir_id"),
                    "dir_name": it.get("dir_name"),
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
        cur = _reg_hash(store, r["name"])
        cfg = fsutil.read_json(_reg_path(r["name"], root=_item_root(store, r["name"]))) or {}
        out.append({"name": r["name"], "version": (r["version"] or "")[:12],
                    "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                    "target": cfg.get("url") or (cfg.get("command", "") + " " + " ".join(cfg.get("args", []))).strip(),
                    "env_keys": sorted((cfg.get("env") or {}).keys()),
                    "manual": r["source_id"] is None,
                    "dir_id": r.get("dir_id"),
                    "modified": bool(cur and r["hash"] and cur != r["hash"]),
                    "deployments": dep_map.get(r["name"], [])})
    return out


def item_detail(store, name):
    """条目详情：优先本地库；本地库没有（远程条目尚未「更新到本地」）时回落读源仓库缓存。"""
    from_source = False
    cfg = fsutil.read_json(_reg_path(name, root=_item_root(store, name)))
    if cfg is None:
        with store.lock:
            row = store.db.execute(
                "SELECT source_id, path FROM items WHERE kind=? AND name=? ORDER BY id DESC LIMIT 1",
                (KIND, name)).fetchone()
        if not row or not row["path"]:
            return None
        base = os.path.join(_source_cache(store, row["source_id"]) or "", row["path"])
        cand = [base, os.path.join(base, "mcp.json"), os.path.join(base, name + ".json"),
                os.path.join(base, "config.json")]
        for c in cand:
            cfg = fsutil.read_json(c) if os.path.isfile(c) else None
            if cfg is not None:
                from_source = True
                break
        if cfg is None:
            return None
    masked = {}
    for k, v in (cfg.get("env") or {}).items():
        masked[k] = fsutil.mask_secret(v)
    with store.lock:
        reg_row = store.db.execute("SELECT dir_id FROM registry_items WHERE kind=? AND name=?",
                                   (KIND, name)).fetchone()
    dir_name = None
    dir_id = dict(reg_row)["dir_id"] if reg_row else None
    if dir_id:
        d = local_dirs.get_dir(store, dir_id)
        dir_name = d["name"] if d else None
    # 预览 = 真实写入体：env 掩码单列，内嵌 name 剔除（server 名由写入时的 key 表达）
    return {"name": name, "config": {k: v for k, v in cfg.items() if k not in ("env", "name")},
            "env_masked": masked, "from_source": from_source,
            "dir_id": dir_id, "dir_name": dir_name}


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
            return _r(pull_source(store, sid, removed_action=body.get("removed_action")))
        if not tail and method == "PATCH":
            return _r(update_source(store, sid, body))
        if not tail and method == "DELETE":
            return _r(delete_source(store, sid))
    if path == PREFIX + "/items" and method == "GET":
        def _q(k, d=None):
            v = q.get(k, [d])
            return v[0] if isinstance(v, list) else v
        src = _q("source")
        if src in (None, ""):            # 未传 = 不过滤
            src = None
        elif str(src).isdigit():         # 数字 = 远程源 id
            src = int(src)
        else:                            # "manual" = 本地手动条目
            src = str(src)
        dv = _q("dir")                   # 本地目录过滤："default" / 数字 id
        if dv in (None, ""):
            dv = None
        elif str(dv).isdigit():
            dv = int(dv)
        else:
            dv = str(dv)
        return 200, items_view(store, source=src, q=_q("q") or None,
                               page=_q("page", 1), per_page=_q("per_page", 20), dir=dv)
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
    # ---- manual items ----
    if path == PREFIX + "/registry/item" and method == "POST":
        return _r(create_manual(store, body.get("name"), body.get("config"),
                                dir_id=body.get("dir_id")))
    if path.startswith(PREFIX + "/registry/item/") and method == "PUT":
        return _r(update_manual(store, path[len(PREFIX + "/registry/item/"):],
                                body.get("config")))
    if path.startswith(PREFIX + "/registry/item/") and method == "DELETE":
        return _r(delete_manual(store, path[len(PREFIX + "/registry/item/"):],
                                force=bool(body.get("force"))))
    if path == PREFIX + "/targets" and method == "GET":
        # 展示口径与 items_view 一致：停用 / mcp_config 为空的工具目标不返回；附带工具名
        from hub.modules.mod_skills import _target_visible, _tool_names
        rows = [t for t in list_targets(store)
                if _target_visible(store, t.get("tool"), "mcp_config")]
        tnames = _tool_names(store)
        for r in rows:
            r["tool_name"] = tnames.get(r.get("tool"))
        return 200, {"ok": True, "targets": rows}
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
    # ---- 工具来源（反向提取）----
    if path == PREFIX + "/tool-items" and method == "GET":
        return 200, tool_items(store, (query.get("tool") or [None])[0])
    if path == PREFIX + "/extract" and method == "POST":
        return 200, extract(store, body.get("tool"), body.get("names") or [])
    if path == PREFIX + "/tool-sync" and method == "POST":
        return 200, sync_to_targets(store, body.get("tool"), body.get("names") or [],
                                    body.get("target_ids") or [])
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


def items_view(store, source=None, q=None, page=1, per_page=20, dir=None):
    """统一条目列表：来源过滤 + 关键词 + 分页 + 逐目标写入状态/差异。

    dir：本地目录过滤（"default" = 默认目录 / 数字 id）；仅对 manual 条目生效。
    """
    # source 可以是数字（远程源 id）或 "manual"（本地手动条目）；其它字符串按"不过滤"处理
    if isinstance(source, str) and source.lower() in ("manual", "local"):
        cat = [it for it in catalog_view(store) if it.get("manual")]
    else:
        cat = catalog_view(store, source_id=source if isinstance(source, int) else None)
    if dir is not None and source in ("manual", None):
        want = None if dir == "default" else dir
        cat = [it for it in cat if it.get("manual") and it.get("dir_id") == want]
    if q:
        cat = [it for it in cat if q.lower() in it["name"].lower()
               or q.lower() in (it.get("target") or "").lower()]
    total = len(cat)
    page = max(1, int(page or 1))
    per_page = min(100, max(5, int(per_page or 20)))
    slice_ = cat[(page - 1) * per_page: page * per_page]
    with store.lock:
        trows = [dict(r) for r in store.db.execute(
            "SELECT * FROM targets WHERE kind IN ('mcp_json','mcp_toml') ORDER BY id").fetchall()]
        deps = [dict(r) for r in store.db.execute(
            "SELECT d.*, t.name AS target_name FROM deployments d LEFT JOIN targets t ON t.id=d.target_id "
            "WHERE d.item_kind='mcp' AND d.status='ok'").fetchall()]
    # 停用工具 / mcp_config 为空的工具，其分发目标不展示（路径为空不在界面显示）
    from hub.modules.mod_skills import _target_visible, _tool_names
    trows = [t for t in trows if _target_visible(store, t.get("tool"), "mcp_config")]
    tnames = _tool_names(store)
    _vis = {t["id"] for t in trows}
    deps = [d for d in deps if d["target_id"] in _vis]
    dep_by_item = {}
    for d in deps:
        dep_by_item.setdefault(d["item_name"], {})[d["target_id"]] = d
    targets = []
    tmap = {t["id"]: t for t in trows}
    for t in trows:
        tj = {"id": t["id"], "name": t["name"], "tool_name": tnames.get(t.get("tool")),
              "path": t["path"], "tool": t["tool"],
              "kind": t["kind"], "format_key": t["format_key"],
              "items": {"latest": 0, "stale": 0, "missing": 0, "total": 0}, "stale_names": []}
        for it in cat:
            dep = dep_by_item.get(it["name"], {}).get(t["id"])
            if dep:
                tj["items"]["total"] += 1
                if _dep_stale(store, it["name"], dep, t):
                    tj["items"]["stale"] += 1
                    tj["stale_names"].append(it["name"])
                else:
                    tj["items"]["latest"] += 1
            else:
                tj["items"]["missing"] += 1
        targets.append(tj)
    rows = []
    for it in slice_:
        per_target = []
        for t in trows:
            dep = dep_by_item.get(it["name"], {}).get(t["id"])
            if dep:
                per_target.append({"target_id": t["id"], "target": t["name"],
                                   "state": "stale" if _dep_stale(store, it["name"], dep, t) else "latest",
                                   "deployed_at": dep["deployed_at"]})
            else:
                per_target.append({"target_id": t["id"], "target": t["name"], "state": "missing",
                                   "deployed_at": None})
        rows.append({**it, "per_target": per_target})
    return {"ok": True, "items": rows, "total": total, "page": page,
            "per_page": per_page, "pages": max(1, (total + per_page - 1) // per_page),
            "targets": targets}


def _dep_stale(store, name, dep, target=None):
    """工具端现状与本地库 config 是否一致：
    ① 目标文件现存内容 vs 当前 registry config（外部手改 / 本地库更新都算 stale）；
    ② 目标不可读时退化为 injected/block_text 对比。"""
    try:
        d = json.loads(dep["detail"]) if dep["detail"] else {}
    except Exception:
        return False
    # 必须用「可比较形态」（去内嵌 name）：本地库文件里存了 name，写进工具端的值不带它，
    # 直接拿原始文件比 → 永远 stale。与 tool_items 的比对口径保持一致。
    cfg = _reg_cfg(store, name)
    if cfg is None:
        return False
    if target is not None:
        path = os.path.expanduser(target["path"])
        try:
            if target["kind"] == "mcp_json":
                data = fsutil.read_json(path)
                fmt_key = d.get("format_key") or target.get("format_key") or "mcpServers"
                cur = _section_get(data or {}, fmt_key).get(name)
                if cur is not None:
                    return cur != cfg
            else:
                text = open(path, encoding="utf-8", errors="replace").read() if os.path.exists(path) else ""
                block = _find_toml_block(text, name)
                if block:
                    return block.group(0) != _toml_block(name, cfg)
        except Exception:
            pass
    if d.get("injected") is not None:
        return d["injected"] != cfg
    if d.get("block_text") is not None:
        return d["block_text"] != _toml_block(name, cfg)
    return False


def _r(res):
    if res.get("ok"):
        return 200, res
    return 400, res
