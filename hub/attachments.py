"""会话附件：按需回放源会话，解析图片 / 文件引用。

扫描器只把附件压成 `[file]` / `[image]` 占位符；本模块在打开会话详情时
回放同一份源数据（SQLite parts / JSONL 消息），按扫描时的 seq 对齐附件，
不新增数据库列，也不改历史数据。附件字节经 `/api/attachment` 按需读取。
"""
import base64
import glob
import json
import mimetypes
import os
import re
import sqlite3
from urllib.parse import quote, unquote, urlencode

from hub.scanners import (_classify_claude_line, _classify_wb_line,
                          _codex_event_text, _codex_payload_text,
                          _oc_is_policy_noise, _strip_oc_markers,
                          _text_from_claude_content, _text_from_pi_content)

ZCODE_ARTIFACTS = os.path.expanduser("~/.zcode/cli/artifacts")

# 可在浏览器里直接预览的图片格式；TIFF 等交给「文件」下载
WEB_IMAGES = ("image/png", "image/jpeg", "image/gif", "image/webp",
              "image/svg+xml", "image/avif", "image/bmp")

TEXT_EXT = {".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml",
            ".xml", ".csv", ".tsv", ".log", ".ini", ".toml", ".conf",
            ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue",
            ".css", ".scss", ".html", ".htm", ".sh", ".bash", ".zsh", ".sql",
            ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".rb", ".php",
            ".swift", ".kt", ".dart", ".lua", ".pl", ".r", ".m", ".mm"}


def session_attachments(store, sid):
    """返回 {seq: [公开附件元数据]}；不含内部路径，只给前端展示字段。"""
    try:
        refs = _session_refs(store, sid)
    except Exception:
        return {}
    out = {}
    for seq, items in (refs or {}).items():
        pub = []
        for i, it in enumerate(items):
            item = {"kind": it.get("kind") or "file",
                    "mime": it.get("mime") or "application/octet-stream",
                    "name": it.get("name") or "附件",
                    "size": int(it.get("size") or 0),
                    "url": _public_url(sid, seq, i)}
            item["download"] = item["url"] + "&download=1"
            pub.append(item)
        if pub:
            out[seq] = pub
    return out


def read_attachment(store, sid, seq, index):
    """读取一条附件的原始字节；返回 (body, mime, filename)。"""
    refs = _session_refs(store, sid)
    items = (refs or {}).get(int(seq)) or []
    if not (0 <= int(index) < len(items)):
        raise FileNotFoundError("附件不存在")
    it = items[int(index)]
    body, mime = _read_ref(it)
    return body, mime, it.get("name") or "附件"


def _public_url(sid, seq, index):
    return "/api/attachment?" + urlencode({"sid": sid, "seq": seq, "i": index})


def _session_refs(store, sid):
    """按工具分派回放；无法解析时返回空表（前端保留原占位文本）。"""
    sess = store.session(sid)
    if not sess:
        return {}
    tool = sess.get("tool") or ""
    src = sess.get("source_file") or ""
    if not src or not os.path.exists(src):
        return {}
    if tool in ("zcode", "opencode"):
        return _sqlite_refs(sess)
    if tool == "claude":
        return _jsonl_refs(sess, _classify_claude_line, _claude_atts)
    if tool == "codex":
        return _codex_refs(sess)
    if tool == "workbuddy":
        return _jsonl_refs(sess, _classify_wb_line, _wb_atts)
    if tool == "autoclaw":
        return _autoclaw_refs(sess)
    if tool in ("pi-agent", "pi"):
        return _pi_refs(sess)
    return {}


def _jsonl_refs(sess, classify, extract):
    """通用 JSONL 回放：seq 口径与扫描器一致（解析失败也占一个 seq）。"""
    out = {}
    seq = 0
    try:
        f = open(sess["source_file"], encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                seq += 1
                continue
            if classify(obj) is None:
                continue
            seq += 1
            atts = [a for a in (extract(obj, seq) or []) if a]
            if atts:
                out[seq] = atts
    return out


def _claude_atts(obj, seq):
    """Claude Code：user/assistant 内容块里的 base64 图片。"""
    content = (obj.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "image":
            continue
        src = block.get("source") or {}
        if src.get("type") == "base64" and src.get("data"):
            data = src["data"]
            mime = src.get("media_type") or _sniff_b64(data)
            out.append(_mk({"type": "data", "data": data}, mime,
                           "图片 %d" % (len(out) + 1), int(len(data) * 3 / 4)))
    return out


def _wb_atts(obj, seq):
    """WorkBuddy：input_image 指向本地 blob 文件。"""
    content = obj.get("content")
    if not isinstance(content, list):
        return []
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") not in ("input_image", "image"):
            continue
        img = block.get("image") if isinstance(block.get("image"), dict) else {}
        path = img.get("blob_path") or block.get("blob_path")
        mime = img.get("mime") or block.get("mime") or ""
        name = img.get("original_filename") or block.get("original_filename") or "图片 %d" % (len(out) + 1)
        size = img.get("size") or 0
        if path:
            out.append(_mk({"type": "path", "path": path}, mime, name, size, path=path))
            continue
        url = block.get("image_url") or block.get("url") or ""
        if url.startswith("data:"):
            header, _, b64 = url.partition(",")
            out.append(_mk({"type": "data", "data": b64},
                           mime or header[5:].split(";")[0], name, size))
    return out


_ATTACHED_PATH_RE = re.compile(r"\[Attached (?:image|file):[^\]]*?—\s*(/[^\]\n]+)\]")


def _paths_from_text(content):
    """部分工具把附件写成「[Attached image: name — /path]」文本，这里还原成文件。"""
    if not isinstance(content, list):
        return []
    out = []
    seen = set()
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        for path in _ATTACHED_PATH_RE.findall(block.get("text") or ""):
            path = os.path.expanduser(path.strip())
            if path in seen or not os.path.isfile(path):
                continue
            seen.add(path)
            out.append(_mk({"type": "path", "path": path}, "",
                           os.path.basename(path), 0, path=path))
    return out


_CODEX_TEXT_PATH_RE = re.compile(r"##\s+[^:\n]+:\s*(/[^\n]+)")
_CODEX_TAG_PATH_RE = re.compile(r'<image[^>]*path="([^"]+)"')


def _codex_refs(sess):
    """Codex：response_item 里的 input_image（data URL/路径）+ 文本路径标记。"""
    target = sess.get("sid") or ""
    out = {}
    seq = 0
    sid = None
    try:
        f = open(sess["source_file"], encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                seq += 1
                continue
            typ = obj.get("type")
            payload = obj.get("payload") or {}
            if typ == "session_meta":
                sid = payload.get("session_id") or payload.get("id")
            if sid is None or (target and sid != target):
                continue
            cls = _codex_payload_text(payload)
            if cls is None and typ == "event_msg":
                cls = _codex_event_text(payload)
            if cls is None:
                continue
            seq += 1
            if cls[0] != "user":
                continue
            atts = _codex_atts(payload)
            if atts:
                out[seq] = atts
    return out


def _codex_atts(payload):
    """Codex 用户消息里的图片：data URL 优先，文本路径兜底去重。"""
    out = []
    seen = set()
    content = payload.get("content")
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "input_image":
                continue
            url = block.get("image_url") or block.get("url") or ""
            if url.startswith("data:"):
                header, _, b64 = url.partition(",")
                mime = header[5:].split(";")[0] or "image/png"
                name = "图片 %d" % (len(out) + 1)
                out.append(_mk({"type": "data", "data": b64}, mime, name,
                               int(len(b64) * 3 / 4)))
    text = ""
    if isinstance(content, list):
        text = "\n".join(b.get("text") or "" for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    else:
        text = str(payload.get("message") or "")
    for path in list(_CODEX_TEXT_PATH_RE.findall(text)) + list(_CODEX_TAG_PATH_RE.findall(text)):
        path = os.path.expanduser(path.strip())
        name = os.path.basename(path)
        if path in seen or name in seen or not os.path.isfile(path):
            continue
        # 同名图片已由 input_image 的 data URL 覆盖 → 不重复展示
        if any(it.get("name") == name for it in out):
            continue
        seen.add(path)
        seen.add(name)
        out.append(_mk({"type": "path", "path": path}, "", name, 0, path=path))
    return out


def _autoclaw_refs(sess):
    """AutoClaw：Claude 风格内容块 + 文本附件路径标记。"""
    out = {}
    seq = 0
    try:
        f = open(sess["source_file"], encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                seq += 1
                continue
            typ = obj.get("type")
            if typ == "compaction":
                if obj.get("summary"):
                    seq += 1
                continue
            if typ != "message":
                continue
            msg = obj.get("message") or {}
            if msg.get("role") not in ("user", "assistant"):
                continue
            raw_content = msg.get("content")
            content = _strip_oc_markers(_text_from_claude_content(raw_content))
            if not content or _oc_is_policy_noise(content):
                continue
            seq += 1
            atts = [a for a in (_claude_atts(obj, seq) or []) if a]
            atts += _paths_from_text(raw_content)
            if atts:
                out[seq] = atts
    return out


def _pi_refs(sess):
    """pi-agent：seq 口径同 PiScanner（toolResult 永远占位，user/assistant 空文本跳过）。"""
    out = {}
    seq = 0
    try:
        f = open(sess["source_file"], encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                seq += 1
                continue
            if obj.get("type") != "message":
                continue
            msg = obj.get("message") or {}
            role = msg.get("role")
            if role == "toolResult":
                seq += 1
            elif role in ("user", "assistant"):
                if not _text_from_pi_content(msg.get("content")):
                    continue
                seq += 1
            else:
                continue
            atts = _pi_atts(msg.get("content"))
            if atts:
                out[seq] = atts
    return out


def _pi_atts(content):
    """pi 的 image 块只有 base64 data，没有 mime，按文件头嗅探。"""
    if not isinstance(content, list):
        return []
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "image" or not block.get("data"):
            continue
        data = block["data"]
        mime = block.get("mimeType") or block.get("mime") or _sniff_b64(data)
        out.append(_mk({"type": "data", "data": data}, mime,
                       "图片 %d" % (len(out) + 1), int(len(data) * 3 / 4)))
    return out


def _sqlite_refs(sess):
    """ZCode / OpenCode：回放 message + part，file part 即附件。"""
    path = sess.get("source_file") or ""
    sid = sess.get("sid") or ""
    if not path or not os.path.isfile(path):
        return {}
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % quote(path), uri=True, timeout=2)
    except sqlite3.Error:
        return {}
    try:
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if "session" not in tables:
            return {}
        mtbl = "message" if "message" in tables else (
            "session_message" if "session_message" in tables else None)
        if not mtbl:
            return {}
        has_part = "part" in tables
        rows = conn.execute(
            "SELECT id, data FROM %s WHERE session_id=? ORDER BY time_created, id" % mtbl,
            (sid,)).fetchall()
        out = {}
        seq = 0
        for mid, data in rows:
            try:
                msg = json.loads(data)
            except Exception:
                continue
            parts = []
            has_content = False
            if has_part:
                try:
                    prows = conn.execute(
                        "SELECT data FROM part WHERE message_id=? ORDER BY time_created, id",
                        (mid,)).fetchall()
                except sqlite3.Error:
                    prows = []
                for (pdata,) in prows:
                    try:
                        part = json.loads(pdata)
                    except Exception:
                        continue
                    typ = part.get("type")
                    if typ == "text":
                        if part.get("text"):
                            has_content = True
                    elif typ == "file":
                        has_content = True
                        parts.append(part)
                    elif typ == "tool":
                        has_content = True
            elif msg.get("text"):
                has_content = True
            if not has_content:
                continue
            seq += 1
            atts = []
            for i, part in enumerate(parts):
                att = _sqlite_att(part, seq, i)
                if att:
                    atts.append(att)
            if atts:
                out[seq] = atts
        return out
    finally:
        conn.close()


def _sqlite_att(part, seq, index):
    """把 file part 转成内部引用；无法解析的（无 url / 远程）直接跳过。"""
    url = str(part.get("url") or "").strip()
    mime = part.get("mime") or ""
    name = part.get("filename") or ""
    meta = part.get("metadata") or {}
    size = meta.get("sizeBytes") or 0
    fallback = ("图片 %d" if str(mime).startswith("image/") else "附件 %d") % (index + 1)
    if not url:
        return None
    if url.startswith("data:"):
        header, _, b64 = url.partition(",")
        dmime = header[5:].split(";")[0] or mime
        return _mk({"type": "data", "data": b64}, mime or dmime,
                   name or fallback, size or int(len(b64) * 3 / 4))
    if url.startswith("zcode-artifact://"):
        rest = url[len("zcode-artifact://"):]
        artsess, _, artifact = rest.partition("/")
        if not artsess or not artifact:
            return None
        return _mk({"type": "artifact", "session": artsess, "artifact": artifact},
                   mime, name or fallback, size)
    if url.startswith("file://"):
        url = unquote(url[7:])
    path = os.path.expanduser(url)
    if os.path.isabs(path):
        if not os.path.exists(path):
            return None
        return _mk({"type": "path", "path": path}, mime,
                   name or os.path.basename(path) or fallback, size, path=path)
    return None


def _mk(ref, mime, name, size=0, path=None):
    """构造内部附件项；附带 kind / mime / name / size 供 UI 直接渲染。"""
    mime = str(mime or "").strip()
    if not mime and path and os.path.isfile(path):
        mime = mimetypes.guess_type(path)[0] or ""
    if not mime and name:
        mime = mimetypes.guess_type(name)[0] or ""
    if path and os.path.isfile(path):
        try:
            size = size or os.path.getsize(path)
        except OSError:
            pass
    return {"kind": _kind(mime, name, bool(path and os.path.isdir(path))),
            "mime": mime or "application/octet-stream",
            "name": name or "附件", "size": int(size or 0), "_ref": ref}


def _kind(mime, name, is_dir=False):
    """决定前端展示方式：image / text / pdf / audio / video / folder / file。"""
    if is_dir:
        return "folder"
    m = str(mime or "").lower()
    ext = os.path.splitext(str(name or ""))[1].lower()
    if m.startswith("image/"):
        return "image" if m in WEB_IMAGES else "file"
    if m == "application/pdf" or ext == ".pdf":
        return "pdf"
    if m.startswith("audio/"):
        return "audio"
    if m.startswith("video/"):
        return "video"
    if m.startswith("text/") or ext in TEXT_EXT or m in (
            "application/json", "application/xml", "application/javascript",
            "application/x-yaml"):
        return "text"
    return "file"


def _read_ref(item):
    """读取内部引用 → (bytes, mime)。"""
    ref = item.get("_ref") or {}
    typ = ref.get("type")
    mime = item.get("mime") or "application/octet-stream"
    if typ == "data":
        data = ref.get("data") or ""
        if data.startswith("data:"):
            _, _, data = data.partition(",")
        return base64.b64decode(data), mime
    if typ == "path":
        path = ref.get("path") or ""
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        with open(path, "rb") as f:
            return f.read(), mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
    if typ == "artifact":
        path = _find_artifact(ref.get("session") or "", ref.get("artifact") or "")
        if not path:
            raise FileNotFoundError("artifact not found")
        with open(path, "rb") as f:
            raw = f.read()
        if raw.startswith(b"data:"):
            header, _, payload = raw.partition(b",")
            dmime = header[5:].split(b";")[0].decode("ascii", "ignore")
            return base64.b64decode(payload), dmime or mime
        return raw, mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
    raise FileNotFoundError("unsupported attachment")


def _find_artifact(session, artifact):
    """在 ~/.zcode/cli/artifacts/<session>/ 里按 artifact id 找落盘文件。"""
    root = os.path.realpath(ZCODE_ARTIFACTS)
    sid = re.sub(r"[^A-Za-z0-9._-]", "", str(session or ""))
    aid = re.sub(r"[^A-Za-z0-9._-]", "", str(artifact or ""))
    if not sid or not aid:
        return None
    folder = os.path.realpath(os.path.join(root, sid))
    if not (folder == root or folder.startswith(root + os.sep)) or not os.path.isdir(folder):
        return None
    hits = glob.glob(os.path.join(folder, "*" + aid + "*"))
    return hits[0] if hits else None


def _sniff_b64(data):
    """从 base64 头几个字节判断图片 mime（pi 的 image 块不带 mime）。"""
    try:
        head = base64.b64decode(data[:64])
    except Exception:
        return "image/png"
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if head.startswith(b"GIF8"):
        return "image/gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"
