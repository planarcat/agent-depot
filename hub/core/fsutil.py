"""文件与哈希工具：原子写、目录树哈希、diff、脱敏。

安全约定：被本系统写入的目标文件先备份（调用方负责），写入一律 tmp+rename。
"""
import hashlib
import json
import os
import shutil
import tempfile


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def list_files(root):
    """{relpath: sha256}（相对路径排序稳定，用于树哈希与 diff）。"""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fn in sorted(filenames):
            if fn == ".DS_Store":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root)
            out[rel] = sha256_file(full)
    return out


def tree_hash_from_files(files):
    """files: {rel: sha} → 排序后哈希（内容树指纹）。"""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode())
        h.update(b"\x00")
        h.update(files[rel].encode())
        h.update(b"\n")
    return h.hexdigest()


def tree_hash(root):
    return tree_hash_from_files(list_files(root))


def atomic_write_bytes(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".hub-tmp-", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def atomic_write_text(path, text):
    atomic_write_bytes(path, text.encode())


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def write_json_atomic(path, obj, indent=2):
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=indent) + "\n")


def unified_diff(a_text, b_text, a_name="current", b_name="new"):
    import difflib
    a = a_text.splitlines(keepends=True)
    b = b_text.splitlines(keepends=True)
    return "".join(difflib.unified_diff(a, b, fromfile=a_name, tofile=b_name))


def mask_secret(v):
    """密钥脱敏：保留头 2 尾 2，中间星号。"""
    if v is None:
        return None
    s = str(v)
    if len(s) <= 4:
        return "*" * len(s)
    return s[:2] + "*" * max(4, len(s) - 4) + s[-2:]


def backup_file(path, backup_dir=None):
    """备份单个文件到同目录 .hub-backup/ 或指定目录；返回备份路径（None=文件不存在）。"""
    if not os.path.exists(path):
        return None
    if backup_dir is None:
        backup_dir = os.path.join(os.path.dirname(path), ".hub-backup")
    os.makedirs(backup_dir, exist_ok=True)
    ts = __import__("time").strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(backup_dir, os.path.basename(path) + "." + ts)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(backup_dir, "%s.%s.%d" % (os.path.basename(path), ts, n))
        n += 1
    shutil.copy2(path, dest)
    return dest


def safe_rm(path):
    """仅允许删除 hub 自管目录内的路径（防御纵深）。"""
    real = os.path.realpath(path)
    allowed_roots = [os.path.realpath(os.path.expanduser("~/.agent/hub"))]
    if not any(real.startswith(r + os.sep) or real == r for r in allowed_roots):
        raise PermissionError("refuse to remove outside hub dir: %s" % path)
    if os.path.isdir(real):
        shutil.rmtree(real)
    elif os.path.exists(real):
        os.unlink(real)
