"""一级模块：Skills 管理分发。

数据流：远程 Git 源 →（拉取）→ hub 本地库 registry/skills/ →（分发）→ 各目标目录。
安全约定：
- 目标目录中「非本系统托管」的内容一律冲突停手（force 才覆盖，且先备份）；
- 只改写/删除 deployments 记录中我们落盘过的文件；
- 每文件写入 = 备份 + 原子写；失败单条回滚不影响其余。
"""
import json
import os
import time

from hub.core import fsutil, ops
from hub.lib import catalog, gitsrc

MODULE = "skills"
KIND = "skills"
PREFIX = "/api/skills"


def _hub_dir():
    return os.environ.get("AGENT_HUB_DIR") or os.path.expanduser("~/.agent/hub")


def sources_root():
    return os.path.join(_hub_dir(), "sources")


def registry_root():
    return os.path.join(_hub_dir(), "registry", "skills")


def versions_root(name):
    return os.path.join(_hub_dir(), "registry", ".versions", "skills", name)


# ============================================================ sources
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
            "SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS item_count, "
            "(SELECT COUNT(*) FROM snapshots sn WHERE sn.source_id=s.id) AS snapshot_count "
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
    args.append(source_id)
    with store.lock:
        store.db.execute("UPDATE sources SET %s WHERE id=? AND kind=?" % ",".join(sets),
                         args + [KIND])
        store.db.commit()
    ops.log_op(store, MODULE, "source:update", "ok", source_id=source_id, detail=fields)
    return {"ok": True}


def delete_source(store, source_id):
    with store.lock:
        store.db.execute("DELETE FROM items WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM snapshots WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM sources WHERE id=? AND kind=?", (source_id, KIND))
        store.db.commit()
    ops.log_op(store, MODULE, "source:delete", "ok", source_id=source_id)
    return {"ok": True}


# ============================================================ pull
def pull_source(store, source_id, force=False):
    """fetch + 解析 + 快照 + 条目差分。返回 {ok, commit, added, changed, removed, error}。"""
    with store.lock:
        src = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?",
                               (source_id, KIND)).fetchone()
    if not src:
        return {"ok": False, "error": "源不存在"}
    src = dict(src)
    cache = os.path.join(sources_root(), "skills-%d" % source_id)
    ok, commit, resolved_branch, err = gitsrc.ensure_cache(
        cache, src["url"], src["branch"] or "main", src["auth_ref"])
    if not ok:
        _mark_error(store, source_id, err)
        ops.log_op(store, MODULE, "pull", "failed", source_id=source_id,
                   item_name=src["name"], reason=err)
        return {"ok": False, "error": err}
    if err:  # 非致命警告（如凭据文件权限）
        ops.log_op(store, MODULE, "pull", "info", source_id=source_id, reason=err)

    files = gitsrc.ls_tree(cache, commit)
    show = lambda p: gitsrc.show_bytes(cache, commit, p)  # noqa: E731
    items = catalog.parse_skills(files, show, commit, subdir=src["subdir"] or "")
    if not items:
        msg = "源中没有解析到任何 skill（检查目录结构：需含 SKILL.md）"
        _mark_error(store, source_id, msg)
        ops.log_op(store, MODULE, "pull", "failed", source_id=source_id, reason=msg)
        return {"ok": False, "error": msg}

    added, changed, removed = [], [], []
    with store.lock:
        old = {r["name"]: dict(r) for r in store.db.execute(
            "SELECT * FROM items WHERE source_id=?", (source_id,)).fetchall()}
        new_names = set()
        for it in items:
            new_names.add(it["name"])
            it["version"] = it["version"] or commit  # 版本回落：commit 短哈希
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
                (source_id, KIND, it["name"], it["path"], it["source_hash"], it["version"],
                 json.dumps(it["meta"], ensure_ascii=False)))
        for nm in old:
            if nm not in new_names:
                removed.append(nm)
                store.db.execute("DELETE FROM items WHERE source_id=? AND name=?",
                                 (source_id, nm))
        store.db.execute(
            "INSERT INTO snapshots(source_id, commit_hash, taken_at, item_count, catalog_json) "
            "VALUES(?,?,?,?,?)",
            (source_id, commit, ops.now_iso(), len(items),
             json.dumps(items, ensure_ascii=False)))
        store.db.execute(
            "UPDATE sources SET last_sync_at=?, last_commit=?, last_error=NULL, "
            "branch=COALESCE(?, branch) WHERE id=?",
            (ops.now_iso(), commit, resolved_branch, source_id))
        store.db.commit()
    ops.log_op(store, MODULE, "pull", "ok", source_id=source_id, item_name=src["name"],
               item_version=commit,
               detail={"added": added, "changed": changed, "removed": removed})
    return {"ok": True, "commit": commit, "added": added, "changed": changed, "removed": removed}


def _mark_error(store, source_id, msg):
    with store.lock:
        store.db.execute("UPDATE sources SET last_error=? WHERE id=?", (msg, source_id))
        store.db.commit()


# ============================================================ registry
def _item_status(store, name, reg, src_item):
    """状态机：未安装 | 已安装 | 可更新 | 本地修改。"""
    if not reg:
        return "not-installed"
    cur_hash = _registry_current_hash(name)
    if cur_hash and reg["hash"] and cur_hash != reg["hash"]:
        return "local-modified"
    if src_item and reg.get("source_hash_at") and src_item["source_hash"] != reg["source_hash_at"]:
        return "update-available"
    return "installed"


def _registry_current_hash(name):
    d = os.path.join(registry_root(), name)
    if not os.path.isdir(d):
        return None
    return fsutil.tree_hash(d)


def _materialize(store, item_row, commit):
    """把源条目落盘到 registry/<name>（tmp 目录 + 交换），返回 {files: {rel: sha}}。"""
    cache = os.path.join(sources_root(), "skills-%d" % item_row["source_id"])
    files = gitsrc.ls_tree(cache, commit)
    prefix = item_row["path"].rstrip("/")
    if prefix and prefix != ".":
        prefix += "/"
    member = {p: h for p, h in files.items() if p.startswith(prefix)}
    dest = os.path.join(registry_root(), item_row["name"])
    tmp = dest + ".hub-tmp-%d" % os.getpid()
    if os.path.isdir(tmp):
        fsutil.safe_rm(tmp) if tmp.startswith(os.path.realpath(_hub_dir())) else None
    written = {}
    for rel, _blob in sorted(member.items()):
        rel_short = rel[len(prefix):] if prefix else rel
        data = gitsrc.show_bytes(cache, commit, rel)
        if data is None:
            continue
        target_file = os.path.join(tmp, rel_short)
        fsutil.atomic_write_bytes(target_file, data)
        written[rel_short] = fsutil.sha256_bytes(data)
    # 旧版本备份 + 原子交换
    if os.path.isdir(dest):
        vroot = versions_root(item_row["name"])
        os.makedirs(vroot, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(vroot, stamp)
        n = 1
        while os.path.exists(backup):
            backup = os.path.join(vroot, "%s-%d" % (stamp, n)); n += 1
        os.rename(dest, backup)
    os.rename(tmp, dest)
    return written


def update_registry(store, names, source_id=None, force=False):
    """源 → 本地库。逐条结果；本地被改且 force=False → conflict-local-modified。"""
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
            src = store.db.execute("SELECT * FROM sources WHERE id=?", (row["source_id"],)).fetchone()
            reg = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                                   (KIND, name)).fetchone()
            reg = dict(reg) if reg else None
            commit = dict(src)["last_commit"]
            if not commit:
                results.append({"item": name, "status": "failed", "reason": "源尚未拉取"})
                continue
            cur_hash = _registry_current_hash(name)
            if reg and cur_hash and reg["hash"] and cur_hash != reg["hash"] and not force:
                results.append({"item": name, "status": "conflict-local-modified",
                                "reason": "本地库中该技能已被修改（保留本地；可 force 覆盖）"})
                ops.log_op(store, MODULE, "update", "conflict", item_kind="skill",
                           item_name=name, source_id=row["source_id"],
                           reason="local-modified")
                continue
            if reg and reg.get("source_hash_at") == row["source_hash"] and cur_hash == reg["hash"]:
                results.append({"item": name, "status": "unchanged", "version": reg["version"]})
                continue
            try:
                written = _materialize(store, row, commit)
            except Exception as e:
                results.append({"item": name, "status": "failed", "reason": str(e)[:200]})
                ops.log_op(store, MODULE, "update", "failed", item_kind="skill",
                           item_name=name, source_id=row["source_id"], reason=str(e)[:200])
                continue
            new_hash = fsutil.tree_hash_from_files(written)
            prev_version = reg["version"] if reg else None
            prev_hash = reg["hash"] if reg else None
            store.db.execute(
                "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
                "prev_version, prev_hash, source_hash_at) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(kind, name) DO UPDATE SET source_id=excluded.source_id, "
                "version=excluded.version, hash=excluded.hash, updated_at=excluded.updated_at, "
                "prev_version=excluded.prev_version, prev_hash=excluded.prev_hash, "
                "source_hash_at=excluded.source_hash_at",
                (KIND, name, row["source_id"], row["version"], new_hash, ops.now_iso(),
                 prev_version, prev_hash, row["source_hash"]))
            store.db.commit()
            status = "updated" if reg else "installed"
            results.append({"item": name, "status": status, "version": row["version"],
                            "hash": new_hash[:12], "files": len(written)})
            ops.log_op(store, MODULE, "update", "ok", item_kind="skill", item_name=name,
                       item_version=row["version"], source_id=row["source_id"])
    return results


def rollback_registry(store, name):
    """本地库回退到上一个版本快照。"""
    vroot = versions_root(name)
    if not os.path.isdir(vroot):
        return {"ok": False, "error": "没有可回退的版本快照"}
    snaps = sorted(d for d in os.listdir(vroot) if not d.startswith("."))
    if not snaps:
        return {"ok": False, "error": "版本快照为空"}
    latest = os.path.join(vroot, snaps[-1])
    dest = os.path.join(registry_root(), name)
    # 当前版本转存为新快照（可再回退）
    if os.path.isdir(dest):
        stamp = time.strftime("%Y%m%d-%H%M%S") + "-pre-rollback"
        os.rename(dest, os.path.join(vroot, stamp))
    os.rename(latest, dest)
    new_hash = fsutil.tree_hash(dest)
    with store.lock:
        row = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
        if row:
            store.db.execute("UPDATE registry_items SET hash=?, updated_at=?, "
                             "prev_hash=prev_hash WHERE kind=? AND name=?",
                             (new_hash, ops.now_iso(), KIND, name))
            store.db.commit()
    ops.log_op(store, MODULE, "rollback", "ok", item_kind="skill", item_name=name)
    return {"ok": True, "hash": new_hash[:12], "restored_from": snaps[-1]}


# ============================================================ targets
def seed_defaults(store):
    """探测本机全局目标并注册（幂等）。"""
    home = os.path.expanduser("~")
    defaults = [
        ("Claude Skills (全局)", "skills_dir", "claude", os.path.join(home, ".claude", "skills"), None),
        ("Codex Skills (全局)", "skills_dir", "codex", os.path.join(home, ".codex", "skills"), None),
        ("OpenCode Skills (全局)", "skills_dir", "opencode", os.path.join(home, ".config", "opencode", "skills"), None),
        ("Agents Skills (全局)", "skills_dir", "plain", os.path.join(home, ".agents", "skills"), None),
    ]
    created = []
    with store.lock:
        for nm, kind, tool, path, fkey in defaults:
            if not os.path.isdir(os.path.dirname(path)) and not os.path.isdir(path):
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
        ops.log_op(store, "system", "targets:seed", "ok", detail={"created": created})
    return created


def add_target(store, name, kind, tool, path, format_key=None):
    if kind not in ("skills_dir", "mcp_json", "mcp_toml"):
        return {"ok": False, "error": "kind 必须是 skills_dir / mcp_json / mcp_toml"}
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
    ops.log_op(store, MODULE if kind == "skills_dir" else "mcp", "target:add", "ok",
               target_id=tid, item_name=name)
    return {"ok": True, "id": tid}


def list_targets(store, kind=None):
    with store.lock:
        if kind:
            rows = store.db.execute("SELECT * FROM targets WHERE kind=? ORDER BY id",
                                    (kind,)).fetchall()
        else:
            rows = store.db.execute("SELECT * FROM targets ORDER BY id").fetchall()
    return [dict(r) for r in rows]


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


# ============================================================ distribute (skills_dir)
def _deployment(store, name, target_id):
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM deployments WHERE item_kind='skill' AND item_name=? AND target_id=?",
            (name, target_id)).fetchone()
    return dict(row) if row else None


def _plan_skills_dir(store, name, target, force=False):
    """返回 plan：{status, reason, files_new:{rel:sha}, files_changed:[], conflicts:[], dest}"""
    reg_dir = os.path.join(registry_root(), name)
    if not os.path.isdir(reg_dir):
        return {"status": "failed", "reason": "本地库中不存在该技能（先更新到本地）"}
    new_files = fsutil.list_files(reg_dir)
    new_hash = fsutil.tree_hash_from_files(new_files)
    dest = os.path.join(target["path"], name)
    dep = _deployment(store, name, target["id"])
    if dep and dep["deployed_hash"] == new_hash:
        # 再校验目标现状（防被手改后误报 already-current）
        if os.path.isdir(dest):
            cur = fsutil.list_files(dest)
            managed = (json.loads(dep["detail"]) if dep["detail"] else {}).get("files", {})
            drifted = [f for f, h in managed.items() if cur.get(f) != h]
            if not drifted:
                return {"status": "skipped", "reason": "已是最新（幂等跳过）", "dest": dest}
            if not force:
                return {"status": "conflict",
                        "reason": "目标文件被手动修改：%s" % ", ".join(drifted[:3]), "dest": dest}
            # force：按托管清单恢复
            return {"status": "ok", "action": "restore", "dest": dest, "files_new": new_files,
                    "files_changed": drifted, "conflicts": drifted, "managed": managed,
                    "new_hash": new_hash}
        return {"status": "conflict", "reason": "目标目录缺失但记录存在", "dest": dest}
    if dep:
        # 已托管：检测手改
        managed = (json.loads(dep["detail"]) if dep["detail"] else {}).get("files", {})
        cur = fsutil.list_files(dest) if os.path.isdir(dest) else {}
        drifted = [f for f, h in managed.items() if cur.get(f, None) != h]
        if drifted and not force:
            return {"status": "conflict",
                    "reason": "目标文件被手动修改：%s" % ", ".join(drifted[:3]), "dest": dest}
        files_changed = [f for f in new_files if managed.get(f) != new_files[f]]
        return {"status": "ok", "action": "update", "dest": dest, "files_new": new_files,
                "files_changed": files_changed, "conflicts": drifted,
                "managed": managed, "new_hash": new_hash}
    # 首次分发
    if os.path.isdir(dest):
        cur = fsutil.list_files(dest)
        if cur and cur != new_files and not force:
            return {"status": "conflict",
                    "reason": "目标位置已存在未托管的同名内容（%d 个文件）；确认后用 force 覆盖" % len(cur),
                    "dest": dest}
        if cur == new_files:
            return {"status": "ok", "action": "adopt", "dest": dest, "files_new": new_files,
                    "files_changed": [], "conflicts": [], "managed": {}, "new_hash": new_hash}
    return {"status": "ok", "action": "create", "dest": dest, "files_new": new_files,
            "files_changed": list(new_files), "conflicts": [], "managed": {},
            "new_hash": new_hash}


def _apply_skills_dir(store, name, target, plan):
    dest = plan["dest"]
    new_files = plan["files_new"]
    managed = plan.get("managed", {})
    backup_root = os.path.join(dest, ".hub-backup")
    written = {}
    # 备份将被覆盖/删除的文件
    for rel in sorted(set(list(managed.keys()) + list(new_files.keys()))):
        cur_path = os.path.join(dest, rel)
        if os.path.exists(cur_path):
            incoming = new_files.get(rel)
            if incoming is None or fsutil.sha256_file(cur_path) != incoming:
                fsutil.backup_file(cur_path, os.path.join(backup_root, time.strftime("%Y%m%d-%H%M%S")))
    for rel, sha in sorted(new_files.items()):
        data = open(os.path.join(registry_root(), name, rel), "rb").read()
        fsutil.atomic_write_bytes(os.path.join(dest, rel), data)
        written[rel] = fsutil.sha256_bytes(data)
    # 清理「曾托管但本次不再存在」的文件（严格限定在 managed 列表内）
    removed = [rel for rel in managed if rel not in new_files]
    for rel in removed:
        p = os.path.join(dest, rel)
        if os.path.exists(p):
            os.unlink(p)
    # 清理空目录（仅限目标技能目录内）
    for dirpath, dirnames, filenames in os.walk(dest, topdown=False):
        if dirpath == dest:
            continue
        if not os.listdir(dirpath):
            os.rmdir(dirpath)
    dep = _deployment(store, name, target["id"])
    with store.lock:
        store.db.execute(
            "INSERT INTO deployments(item_kind, item_name, item_version, target_id, "
            "deployed_hash, deployed_at, status, detail) VALUES('skill',?,?,?,?,?,?,?) "
            "ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET "
            "item_version=excluded.item_version, deployed_hash=excluded.deployed_hash, "
            "deployed_at=excluded.deployed_at, status=excluded.status, detail=excluded.detail",
            (name, plan.get("version"), target["id"], plan["new_hash"], ops.now_iso(), "ok",
             json.dumps({"files": written, "removed": removed}, ensure_ascii=False)))
        store.db.commit()
    return {"written": len(written), "removed": removed}


def distribute_skills(store, names, target_ids, dry_run=False, force=False):
    """skills → skills_dir 目标。逐条结果。"""
    results = []
    targets = [t for t in list_targets(store, kind="skills_dir") if t["id"] in target_ids]
    for name in names:
        for t in targets:
            plan = _plan_skills_dir(store, name, t, force=force)
            if plan["status"] != "ok":
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": plan["status"], "reason": plan.get("reason"),
                                "dry_run": dry_run})
                if not dry_run and plan["status"] == "conflict":
                    ops.log_op(store, MODULE, "distribute", "conflict", item_kind="skill",
                               item_name=name, target_id=t["id"], reason=plan.get("reason"))
                continue
            if dry_run:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan.get("action", "update"),
                                "files_changed": len(plan["files_changed"]),
                                "reason": "dry-run（未写入）", "dry_run": True})
                continue
            try:
                applied = _apply_skills_dir(store, name, t, plan)
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan.get("action", "update"),
                                "files_changed": len(plan["files_changed"]),
                                "files_removed": len(applied["removed"]), "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "ok", item_kind="skill",
                           item_name=name, target_id=t["id"],
                           detail={"files": applied["written"], "removed": applied["removed"]})
            except Exception as e:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "failed", "reason": str(e)[:200], "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "failed", item_kind="skill",
                           item_name=name, target_id=t["id"], reason=str(e)[:200])
    return results


# ============================================================ queries for UI
def catalog_view(store, source_id=None):
    """源侧目录 + 本地状态合并视图。"""
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
        st = _item_status(store, it["name"], reg, it)
        out.append({
            "name": it["name"], "version": it["version"],
            "source_name": it["source_name"], "source_id": it["source_id"],
            "description": (json.loads(it["meta"]) if it["meta"] else {}).get("description", ""),
            "status": st,
            "local_version": reg["version"] if reg else None,
        })
    return out


def registry_view(store):
    with store.lock:
        regs = [dict(r) for r in store.db.execute(
            "SELECT * FROM registry_items WHERE kind=? ORDER BY name", (KIND,)).fetchall()]
        deps = [dict(r) for r in store.db.execute(
            "SELECT d.*, t.name AS target_name FROM deployments d "
            "LEFT JOIN targets t ON t.id=d.target_id WHERE d.item_kind='skill' AND d.status='ok'"
        ).fetchall()]
    dep_map = {}
    for d in deps:
        dep_map.setdefault(d["item_name"], []).append(
            {"target": d["target_name"], "target_id": d["target_id"], "hash": d["deployed_hash"]})
    out = []
    for r in regs:
        cur_hash = _registry_current_hash(r["name"])
        out.append({
            "name": r["name"], "version": r["version"], "hash": (r["hash"] or "")[:12],
            "updated_at": r["updated_at"],
            "modified": bool(cur_hash and r["hash"] and cur_hash != r["hash"]),
            "deployments": dep_map.get(r["name"], []),
        })
    return out


def item_detail(store, name):
    reg_dir = os.path.join(registry_root(), name)
    if not os.path.isdir(reg_dir):
        return None
    files = fsutil.list_files(reg_dir)
    skill_md = None
    p = os.path.join(reg_dir, "SKILL.md")
    if os.path.exists(p):
        skill_md = open(p, encoding="utf-8", errors="replace").read()[:12000]
    with store.lock:
        reg = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
    return {"name": name, "skill_md": skill_md, "files": sorted(files.keys()),
            "version": dict(reg)["version"] if reg else None}


def diff_registry_vs_source(store, name, source_id=None):
    """本地库当前内容 vs 源最新：逐文件 unified diff（文本文件）。"""
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM items WHERE kind=? AND name=? " +
            ("AND source_id=? " if source_id else "") + "ORDER BY id DESC LIMIT 1",
            ([KIND, name] + ([source_id] if source_id else []))).fetchone()
        if not row:
            return {"ok": False, "error": "源中没有该条目"}
        row = dict(row)
        src = store.db.execute("SELECT * FROM sources WHERE id=?", (row["source_id"],)).fetchone()
    commit = dict(src)["last_commit"]
    if not commit:
        return {"ok": False, "error": "源尚未拉取"}
    cache = os.path.join(sources_root(), "skills-%d" % row["source_id"])
    files = gitsrc.ls_tree(cache, commit)
    prefix = row["path"].rstrip("/")
    if prefix and prefix != ".":
        prefix += "/"
    diffs = []
    reg_dir = os.path.join(registry_root(), name)
    for rel, _ in sorted(files.items()):
        if prefix and not rel.startswith(prefix):
            continue
        rel_short = rel[len(prefix):] if prefix else rel
        src_text = (gitsrc.show_bytes(cache, commit, rel) or b"").decode("utf-8", "replace")
        cur_path = os.path.join(reg_dir, rel_short)
        cur_text = ""
        if os.path.exists(cur_path):
            try:
                cur_text = open(cur_path, encoding="utf-8", errors="replace").read()
            except OSError:
                cur_text = ""
        if src_text != cur_text:
            diffs.append(fsutil.unified_diff(cur_text, src_text,
                                             "local/" + rel_short, "source/" + rel_short))
    return {"ok": True, "name": name, "commit": commit,
            "diff": "\n".join(diffs) if diffs else "（无差异）"}


# ============================================================ HTTP routes
def handle(store, method, path, query, body):
    """模块路由（由 server.py 分发）。返回 (status, payload) 或 None（不处理）。"""
    if not path.startswith(PREFIX):
        return None
    if not registry_enabled(store):
        return 503, {"ok": False, "error": "模块已禁用（可在模块管理中启用）"}
    q = query or {}

    def need_sid(text):
        try:
            return int(text)
        except (TypeError, ValueError):
            return None

    # ---- sources ----
    if path == PREFIX + "/sources" and method == "GET":
        return 200, {"ok": True, "sources": list_sources(store)}
    if path == PREFIX + "/sources" and method == "POST":
        return _r(add_source(store, body.get("name"), body.get("url"), body.get("branch", "main"),
                             body.get("subdir", ""), body.get("auth_ref")))
    if path.startswith(PREFIX + "/sources/"):
        rest = path[len(PREFIX + "/sources/"):]
        sid, _, tail = rest.partition("/")
        sid = need_sid(sid)
        if sid is None:
            return 400, {"ok": False, "error": "非法 source id"}
        if tail == "pull" and method == "POST":
            return _r(pull_source(store, sid, force=bool(body.get("force"))))
        if not tail and method == "PATCH":
            return _r(update_source(store, sid, body))
        if not tail and method == "DELETE":
            return _r(delete_source(store, sid))
    # ---- catalog / registry ----
    if path == PREFIX + "/catalog" and method == "GET":
        return 200, {"ok": True, "items": catalog_view(store, need_sid(q.get("source_id", [None])[0]) if isinstance(q.get("source_id"), list) else None)}
    if path == PREFIX + "/registry" and method == "GET":
        return 200, {"ok": True, "items": registry_view(store)}
    if path == PREFIX + "/registry/update" and method == "POST":
        names = body.get("names") or []
        if not names:
            return 400, {"ok": False, "error": "names 不能为空"}
        source_id = body.get("source_id")
        return 200, {"ok": True, "results": update_registry(store, names, source_id,
                                                            force=bool(body.get("force")))}
    if path == PREFIX + "/registry/rollback" and method == "POST":
        name = body.get("name")
        if not name:
            return 400, {"ok": False, "error": "name 必填"}
        return _r(rollback_registry(store, name))
    if path.startswith(PREFIX + "/item/") and method == "GET":
        name = path[len(PREFIX + "/item/"):]
        detail = item_detail(store, name)
        if not detail:
            return 404, {"ok": False, "error": "本地库中不存在"}
        return 200, {"ok": True, **detail}
    if path == PREFIX + "/diff" and method == "GET":
        name = (q.get("name") or [""])[0]
        if not name:
            return 400, {"ok": False, "error": "name 必填"}
        return _r(diff_registry_vs_source(store, name))
    # ---- targets ----
    if path == PREFIX + "/targets" and method == "GET":
        return 200, {"ok": True, "targets": list_targets(store, kind="skills_dir")}
    if path == PREFIX + "/targets" and method == "POST":
        return _r(add_target(store, body.get("name"), body.get("kind"), body.get("tool"),
                             body.get("path"), body.get("format_key")))
    if path == PREFIX + "/targets/seed" and method == "POST":
        return 200, {"ok": True, "created": seed_defaults(store)}
    if path.startswith(PREFIX + "/targets/") and method == "DELETE":
        tid = need_sid(path[len(PREFIX + "/targets/"):])
        if tid is None:
            return 400, {"ok": False, "error": "非法 target id"}
        return _r(delete_target(store, tid, force=bool(body.get("force"))))
    # ---- distribute ----
    if path == PREFIX + "/distribute" and method == "POST":
        names = body.get("names") or []
        target_ids = body.get("target_ids") or []
        if not names or not target_ids:
            return 400, {"ok": False, "error": "names 与 target_ids 必填"}
        return 200, {"ok": True, "results": distribute_skills(
            store, names, target_ids, dry_run=bool(body.get("dry_run")),
            force=bool(body.get("force")))}
    return 404, {"ok": False, "error": "skills: 未知路由 %s %s" % (method, path)}


def registry_enabled(store):
    from hub.core import registry as reg
    return reg.enabled(store, MODULE)


def _r(res):
    if res.get("ok"):
        return 200, res
    return 400, res
