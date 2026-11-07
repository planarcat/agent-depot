"""本地目录：本地源的多目录登记与内容扫描同步（Skills / MCP 共用）。

- 默认目录不登记：registry_items.dir_id IS NULL 即默认，物理位置仍是
  registry/skills 与 registry/mcp（各模块 registry_root()）。
- 链接目录 = 选择磁盘已有目录（原生选择器 / 手填路径）登记其 realpath，
  扫描发现的条目自动登记为手动条目（与新建/导入同权，可分发/版本/回退）；
  「创建目录」已按用户口径移除（2026-10-31「取消创建，提供选择目录」）。
- 目录内容被外部增删改时，scan_sync 让登记跟随磁盘：新条目登记、
  变化更新 hash（prev_hash 留链）、消失注销；外部改写在事件发生前
  已落盘，旧内容无法事后备份，回退链只保留 hash 记录。

扫描口径（与 import_local / 拉取一致）：
- skill = 含 SKILL.md 的一级子目录（跳过 .git/.hub-backup/.versions/node_modules/__pycache__ 与 .DS_Store）；
- mcp  = 一级 *.json，且解析为含 command 或 url 的 dict（与 catalog 的 MCP 准入一致；
  文件内容保持作者原样分发，与「应用外手改 registry 文件」的既有口径相同）。

manifest 缓存：按 (目录 id, kind, name) 记 (mtime+size 指纹 → hash)，
未变条目不重算，让 GET /api/local-dirs 每次触发的 scan_sync 保持增量廉价。
"""
import json
import os
import re
import subprocess
import threading

from . import fsutil, ops
from .. import paths
from ..lib import catalog

MODULE = "localdirs"

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SKIP_DIRS = (".git", ".hub-backup", ".versions", "node_modules", "__pycache__")

# (dir_id, kind, name) → (指纹, hash, version)；指纹未变即复用，进程内缓存
_MANIFEST = {}

# 原生选择器同时只允许一个（osascript 弹窗是模态等待）
_PICK_LOCK = threading.Lock()

_PICK_PROMPT = "选择要链接到 Agent Depot 的目录"
# 先把 osascript 进程置为前台再弹窗：后台进程弹的系统对话框初始不带焦点，
# 用户第一次点击只会激活窗口（点两次才选中，2026-10-31 用户反馈）。
# 走 System Events 需要一次「自动化」授权；被拒绝/受限时回退到不带激活的版本（功能不丢）。
_PICK_SCRIPT_FRONT = (
    'tell application "System Events" to set frontmost of process "osascript" to true\n'
    'POSIX path of (choose folder with prompt "%s")' % _PICK_PROMPT)
_PICK_SCRIPT_PLAIN = 'POSIX path of (choose folder with prompt "%s")' % _PICK_PROMPT


def _run_pick_script(script, timeout=300):
    try:
        return subprocess.run(["osascript", "-e", script],
                              capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def pick_native(store):
    """弹 macOS 原生「选择文件夹」对话框并返回所选路径。

    由 hub 服务进程弹出（osascript `choose folder`），不经浏览器——浏览器的
    安全模型不向网页暴露磁盘绝对路径，而「原地挂载 + 实时监听」必须有真实路径。
    用户取消 → {ok: False, canceled: True}（前端静默）；返回值只含路径，
    登记仍走 link_dir（路由层串起来）。阻塞等待期间用 _PICK_LOCK 防重复弹出。
    """
    if not _PICK_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "已有选择窗口在等待，请先完成或取消"}
    try:
        out = _run_pick_script(_PICK_SCRIPT_FRONT)
        if out is None:
            return {"ok": False, "error": "选择超时（未在 5 分钟内完成选择）"}
        err = (out.stderr or "").strip()
        if out.returncode != 0:
            # 前台激活被系统限制（未授权自动化等）→ 回退到普通弹窗，功能保持可用
            limited = any(k in err for k in ("System Events", "assistive", "assist",
                                             "不允许", "not allowed", "-1743", "-25211", "-1719"))
            if limited:
                out = _run_pick_script(_PICK_SCRIPT_PLAIN)
                if out is None:
                    return {"ok": False, "error": "选择超时（未在 5 分钟内完成选择）"}
                err = (out.stderr or "").strip()
        if out.returncode != 0:
            if "User canceled" in err or "用户已取消" in err or "(-128)" in err:
                return {"ok": False, "canceled": True}
            return {"ok": False, "error": (err[:200] or "无法打开文件夹选择器")}
        path = out.stdout.strip().rstrip("/") or "/"
        return {"ok": True, "path": path}
    finally:
        _PICK_LOCK.release()


# ============================================================ CRUD
def list_dirs(store):
    """全部本地目录 + 分类计数 + 绑定（不触发扫描；扫描由路由层先调 sync_all）。"""
    with store.lock:
        rows = [dict(r) for r in store.db.execute(
            "SELECT * FROM local_dirs ORDER BY id").fetchall()]
        for d in rows:
            d["counts"] = {"skills": 0, "mcp": 0}
            d["bindings"] = []
        cnt = store.db.execute(
            "SELECT dir_id, kind, COUNT(*) AS n FROM registry_items "
            "WHERE dir_id IS NOT NULL GROUP BY dir_id, kind").fetchall()
        binds = store.db.execute(
            "SELECT b.id, b.dir_id, b.target_id, b.mode, b.enabled, b.channels, b.excluded, "
            "b.last_sync_at, "
            "b.last_result, t.tool, t.kind AS target_kind, "
            "t.name AS target_name, t.path AS target_path "
            "FROM dir_bindings b JOIN targets t ON t.id=b.target_id").fetchall()
    for r in cnt:
        d = next((x for x in rows if x["id"] == r["dir_id"]), None)
        if d and r["kind"] in d["counts"]:
            d["counts"][r["kind"]] = r["n"]
    for d in rows:
        try:
            d["layout"] = json.loads(d["layout"]) if d.get("layout") else None
        except Exception:
            d["layout"] = None   # 容器模式布局：{skills: [子文件夹 rel...], mcp: [...]}
    for b in binds:
        d = next((x for x in rows if x["id"] == b["dir_id"]), None)
        if d:
            b = dict(b)
            b["enabled"] = bool(b["enabled"])
            ch = str(b.get("channels") or "skills")
            b["channels"] = [c for c in (x.strip() for x in ch.split(",")) if c]
            try:
                import json as _json
                b["excluded"] = _json.loads(b.get("excluded") or "[]")
            except Exception:
                b["excluded"] = []
            d["bindings"].append(b)
    return rows


def get_dir(store, dir_id):
    with store.lock:
        row = store.db.execute("SELECT * FROM local_dirs WHERE id=?", (dir_id,)).fetchone()
    return dict(row) if row else None


def link_dir(store, path, name=None):
    """链接目录：登记磁盘已有目录（realpath），扫描发现条目并登记。"""
    raw = os.path.expanduser((path or "").strip())
    if not raw:
        return {"ok": False, "error": "目录路径必填"}
    real = os.path.realpath(raw)
    if not os.path.isdir(real):
        return {"ok": False, "error": "目录不存在：%s" % (path or "（空）")}
    hub_real = os.path.realpath(paths.hub_dir())
    if real == hub_real or real.startswith(hub_real + os.sep):
        return {"ok": False, "error": "不能链接 hub 自身目录（内容已归 hub 管）"}
    over = _overlap(store, real)
    if over:
        return {"ok": False, "error": "与已链接目录重叠：%s" % over["name"]}
    name = (name or os.path.basename(real)).strip()
    if not _NAME_RE.match(name):
        return {"ok": False, "error": "名称非法（字母数字开头，允许 . _ -，≤64 字符）"}
    with store.lock:
        dup = store.db.execute("SELECT 1 FROM local_dirs WHERE name=? OR path=?",
                               (name, real)).fetchone()
    if dup:
        return {"ok": False, "error": "已存在同名/同路径目录"}
    try:
        with store.lock:
            cur = store.db.execute(
                "INSERT INTO local_dirs(name, path, origin, created_at) VALUES(?,?,?,?)",
                (name, real, "linked", ops.now_iso()))
            store.db.commit()
            dir_id = cur.lastrowid
    except Exception as e:
        return {"ok": False, "error": "登记失败：%s" % e}
    scan = scan_sync(store, get_dir(store, dir_id))
    ops.log_op(store, MODULE, "dir:link", "ok",
               detail={"name": name, "path": real, "scan": _brief(scan)})
    return {"ok": True, "id": dir_id, "name": name, "path": real, "origin": "linked",
            **_brief(scan)}


def remove_dir(store, dir_id):
    """移除目录：仅解除登记并下架其条目登记；磁盘文件一律不动（非破坏性）。"""
    d = get_dir(store, dir_id)
    if not d:
        return {"ok": False, "error": "目录不存在"}
    with store.lock:
        n = store.db.execute("SELECT COUNT(*) AS n FROM registry_items WHERE dir_id=?",
                             (dir_id,)).fetchone()["n"]
        nb = store.db.execute("SELECT COUNT(*) AS n FROM dir_bindings WHERE dir_id=?",
                              (dir_id,)).fetchone()["n"]
        store.db.execute("DELETE FROM registry_items WHERE dir_id=?", (dir_id,))
        store.db.execute("DELETE FROM dir_bindings WHERE dir_id=?", (dir_id,))   # 移除目录 = 自动解绑（工具内文件保留）
        store.db.execute("DELETE FROM local_dirs WHERE id=?", (dir_id,))
        store.db.commit()
    for key in [k for k in _MANIFEST if k[0] == dir_id]:
        _MANIFEST.pop(key, None)
    ops.log_op(store, MODULE, "dir:remove", "ok",
               detail={"name": d["name"], "path": d["path"], "items_unregistered": n,
                       "bindings_removed": nb, "files_kept": True})
    return {"ok": True, "name": d["name"], "path": d["path"], "items_unregistered": n,
            "bindings_removed": nb}


def _overlap(store, real):
    for d in list_dirs(store):
        other = os.path.realpath(d["path"])
        if real == other or real.startswith(other + os.sep) or other.startswith(real + os.sep):
            return d
    return None


def _brief(scan):
    return {"added": len(scan["added"]), "updated": len(scan["updated"]),
            "removed": len(scan["removed"]), "skipped": scan["skipped"]}


# ============================================================ 扫描同步
def _save_layout(store, dir_id, layout):
    js = json.dumps(layout, ensure_ascii=False) if layout else None
    with store.lock:
        cur = store.db.execute("SELECT layout FROM local_dirs WHERE id=?", (dir_id,)).fetchone()
        if cur and (cur["layout"] or None) == js:
            return
        store.db.execute("UPDATE local_dirs SET layout=? WHERE id=?", (js, dir_id))
        store.db.commit()


def scan_sync(store, d):
    """扫描目录并同步 registry_items 登记。返回 {added, updated, removed, skipped}。

    两种模式（用户口径 2026-11-05）：
    - 目录含子 skills/mcp 集合文件夹（discover_layout 非空）→ 容器模式：
      逐个集合文件夹扫条目（登记 sub_path），全部一起算 counts、一起随绑定同步；
    - 否则普通模式：目录自身即条目根，只扫一级（现行行为）。

    - 新条目：与默认目录/其它目录/源条目重名 → 跳过（登记以先到者为准）；
    - 已登记：重算 hash，变化则更新（prev_hash 留链）；
    - 磁盘消失：注销登记（部署记录保留不动）。
    """
    d = dict(d)
    layout = discover_layout(d["path"])
    folder_mode = bool(layout["skills"] or layout["mcp"])
    _save_layout(store, d["id"], layout if folder_mode else None)
    found = {"skills": {}, "mcp": {}}
    if folder_mode:
        for kind in ("skills", "mcp"):
            for sub in layout[kind]:
                _scan_into(found, d["id"], d["path"], sub, kind)
    else:
        _scan_into(found, d["id"], d["path"], None, "skills")
        _scan_into(found, d["id"], d["path"], None, "mcp")
    res = {"added": [], "updated": [], "removed": [], "skipped": []}
    with store.lock:
        mine = {(r["kind"], r["name"]): dict(r) for r in store.db.execute(
            "SELECT * FROM registry_items WHERE dir_id=?", (d["id"],)).fetchall()}
    for kind in ("skills", "mcp"):
        for name, info in found[kind].items():
            if (kind, name) in mine:
                row = mine.pop((kind, name))
                if info["hash"] and info["hash"] != row["hash"]:
                    _update_item(store, kind, name, info, row, d["name"])
                    res["updated"].append({"kind": kind, "name": name})
                continue
            with store.lock:
                clash = store.db.execute(
                    "SELECT 1 FROM registry_items WHERE kind=? AND name=?",
                    (kind, name)).fetchone()
            if clash:
                res["skipped"].append({"kind": kind, "name": name, "reason": "重名"})
                continue
            _register_item(store, kind, name, info, d["id"], d["name"])
            res["added"].append({"kind": kind, "name": name})
    for (kind, name), _row in list(mine.items()):    # 磁盘已消失
        with store.lock:
            store.db.execute("DELETE FROM registry_items WHERE kind=? AND name=? AND dir_id=?",
                             (kind, name, d["id"]))
            store.db.commit()
        _MANIFEST.pop((d["id"], kind, name), None)
        res["removed"].append({"kind": kind, "name": name})
        ops.log_op(store, MODULE, "dir:scan-remove", "ok", item_kind=kind, item_name=name,
                   detail={"dir": d["name"]})
    if any(res[k] for k in ("added", "updated", "removed")):
        ops.log_op(store, MODULE, "dir:scan", "ok", detail={"dir": d["name"], **_brief(res)})
    return res


def sync_all(store):
    """全部目录依次 scan_sync（路由读列表前调用；manifest 缓存使其增量廉价）。"""
    out = {}
    for d in list_dirs(store):
        try:
            out[d["name"]] = _brief(scan_sync(store, d))
        except OSError as e:                    # 目录被外部删除/权限问题：不挡列表
            out[d["name"]] = {"error": str(e)[:120]}
    return out


def discover_layout(root):
    """发现关联目录下的子 skills/mcp 集合文件夹（目录名恰为 skills / mcp）。

    受限遍历（集合文件夹最多出现在第 4 层，如 A/x/y/z/skills；跳过 _SKIP_DIRS 与 . 开头）；
    进入集合文件夹后不再下钻
    （防 skills/foo/skills 嵌套误发现）。返回 {"skills": [rel...], "mcp": [rel...]}，
    rel 为相对目录根的路径；两者皆空 = 目录自身即条目根（普通模式）。
    每次读取/同步时重算 → 新增子文件夹在下一次对齐时自动跟随。
    """
    out = {"skills": [], "mcp": []}
    if not os.path.isdir(root):
        return out

    def walk(dirpath, rel, depth):
        if depth > 4:
            return
        try:
            entries = sorted(os.listdir(dirpath))
        except OSError:
            return
        for name in entries:
            if name.startswith(".") or name in _SKIP_DIRS or not _NAME_RE.match(name):
                continue
            full = os.path.join(dirpath, name)
            if not os.path.isdir(full):
                continue
            rel_child = f"{rel}/{name}" if rel else name
            kind = "skills" if name == "skills" else ("mcp" if name == "mcp" else None)
            if kind:
                if rel_child not in out[kind]:
                    out[kind].append(rel_child)
                continue        # 集合文件夹不再下钻
            walk(full, rel_child, depth + 1)

    walk(root, "", 1)
    return out


def _scan_into(out, dir_id, root, sub, kind):
    """扫描单个集合文件夹（容器模式）入 out[kind]：一级子目录含 SKILL.md=skills
    条目；*.json 含 command/url=mcp 条目。manifest 键按 sub 区分。"""
    base = os.path.join(root, sub.replace("/", os.sep)) if sub else root
    if not os.path.isdir(base):
        return
    for entry in sorted(os.listdir(base)):
        full = os.path.join(root, entry)
        if entry.startswith(".") or not _NAME_RE.match(entry):
            continue
        full = os.path.join(base, entry)
        if os.path.isdir(full):
            if entry in _SKIP_DIRS or kind != "skills" or not os.path.isfile(os.path.join(full, "SKILL.md")):
                continue
            sig = _dir_sig(full)                    # 廉价指纹先行：未变不重算整树 sha256
            prev = _MANIFEST.get((dir_id, sub or "", "skills", entry))
            if not prev or prev[0] != sig:
                ent = (sig, fsutil.tree_hash_from_files(fsutil.list_files(full)),
                       _fm_version(full))
                _MANIFEST[(dir_id, sub or "", "skills", entry)] = ent
                prev = ent
            out["skills"][entry] = {"path": full, "hash": prev[1], "sub": sub,
                                    "version": prev[2], "sig": sig}
        elif kind == "mcp" and entry.lower().endswith(".json"):
            cfg = fsutil.read_json(full)
            if not isinstance(cfg, dict) or ("command" not in cfg and "url" not in cfg):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            sig = ((st.st_mtime_ns, st.st_size),)
            name = entry[: -len(".json")]
            prev = _MANIFEST.get((dir_id, sub or "", "mcp", name))
            if not prev or prev[0] != sig:
                ent = (sig, fsutil.sha256_file(full), "v2")
                _MANIFEST[(dir_id, sub or "", "mcp", name)] = ent
                prev = ent
            out["mcp"][name] = {"path": full, "hash": prev[1], "sub": sub,
                                "version": prev[2], "sig": sig}
    return out


def _dir_sig(root):
    """目录内容指纹：[(rel, mtime_ns, size)] 排序序列（内容变化必然带动 mtime/size）。"""
    sig = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [x for x in sorted(dirnames) if x not in _SKIP_DIRS]
        for fn in sorted(filenames):
            if fn == ".DS_Store":
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            sig.append((os.path.relpath(full, root).replace(os.sep, "/"),
                        st.st_mtime_ns, st.st_size))
    return tuple(sig)


def _fm_version(skill_dir):
    p = os.path.join(skill_dir, "SKILL.md")
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                fm = catalog._parse_frontmatter(f.read())
            return fm.get("version") or None
        except OSError:
            return None
    return None


def _register_item(store, kind, name, info, dir_id, dir_name):
    """扫描发现的条目登记为手动条目（source_id=NULL，dir_id 指回目录）。
    sub_path = 所属集合子文件夹（容器模式）；NULL = 目录自身即条目根。"""
    with store.lock:
        prev = store.db.execute("SELECT version, hash FROM registry_items WHERE kind=? AND name=?",
                                (kind, name)).fetchone()
        store.db.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, "
            "prev_version, prev_hash, source_hash_at, dir_id, sub_path) "
            "VALUES(?,?,NULL,?,?,?,?,?,NULL,?,?) "
            "ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, "
            "updated_at=excluded.updated_at, prev_version=excluded.prev_version, "
            "prev_hash=excluded.prev_hash, source_hash_at=NULL, dir_id=excluded.dir_id, "
            "sub_path=excluded.sub_path",
            (kind, name, info.get("version"), info["hash"], ops.now_iso(),
             prev["version"] if prev else None, prev["hash"] if prev else None, dir_id,
             info.get("sub")))
        store.db.commit()
    ops.log_op(store, MODULE, "dir:scan-add", "ok", item_kind=kind, item_name=name,
               detail={"dir": dir_name, "hash": (info["hash"] or "")[:12]})


def _update_item(store, kind, name, info, row, dir_name):
    with store.lock:
        store.db.execute(
            "UPDATE registry_items SET version=?, hash=?, updated_at=?, "
            "prev_version=?, prev_hash=?, sub_path=? WHERE kind=? AND name=?",
            (info.get("version"), info["hash"], ops.now_iso(),
             row.get("version"), row.get("hash"), info.get("sub"), kind, name))
        store.db.commit()
    ops.log_op(store, MODULE, "dir:scan-update", "ok", item_kind=kind, item_name=name,
               detail={"dir": dir_name, "hash": (info["hash"] or "")[:12],
                       "prev_hash": (row.get("hash") or "")[:12]})
