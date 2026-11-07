"""设置级远程仓库主表：一份配置，多个模块共用。

数据模型：
- `remote_repos` 是仓库实体（名称 / 地址 / 分支 / 子目录 / 凭据 / 定时）；
- `sources` 仍是各模块自己的落地记录（拉取、条目、缓存都挂在其 id 上）；
- `sources.repo_id` 回指主表；某模块是否勾选 = 该 kind 下是否存在 source 记录。

同步入口：
- 设置页 create_repo / update_repo → 增删各模块的 sources；
- 模块侧 link_source / update_from_source / prune_repo → 反向维护主表。
"""
from hub.core import ops

MODULES = ("skills", "mcp")
MODULE_NAMES = {"skills": "Skills", "mcp": "MCP"}
SHARED_FIELDS = ("name", "url", "branch", "subdir", "auth_ref", "poll_min")
SOURCE_FIELDS = SHARED_FIELDS + ("enabled",)


def _text(v):
    return (v or "").strip()


def _clean_fields(fields, base=None):
    """规范化仓库字段；编辑时用 base 补齐未提交的字段。"""
    out = {}
    for key in SHARED_FIELDS:
        if key in (fields or {}):
            val = fields[key]
        elif base is not None:
            val = base.get(key)
        else:
            continue
        if key == "auth_ref":
            out[key] = _text(val) or None
        elif key == "poll_min":
            try:
                out[key] = max(0, int(val))
            except (TypeError, ValueError):
                out[key] = 0
        else:
            out[key] = _text(val)
    if "branch" in out and not out["branch"]:
        out["branch"] = "main"
    return out


def _norm_modules(mods):
    """只认已支持的模块，去重并保持顺序。"""
    out = []
    for m in (mods or []):
        if m in MODULES and m not in out:
            out.append(m)
    return out


def _insert_source_locked(store, repo_id, kind, fields):
    """在某模块下建库里对应的 source 记录（与主表共享同一份配置）。"""
    cur = store.db.execute(
        "INSERT INTO sources(kind, name, url, branch, subdir, auth_ref, poll_min, "
        "created_at, repo_id) VALUES(?,?,?,?,?,?,?,?,?)",
        (kind, fields["name"], fields["url"], fields["branch"], fields["subdir"],
         fields.get("auth_ref"), fields.get("poll_min") or 0, ops.now_iso(), repo_id))
    return cur.lastrowid


def _link_locked(store, src):
    """把一个 source 接入主表（同 URL / 分支 / 子目录视为同一仓库）。

    source 可能来自老库（没有 repo_id）或模块侧新建；返回仓库 id。
    """
    if src.get("repo_id"):
        return src["repo_id"]
    row = store.db.execute(
        "SELECT * FROM remote_repos WHERE url=? AND branch=? AND subdir=?",
        (src["url"], src["branch"] or "main", src["subdir"] or "")).fetchone()
    if row:
        repo_id = row["id"]
    else:
        cur = store.db.execute(
            "INSERT INTO remote_repos(name, url, branch, subdir, auth_ref, poll_min, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (src["name"], src["url"], src["branch"] or "main", src["subdir"] or "",
             src.get("auth_ref"), src.get("poll_min") or 0, ops.now_iso()))
        repo_id = cur.lastrowid
    store.db.execute("UPDATE sources SET repo_id=? WHERE id=?", (repo_id, src["id"]))
    return repo_id


def backfill(store):
    """老库升级：给没有 repo_id 的 sources 补主表记录，并清掉没有来源的空仓库。"""
    with store.lock:
        rows = [dict(r) for r in store.db.execute(
            "SELECT * FROM sources WHERE repo_id IS NULL").fetchall()]
        for src in rows:
            _link_locked(store, src)
        store.db.execute(
            "DELETE FROM remote_repos WHERE id NOT IN "
            "(SELECT repo_id FROM sources WHERE repo_id IS NOT NULL)")
        store.db.commit()


def list_repos(store):
    """设置页列表：仓库 + 已勾选模块 + 各模块源状态（拉取时间 / 错误 / 条目数）。"""
    with store.lock:
        repos = [dict(r) for r in store.db.execute(
            "SELECT * FROM remote_repos ORDER BY id").fetchall()]
        rows = [dict(r) for r in store.db.execute(
            "SELECT id, kind, repo_id, name, last_sync_at, last_commit, last_error, "
            "(SELECT COUNT(*) FROM items i WHERE i.source_id=sources.id) AS item_count "
            "FROM sources WHERE repo_id IS NOT NULL ORDER BY id").fetchall()]
    by_repo = {}
    for row in rows:
        by_repo.setdefault(row["repo_id"], {})[row["kind"]] = row
    for repo in repos:
        mods = by_repo.get(repo["id"], {})
        repo["modules"] = [m for m in MODULES if m in mods]
        repo["sources"] = mods
    return repos


def create_repo(store, body):
    """设置页新建：同一仓库地址不允许重复，仓库至少要勾选一个模块。"""
    fields = _clean_fields(body)
    modules = _norm_modules((body or {}).get("modules"))
    if not fields.get("name") or not fields.get("url"):
        return {"ok": False, "error": "名称与仓库地址必填"}
    if not modules:
        return {"ok": False, "error": "至少勾选一个模块（Skills / MCP）"}
    fields.setdefault("branch", "main")
    fields.setdefault("subdir", "")
    fields.setdefault("auth_ref", None)
    fields.setdefault("poll_min", 0)
    with store.lock:
        dup = store.db.execute(
            "SELECT name FROM remote_repos WHERE url=? AND branch=? AND subdir=?",
            (fields["url"], fields["branch"], fields["subdir"])).fetchone()
        if dup:
            return {"ok": False, "error": "该仓库已存在（%s），请在列表里直接编辑" % dup["name"]}
        for kind in modules:
            row = store.db.execute("SELECT id FROM sources WHERE kind=? AND name=?",
                                   (kind, fields["name"])).fetchone()
            if row:
                return {"ok": False,
                        "error": "%s 模块已有同名仓库「%s」，请换个名称"
                                 % (MODULE_NAMES[kind], fields["name"])}
        cur = store.db.execute(
            "INSERT INTO remote_repos(name, url, branch, subdir, auth_ref, poll_min, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (fields["name"], fields["url"], fields["branch"], fields["subdir"],
             fields["auth_ref"], fields["poll_min"], ops.now_iso()))
        repo_id = cur.lastrowid
        for kind in modules:
            _insert_source_locked(store, repo_id, kind, fields)
        store.db.commit()
    ops.log_op(store, "system", "remote-repo:add", "ok", source_id=None,
               item_name=fields["name"],
               detail={"repo_id": repo_id, "modules": modules, "url": fields["url"]})
    return {"ok": True, "id": repo_id, "modules": modules}


def update_repo(store, repo_id, body):
    """设置页编辑：改共享字段 + 增删模块勾选。

    取消勾选会按模块「移除源」的默认语义处理：删源与条目，已拉取到本地库的
    副本转为手动条目（不删已分发文件）。
    """
    with store.lock:
        repo = store.db.execute("SELECT * FROM remote_repos WHERE id=?", (repo_id,)).fetchone()
        if not repo:
            return {"ok": False, "error": "仓库不存在"}
        repo = dict(repo)
        merged = _clean_fields(body, base=repo)
        if not merged.get("name") or not merged.get("url"):
            return {"ok": False, "error": "名称与仓库地址必填"}
        srcs = [dict(r) for r in store.db.execute(
            "SELECT * FROM sources WHERE repo_id=?", (repo_id,)).fetchall()]
        by_kind = {r["kind"]: r for r in srcs}
        mods = body.get("modules") if isinstance(body, dict) else None
        if mods is not None:
            mods = _norm_modules(mods)
            if not mods:
                return {"ok": False, "error": "至少保留一个模块（Skills / MCP）"}
            removed = [by_kind[m]["id"] for m in by_kind if m not in mods]
            added = [m for m in mods if m not in by_kind]
        else:
            removed, added = [], []
        # 地址 / 分支 / 子目录是仓库唯一键：不能和其它仓库撞车
        dup = store.db.execute(
            "SELECT name FROM remote_repos WHERE url=? AND branch=? AND subdir=? AND id<>?",
            (merged["url"], merged["branch"], merged["subdir"], repo_id)).fetchone()
        if dup:
            return {"ok": False, "error": "相同地址 / 分支 / 子目录的仓库已存在（%s）" % dup["name"]}
        # 改名后各模块内不能与别的仓库重名（本仓库自己的源除外）
        kept_kinds = [k for k in by_kind if k not in
                      [r["kind"] for r in srcs if r["id"] in removed]]
        for kind in kept_kinds + added:
            row = store.db.execute(
                "SELECT id FROM sources WHERE kind=? AND name=? "
                "AND (repo_id IS NULL OR repo_id<>?)",
                (kind, merged["name"], repo_id)).fetchone()
            if row:
                return {"ok": False,
                        "error": "%s 模块已有同名仓库「%s」，请换个名称"
                                 % (MODULE_NAMES[kind], merged["name"])}
        store.db.execute(
            "UPDATE remote_repos SET name=?, url=?, branch=?, subdir=?, auth_ref=?, poll_min=? "
            "WHERE id=?",
            (merged["name"], merged["url"], merged["branch"], merged["subdir"],
             merged["auth_ref"], merged["poll_min"], repo_id))
        for src in srcs:
            store.db.execute(
                "UPDATE sources SET name=?, url=?, branch=?, subdir=?, auth_ref=?, poll_min=? "
                "WHERE id=?",
                (merged["name"], merged["url"], merged["branch"], merged["subdir"],
                 merged["auth_ref"], merged["poll_min"], src["id"]))
        for kind in added:
            _insert_source_locked(store, repo_id, kind, merged)
        store.db.commit()
    # 取消勾选的模块：沿用各模块自己的移除语义（含条目处理 / 缓存清理）
    failed = []
    for sid in removed:
        kind = next((r["kind"] for r in srcs if r["id"] == sid), None)
        try:
            if kind == "skills":
                from hub.modules import mod_skills as mod
                mod.delete_source(store, sid)
            elif kind == "mcp":
                from hub.modules import mod_mcp as mod
                mod.delete_source(store, sid)
        except Exception as e:                       # 单模块失败不影响其余勾选
            failed.append("%s：%s" % (MODULE_NAMES.get(kind, kind), e))
    ops.log_op(store, "system", "remote-repo:update", "ok", item_name=merged["name"],
               detail={"repo_id": repo_id, "modules": mods,
                       "added": added, "removed": removed})
    if failed:
        return {"ok": False, "error": "仓库已保存，但移除模块失败：" + "；".join(failed)}
    return {"ok": True, "id": repo_id, "modules": mods if mods is not None else None}


def link_source(store, kind, source_id):
    """模块侧新增远仓后调用：把它接入设置级主表（同地址自动视为同一仓库）。"""
    with store.lock:
        row = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?",
                               (source_id, kind)).fetchone()
        if not row:
            return None
        repo_id = _link_locked(store, dict(row))
        store.db.commit()
    return repo_id


def update_from_source(store, kind, source_id, fields):
    """模块侧编辑远仓后调用：同步主表与其它模块的同仓库记录。

    返回 None 表示成功；否则返回错误文本（调用方转成 {ok:false, error}）。
    """
    fields = {k: v for k, v in (fields or {}).items() if k in SOURCE_FIELDS}
    if not fields:
        return "无更新字段"
    with store.lock:
        src = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?",
                               (source_id, kind)).fetchone()
        if not src:
            return "源不存在"
        src = dict(src)
        repo_id = _link_locked(store, src)
        repo = dict(store.db.execute("SELECT * FROM remote_repos WHERE id=?",
                                     (repo_id,)).fetchone())
        merged = _clean_fields(fields, base=repo)
        if not merged.get("name") or not merged.get("url"):
            return "名称与仓库地址必填"
        dup = store.db.execute(
            "SELECT name FROM remote_repos WHERE url=? AND branch=? AND subdir=? AND id<>?",
            (merged["url"], merged["branch"], merged["subdir"], repo_id)).fetchone()
        if dup:
            return "相同地址 / 分支 / 子目录的仓库已存在（%s）" % dup["name"]
        siblings = [dict(r) for r in store.db.execute(
            "SELECT * FROM sources WHERE repo_id=? AND id<>?", (repo_id, source_id)).fetchall()]
        for sib in siblings:
            row = store.db.execute(
                "SELECT id FROM sources WHERE kind=? AND name=? AND id<>?",
                (sib["kind"], merged["name"], sib["id"])).fetchone()
            if row:
                return "%s 模块已有同名仓库「%s」，请换个名称" % (
                    MODULE_NAMES.get(sib["kind"], sib["kind"]), merged["name"])
        store.db.execute(
            "UPDATE remote_repos SET name=?, url=?, branch=?, subdir=?, auth_ref=?, poll_min=? "
            "WHERE id=?",
            (merged["name"], merged["url"], merged["branch"], merged["subdir"],
             merged["auth_ref"], merged["poll_min"], repo_id))
        sets = ["name=?", "url=?", "branch=?", "subdir=?", "auth_ref=?", "poll_min=?"]
        args = [merged["name"], merged["url"], merged["branch"], merged["subdir"],
                merged["auth_ref"], merged["poll_min"]]
        if "enabled" in fields:
            sets.append("enabled=?")
            args.append(1 if fields["enabled"] else 0)
        args.append(source_id)
        store.db.execute("UPDATE sources SET %s WHERE id=?" % ",".join(sets), args)
        if siblings:
            store.db.execute(
                "UPDATE sources SET name=?, url=?, branch=?, subdir=?, auth_ref=?, poll_min=? "
                "WHERE repo_id=? AND id<>?",
                (merged["name"], merged["url"], merged["branch"], merged["subdir"],
                 merged["auth_ref"], merged["poll_min"], repo_id, source_id))
        store.db.commit()
    return None


def prune_repo(store, repo_id):
    """模块侧删源后调用：仓库已没有任何模块在用时，连同主表记录一起删除。"""
    if not repo_id:
        return
    with store.lock:
        left = store.db.execute("SELECT COUNT(*) AS n FROM sources WHERE repo_id=?",
                                (repo_id,)).fetchone()["n"]
        if not left:
            store.db.execute("DELETE FROM remote_repos WHERE id=?", (repo_id,))
        store.db.commit()
