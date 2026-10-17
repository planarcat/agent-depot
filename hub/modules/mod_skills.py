"""一级模块：Skills 管理分发。

数据流：远程 Git 源 →（拉取）→ hub 本地库 registry/skills/ →（分发）→ 各目标目录。
安全约定：
- 目标目录中「非本系统托管」的内容一律冲突停手（force 才覆盖，且先备份）；
- 只改写/删除 deployments 记录中我们落盘过的文件；
- 每文件写入 = 备份 + 原子写；失败单条回滚不影响其余。
"""
import json
import os
import re
import shutil
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
            "(SELECT COUNT(*) FROM snapshots sn WHERE sn.source_id=s.id) AS snapshot_count, "
            "(SELECT COUNT(*) FROM registry_items r WHERE r.kind='" + KIND + "' AND r.source_id=s.id) AS registry_count "
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


def delete_source(store, source_id, removed_action=None):
    """移除源：删 items/snapshots/源记录 + git 缓存目录；registry 与已部署内容默认不动。

    removed_action：
    - None / "keep" → 本地库副本保留但转为手动条目（脱离源，避免孤儿引用）——移除源的默认语义；
    - "delete" → 本地库副本一并清除（备份到 .versions；已分发文件保留）。"""
    with store.lock:
        src = store.db.execute("SELECT name FROM sources WHERE id=? AND kind=?",
                               (source_id, KIND)).fetchone()
        items = [dict(r) for r in store.db.execute(
            "SELECT * FROM items WHERE source_id=?", (source_id,)).fetchall()]
        store.db.execute("DELETE FROM items WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM snapshots WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM sources WHERE id=? AND kind=?", (source_id, KIND))
        store.db.commit()
    if src:
        import shutil as _sh
        cache = os.path.join(sources_root(), "skills-%d" % source_id)
        if os.path.isdir(cache):
            _sh.rmtree(cache, ignore_errors=True)
    localized, purged = [], []
    for it in items:
        with store.lock:
            reg = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                   (KIND, it["name"])).fetchone()
        if not reg:
            continue
        if removed_action == "delete":
            _purge_registry_item_locked(store, it["name"])
            purged.append(it["name"])
        else:
            with store.lock:
                store.db.execute(
                    "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL "
                    "WHERE kind=? AND name=?", (KIND, it["name"]))
                store.db.commit()
            localized.append(it["name"])
    ops.log_op(store, MODULE, "source:delete", "ok", source_id=source_id,
               item_name=src["name"] if src else None,
               detail={"localized": localized, "purged": purged,
                       "removed_action": removed_action or "keep"})
    return {"ok": True, "localized": localized, "purged": purged}


# ============================================================ pull
def pull_source(store, source_id, force=False, removed_action=None):
    """fetch + 解析 + 快照 + 条目差分。返回 {ok, commit, added, changed, removed, error}。

    远程删除了条目（removed 非空）时的语义：
    - removed_action 为 None → 不应用本次同步（目录/快照/last_commit 保持旧态），
      返回 needs_action 交由 UI 询问用户（同步删除 / 转为本地 / 取消）；
    - "delete" → 条目从目录移除；本地库副本一并清除（内容备份到 .versions；
      已分发到工具的文件保留不动）；
    - "localize" → 已拉取过本地的副本脱离该源（source_id 置空，成为手动条目）；
      仅存在于目录的条目从上一个快照 commit 物化内容为手动条目。"""
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
        removed = [nm for nm in old if nm not in new_names]
        if removed and not removed_action:
            # 不应用：保持旧目录/快照/last_commit，交由用户决定处置方式
            detail = []
            for nm in removed:
                reg = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                       (KIND, nm)).fetchone()
                dep = store.db.execute(
                    "SELECT COUNT(*) c FROM deployments WHERE item_kind='skill' AND item_name=? AND status='ok'",
                    (nm,)).fetchone()["c"]
                detail.append({"name": nm, "in_registry": bool(reg), "deployed_count": dep})
            store.db.commit()
            return {"ok": True, "needs_action": True, "commit": commit,
                    "added": added, "changed": changed, "removed": removed,
                    "removed_detail": detail}
        old_commit_row = store.db.execute(
            "SELECT commit_hash FROM snapshots WHERE source_id=? ORDER BY id DESC LIMIT 1",
            (source_id,)).fetchone()
        old_commit = old_commit_row["commit_hash"] if old_commit_row else None
        for it in items:
            store.db.execute(
                "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) "
                "VALUES(?,?,?,?,?,?,?) "
                "ON CONFLICT(source_id, name) DO UPDATE SET path=excluded.path, "
                "source_hash=excluded.source_hash, version=excluded.version, meta=excluded.meta",
                (source_id, KIND, it["name"], it["path"], it["source_hash"], it["version"],
                 json.dumps(it["meta"], ensure_ascii=False)))
        for nm in removed:
            if removed_action == "localize":
                reg = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                       (KIND, nm)).fetchone()
                if reg:
                    store.db.execute(
                        "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL "
                        "WHERE kind=? AND name=?", (KIND, nm))
                else:
                    _materialize_removed_manual(store, cache, old[nm], old_commit)
            else:
                _purge_registry_item_locked(store, nm)
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
               detail={"added": added, "changed": changed, "removed": removed,
                       "removed_action": removed_action})
    # 拉取即落库：新增/变更条目自动物化进本地库（非 force，本地有改动则标记冲突不覆盖）
    materialized = []
    if added or changed:
        materialized = update_registry(store, added + changed,
                                       source_id=source_id, force=False)
    return {"ok": True, "commit": commit, "added": added, "changed": changed, "removed": removed,
            "removed_action": removed_action, "materialized": materialized}


def _mark_error(store, source_id, msg):
    with store.lock:
        store.db.execute("UPDATE sources SET last_error=? WHERE id=?", (msg, source_id))
        store.db.commit()


def _purge_registry_item_locked(store, name):
    """同步删除：清 registry 行 + registry 目录（内容先备份到 .versions）；已分发文件保留。"""
    dest = os.path.join(registry_root(), name)
    if os.path.isdir(dest):
        _backup_registry_dir(name)
        fsutil.safe_rm(dest)
    with store.lock:
        store.db.execute("DELETE FROM registry_items WHERE kind=? AND name=?", (KIND, name))
        store.db.commit()


def _materialize_removed_manual(store, cache, item_row, old_commit):
    """转本地：源已删但从未拉到本地 → 从上一个快照 commit 物化目录 + 登记为手动条目。"""
    name = item_row["name"]
    prefix = (item_row["path"] or "").rstrip("/")
    prefix = prefix + "/" if prefix and prefix != "." else ""
    if not old_commit:
        return False
    files = gitsrc.ls_tree(cache, old_commit)
    member = {p: h for p, h in files.items() if p.startswith(prefix)}
    if not member:
        return False
    dest = os.path.join(registry_root(), name)
    if os.path.isdir(dest):
        return True  # 本地目录还在，直接登记即可
    tmp = dest + ".hub-tmp-%d" % os.getpid()
    if os.path.isdir(tmp):
        fsutil.safe_rm(tmp)
    os.makedirs(tmp, exist_ok=True)
    for rel in sorted(member):
        data = gitsrc.show_bytes(cache, old_commit, rel)
        if data is None:
            continue
        rel_short = rel[len(prefix):] if prefix else rel
        fsutil.atomic_write_bytes(os.path.join(tmp, rel_short), data)
    os.rename(tmp, dest)
    _register_manual(store, name, len(member))
    return True


# ============================================================ manual items
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _safe_rel(rel):
    """条目内相对路径白名单校验（防穿越/隐藏备份文件）。"""
    if not rel or len(rel) > 200 or rel.startswith("/") or "\\" in rel:
        return False
    for seg in rel.split("/"):
        if seg in ("", ".", "..") or seg.startswith(".hub"):
            return False
    return True


def _name_conflict(store, name):
    """与源条目 / registry / 磁盘目录重名 → 返回冲突描述，否则 None。"""
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
    if os.path.isdir(os.path.join(registry_root(), name)):
        return "已存在同名目录（本地库）"
    return None


def _manual_reg(store, name):
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM registry_items WHERE kind=? AND name=? AND source_id IS NULL",
            (KIND, name)).fetchone()
    return dict(row) if row else None


def _fm_description(name):
    p = os.path.join(registry_root(), name, "SKILL.md")
    if os.path.exists(p):
        fm = catalog._parse_frontmatter(open(p, encoding="utf-8", errors="replace").read())
        return fm.get("description", "")
    return ""


def _register_manual(store, name, files_count):
    new_hash = fsutil.tree_hash(os.path.join(registry_root(), name))
    with store.lock:
        prev = store.db.execute("SELECT version, hash FROM registry_items WHERE kind=? AND name=?",
                                (KIND, name)).fetchone()
        store.db.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
            "prev_version, prev_hash, source_hash_at) VALUES(?,?,NULL,?,?,?,?,?,NULL) "
            "ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, "
            "updated_at=excluded.updated_at, prev_version=excluded.prev_version, "
            "prev_hash=excluded.prev_hash, source_hash_at=NULL",
            (KIND, name, _fm_version(name), new_hash, ops.now_iso(),
             prev["version"] if prev else None, prev["hash"] if prev else None))
        store.db.commit()
    return new_hash


def _fm_version(name):
    p = os.path.join(registry_root(), name, "SKILL.md")
    if os.path.exists(p):
        fm = catalog._parse_frontmatter(open(p, encoding="utf-8", errors="replace").read())
        return fm.get("version") or None
    return None


def create_manual(store, name, description="", files=None):
    files = files or {}
    name = (name or "").strip()
    if "SKILL.md" not in files:
        return {"ok": False, "error": "缺少 SKILL.md（手动条目必须包含）"}
    for rel, text in files.items():
        if not _safe_rel(rel):
            return {"ok": False, "error": "非法文件路径：%s" % rel[:60]}
        if not isinstance(text, str):
            return {"ok": False, "error": "文件内容必须是文本：%s" % rel[:60]}
    err = _name_conflict(store, name)
    if err:
        return {"ok": False, "error": err}
    if description:
        files = dict(files)
        files["SKILL.md"] = _with_fm_field(files["SKILL.md"], "description", description)
    dest = os.path.join(registry_root(), name)
    tmp = dest + ".hub-tmp-%d" % os.getpid()
    if os.path.isdir(tmp):
        fsutil.safe_rm(tmp)
    os.makedirs(tmp, exist_ok=True)
    for rel, text in sorted(files.items()):
        fsutil.atomic_write_text(os.path.join(tmp, rel), text)
    os.rename(tmp, dest)
    new_hash = _register_manual(store, name, len(files))
    ops.log_op(store, MODULE, "create", "ok", item_kind="skill", item_name=name,
               detail={"files": len(files), "hash": new_hash[:12]})
    return {"ok": True, "name": name, "files": len(files), "hash": new_hash[:12]}


def _with_fm_field(text, key, value):
    """frontmatter 里设置/替换一个字段；无 frontmatter 则生成。"""
    lines = text.splitlines()
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end:
            body = [l for l in lines[1:end] if not l.strip().startswith(key + ":")]
            return "\n".join([lines[0]] + body + ["%s: %s" % (key, value)] + lines[end:])
    fm = ["---", "name: %s" % (key == "name" and value or ""), "%s: %s" % (key, value), "---", ""]
    return "\n".join(fm) + text


def import_local(store, src_path, name=None, overwrite=False):
    """把本地目录复制为手动条目（原目录只读）；已存在同名手动条目且 overwrite=True → 覆盖更新。"""
    src_path = os.path.realpath(os.path.expanduser((src_path or "").strip()))
    if not os.path.isdir(src_path):
        return {"ok": False, "error": "目录不存在：%s" % (src_path or "（空）")}
    hub_real = os.path.realpath(_hub_dir())
    if src_path == hub_real or src_path.startswith(hub_real + os.sep):
        return {"ok": False, "error": "不能从 hub 自身目录导入"}
    name = (name or os.path.basename(src_path)).strip()
    existing = _manual_reg(store, name)
    if existing and not overwrite:
        return {"ok": False, "error": "已存在同名手动条目 %s；可勾选覆盖更新" % name}
    if not existing:
        err = _name_conflict(store, name)
        if err:
            return {"ok": False, "error": err}
    files = {}
    for dirpath, dirnames, filenames in os.walk(src_path):
        dirnames[:] = [d for d in sorted(dirnames)
                       if d not in (".git", ".hub-backup", ".versions", "node_modules", "__pycache__")]
        for fn in sorted(filenames):
            if fn == ".DS_Store":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, src_path)
            if not _safe_rel(rel):
                continue
            files[rel] = full
    if "SKILL.md" not in files:
        return {"ok": False, "error": "目录中未找到 SKILL.md（导入的条目必须包含）"}
    if existing:
        _backup_registry_dir(name)
        for rel in list(fsutil.list_files(os.path.join(registry_root(), name))):
            if rel not in files:
                p = os.path.join(registry_root(), name, rel)
                if os.path.exists(p):
                    os.unlink(p)
    dest = os.path.join(registry_root(), name)
    tmp = dest + ".hub-tmp-%d" % os.getpid()
    if os.path.isdir(tmp):
        fsutil.safe_rm(tmp)
    os.makedirs(tmp, exist_ok=True)
    for rel, full in sorted(files.items()):
        with open(full, "rb") as f:
            fsutil.atomic_write_bytes(os.path.join(tmp, rel), f.read())
    if not os.path.isdir(dest):
        os.rename(tmp, dest)
    else:
        for rel, full in sorted(files.items()):
            with open(full, "rb") as f:
                fsutil.atomic_write_bytes(os.path.join(dest, rel), f.read())
        fsutil.safe_rm(tmp)
    new_hash = _register_manual(store, name, len(files))
    ops.log_op(store, MODULE, "import", "ok", item_kind="skill", item_name=name,
               detail={"files": len(files), "from": src_path, "overwrite": bool(existing),
                       "hash": new_hash[:12]})
    return {"ok": True, "name": name, "files": len(files), "hash": new_hash[:12],
            "overwritten": bool(existing)}


def update_manual(store, name, files=None):
    """编辑手动条目：files={rel: text|None}，None 表示删除该文件；其余文件保留。"""
    files = files or {}
    if not _manual_reg(store, name):
        return {"ok": False, "error": "只支持编辑本地手动条目（该条目来自远程源）"}
    dest = os.path.join(registry_root(), name)
    if not os.path.isdir(dest):
        return {"ok": False, "error": "本地库目录缺失"}
    for rel, text in files.items():
        if not _safe_rel(rel):
            return {"ok": False, "error": "非法文件路径：%s" % rel[:60]}
        if text is not None and not isinstance(text, str):
            return {"ok": False, "error": "文件内容必须是文本：%s" % rel[:60]}
    _backup_registry_dir(name)
    for rel, text in sorted(files.items()):
        p = os.path.join(dest, rel)
        if text is None:
            if os.path.exists(p):
                os.unlink(p)
            continue
        fsutil.atomic_write_text(p, text)
    for dirpath, dirnames, _fn in os.walk(dest, topdown=False):
        if dirpath != dest and not os.listdir(dirpath):
            os.rmdir(dirpath)
    new_hash = _register_manual(store, name, len(files))
    ops.log_op(store, MODULE, "edit", "ok", item_kind="skill", item_name=name,
               detail={"files": sorted(files.keys()), "hash": new_hash[:12]})
    return {"ok": True, "name": name, "hash": new_hash[:12]}


def _backup_registry_dir(name):
    dest = os.path.join(registry_root(), name)
    if not os.path.isdir(dest):
        return None
    vroot = versions_root(name)
    os.makedirs(vroot, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(vroot, stamp)
    n = 1
    while os.path.exists(backup):
        backup = os.path.join(vroot, "%s-%d" % (stamp, n)); n += 1
    shutil.copytree(dest, backup)
    return backup


def delete_manual(store, name, force=False):
    reg = _manual_reg(store, name)
    if not reg:
        with store.lock:
            remote = store.db.execute("SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                                      (KIND, name)).fetchone()
        return {"ok": False, "error": "远程条目不能在此删除（用「移除源」或「回退」）" if remote
                else "条目不存在"}
    with store.lock:
        deps = [dict(r) for r in store.db.execute(
            "SELECT * FROM deployments WHERE item_kind='skill' AND item_name=? AND status='ok'",
            (name,)).fetchall()]
    if deps and not force:
        return {"ok": False, "error": "已部署到 %d 个目标；确认后连同目标内文件一起删除" % len(deps)}
    removed_targets = []
    for dep in deps:
        t = store.db.execute("SELECT * FROM targets WHERE id=?", (dep["target_id"],)).fetchone()
        if not t:
            continue
        t = dict(t)
        dest = os.path.join(t["path"], name)
        if os.path.isdir(dest):
            managed = (json.loads(dep["detail"]) if dep["detail"] else {}).get("files", {})
            for rel in managed:
                p = os.path.join(dest, rel)
                if os.path.exists(p):
                    os.unlink(p)
            backup_dir = os.path.join(dest, ".hub-backup")
            if os.path.isdir(backup_dir):
                import shutil as _sh
                _sh.rmtree(backup_dir)
            for dirpath, dirnames, _fn in os.walk(dest, topdown=False):
                if dirpath != dest and not os.listdir(dirpath):
                    os.rmdir(dirpath)
            if os.path.isdir(dest) and not os.listdir(dest):
                import shutil as _sh2
                _sh2.rmtree(dest)  # 仅空目录（managed 文件已逐个删除）
            removed_targets.append(t["name"])
    if os.path.isdir(os.path.join(registry_root(), name)):
        _backup_registry_dir(name)
        fsutil.safe_rm(os.path.join(registry_root(), name))
    with store.lock:
        store.db.execute("DELETE FROM deployments WHERE item_kind='skill' AND item_name=?", (name,))
        store.db.execute("DELETE FROM registry_items WHERE kind=? AND name=?", (KIND, name))
        store.db.commit()
    ops.log_op(store, MODULE, "delete", "ok", item_kind="skill", item_name=name,
               detail={"removed_from_targets": removed_targets})
    return {"ok": True, "name": name, "removed_from_targets": removed_targets}


# ============================================================ registry
# ============================================================ 工具来源（反向提取）
def _skill_tools(store):
    """启用了 skills_dir 的工具清单（工具来源的扫描范围）。"""
    from hub import tools_registry
    return [t for t in tools_registry.load_tools(store)
            if t.get("enabled") and t.get("skills_dir")]


def tool_items(store, tool_id=None):
    """扫描工具 skills 目录并与本地库对齐，条目名做键分三态。

    synced=与本地库内容一致 / diff=同名不同内容 / local_only=本地库没有。
    tool_id 缺省时聚合全部工具：同一条目跨工具出现则按 name 聚合，
    tools 列出出现它的工具，任一工具与本地库不一致即标 diff。
    目录探不到的工具直接跳过（置灰语义由前端表达）。
    """
    tools = _skill_tools(store)
    if tool_id:
        tools = [t for t in tools if t["id"] == tool_id]
    reg = {r["name"]: r["hash"] for r in store.db.execute(
        "SELECT name, hash FROM registry_items WHERE kind=?", (KIND,)).fetchall()}
    agg = {}
    for t in tools:
        root = os.path.expanduser(t["skills_dir"])
        if not os.path.isdir(root):
            continue
        meta = {"id": t["id"], "name": t["name"]}
        for entry in sorted(os.listdir(root)):
            d = os.path.join(root, entry)
            if not os.path.isdir(d) or entry.startswith("."):
                continue
            cur = agg.get(entry)
            if cur is None:
                cur = {"name": entry, "state": "synced" if entry in reg else "local_only",
                       "tools": []}
                agg[entry] = cur
            if entry not in reg:
                cur["state"] = "local_only"
            elif reg[entry] != fsutil.tree_hash(d):
                cur["state"] = "diff"
            cur["tools"].append(meta)
    return {"ok": True,
            "items": sorted(agg.values(), key=lambda x: (-{"local_only": 0, "diff": 1, "synced": 2}[x["state"]], x["name"]))}


def extract(store, tool_id, names):
    """把工具 skills 目录中指定条目收编进本地库（manual，与源拉取同权）。

    local_only 直接复制；diff 以工具内容为准覆盖本地库（旧内容先备份到
    versions）；synced 跳过。工具内文件保留不动（视为已安装）。逐条返回
    结果并记 ops 台账。
    """
    tools = [t for t in _skill_tools(store) if t["id"] == tool_id]
    if not tools:
        return {"ok": False, "error": "工具不存在、未启用或没有 skills 目录"}
    root = os.path.expanduser(tools[0]["skills_dir"])
    out = []
    for raw in names or []:
        name = str(raw).strip()
        # 防穿越：只接受单段目录名
        ok = bool(name) and name not in (".", "..") and os.path.basename(name) == name
        src = os.path.join(root, name) if ok else None
        if not src or not os.path.isdir(src):
            out.append({"name": name, "ok": False, "error": "工具中不存在该条目"})
            continue
        dest = os.path.join(registry_root(), name)
        existed = os.path.isdir(dest)
        if existed:
            if _registry_current_hash(name) == fsutil.tree_hash(src):
                out.append({"name": name, "ok": True, "skipped": "已与本地库一致"})
                continue
            _backup_registry_dir(name)
            fsutil.safe_rm(dest)
        shutil.copytree(src, dest)
        _register_manual(store, name, len(fsutil.list_files(dest)))
        out.append({"name": name, "ok": True, "action": "覆盖本地库" if existed else "已收编"})
    store.log("skills.extract", {"tool": tool_id, "names": names, "results": out})
    return {"ok": True, "items": out}


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
    new_version = None
    with store.lock:
        row = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
        if row:
            row = dict(row)
            # 版本号随内容回退；prev_* 交换指向被回退掉的版本（可再切回）
            new_version = row["prev_version"] or row["version"]
            store.db.execute(
                "UPDATE registry_items SET version=?, hash=?, updated_at=?, "
                "prev_version=?, prev_hash=? WHERE kind=? AND name=?",
                (new_version, new_hash, ops.now_iso(),
                 row["version"], row["hash"], KIND, name))
            store.db.commit()
    ops.log_op(store, MODULE, "rollback", "ok", item_kind="skill", item_name=name,
               item_version=new_version, detail={"restored_from": snaps[-1]})
    return {"ok": True, "hash": new_hash[:12], "version": new_version,
            "restored_from": snaps[-1]}


# ============================================================ targets
def seed_defaults(store):
    """探测本机全局目标并注册（幂等）。"""
    home = os.path.expanduser("~")
    defaults = [
        ("Claude Skills (全局)", "skills_dir", "claude", os.path.join(home, ".claude", "skills"), None),
        # Agents：共享技能目录（Codex CLI / OpenCode / Cursor 原生直读，它们的 skills_dir 置空）
        ("Agents (全局)", "skills_dir", "agents", os.path.join(home, ".agents", "skills"), None),
        ("WorkBuddy Skills (全局)", "skills_dir", "workbuddy", os.path.join(home, ".workbuddy", "skills"), None),
        ("ZCode Skills (全局)", "skills_dir", "zcode", os.path.join(home, ".zcode", "skills"), None),
        ("AutoClaw Skills (全局)", "skills_dir", "autoclaw", os.path.join(home, ".openclaw-autoclaw", "skills"), None),
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
    with store.lock:
        reg_row = store.db.execute("SELECT version FROM registry_items WHERE kind=? AND name=?",
                                   (KIND, name)).fetchone()
        dep_version = dict(reg_row)["version"] if reg_row else plan.get("version")
        store.db.execute(
            "INSERT INTO deployments(item_kind, item_name, item_version, target_id, "
            "deployed_hash, deployed_at, status, detail) VALUES('skill',?,?,?,?,?,?,?) "
            "ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET "
            "item_version=excluded.item_version, deployed_hash=excluded.deployed_hash, "
            "deployed_at=excluded.deployed_at, status=excluded.status, detail=excluded.detail",
            (name, dep_version, target["id"], plan["new_hash"], ops.now_iso(), "ok",
             json.dumps({"files": written, "removed": removed}, ensure_ascii=False)))
        store.db.commit()
    return {"written": len(written), "removed": removed}


def _ensure_materialized(store, name):
    """分发兜底：本地库缺该条目目录但源条目存在 → 自动物化后再分发（两道保险之二）。"""
    if os.path.isdir(os.path.join(registry_root(), name)):
        return
    with store.lock:
        has_src = store.db.execute(
            "SELECT 1 FROM items WHERE kind=? AND name=? LIMIT 1", (KIND, name)).fetchone()
    if has_src:
        update_registry(store, [name], force=False)


def distribute_skills(store, names, target_ids, dry_run=False, force=False):
    """skills → skills_dir 目标。逐条结果。"""
    results = []
    targets = [t for t in list_targets(store, kind="skills_dir") if t["id"] in target_ids]
    for name in names:
        _ensure_materialized(store, name)
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
    """源侧目录 + 本地状态合并视图；手动条目（source_id IS NULL）一并返回。"""
    with store.lock:
        items = []
        if not source_id:
            with store.lock:
                for r in store.db.execute(
                        "SELECT * FROM registry_items WHERE kind=? AND source_id IS NULL ORDER BY name",
                        (KIND,)).fetchall():
                    items.append({"name": r["name"], "version": r["version"], "path": None,
                                  "source_hash": None, "meta": None, "source_name": "本地"})
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
        st = "installed" if manual and reg else _item_status(store, it["name"], reg, it)
        if manual and not reg:
            st = "not-installed"
        desc = ""
        if it.get("meta"):
            desc = (json.loads(it["meta"]) if isinstance(it["meta"], str) else it["meta"]).get("description", "")
        elif manual:
            desc = _fm_description(it["name"])
        out.append({
            "name": it["name"], "version": it["version"],
            "source_name": it.get("source_name") or ("本地" if manual else ""),
            "source_id": None if manual else it.get("source_id"),
            "manual": bool(manual),
            "description": desc,
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
            "manual": r["source_id"] is None,
            "modified": bool(cur_hash and r["hash"] and cur_hash != r["hash"]),
            "deployments": dep_map.get(r["name"], []),
        })
    return out


def item_detail(store, name):
    """条目详情：优先本地库；本地库没有（远程条目尚未「更新到本地」）时，回落读源仓库缓存。"""
    reg_dir = os.path.join(registry_root(), name)
    if not os.path.isdir(reg_dir):
        with store.lock:
            row = store.db.execute(
                "SELECT source_id, path FROM items WHERE kind=? AND name=? ORDER BY id DESC LIMIT 1",
                (KIND, name)).fetchone()
        if not row or not row["path"]:
            return None
        src_dir = os.path.join(sources_root(), "skills-%d" % row["source_id"], row["path"])
        if not os.path.isdir(src_dir):
            return None
        reg_dir = src_dir
        from_source = True
    else:
        from_source = False
    files = fsutil.list_files(reg_dir)
    skill_md = None
    p = os.path.join(reg_dir, "SKILL.md")
    if os.path.exists(p):
        skill_md = open(p, encoding="utf-8", errors="replace").read()[:12000]
    with store.lock:
        reg = store.db.execute("SELECT * FROM registry_items WHERE kind=? AND name=?",
                               (KIND, name)).fetchone()
    return {"name": name, "skill_md": skill_md, "files": sorted(files.keys()),
            "version": dict(reg)["version"] if reg else None,
            "manual": bool(reg and dict(reg)["source_id"] is None),
            "from_source": from_source}


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
            return _r(pull_source(store, sid, force=bool(body.get("force")),
                                  removed_action=body.get("removed_action")))
        if not tail and method == "PATCH":
            return _r(update_source(store, sid, body))
        if not tail and method == "DELETE":
            return _r(delete_source(store, sid, removed_action=body.get("removed_action")))
    # ---- catalog / registry ----
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
        return 200, items_view(store, source=src, q=_q("q") or None,
                               page=_q("page", 1), per_page=_q("per_page", 20))
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
    # ---- manual items ----
    if path == PREFIX + "/registry/item" and method == "POST":
        return _r(create_manual(store, body.get("name"), body.get("description", ""),
                                body.get("files")))
    if path == PREFIX + "/registry/import" and method == "POST":
        return _r(import_local(store, body.get("path"), body.get("name"),
                               overwrite=bool(body.get("overwrite"))))
    if path.startswith(PREFIX + "/registry/item/") and method == "PUT":
        return _r(update_manual(store, path[len(PREFIX + "/registry/item/"):],
                                body.get("files")))
    if path.startswith(PREFIX + "/registry/item/") and method == "DELETE":
        return _r(delete_manual(store, path[len(PREFIX + "/registry/item/"):],
                                force=bool(body.get("force"))))
    # ---- targets ----
    if path == PREFIX + "/targets" and method == "GET":
        # 展示口径与 items_view 一致：停用/路径为空的工具目标不返回；附带工具名
        rows = [t for t in list_targets(store, kind="skills_dir")
                if _target_visible(store, t.get("tool"), "skills_dir")]
        tmap = _tool_names(store)
        for r in rows:
            r["tool_name"] = tmap.get(r.get("tool"))
        return 200, {"ok": True, "targets": rows}
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
    # ---- 工具来源（反向提取）----
    if path == PREFIX + "/tool-items" and method == "GET":
        return 200, tool_items(store, (q.get("tool") or [None])[0])
    if path == PREFIX + "/extract" and method == "POST":
        return 200, extract(store, body.get("tool"), body.get("names") or [])
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


def _tool_names(store):
    """工具 id → 显示名映射（给分发目标卡片展示工具名用）。"""
    from hub import tools_registry
    return {t["id"]: t["name"] for t in tools_registry.load_tools(store)}


def _target_visible(store, tool_id, path_key=None):
    """分发目标是否应展示：绑定了工具的，工具停用或对应路径为空即隐藏；
    无绑定（plain/手填）的始终展示。path_key 为目标依赖的工具路径字段
    （Skills 目标用 skills_dir，MCP 目标用 mcp_config）——路径为空不在界面显示。"""
    from hub import tools_registry
    if not tool_id or tool_id == "plain":
        return True
    t = tools_registry.tool_by_id(store, tool_id)
    if not t or not t.get("enabled", True):
        return False
    return not path_key or bool(t.get(path_key))


def items_view(store, source=None, q=None, page=1, per_page=20):
    """统一条目列表：来源过滤 + 关键词 + 分页 + 逐目标部署状态/版本差异（供新 UI 右栏联动）。

    停用工具的分发目标不展示（与设置中心「禁用的工具在所有界面隐藏」一致）。
    """
    # source 可以是数字（远程源 id）或 "manual"（本地手动条目）；其它字符串按"不过滤"处理
    if isinstance(source, str) and source.lower() in ("manual", "local"):
        cat = [it for it in catalog_view(store) if it.get("manual")]
    else:
        cat = catalog_view(store, source_id=source if isinstance(source, int) else None)
    if q:
        cat = [it for it in cat if q.lower() in it["name"].lower()
               or q.lower() in (it.get("description") or "").lower()]
    total = len(cat)
    page = max(1, int(page or 1))
    per_page = min(100, max(5, int(per_page or 20)))
    slice_ = cat[(page - 1) * per_page: page * per_page]
    names = [it["name"] for it in slice_]
    with store.lock:
        trows = [dict(r) for r in store.db.execute(
            "SELECT * FROM targets WHERE kind='skills_dir' ORDER BY id").fetchall()]
        deps = [dict(r) for r in store.db.execute(
            "SELECT d.*, t.name AS target_name FROM deployments d LEFT JOIN targets t ON t.id=d.target_id "
            "WHERE d.item_kind='skill' AND d.status='ok'").fetchall()]
    trows = [t for t in trows if _target_visible(store, t.get("tool"), "skills_dir")]
    tmap = _tool_names(store)
    visible_ids = {t["id"] for t in trows}
    deps = [d for d in deps if d["target_id"] in visible_ids]
    regs = {r["name"]: r for r in registry_view(store)}
    with store.lock:
        full_hash = {r["name"]: r["hash"] for r in store.db.execute(
            "SELECT name, hash FROM registry_items WHERE kind=?", (KIND,)).fetchall()}
    dep_by_item = {}
    for d in deps:
        dep_by_item.setdefault(d["item_name"], {})[d["target_id"]] = d
    targets = []
    for t in trows:
        tj = {"id": t["id"], "name": t["name"], "tool_name": tmap.get(t.get("tool")),
              "path": t["path"], "tool": t["tool"],
              "items": {"latest": 0, "stale": 0, "missing": 0, "total": 0}, "stale_names": []}
        for it in cat:  # 全量统计（含本页外），与工具聚合口径一致
            dep = dep_by_item.get(it["name"], {}).get(t["id"])
            reg = regs.get(it["name"])
            if dep:
                tj["items"]["total"] += 1
                if reg and dep["deployed_hash"] and full_hash.get(it["name"]) and dep["deployed_hash"] != full_hash[it["name"]]:
                    tj["items"]["stale"] += 1
                    tj["stale_names"].append(it["name"])
                else:
                    tj["items"]["latest"] += 1
            else:
                tj["items"]["missing"] += 1
        targets.append(tj)
    rows = []
    for it in slice_:
        reg = regs.get(it["name"])
        per_target = []
        for t in trows:
            dep = dep_by_item.get(it["name"], {}).get(t["id"])
            if dep:
                stale = bool(full_hash.get(it["name"]) and dep["deployed_hash"]
                             and dep["deployed_hash"] != full_hash[it["name"]])
                per_target.append({"target_id": t["id"], "target": t["name"], "state":
                                   "stale" if stale else "latest",
                                   "deployed_version": dep["item_version"],
                                   "local_version": reg["version"] if reg else None,
                                   "deployed_at": dep["deployed_at"]})
            else:
                per_target.append({"target_id": t["id"], "target": t["name"], "state": "missing",
                                   "deployed_version": None, "local_version": reg["version"] if reg else None,
                                   "deployed_at": None})
        rows.append({**it, "hash": (reg or {}).get("hash", ""),
                     "updated_at": (reg or {}).get("updated_at"),
                     "modified": (reg or {}).get("modified", False),
                     "deployments": (reg or {}).get("deployments", []),
                     "per_target": per_target})
    return {"ok": True, "items": rows, "total": total, "page": page,
            "per_page": per_page, "pages": max(1, (total + per_page - 1) // per_page),
            "targets": targets}


def _r(res):
    if res.get("ok"):
        return 200, res
    return 400, res
