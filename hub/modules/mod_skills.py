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

from hub import paths
from hub.core import fsutil, ops, remote_repos, local_dirs
from hub.lib import catalog, gitsrc

MODULE = "skills"
KIND = "skills"
PREFIX = "/api/skills"


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


def sources_root():
    return os.path.join(_hub_dir(), "sources")


def registry_root():
    return os.path.join(_hub_dir(), "registry", "skills")


def _item_root(store, name):
    """手动条目的落盘根：登记在本地目录（local_dirs）→ 该目录；否则默认库 registry/skills。"""
    with store.lock:
        row = store.db.execute(
            "SELECT d.path AS p FROM registry_items r JOIN local_dirs d ON d.id=r.dir_id "
            "WHERE r.kind=? AND r.name=?", (KIND, name)).fetchone()
    return row["p"] if row and row["p"] else registry_root()


def _item_sub(store, name):
    """条目所属集合子文件夹（关联目录自动发现）：'' = 目录自身即条目根（普通模式）。
    容器模式下条目物理位置 = <root>/<sub>/<name>。"""
    with store.lock:
        row = store.db.execute(
            "SELECT sub_path FROM registry_items WHERE kind=? AND name=?",
            (KIND, name)).fetchone()
    return (row["sub_path"].replace("/", os.sep) if row and row["sub_path"] else "")


def _item_dir(store, name):
    """条目实际落盘目录 = <dir根>/<sub>/<name>（sub 为空 = 普通模式目录根下）。"""
    sub = _item_sub(store, name)
    return os.path.join(_item_root(store, name), sub, name) if sub else \
        os.path.join(_item_root(store, name), name)


def _item_dirs_map(store):
    """批量版 _item_dir：一次查询拿到全部手动条目的实际目录（视图层用，
    避免每条目一次 SQL 的查询风暴——2026-10-31 追查 500 查询/秒风暴时引入）。"""
    with store.lock:
        rows = store.db.execute(
            "SELECT r.name, r.sub_path AS sub, d.path AS p FROM registry_items r "
            "LEFT JOIN local_dirs d ON d.id=r.dir_id "
            "WHERE r.kind=? AND r.source_id IS NULL", (KIND,)).fetchall()
    out = {}
    for r in rows:
        root = r["p"] or registry_root()
        sub = (r["sub"] or "").replace("/", os.sep)
        out[r["name"]] = os.path.join(root, sub, r["name"]) if sub else os.path.join(root, r["name"])
    return out


def _container_root(d, kind):
    """目录的写入根：容器目录（layout 有该 kind 的集合子文件夹）→ 第一个子文件夹；
    普通目录 → 目录自身（否则写进容器根会扫描不到）。"""
    try:
        layout = json.loads(d.get("layout") or "null") or {}
    except Exception:
        layout = {}
    subs = layout.get(kind) or []
    if subs:
        return os.path.join(d["path"], subs[0].replace("/", os.sep))
    return d["path"]


def _dir_root(store, dir_id):
    """新建/导入指定的目标目录根；dir_id 为空 → 默认库。非法目录报错由调用方兜底。"""
    if not dir_id:
        return registry_root(), None
    d = local_dirs.get_dir(store, dir_id)
    if not d:
        return None, "本地目录不存在（id=%s）" % dir_id
    return _container_root(d, KIND), None


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
    remote_repos.link_source(store, KIND, sid)      # 同步到 设置 → 远程仓库
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
    payload = {k: v for k, v in (fields or {}).items() if k in allowed}
    if not payload:
        return {"ok": False, "error": "无更新字段"}
    # 共享字段同步主表与另一模块的同仓库记录；重名/重址冲突在这里拦下
    err = remote_repos.update_from_source(store, KIND, source_id, payload)
    if err:
        return {"ok": False, "error": err}
    ops.log_op(store, MODULE, "source:update", "ok", source_id=source_id, detail=payload)
    return {"ok": True}


def delete_source(store, source_id, removed_action=None):
    """移除源：删 items/snapshots/源记录 + git 缓存目录；registry 与已部署内容默认不动。

    removed_action：
    - None / "keep" → 本地库副本保留但转为手动条目（脱离源，避免孤儿引用）——移除源的默认语义；
    - "delete" → 本地库副本一并清除（备份到 .versions；已分发文件保留）。"""
    with store.lock:
        src = store.db.execute("SELECT name, url, branch, subdir, repo_id FROM sources "
                               "WHERE id=? AND kind=?", (source_id, KIND)).fetchone()
        items = [dict(r) for r in store.db.execute(
            "SELECT * FROM items WHERE source_id=?", (source_id,)).fetchall()]
        store.db.execute("DELETE FROM items WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM snapshots WHERE source_id=?", (source_id,))
        store.db.execute("DELETE FROM sources WHERE id=? AND kind=?", (source_id, KIND))
        store.db.commit()
    if src:
        import shutil as _sh
        cache = paths.source_cache_dir(KIND, src["url"], src["branch"], src["subdir"])
        if os.path.isdir(cache):
            _sh.rmtree(cache, ignore_errors=True)
        remote_repos.prune_repo(store, src["repo_id"])   # 没有模块再用它 → 设置页也移除
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
def sync_from_cache(store, source_id):
    """把本地缓存里**已存在的**提交同步进索引（不联网）。

    场景：远端仓库更新了，但本机连不上 github（拉取报 443）；或你在应用外手动 git pull 过。
    这里直接读缓存 HEAD → 解析 → 与索引差分 → 应用，复用 pull_source 的后半段逻辑。
    返回 {ok, commit, added, changed, removed, error}。
    """
    with store.lock:
        row = store.db.execute("SELECT * FROM sources WHERE id=? AND kind=?", (source_id, KIND)).fetchone()
    if not row:
        return {"ok": False, "error": "源不存在"}
    src = dict(row)
    cache = paths.source_cache_dir(KIND, src["url"], src["branch"], src["subdir"])
    if not os.path.isdir(os.path.join(cache, ".git")):
        return {"ok": False, "error": "本地还没有该源的缓存（需要先联网拉取一次）"}
    import subprocess
    try:
        commit = subprocess.run(["git", "-C", cache, "rev-parse", "HEAD"], capture_output=True,
                                text=True, timeout=20).stdout.strip()
    except Exception as e:
        return {"ok": False, "error": "读取本地缓存失败：%s" % e}
    if not commit:
        return {"ok": False, "error": "读取本地缓存提交失败"}
    if commit == (src.get("last_commit") or ""):
        return {"ok": True, "commit": commit, "added": [], "changed": [], "removed": [],
                "unchanged": True, "message": "本地缓存与索引一致，无需同步"}
    # 复用 pull 的解析 + 差分逻辑（把 ensure_cache 换成"读本地 HEAD"）
    files = gitsrc.ls_tree(cache, commit)
    show = lambda p: gitsrc.show_bytes(cache, commit, p)  # noqa: E731
    items = catalog.parse_skills(files, show, commit, subdir=src["subdir"] or "")
    if not items:
        return {"ok": False, "error": "本地缓存里没解析到任何 skill"}
    added, changed, removed = [], [], []
    with store.lock:
        old = {r["name"]: dict(r) for r in store.db.execute(
            "SELECT * FROM items WHERE source_id=?", (source_id,)).fetchall()}
        new_names = set()
        for it in items:
            new_names.add(it["name"])
            it["version"] = it["version"] or commit
            prev = old.get(it["name"])
            if prev is None:
                added.append(it["name"])
                store.db.execute(
                    "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (source_id, KIND, it["name"], it["path"], it.get("source_hash"), it["version"],
                     json.dumps(it.get("meta") or {}, ensure_ascii=False)))
            elif prev.get("source_hash") != it.get("source_hash"):
                changed.append(it["name"])
                store.db.execute(
                    "UPDATE items SET path=?, source_hash=?, version=?, meta=? WHERE source_id=? AND name=?",
                    (it["path"], it.get("source_hash"), it["version"],
                     json.dumps(it.get("meta") or {}, ensure_ascii=False), source_id, it["name"]))
        for name in old:
            if name not in new_names:
                removed.append(name)
                store.db.execute("DELETE FROM items WHERE source_id=? AND name=?", (source_id, name))
        store.db.execute("UPDATE sources SET last_commit=?, last_sync_at=?, last_error=NULL WHERE id=?",
                         (commit, ops.now_iso(), source_id))
    ops.log_op(store, MODULE, "sync-local", "ok", source_id=source_id, item_name=src["name"],
               detail={"commit": commit, "added": len(added), "changed": len(changed), "removed": len(removed)})
    return {"ok": True, "commit": commit, "added": added, "changed": changed, "removed": removed}


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
    cache = paths.source_cache_dir(KIND, src["url"], src["branch"], src["subdir"])
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
        _backup_registry_dir(store, name)
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


def _name_conflict(store, name, root=None):
    """与源条目 / registry / 磁盘目录重名 → 返回冲突描述，否则 None。

    root：目标落盘根（默认库或本地目录）；磁盘查重针对实际落点。
    """
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
    if os.path.isdir(os.path.join(root or registry_root(), name)):
        return "已存在同名目录"
    return None


def _manual_reg(store, name):
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM registry_items WHERE kind=? AND name=? AND source_id IS NULL",
            (KIND, name)).fetchone()
    return dict(row) if row else None


def _fm_description(store, name, item_dir=None):
    p = os.path.join(item_dir or _item_dir(store, name), "SKILL.md")
    if os.path.exists(p):
        fm = catalog._parse_frontmatter(open(p, encoding="utf-8", errors="replace").read())
        return fm.get("description", "")
    return ""


def _sub_for_root(store, dir_id, root):
    """由写入根反推集合子文件夹（容器目录）：root 在目录根之下 → 相对路径。"""
    if not dir_id or not root:
        return None
    d = local_dirs.get_dir(store, dir_id)
    if not d:
        return None
    try:
        rel = os.path.relpath(root, d["path"])
    except Exception:
        return None
    return None if rel in (".", "") else rel.replace(os.sep, "/")


def _register_manual(store, name, files_count, root=None, dir_id=None):
    new_hash = fsutil.tree_hash(os.path.join(root or registry_root(), name))
    with store.lock:
        prev = store.db.execute("SELECT version, hash FROM registry_items WHERE kind=? AND name=?",
                                (KIND, name)).fetchone()
        store.db.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
            "prev_version, prev_hash, source_hash_at, dir_id, sub_path) "
            "VALUES(?,?,NULL,?,?,?,?,?,NULL,?,?) "
            "ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, "
            "updated_at=excluded.updated_at, prev_version=excluded.prev_version, "
            "prev_hash=excluded.prev_hash, source_hash_at=NULL, dir_id=excluded.dir_id, "
            "sub_path=excluded.sub_path",
            (KIND, name, _fm_version(store, name), new_hash, ops.now_iso(),
             prev["version"] if prev else None, prev["hash"] if prev else None, dir_id,
             _sub_for_root(store, dir_id, root)))
        store.db.commit()
    return new_hash


def _fm_version(store, name):
    p = os.path.join(_item_dir(store, name), "SKILL.md")
    if os.path.exists(p):
        fm = catalog._parse_frontmatter(open(p, encoding="utf-8", errors="replace").read())
        return fm.get("version") or None
    return None


def create_manual(store, name, description="", files=None, dir_id=None):
    files = files or {}
    name = (name or "").strip()
    if "SKILL.md" not in files:
        return {"ok": False, "error": "缺少 SKILL.md（手动条目必须包含）"}
    for rel, text in files.items():
        if not _safe_rel(rel):
            return {"ok": False, "error": "非法文件路径：%s" % rel[:60]}
        if not isinstance(text, str):
            return {"ok": False, "error": "文件内容必须是文本：%s" % rel[:60]}
    root, err = _dir_root(store, dir_id)
    if err:
        return {"ok": False, "error": err}
    err = _name_conflict(store, name, root=root)
    if err:
        return {"ok": False, "error": err}
    if description:
        files = dict(files)
        files["SKILL.md"] = _with_fm_field(files["SKILL.md"], "description", description)
    dest = os.path.join(root, name)
    tmp = dest + ".hub-tmp-%d" % os.getpid()
    if os.path.isdir(tmp):
        fsutil.safe_rm(tmp)
    os.makedirs(tmp, exist_ok=True)
    for rel, text in sorted(files.items()):
        fsutil.atomic_write_text(os.path.join(tmp, rel), text)
    os.rename(tmp, dest)
    new_hash = _register_manual(store, name, len(files), root=root, dir_id=dir_id or None)
    ops.log_op(store, MODULE, "create", "ok", item_kind="skill", item_name=name,
               detail={"files": len(files), "hash": new_hash[:12],
                       "dir": root if dir_id else "默认"})
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


def import_local(store, src_path, name=None, overwrite=False, dir_id=None):
    """把本地目录复制为手动条目（原目录只读）；已存在同名手动条目且 overwrite=True → 覆盖更新。

    dir_id：目标本地目录（省略 = 默认库）；覆盖更新不换目录（登记归属保持不变）。
    """
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
    root, err = _dir_root(store, existing["dir_id"] if existing else dir_id)
    if err:
        return {"ok": False, "error": err}
    if not existing:
        err = _name_conflict(store, name, root=root)
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
        _backup_registry_dir(store, name)
        for rel in list(fsutil.list_files(os.path.join(root, name))):
            if rel not in files:
                p = os.path.join(root, name, rel)
                if os.path.exists(p):
                    os.unlink(p)
    dest = os.path.join(root, name)
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
    new_hash = _register_manual(store, name, len(files), root=root,
                                dir_id=(existing["dir_id"] if existing else (dir_id or None)))
    ops.log_op(store, MODULE, "import", "ok", item_kind="skill", item_name=name,
               detail={"files": len(files), "from": src_path, "overwrite": bool(existing),
                       "dir": root, "hash": new_hash[:12]})
    return {"ok": True, "name": name, "files": len(files), "hash": new_hash[:12],
            "overwritten": bool(existing)}


def update_manual(store, name, files=None):
    """编辑手动条目：files={rel: text|None}，None 表示删除该文件；其余文件保留。"""
    files = files or {}
    reg = _manual_reg(store, name)
    if not reg:
        return {"ok": False, "error": "只支持编辑本地手动条目（该条目来自远程源）"}
    dest = _item_dir(store, name)
    if not os.path.isdir(dest):
        return {"ok": False, "error": "本地库目录缺失"}
    for rel, text in files.items():
        if not _safe_rel(rel):
            return {"ok": False, "error": "非法文件路径：%s" % rel[:60]}
        if text is not None and not isinstance(text, str):
            return {"ok": False, "error": "文件内容必须是文本：%s" % rel[:60]}
    _backup_registry_dir(store, name)
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
    new_hash = _register_manual(store, name, len(files), root=os.path.dirname(dest),
                                dir_id=reg.get("dir_id"))
    ops.log_op(store, MODULE, "edit", "ok", item_kind="skill", item_name=name,
               detail={"files": sorted(files.keys()), "hash": new_hash[:12]})
    return {"ok": True, "name": name, "hash": new_hash[:12]}


def _backup_registry_dir(store, name):
    dest = _item_dir(store, name)
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
        if os.path.islink(dest):
            os.unlink(dest)          # 软链接只删链接，本地库内容由下方统一处理
            removed_targets.append(t["name"])
            continue
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
    item_dir = _item_dir(store, name)
    if os.path.isdir(item_dir):
        _backup_registry_dir(store, name)
        if _item_root(store, name) == registry_root():
            fsutil.safe_rm(item_dir)   # safe_rm 只放行 hub 自管目录
        else:
            shutil.rmtree(item_dir)    # 本地目录在 hub 外，不能走 safe_rm
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
    hashed = {}          # 目录 → 内容哈希：多个工具指向同一目录（如 ~/.agents/skills）时只整树算一次
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
            elif hashed.setdefault(d, fsutil.tree_hash(d)) != reg[entry]:
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
        # 已登记在本地目录的条目：收编覆盖也写回它所在的目录（登记归属不变）
        reg_row = _manual_reg(store, name)
        if reg_row and reg_row.get("dir_id"):
            dest = _item_dir(store, name)
        existed = os.path.isdir(dest)
        if existed:
            if _registry_current_hash(store, name) == fsutil.tree_hash(src):
                out.append({"name": name, "ok": True, "skipped": "已与本地库一致"})
                continue
            _backup_registry_dir(store, name)
            if dest.startswith(os.path.realpath(_hub_dir()) + os.sep):
                fsutil.safe_rm(dest)
            else:
                shutil.rmtree(dest)
        shutil.copytree(src, dest)
        _register_manual(store, name, len(fsutil.list_files(dest)),
                         root=os.path.dirname(dest), dir_id=reg_row.get("dir_id") if reg_row else None)
        out.append({"name": name, "ok": True, "action": "覆盖本地库" if existed else "已收编"})
    store.log("skills.extract", {"tool": tool_id, "names": names, "results": out})
    return {"ok": True, "items": out}


def sync_to_targets(store, tool_id, names, target_ids, mode="copy"):
    """把一个工具里已安装的技能一键同步到其它工具（同名覆盖）。

    复用「提取 + 分发」同一条资产管线：先以工具内实际内容为准收编进本地库
    （有差异先备份），再按 mode（copy / link）写到所选目标；两种表示互斥。
    源工具自己的目标会被剔除，避免原地重写；返回 {ok, extracted, results}。
    """
    mode = "link" if str(mode or "").lower() == "link" else "copy"
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
            "SELECT id FROM targets WHERE kind='skills_dir' AND tool=?", (tool_id,)).fetchall()}
        valid = {r["id"] for r in store.db.execute(
            "SELECT id FROM targets WHERE kind='skills_dir'").fetchall()}
    tids = [t for t in ids if t in valid and t not in own]
    if not tids:
        return {"ok": False, "error": "没有可用的目标工具（源工具自身不作为目标）"}
    ex = extract(store, tool_id, names)
    if not ex.get("ok"):
        return ex
    extracted = ex.get("items") or []
    outgoing = [x["name"] for x in extracted if x.get("ok")]
    results = distribute_skills(store, outgoing, tids, force=True, mode=mode) if outgoing else []
    ops.log_op(store, MODULE, "tool-sync", "ok", item_kind="skill",
               detail={"tool": tool_id, "names": outgoing, "target_ids": tids, "mode": mode})
    return {"ok": True, "extracted": extracted, "results": results}


def _item_status(store, name, reg, src_item):
    """状态机：未安装 | 已安装 | 可更新 | 本地修改。"""
    if not reg:
        return "not-installed"
    cur_hash = _registry_current_hash(store, name)
    if cur_hash and reg["hash"] and cur_hash != reg["hash"]:
        return "local-modified"
    if src_item and reg.get("source_hash_at") and src_item["source_hash"] != reg["source_hash_at"]:
        return "update-available"
    return "installed"


def _registry_current_hash(store, name):
    d = _item_dir(store, name)
    if not os.path.isdir(d):
        return None
    return fsutil.tree_hash(d)


def _materialize(store, item_row, commit):
    """把源条目落盘到 registry/<name>（tmp 目录 + 交换），返回 {files: {rel: sha}}。"""
    cache = _source_cache(store, item_row["source_id"])
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
            cur_hash = _registry_current_hash(store, name)
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


def _move(src, dst):
    """跨设备安全的目录移动（链接目录可能在另一个卷上，os.rename 会 EXDEV）。"""
    try:
        os.rename(src, dst)
    except OSError:
        shutil.copytree(src, dst)
        shutil.rmtree(src)


def rollback_registry(store, name):
    """本地库回退到上一个版本快照。"""
    vroot = versions_root(name)
    if not os.path.isdir(vroot):
        return {"ok": False, "error": "没有可回退的版本快照"}
    snaps = sorted(d for d in os.listdir(vroot) if not d.startswith("."))
    if not snaps:
        return {"ok": False, "error": "版本快照为空"}
    latest = os.path.join(vroot, snaps[-1])
    dest = _item_dir(store, name)
    # 当前版本转存为新快照（可再回退）；同秒多次回退 → -n 后缀去碰撞
    if os.path.isdir(dest):
        stamp = time.strftime("%Y%m%d-%H%M%S") + "-pre-rollback"
        target_snap = os.path.join(vroot, stamp)
        n = 1
        while os.path.exists(target_snap):
            target_snap = os.path.join(vroot, "%s.%d" % (stamp, n))
            n += 1
        _move(dest, target_snap)
    _move(latest, dest)
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
        # Agents：共享技能目录（Codex CLI / OpenCode / Cursor / Pi-Agent 直读同一目录，
        # 它们的 skills_dir 也指向这里，故分发目标只有这一行，工具来源卡片会有多张）
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
    out = [dict(r) for r in rows]
    if kind in (None, "skills_dir"):
        _enrich_target_tools(store, out)
    return out


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


def _dep_detail(dep):
    """部署记录 detail；老记录没有 mode 字段时按「直接复制」处理。"""
    if not dep or not dep.get("detail"):
        return {}
    try:
        return json.loads(dep["detail"])
    except (TypeError, ValueError):
        return {}


def _link_live(dest, reg_dir, detail):
    """目标处是否为指向本地库该技能的有效软链接。"""
    return (detail.get("mode") == "link" and os.path.islink(dest)
            and os.path.realpath(dest) == os.path.realpath(reg_dir))


def _clear_target_entry(dest, backup_root=None):
    """清除目标处的同名表示（普通目录 / 软链接），保证同名只留一种。

    软链接只 unlink 链接本身（绝不触碰它指向的内容）；普通目录先整体复制到
    backup_root（隐藏目录，不会被工具来源扫描当成条目）再删除。
    """
    if not os.path.lexists(dest):
        return None
    if os.path.islink(dest):
        os.unlink(dest)
        return None
    backup = None
    if backup_root:
        os.makedirs(backup_root, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(backup_root, "%s.%s" % (os.path.basename(dest), stamp))
        n = 1
        while os.path.exists(backup):
            backup = os.path.join(backup_root, "%s.%s.%d" % (os.path.basename(dest), stamp, n))
            n += 1
        shutil.copytree(dest, backup)
    shutil.rmtree(dest)
    return backup


def _plan_skills_dir(store, name, target, force=False, mode="copy"):
    """返回 plan：{status, reason, mode, files_new, files_changed, ..., dest}。

    mode=copy 时文件复制进目标；mode=link 时目标只放指向本地库的软链接。
    两种表示互斥：切换模式会清掉目标处另一种表示（普通目录先整体备份）。
    """
    mode = "link" if str(mode or "").lower() == "link" else "copy"
    reg_dir = os.path.join(_item_root(store, name), _item_sub(store, name), name)
    if not os.path.isdir(reg_dir):
        return {"status": "failed", "reason": "本地库中不存在该技能（先更新到本地）", "mode": mode}
    new_files = fsutil.list_files(reg_dir)
    new_hash = fsutil.tree_hash_from_files(new_files)
    dest = os.path.join(target["path"], name)
    is_link = os.path.islink(dest)
    dep = _deployment(store, name, target["id"])
    if dep and dep.get("status") == "removed":
        # 已被本 hub 清理过的部署记录（clean 断连/清理）：重新建连视为首次安装，
        # 不触发「记录在案但目标缺失」的 force 守卫（否则 clean 断连后重连 = conflict 死锁）
        dep = None
    detail = _dep_detail(dep)
    dep_mode = detail.get("mode") or "copy"
    link_live = _link_live(dest, reg_dir, detail)
    if mode == "link":
        if dep and dep_mode == "link" and link_live:
            return {"status": "skipped", "reason": "已是软链接（内容跟随本地库）",
                    "dest": dest, "mode": "link"}
        if is_link and not link_live and not force:
            return {"status": "conflict",
                    "reason": "目标位置已有指向别处的软链接；确认后用 force 替换",
                    "dest": dest, "mode": "link"}
        if os.path.isdir(dest) and not is_link and not dep and not force:
            cur = fsutil.list_files(dest)
            if cur and cur != new_files:
                return {"status": "conflict",
                        "reason": "目标位置已存在未托管的同名内容（%d 个文件）；确认后用 force 替换为软链接" % len(cur),
                        "dest": dest, "mode": "link"}
        return {"status": "ok", "action": "link", "dest": dest, "files_new": new_files,
                "files_changed": list(new_files), "conflicts": [], "managed": {},
                "new_hash": new_hash, "mode": "link"}
    # copy 模式：软链接没有自身内容，直接清除后按文件副本落盘
    if is_link:
        if not dep and not force:
            return {"status": "conflict",
                    "reason": "目标位置是未托管的软链接；确认后用 force 替换为文件副本",
                    "dest": dest, "mode": "copy"}
        return {"status": "ok", "action": "copy", "dest": dest, "files_new": new_files,
                "files_changed": list(new_files), "conflicts": [], "managed": {},
                "new_hash": new_hash, "mode": "copy"}
    if dep and dep["deployed_hash"] == new_hash:
        # 再校验目标现状（防被手改后误报 already-current）
        if os.path.isdir(dest):
            cur = fsutil.list_files(dest)
            managed = detail.get("files", {})
            drifted = [f for f, h in managed.items() if cur.get(f) != h]
            if not drifted and not force:
                return {"status": "skipped", "reason": "已是最新（幂等跳过）", "dest": dest,
                        "mode": "copy"}
            if drifted and not force:
                return {"status": "conflict",
                        "reason": "目标文件被手动修改：%s" % ", ".join(drifted[:3]), "dest": dest,
                        "mode": "copy"}
            # force：即使内容一致也整目录重写；有手改则按托管清单恢复
            return {"status": "ok", "action": "restore" if drifted else "overwrite", "dest": dest,
                    "files_new": new_files, "files_changed": drifted, "conflicts": drifted,
                    "managed": managed, "new_hash": new_hash, "mode": "copy"}
        if not force:
            return {"status": "conflict", "reason": "目标目录缺失但记录存在", "dest": dest,
                    "mode": "copy"}
        # force 且目录缺失：按本地库重新落盘
        return {"status": "ok", "action": "recreate", "dest": dest, "files_new": new_files,
                "files_changed": list(new_files), "conflicts": [], "managed": {},
                "new_hash": new_hash, "mode": "copy"}
    if dep:
        # 已托管：检测手改
        managed = detail.get("files", {})
        cur = fsutil.list_files(dest) if os.path.isdir(dest) else {}
        drifted = [f for f, h in managed.items() if cur.get(f, None) != h]
        if drifted and not force:
            return {"status": "conflict",
                    "reason": "目标文件被手动修改：%s" % ", ".join(drifted[:3]), "dest": dest,
                    "mode": "copy"}
        files_changed = [f for f in new_files if managed.get(f) != new_files[f]]
        return {"status": "ok", "action": "update", "dest": dest, "files_new": new_files,
                "files_changed": files_changed, "conflicts": drifted,
                "managed": managed, "new_hash": new_hash, "mode": "copy"}
    # 首次分发
    if os.path.isdir(dest):
        cur = fsutil.list_files(dest)
        if cur and cur != new_files and not force:
            return {"status": "conflict",
                    "reason": "目标位置已存在未托管的同名内容（%d 个文件）；确认后用 force 覆盖" % len(cur),
                    "dest": dest, "mode": "copy"}
        if cur == new_files:
            return {"status": "ok", "action": "adopt", "dest": dest, "files_new": new_files,
                    "files_changed": [], "conflicts": [], "managed": {}, "new_hash": new_hash,
                    "mode": "copy"}
    return {"status": "ok", "action": "create", "dest": dest, "files_new": new_files,
            "files_changed": list(new_files), "conflicts": [], "managed": {},
            "new_hash": new_hash, "mode": "copy"}


def _apply_skills_dir(store, name, target, plan):
    """执行分发计划；写入前保证目标处只保留本次选择的表示方式。"""
    dest = plan["dest"]
    mode = plan.get("mode", "copy")
    new_files = plan["files_new"]
    written = {}
    removed = []
    detail = {"mode": mode}
    if mode == "link":
        # 切换为软链接：旧副本整体备份到 <目标>/.hub-backup/，旧链接直接替换
        backup = _clear_target_entry(dest, backup_root=os.path.join(target["path"], ".hub-backup"))
        link_to = _item_dir(store, name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.symlink(link_to, dest, target_is_directory=True)
        detail.update({"link": link_to, "files": {}})
        if backup:
            detail["backup"] = backup
    else:
        managed = plan.get("managed", {})
        if os.path.islink(dest):
            os.unlink(dest)          # 链接本身无内容，清除即完成互斥
        backup_root = os.path.join(dest, ".hub-backup")
        # 备份将被覆盖/删除的文件
        for rel in sorted(set(list(managed.keys()) + list(new_files.keys()))):
            cur_path = os.path.join(dest, rel)
            if os.path.exists(cur_path):
                incoming = new_files.get(rel)
                if incoming is None or fsutil.sha256_file(cur_path) != incoming:
                    fsutil.backup_file(cur_path, os.path.join(backup_root, time.strftime("%Y%m%d-%H%M%S")))
        for rel, sha in sorted(new_files.items()):
            data = open(os.path.join(_item_dir(store, name), rel), "rb").read()
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
        detail.update({"files": written, "removed": removed})
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
             json.dumps(detail, ensure_ascii=False)))
        store.db.commit()
    return {"written": len(written) if mode == "copy" else len(new_files), "removed": removed}


def _ensure_materialized(store, name):
    """分发兜底：本地库缺该条目目录但源条目存在 → 自动物化后再分发（两道保险之二）。"""
    if os.path.isdir(os.path.join(registry_root(), name)):
        return
    with store.lock:
        has_src = store.db.execute(
            "SELECT 1 FROM items WHERE kind=? AND name=? LIMIT 1", (KIND, name)).fetchone()
    if has_src:
        update_registry(store, [name], force=False)


def distribute_skills(store, names, target_ids, dry_run=False, force=False, mode="copy"):
    """skills → skills_dir 目标。逐条结果。

    mode=copy（默认）复制文件；mode=link 建软链接。两种表示互斥，
    切换时由 _apply_skills_dir 清除目标处另一种表示。
    """
    mode = "link" if str(mode or "").lower() == "link" else "copy"
    results = []
    targets = [t for t in list_targets(store, kind="skills_dir") if t["id"] in target_ids]
    for name in names:
        # 防穿越门禁：name 直接参与 dest 拼接（../evil 可写出目标目录之外）
        if not _NAME_RE.match(str(name) or ""):
            results.append({"item": name, "target": None, "target_id": None,
                            "status": "failed", "reason": "非法条目名", "mode": mode,
                            "dry_run": dry_run})
            continue
        _ensure_materialized(store, name)
        for t in targets:
            plan = _plan_skills_dir(store, name, t, force=force, mode=mode)
            if plan["status"] != "ok":
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": plan["status"], "reason": plan.get("reason"),
                                "mode": mode, "dry_run": dry_run})
                if not dry_run and plan["status"] == "conflict":
                    ops.log_op(store, MODULE, "distribute", "conflict", item_kind="skill",
                               item_name=name, target_id=t["id"], reason=plan.get("reason"))
                continue
            if dry_run:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan.get("action", "update"),
                                "files_changed": len(plan["files_changed"]),
                                "mode": mode, "reason": "dry-run（未写入）", "dry_run": True})
                continue
            try:
                applied = _apply_skills_dir(store, name, t, plan)
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "ok", "action": plan.get("action", "update"),
                                "files_changed": len(plan["files_changed"]),
                                "files_removed": len(applied["removed"]), "mode": mode,
                                "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "ok", item_kind="skill",
                           item_name=name, target_id=t["id"],
                           detail={"files": applied["written"], "removed": applied["removed"],
                                   "mode": mode})
            except Exception as e:
                results.append({"item": name, "target": t["name"], "target_id": t["id"],
                                "status": "failed", "reason": str(e)[:200], "mode": mode,
                                "dry_run": False})
                ops.log_op(store, MODULE, "distribute", "failed", item_kind="skill",
                           item_name=name, target_id=t["id"], reason=str(e)[:200])
    return results


# ============================================================ 目录 ↔ 工具 绑定同步
# 建连 = 目录内全部 skills 一次性分发；此后目录内容变化由 worker（server.py 订阅 watcher）
# 调 sync_all_bindings 自动跟随。绑定对象是 target（目标目录）——共享 skills_dir 的
# 多工具一次同步同时生效。冲突语义全部沿用 distribute_skills：未托管内容停手不碰。
def list_dir_bindings(store, dir_id=None):
    """绑定清单（目录管理弹窗 / worker 用）：绑定行拼上目录与目标信息。"""
    sql = ("SELECT b.*, d.name AS dir_name, d.path AS dir_path, "
           "t.name AS target_name, t.path AS target_path, t.tool AS tool, "
           "t.kind AS target_kind "
           "FROM dir_bindings b "
           "JOIN local_dirs d ON d.id=b.dir_id "
           "JOIN targets t ON t.id=b.target_id")
    args = []
    if dir_id:
        sql += " WHERE b.dir_id=?"
        args.append(dir_id)
    sql += " ORDER BY b.id"
    with store.lock:
        rows = [dict(r) for r in store.db.execute(sql, args).fetchall()]
    for r in rows:
        r["enabled"] = bool(r["enabled"])
        ch = str(r.get("channels") or "skills")
        r["channels"] = [c for c in (x.strip() for x in ch.split(",")) if c]
        try:
            r["excluded"] = json.loads(r.get("excluded") or "[]")
        except Exception:
            r["excluded"] = []
        try:
            r["last_result"] = json.loads(r["last_result"]) if r["last_result"] else None
        except Exception:
            r["last_result"] = None
    return rows


def _dir_item_names(store, dir_id, kind=KIND):
    """目录内某类条目名（skill=skills 通道，mcp=MCP 通道）。"""
    with store.lock:
        return [r["name"] for r in store.db.execute(
            "SELECT name FROM registry_items WHERE kind=? AND dir_id=? ORDER BY name",
            (kind, dir_id)).fetchall()]


def _channels_of(kind):
    """目标类型 → 通道名。skills_dir 走 Skills 通道，mcp_json/mcp_toml 走 MCP 通道。"""
    return "mcp" if str(kind or "").startswith("mcp_") else "skills"


def _agg_distribute(results):
    """把 distribute_skills 的逐条结果聚合成计数。"""
    agg = {"added": 0, "updated": 0, "skipped": 0, "conflicts": 0, "failed": 0}
    for r in results or []:
        st = r.get("status")
        if st == "ok":
            agg["added" if r.get("action") in ("create", "adopt", "recreate") else "updated"] += 1
        elif st == "skipped":
            agg["skipped"] += 1
        elif st == "conflict":
            agg["conflicts"] += 1
        elif st == "failed":
            agg["failed"] += 1
    return agg


def _tag_binding_deployments(store, target_id, names, binding_id, item_kind="skill"):
    """给本轮分发产生的部署记录打上绑定标记（removed 反向清理只认自己落过的）。"""
    if not names:
        return
    qmarks = ",".join("?" * len(names))
    with store.lock:
        rows = store.db.execute(
            "SELECT id, detail FROM deployments WHERE item_kind=? AND target_id=? "
            "AND item_name IN (%s) AND status='ok'" % qmarks,
            [item_kind, target_id] + list(names)).fetchall()
        for r in rows:
            try:
                detail = json.loads(r["detail"]) if r["detail"] else {}
            except Exception:
                detail = {}
            if detail.get("binding") == binding_id:
                continue
            detail["binding"] = binding_id
            store.db.execute("UPDATE deployments SET detail=? WHERE id=?",
                             (json.dumps(detail, ensure_ascii=False), r["id"]))
        store.db.commit()


def _remove_mcp_deployment(store, dep, target):
    """把本绑定写进目标配置的一个 mcp 条目摘掉（json / toml 两种）。"""
    from hub.modules import mod_mcp
    path = os.path.expanduser(target["path"])
    try:
        detail = json.loads(dep["detail"]) if dep["detail"] else {}
    except Exception:
        detail = {}
    try:
        if target["kind"] == "mcp_json":
            data = fsutil.read_json(path)
            if not isinstance(data, dict):
                return False
            fmt_key = detail.get("format_key") or "mcpServers"
            section = mod_mcp._section_get(data, fmt_key)
            name = dep["item_name"]
            if name not in section:
                return False
            injected = detail.get("injected")
            if injected is not None and section[name] != injected:
                return False                      # 用户改过这份配置，不碰
            del section[name]
            fsutil.write_json_atomic(path, data)
            return True
        text = ""
        if os.path.exists(path):
            text = open(path, encoding="utf-8", errors="replace").read()
        block = mod_mcp._find_toml_block(text, dep["item_name"])
        if not block:
            return False
        fsutil.atomic_write_text(path, text[:block.start()] + text[block.end():])
        return True
    except Exception:
        return False


def _cleanup_removed_for_binding(store, b, current_names):
    """目录里消失的条目：按托管清单反向清理（skill 删文件，mcp 从目标配置摘条目）。"""
    trow = store.db.execute("SELECT * FROM targets WHERE id=?", (b["target_id"],)).fetchone()
    target = dict(trow) if trow else None
    kind = "mcp" if target and str(target.get("kind", "")).startswith("mcp_") else "skill"
    with store.lock:
        deps = [dict(r) for r in store.db.execute(
            "SELECT * FROM deployments WHERE item_kind=? AND target_id=? AND status='ok'",
            (kind, b["target_id"])).fetchall()]
    removed = []
    for dep in deps:
        if dep["item_name"] in current_names:
            continue
        try:
            detail = json.loads(dep["detail"]) if dep["detail"] else {}
        except Exception:
            detail = {}
        if detail.get("binding") != b["id"]:
            continue                      # 不是本绑定落的内容，一个不碰
        if kind == "mcp":
            if target and _remove_mcp_deployment(store, dep, target):
                with store.lock:
                    store.db.execute("UPDATE deployments SET status='removed' WHERE id=?",
                                     (dep["id"],))
                    store.db.commit()
                removed.append(dep["item_name"])
            continue
        t = store.db.execute("SELECT path FROM targets WHERE id=?", (b["target_id"],)).fetchone()
        if not t:
            continue
        base = os.path.join(dict(t)["path"], dep["item_name"])
        if os.path.isdir(base):
            for rel in (detail.get("files") or {}):
                p = os.path.join(base, rel)
                if os.path.exists(p):
                    try:
                        os.unlink(p)
                    except OSError:
                        pass
            backup_dir = os.path.join(base, ".hub-backup")
            if os.path.isdir(backup_dir):
                shutil.rmtree(backup_dir, ignore_errors=True)   # hub 自己的备份也是受管内容（同 delete_manual）
            for dirpath, dirnames, _fn in os.walk(base, topdown=False):
                if dirpath != base and not os.listdir(dirpath):
                    try:
                        os.rmdir(dirpath)
                    except OSError:
                        pass
            if os.path.isdir(base) and not os.listdir(base):
                shutil.rmtree(base, ignore_errors=True)
        with store.lock:
            store.db.execute("UPDATE deployments SET status='removed' WHERE id=?", (dep["id"],))
            store.db.commit()
        removed.append(dep["item_name"])
        ops.log_op(store, MODULE, "binding:sync", "ok", item_kind="skill",
                   item_name=dep["item_name"], target_id=b["target_id"],
                   detail={"removed": True, "binding": b["id"]})
    return removed


def _sync_binding(store, b, names=None, force=False):
    """执行一个绑定的同步：按通道分发（skills / mcp）+ 反向清理 + 记录结果。"""
    try:
        trow = store.db.execute("SELECT kind FROM targets WHERE id=?", (b["target_id"],)).fetchone()
        tkind = (dict(trow)["kind"] if trow else "skills_dir")
        raw_ex = b.get("excluded")
        if isinstance(raw_ex, (list, tuple)):
            excluded = set(raw_ex)
        else:
            try:
                excluded = set(json.loads(raw_ex or "[]"))
            except Exception:
                excluded = set()
        if str(tkind).startswith("mcp_"):
            from hub.modules import mod_mcp
            all_names = _dir_item_names(store, b["dir_id"], "mcp") if names is None else names
            send = [n for n in all_names if n not in excluded]
            results = mod_mcp.distribute_mcp(store, send, [b["target_id"]], force=force)
            agg = _agg_distribute(results)
            _tag_binding_deployments(store, b["target_id"], send, b["id"], item_kind="mcp")
        else:
            all_names = _dir_item_names(store, b["dir_id"], KIND) if names is None else names
            send = [n for n in all_names if n not in excluded]
            results = distribute_skills(store, send, [b["target_id"]], force=force,
                                        mode=b["mode"])
            agg = _agg_distribute(results)
            _tag_binding_deployments(store, b["target_id"], send, b["id"])
        agg["excluded"] = len([n for n in all_names if n in excluded])
        # 清理口径：被排除的条目（即使已从目录删掉）也保留工具内文件
        removed = _cleanup_removed_for_binding(store, b, list(all_names) + list(excluded))
        agg["removed"] = len(removed)
        with store.lock:
            store.db.execute(
                "UPDATE dir_bindings SET last_sync_at=?, last_result=? WHERE id=?",
                (ops.now_iso(), json.dumps(agg, ensure_ascii=False), b["id"]))
            store.db.commit()
        ops.log_op(store, MODULE, "binding:sync", "ok" if not agg["failed"] else "failed",
                   detail={"binding": b["id"], "dir": b.get("dir_name"),
                           "target": b.get("target_name"), **agg})
        return agg
    except Exception as e:
        ops.log_op(store, MODULE, "binding:sync", "failed", reason=str(e)[:200],
                   detail={"binding": b["id"]})
        return {"added": 0, "updated": 0, "skipped": 0, "conflicts": 0,
                "failed": 1, "removed": 0, "error": str(e)[:200]}


def bind_dirs(store, dir_id, target_ids, mode="copy", force=False):
    """建连：目录 × 多个目标建立绑定并立即全量同步。"""
    d = local_dirs.get_dir(store, dir_id)
    if not d:
        return {"ok": False, "error": "本地目录不存在"}
    mode = "link" if str(mode or "").lower() == "link" else "copy"
    out = []
    for tid in target_ids or []:
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            out.append({"ok": False, "error": "非法目标 id"}); continue
        t = store.db.execute(
            "SELECT * FROM targets WHERE id=? AND kind IN ('skills_dir','mcp_json','mcp_toml')",
            (tid,)).fetchone()
        if not t:
            out.append({"ok": False, "error": "目标不存在（%s）" % tid}); continue
        t = dict(t)
        channel = _channels_of(t["kind"])
        path_key = "mcp_config" if channel == "mcp" else "skills_dir"
        if not _target_visible(store, t.get("tool"), path_key):
            out.append({"ok": False, "target": t["name"], "error": "工具已停用或目标不可见"}); continue
        dup = store.db.execute("SELECT 1 FROM dir_bindings WHERE dir_id=? AND target_id=?",
                               (dir_id, tid)).fetchone()
        if dup:
            out.append({"ok": False, "target": t["name"], "error": "已建立连接"}); continue
        with store.lock:
            cur = store.db.execute(
                "INSERT INTO dir_bindings(dir_id, target_id, mode, channels, created_at) "
                "VALUES(?,?,?,?,?)",
                (dir_id, tid, mode, channel, ops.now_iso()))
            store.db.commit()
            bid = cur.lastrowid
        b = {"id": bid, "dir_id": dir_id, "target_id": tid, "mode": mode,
             "channels": channel, "dir_name": d["name"], "target_name": t["name"]}
        agg = _sync_binding(store, b, force=force)
        count = len(_dir_item_names(store, dir_id, "mcp" if channel == "mcp" else KIND))
        out.append({"ok": not agg.get("failed"), "binding_id": bid, "target": t["name"],
                    "tool": t.get("tool"), "channel": channel,
                    "skills" if channel == "skills" else "mcp": count, **agg})
        ops.log_op(store, MODULE, "binding:bind", "ok",
                   detail={"binding": bid, "dir": d["name"], "target": t["name"],
                           "mode": mode, "channel": channel, "items": count})
    ok = all(x.get("ok") for x in out) if out else False
    return {"ok": bool(out) and ok, "results": out}


def set_binding_enabled(store, binding_id, enabled):
    with store.lock:
        row = store.db.execute("SELECT id FROM dir_bindings WHERE id=?", (binding_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "绑定不存在"}
        store.db.execute("UPDATE dir_bindings SET enabled=? WHERE id=?",
                         (1 if enabled else 0, binding_id))
        store.db.commit()
    ops.log_op(store, MODULE, "binding:pause" if not enabled else "binding:resume", "ok",
               detail={"binding": binding_id})
    return {"ok": True, "enabled": bool(enabled)}


def set_binding_excluded(store, binding_id, excluded):
    """设置绑定内「不跟随」的条目（工具内已装文件保留）。"""
    if isinstance(excluded, str):
        excluded = [x for x in excluded.split(",") if x]
    names = sorted({str(x) for x in (excluded or [])})
    with store.lock:
        row = store.db.execute("SELECT * FROM dir_bindings WHERE id=?", (binding_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "绑定不存在"}
        store.db.execute("UPDATE dir_bindings SET excluded=? WHERE id=?",
                         (json.dumps(names, ensure_ascii=False), binding_id))
        store.db.commit()
    b = dict(row)
    b.update({"id": binding_id, "excluded": json.dumps(names, ensure_ascii=False)})
    agg = _sync_binding(store, b)
    ops.log_op(store, MODULE, "binding:excluded", "ok",
               detail={"binding": binding_id, "excluded": names})
    return {"ok": True, "excluded": names, "sync": agg}


def set_binding_channels(store, binding_id, channels):
    """调整绑定开启的通道（skills / mcp）；改动后立即重同步。"""
    if isinstance(channels, str):
        channels = [x.strip() for x in channels.split(",")]
    wanted = [c for c in ("skills", "mcp") if c in (channels or [])]
    if not wanted:
        return {"ok": False, "error": "至少要保留一个通道"}
    with store.lock:
        row = store.db.execute(
            "SELECT b.*, t.kind AS target_kind FROM dir_bindings b "
            "JOIN targets t ON t.id=b.target_id WHERE b.id=?", (binding_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "绑定不存在"}
        b = dict(row)
        cap = _channels_of(b["target_kind"])
        if cap not in wanted:
            return {"ok": False, "error": "该目标的通道是 %s，不能只留 %s" % (cap, wanted)}
        store.db.execute("UPDATE dir_bindings SET channels=? WHERE id=?",
                         (",".join(wanted), binding_id))
        store.db.commit()
    b.update({"id": binding_id, "channels": ",".join(wanted)})
    agg = _sync_binding(store, b)
    ops.log_op(store, MODULE, "binding:channels", "ok",
               detail={"binding": binding_id, "channels": wanted})
    return {"ok": True, "channels": wanted, "sync": agg}


def unbind(store, binding_id, clean=False):
    """断开：默认保留工具内文件；clean=True 按托管清单清理本绑定落过的内容。"""
    with store.lock:
        row = store.db.execute(
            "SELECT b.*, d.name AS dir_name, t.name AS target_name, t.path AS target_path "
            "FROM dir_bindings b JOIN local_dirs d ON d.id=b.dir_id "
            "JOIN targets t ON t.id=b.target_id WHERE b.id=?", (binding_id,)).fetchone()
    if not row:
        return {"ok": False, "error": "绑定不存在"}
    b = dict(row)
    b["id"] = binding_id
    # current_names 传空 = 本绑定打标的所有部署全部清理（不管条目是否还在目录里）
    cleaned = _cleanup_removed_for_binding(store, b, []) if clean else []
    with store.lock:
        store.db.execute("DELETE FROM dir_bindings WHERE id=?", (binding_id,))
        store.db.commit()
    ops.log_op(store, MODULE, "binding:unlink", "ok",
               detail={"binding": binding_id, "dir": b["dir_name"],
                       "target": b["target_name"], "cleaned": len(cleaned),
                       "files_kept": not clean})
    return {"ok": True, "cleaned": len(cleaned), "files_kept": not clean}


def sync_dir_bindings(store, dir_id, force=False):
    """某目录内容变化后的绑定跟随（worker / 手动入口共用）。"""
    out = []
    for b in list_dir_bindings(store, dir_id=dir_id):
        if not b["enabled"]:
            continue
        out.append({"binding_id": b["id"], "target": b["target_name"],
                    **_sync_binding(store, b, force=force)})
    return out


def sync_all_bindings(store):
    """全部目录：扫描（拾取外部变化）→ 绑定跟随。worker 循环与启动兜底共用。"""
    summary = []
    for d in local_dirs.list_dirs(store):
        try:
            local_dirs.scan_sync(store, d)
            for r in sync_dir_bindings(store, d["id"]):
                summary.append(r)
        except OSError:
            continue                              # 目录消失/无权限：不影响其余目录
    return summary


# ============================================================ queries for UI
def catalog_view(store, source_id=None):
    """源侧目录 + 本地状态合并视图；手动条目（source_id IS NULL，含本地目录条目）一并返回。"""
    with store.lock:
        items = []
        if not source_id:
            with store.lock:
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
    item_dirs = _item_dirs_map(store)             # 批量取条目目录：避免逐条目 SQL 查询风暴
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
            desc = _fm_description(store, it["name"], item_dirs.get(it["name"]))
        out.append({
            "name": it["name"], "version": it["version"],
            "source_name": it.get("source_name") or ("本地" if manual else ""),
            "source_id": None if manual else it.get("source_id"),
            "manual": bool(manual),
            "dir_id": it.get("dir_id"),
            "dir_name": it.get("dir_name"),
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
    item_dirs = _item_dirs_map(store)             # 批量取条目目录（避免逐条目 SQL 查询风暴）
    for r in regs:
        item_dir = item_dirs.get(r["name"]) or os.path.join(registry_root(), r["name"])
        cur_hash = fsutil.tree_hash(item_dir) if os.path.isdir(item_dir) else None
        out.append({
            "name": r["name"], "version": r["version"], "hash": (r["hash"] or "")[:12],
            "updated_at": r["updated_at"],
            "manual": r["source_id"] is None,
            "dir_id": r.get("dir_id"),
            "modified": bool(cur_hash and r["hash"] and cur_hash != r["hash"]),
            "deployments": dep_map.get(r["name"], []),
        })
    return out


def item_detail(store, name):
    """条目详情：优先本地库；本地库没有（远程条目尚未「更新到本地」）时，回落读源仓库缓存。"""
    reg_dir = _item_dir(store, name)
    if not os.path.isdir(reg_dir):
        with store.lock:
            row = store.db.execute(
                "SELECT source_id, path FROM items WHERE kind=? AND name=? ORDER BY id DESC LIMIT 1",
                (KIND, name)).fetchone()
        if not row or not row["path"]:
            return None
        src_dir = os.path.join(_source_cache(store, row["source_id"]) or "", row["path"])
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
    reg = dict(reg) if reg else None
    dir_name = None
    if reg and reg.get("dir_id"):
        d = local_dirs.get_dir(store, reg["dir_id"])
        dir_name = d["name"] if d else None
    return {"name": name, "skill_md": skill_md, "files": sorted(files.keys()),
            "version": reg["version"] if reg else None,
            "manual": bool(reg and reg["source_id"] is None),
            "dir_id": reg.get("dir_id") if reg else None,
            "dir_name": dir_name,
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
    cache = _source_cache(store, row["source_id"])
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
        if tail == "sync-local" and method == "POST":
            # 不联网：把本地缓存里已有的提交同步进索引（远端更新+连不上 github 时的救急）
            return _r(sync_from_cache(store, sid))
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
                                body.get("files"), dir_id=body.get("dir_id")))
    if path == PREFIX + "/registry/import" and method == "POST":
        return _r(import_local(store, body.get("path"), body.get("name"),
                               overwrite=bool(body.get("overwrite")),
                               dir_id=body.get("dir_id")))
    if path.startswith(PREFIX + "/registry/item/") and method == "PUT":
        return _r(update_manual(store, path[len(PREFIX + "/registry/item/"):],
                                body.get("files")))
    if path.startswith(PREFIX + "/registry/item/") and method == "DELETE":
        return _r(delete_manual(store, path[len(PREFIX + "/registry/item/"):],
                                force=bool(body.get("force"))))
    # ---- 目录 ↔ 工具 绑定 ----
    if path == PREFIX + "/dir-bindings" and method == "GET":
        return 200, {"ok": True, "bindings": list_dir_bindings(store)}
    if path == PREFIX + "/dir-bindings" and method == "POST":
        return _r(bind_dirs(store, body.get("dir_id"), body.get("target_ids") or [],
                            mode=body.get("mode"), force=bool(body.get("force"))))
    if path == PREFIX + "/dir-bindings/sync" and method == "POST":
        return 200, {"ok": True, "results": sync_all_bindings(store)}
    if path.startswith(PREFIX + "/dir-bindings/"):
        rest = path[len(PREFIX + "/dir-bindings/"):]
        bid, _, tail = rest.partition("/")
        bid = need_sid(bid)
        if bid is None:
            return 400, {"ok": False, "error": "非法绑定 id"}
        if not tail and method == "PATCH":
            if "excluded" in body:
                return _r(set_binding_excluded(store, bid, body.get("excluded")))
            if "channels" in body:
                return _r(set_binding_channels(store, bid, body.get("channels")))
            return _r(set_binding_enabled(store, bid, bool(body.get("enabled"))))
        if not tail and method == "DELETE":
            return _r(unbind(store, bid, clean=bool(body.get("clean"))))
        if tail == "sync" and method == "POST":
            bl = [b for b in list_dir_bindings(store) if b["id"] == bid]
            if not bl:
                return 404, {"ok": False, "error": "绑定不存在"}
            if not bl[0]["enabled"]:
                return 400, {"ok": False, "error": "绑定已暂停"}
            return 200, {"ok": True, "results": [
                {"binding_id": bid, "target": bl[0]["target_name"],
                 **_sync_binding(store, bl[0])}]}
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
    if path == PREFIX + "/tool-sync" and method == "POST":
        return 200, sync_to_targets(store, body.get("tool"), body.get("names") or [],
                                    body.get("target_ids") or [], mode=body.get("mode"))
    # ---- distribute ----
    if path == PREFIX + "/distribute" and method == "POST":
        names = body.get("names") or []
        target_ids = body.get("target_ids") or []
        if not names or not target_ids:
            return 400, {"ok": False, "error": "names 与 target_ids 必填"}
        return 200, {"ok": True, "results": distribute_skills(
            store, names, target_ids, dry_run=bool(body.get("dry_run")),
            force=bool(body.get("force")), mode=body.get("mode"))}
    return 404, {"ok": False, "error": "skills: 未知路由 %s %s" % (method, path)}


def registry_enabled(store):
    from hub.core import registry as reg
    return reg.enabled(store, MODULE)


def _tool_names(store):
    """工具 id → 显示名映射（给分发目标卡片展示工具名用）。"""
    from hub import tools_registry
    return {t["id"]: t["name"] for t in tools_registry.load_tools(store)}


def _enrich_target_tools(store, targets):
    """同一 skills_dir 可被多个工具共用（如 Codex/OpenCode/Pi/Cursor 都用 ~/.agents/skills）。

    目标表按路径去重只剩一行；这里补 tool_ids / tool_names，UI 用子标题把共用工具
    全部列出来，避免用户以为 Pi-Agent 等工具“没有成为目标”。
    """
    from hub import tools_registry
    by_path = {}
    for t in tools_registry.load_tools(store):
        if not t.get("enabled", True):
            continue
        sd = str(t.get("skills_dir") or "").strip()
        if not sd:
            continue
        key = os.path.realpath(os.path.expanduser(sd))
        by_path.setdefault(key, []).append(t)
    tmap = _tool_names(store)
    for tgt in targets:
        path = os.path.realpath(os.path.expanduser(tgt.get("path") or ""))
        alias = by_path.get(path) or []
        ids = [t["id"] for t in alias]
        names = [t.get("name") or t["id"] for t in alias]
        tool = tgt.get("tool")
        if tool and tool not in ids:
            ids.insert(0, tool)
            names.insert(0, tmap.get(tool) or tgt.get("name") or tool)
        tgt["tool_ids"] = ids
        tgt["tool_names"] = names


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


def _dep_stale(store, dep, target, name, full_hash):
    """部署是否落后于本地库；指向本地库的有效软链接永远视为最新（内容自动跟随）。"""
    detail = _dep_detail(dep)
    if detail.get("mode") == "link":
        dest = os.path.join(target["path"], name)
        reg_dir = _item_dir(store, name)
        if os.path.islink(dest) and os.path.realpath(dest) == os.path.realpath(reg_dir):
            return False
    h = full_hash.get(name)
    return bool(h and dep["deployed_hash"] and dep["deployed_hash"] != h)


def items_view(store, source=None, q=None, page=1, per_page=20, dir=None):
    """统一条目列表：来源过滤 + 关键词 + 分页 + 逐目标部署状态/版本差异（供新 UI 右栏联动）。

    dir：本地目录过滤（"default" = 默认目录 / 数字 id）；仅对 manual 条目生效。
    停用工具的分发目标不展示（与设置中心「禁用的工具在所有界面隐藏」一致）。
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
            if dep:
                tj["items"]["total"] += 1
                if _dep_stale(store, dep, t, it["name"], full_hash):
                    tj["items"]["stale"] += 1
                    tj["stale_names"].append(it["name"])
                else:
                    tj["items"]["latest"] += 1
            else:
                tj["items"]["missing"] += 1
        targets.append(tj)
    _enrich_target_tools(store, targets)   # 共用 skills_dir 的工具（Pi/Codex/OpenCode/Cursor）补别名
    rows = []
    for it in slice_:
        reg = regs.get(it["name"])
        per_target = []
        for t in trows:
            dep = dep_by_item.get(it["name"], {}).get(t["id"])
            if dep:
                stale = _dep_stale(store, dep, t, it["name"], full_hash)
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
