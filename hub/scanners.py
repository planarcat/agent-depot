"""Incremental scanners for Claude Code / Codex CLI / OpenCode / Pi-Agent / Cursor.

Design rules:
- NEVER write to the source tools' own files/databases (OpenCode opens read-only URI).
- JSONL sources: incremental tail by byte offset; a shrink or mtime rewind triggers
  a full re-read of that file (hash dedupe makes it safe).
- Content-hash dedupe means re-scans are idempotent.
"""
import glob
import json
import os
import sqlite3
import time
from urllib.parse import quote

from .store import Store, now_iso
from . import tools_registry


import re as _re

_NOISE_TITLE = _re.compile(
    r"^\s*(@/|<(environment_context|app-context|user_instructions|system|turn_context|"
    "environment|context|turn_aborted|image\b|/image>|system-reminder)|# Files mentioned)",
    _re.IGNORECASE)
_FILES_MENTIONED = "# Files mentioned by the user"


def _clean_title(text):
    if not text:
        return None
    text = _re.sub(r"\s+", " ", text).strip()
    return text or None


def _pick_title(candidates):
    """candidates: iterable of raw strings in order; skip system-ish noise."""
    for c in candidates:
        if not c:
            continue
        head = c.lstrip()[:80]
        if _NOISE_TITLE.match(head):
            continue
        if _FILES_MENTIONED in c[:120]:
            continue
        t = _clean_title(c)
        if t and not _NOISE_TITLE.match(t[:80]):
            return t
    return None


def _text_from_claude_content(content):
    """Claude message.content: str OR list of blocks."""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                parts.append(b.get("text", ""))
            elif t == "tool_use":
                parts.append("[tool_use:%s] %s" % (b.get("name", "?"), json.dumps(b.get("input", {}), ensure_ascii=False)[:400]))
            elif t == "tool_result":
                c = b.get("content")
                txt = c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)[:400]
                parts.append("[tool_result] %s" % (txt or ""))
            elif t == "image":
                parts.append("[image]")
            elif t == "thinking":
                parts.append("[thinking] %s" % b.get("thinking", "")[:200])
    return "\n".join(p for p in parts if p)


def _classify_claude_line(o):
    """Return (role, content, content_type) or None to skip."""
    typ = o.get("type")
    if typ == "user":
        msg = o.get("message", {})
        txt = _text_from_claude_content(msg.get("content"))
        if not txt:
            return None
        return ("user", txt, "text")
    if typ == "assistant":
        msg = o.get("message", {})
        txt = _text_from_claude_content(msg.get("content"))
        if not txt:
            return None
        # A single block type -> typed; mixed -> text
        return ("assistant", txt, "text")
    if typ == "summary":
        return ("system", "summary: %s" % o.get("summary", ""), "system")
    return None


def _expand_root(p):
    """统一展开 ~：扫描器用 glob / os.path.exists，不展开 ~ 会静默采不到任何文件。
    （2026-10-14 生产 bug：内置工具的 root 存的是 ~/... ，build_scanners 原样传入 → 全部采不到）"""
    return os.path.expanduser(str(p)) if p else p


class ClaudeScanner:
    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "claude"
        self.root = _expand_root(root)

    def sources(self):
        base = (self.root or os.environ.get("HUB_CLAUDE_PROJECTS")
                or os.path.expanduser("~/.claude/projects"))
        out = []
        for path in glob.glob(os.path.join(base, "*", "*.jsonl")):
            out.append(path)
        return out

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            # shrink -> reset cursor (file rewritten)
            if size < cur["offset_bytes"]:
                cur = {"offset_bytes": 0, "msg_seq": 0}

            sid = os.path.splitext(os.path.basename(path))[0]
            proj = os.path.basename(os.path.dirname(path))
            with open(path, "rb") as f:
                f.seek(cur["offset_bytes"])
                chunk = f.read()
            consumed = cur["offset_bytes"] + len(chunk)
            if chunk.endswith(b"\n"):
                lines = chunk.split(b"\n")[:-1]      # drop trailing empty piece
            else:
                parts = chunk.split(b"\n")
                lines = parts[:-1]                    # last line incomplete -> withhold
                consumed -= len(parts[-1])

            session_touched = False
            user_candidates = []
            seq = cur["msg_seq"]
            started_at = updated_at = None
            custom_title = None
            first_user = None
            last_ts = None
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    seq += 1
                    continue
                ts = o.get("timestamp")
                if ts:
                    last_ts = ts
                    if started_at is None:
                        started_at = ts
                typ = o.get("type")
                if typ == "custom-title":
                    custom_title = o.get("customTitle") or o.get("title") or custom_title
                if typ in ("user", "assistant"):
                    cwd = o.get("cwd")
                    if cwd:
                        proj = cwd
                cls = _classify_claude_line(o)
                if cls is None:
                    continue
                role, content, ctype = cls
                if role == "user" and ctype == "text":
                    user_candidates.append(content[:200])
                    if first_user is None:
                        first_user = content[:120]
                seq += 1
                r = store.add_message(sid, self.tool, seq, ts, role, content, ctype, raw=None)
                if r == "new":
                    stats["new_messages"] += 1
                    session_touched = True

            if session_touched or cur["offset_bytes"] == 0:
                title = custom_title or _pick_title(user_candidates) or "(%s) %s" % (self.tool, _clean_title(proj))
                if started_at is None:
                    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
                store.upsert_session(sid, self.tool, (title or "")[:200], proj, path,
                                     started_at, last_ts or now_iso(),
                                     "custom-title" if custom_title else ("first-user" if first_user else "fallback"))
                stats["new_sessions"] += 1
                store.bump_msg_count(sid)
            store.set_cursor(key, consumed, seq, mtime, size)
        store.commit()
        return stats


def _codex_payload_text(payload):
    """Extract (role, content, ctype) from a codex response_item payload."""
    typ = payload.get("type")
    if typ in ("message",):
        role = payload.get("role", "user")
        if role in ("developer", "system", "instructions"):
            return None
        parts = []
        for c in payload.get("content", []):
            if not isinstance(c, dict):
                continue
            t = c.get("type", "")
            if t.endswith("text") or t == "text":
                parts.append(c.get("text", ""))
            elif t in ("input_image", "image"):
                parts.append("[image]")
            elif "text" in c:
                parts.append(c["text"])
        txt = "\n".join(p for p in parts if p)
        if not txt:
            return None
        return (role, txt, "text")
    if typ in ("function_call", "local_shell_call", "custom_tool_call"):
        return ("assistant", "[tool_call] %s %s" % (payload.get("name", ""), json.dumps(payload.get("arguments", ""), ensure_ascii=False)[:400]), "tool_use")
    if typ in ("function_call_output", "local_shell_output", "custom_tool_call_output"):
        out = payload.get("output")
        txt = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)[:600]
        return ("tool", "[tool_result] %s" % txt, "tool_result")
    if typ == "reasoning":
        return None
    return None


def _codex_event_text(payload):
    """event_msg payloads: user_message / agent_message carry plain text."""
    t = payload.get("type")
    if t == "user_message":
        return ("user", str(payload.get("message") or ""), "text")
    if t == "agent_message":
        return ("assistant", str(payload.get("message") or ""), "text")
    return None


class CodexScanner:
    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "codex"
        self.root = _expand_root(root)

    def sources(self):
        home = (self.root or os.environ.get("CODEX_HOME")
                or os.path.expanduser("~/.codex"))
        return glob.glob(os.path.join(home, "sessions", "**", "*.jsonl"), recursive=True)

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if size < cur["offset_bytes"]:
                cur = {"offset_bytes": 0, "msg_seq": 0}

            with open(path, "rb") as f:
                f.seek(cur["offset_bytes"])
                chunk = f.read()
            consumed = cur["offset_bytes"] + len(chunk)
            if chunk.endswith(b"\n"):
                lines = chunk.split(b"\n")[:-1]      # drop trailing empty piece
            else:
                parts = chunk.split(b"\n")
                lines = parts[:-1]                    # last line incomplete -> withhold
                consumed -= len(parts[-1])

            sid = None
            cwd = None
            seq = cur["msg_seq"]
            started_at = last_ts = None
            touched = False
            user_candidates = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    seq += 1
                    continue
                ts = o.get("timestamp")
                if ts:
                    if started_at is None:
                        started_at = ts
                    last_ts = ts
                typ = o.get("type")
                payload = o.get("payload") or {}
                if typ == "session_meta":
                    sid = payload.get("session_id") or payload.get("id")
                    cwd = payload.get("cwd")
                if sid is None:
                    continue
                cls = _codex_payload_text(payload)
                if cls is None and typ == "event_msg":
                    cls = _codex_event_text(payload)
                if cls is None:
                    continue
                role, content, ctype = cls
                if role == "user":
                    user_candidates.append(content[:200])
                seq += 1
                r = store.add_message(sid, self.tool, seq, ts, role, content, ctype)
                if r == "new":
                    stats["new_messages"] += 1
                    touched = True

            if sid and (touched or cur["offset_bytes"] == 0):
                # title: first user message
                title = _pick_title(user_candidates) or "(%s) %s" % (self.tool, _clean_title(cwd or os.path.basename(path)))
                if started_at is None:
                    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
                store.upsert_session(sid, self.tool, (title or "")[:200], cwd or "", path,
                                     started_at, last_ts or now_iso(),
                                     "first-user" if title else "fallback")
                stats["new_sessions"] += 1
                store.bump_msg_count(sid)
            store.set_cursor(key, consumed, seq, mtime, size)
        store.commit()
        return stats


class OpenCodeScanner:
    """OpenCode keeps sessions in SQLite; we open it read-only via URI."""

    DB_CANDIDATES = [
        os.path.expanduser("~/.local/share/opencode/opencode.db"),
        os.path.expanduser("~/.local/share/opencode/storage/db.sqlite"),  # older layout
    ]

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "opencode"
        self.root = _expand_root(root) or os.environ.get("HUB_OPENCODE_DB")

    def _candidates(self):
        return [self.root] if self.root else self.DB_CANDIDATES

    def sources(self):
        return [p for p in self._candidates() if os.path.exists(p)]

    def _connect_ro(self, path):
        uri = "file:%s?mode=ro&immutable=0" % path
        return sqlite3.connect(uri, uri=True)

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for db_path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, db_path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                conn = self._connect_ro(db_path)
            except sqlite3.Error:
                continue
            try:
                tables = [r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                if "session" not in tables:
                    continue
                has_message_tbl = "message" in tables
                has_session_message_tbl = "session_message" in tables
                mtbl = "message" if has_message_tbl else ("session_message" if has_session_message_tbl else None)

                sessions = conn.execute("SELECT id, title, directory, time_created, time_updated FROM session").fetchall()
                for sid, title, directory, tc, tu in sessions:
                    # per-session cursor: msg_seq in cursor.offset_bytes field
                    skey = "%s:%s:%s" % (self.tool, db_path, sid)
                    scol = conn.execute("PRAGMA table_info(session)").fetchall()
                    cols = [c[1] for c in scol]
                    tc_col = "time_created" if "time_created" in cols else "time_created"
                    # find message count for this session
                    if mtbl:
                        mcount = conn.execute("SELECT COUNT(*) FROM %s WHERE session_id=?" % mtbl, (sid,)).fetchone()[0]
                    else:
                        mcount = 0
                    prev = store.get_cursor(skey)
                    prev_count = prev["offset_bytes"] if prev else -1
                    already = store.session(sid)
                    if prev_count == mcount and already:
                        continue  # no change
                    # read messages
                    seq = 0
                    touched = False
                    if mtbl:
                        idcol = "id"
                        rows = conn.execute(
                            "SELECT id, data, time_created FROM %s WHERE session_id=? ORDER BY time_created, id" % mtbl,
                            (sid,)).fetchall()
                        for mid, data, mtc in rows:
                            try:
                                d = json.loads(data)
                            except Exception:
                                continue
                            role = d.get("role")
                            if role not in ("user", "assistant", "system", "tool"):
                                # opencode 'data' rows without role -> try part text later
                                role = None
                            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime((mtc or 0) / 1000)) if mtc else None
                            # content: parts table if exists, else data.text
                            content = None
                            if "part" in tables:
                                prows = conn.execute("SELECT data FROM part WHERE message_id=? ORDER BY time_created, id", (mid,)).fetchall()
                                texts = []
                                for (pdata,) in prows:
                                    try:
                                        p = json.loads(pdata)
                                    except Exception:
                                        continue
                                    pt = p.get("type")
                                    if pt == "text":
                                        texts.append(p.get("text", ""))
                                    elif pt == "file":
                                        texts.append("[file] %s" % p.get("filename", ""))
                                    elif pt == "step-start":
                                        continue
                                    elif pt == "tool":
                                        texts.append("[tool:%s]" % p.get("tool", "?"))
                                    elif pt == "reasoning":
                                        continue
                                content = "\n".join(t for t in texts if t)
                            if content is None and d.get("text"):
                                content = d["text"]
                            if not content:
                                continue
                            if role is None:
                                role = "user" if d.get("agent") != "build" or True else "assistant"
                                role = d.get("role") or ("assistant" if d.get("parentID") else "user")
                            seq += 1
                            r = store.add_message(sid, self.tool, seq, ts, role, content[:20000], "text")
                            if r == "new":
                                stats["new_messages"] += 1
                                touched = True
                    started = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime((tc or 0) / 1000)) if tc else None
                    updated = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime((tu or 0) / 1000)) if tu else now_iso()
                    store.upsert_session(sid, self.tool, (title or "(%s)" % self.tool)[:200], directory or "", db_path,
                                         started or now_iso(), updated,
                                         "slug" if title else "fallback")
                    stats["new_sessions"] += 1
                    store.bump_msg_count(sid)
                    store.set_cursor(skey, mcount, seq, None, None)
                store.set_cursor(key, int(time.time()), 0, None, None)
            finally:
                conn.close()
        store.commit()
        return stats


def _ms_iso(ms):
    """Epoch millis -> local iso（失败返回 None）。"""
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(int(ms) / 1000)) if ms else None
    except (TypeError, ValueError):
        return None


_PI_SID_RE = _re.compile(
    r"_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$",
    _re.IGNORECASE)


def _pi_sid_from_path(path):
    m = _PI_SID_RE.search(os.path.basename(path))
    return m.group(1) if m else os.path.splitext(os.path.basename(path))[0]


def _text_from_pi_content(content):
    """pi-agent message.content: list of parts（text / thinking / toolCall / image）。"""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                parts.append(b.get("text", ""))
            elif t == "toolCall":
                parts.append("[tool_call] %s %s" % (b.get("name", "?"), json.dumps(
                    b.get("arguments", b.get("input", {})), ensure_ascii=False)[:400]))
            elif t == "thinking":
                parts.append("[thinking] %s" % (b.get("thinking", "") or "")[:200])
            elif t == "image":
                parts.append("[image]")
    return "\n".join(p for p in parts if p)


class PiScanner:
    """Pi-Agent sessions：<root>/<project>/<ts>_<id>.jsonl（追加式）。"""

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "pi"
        self.root = _expand_root(root)

    def sources(self):
        base = self.root or os.path.expanduser("~/.pi/agent/sessions")
        return sorted(glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True))

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if size < cur["offset_bytes"]:
                cur = {"offset_bytes": 0, "msg_seq": 0}

            sid = _pi_sid_from_path(path)
            cwd = None
            with open(path, "rb") as f:
                f.seek(cur["offset_bytes"])
                chunk = f.read()
            consumed = cur["offset_bytes"] + len(chunk)
            if chunk.endswith(b"\n"):
                lines = chunk.split(b"\n")[:-1]
            else:
                parts = chunk.split(b"\n")
                lines = parts[:-1]
                consumed -= len(parts[-1])

            seq = cur["msg_seq"]
            started_at = last_ts = None
            touched = False
            user_candidates = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    seq += 1
                    continue
                ts = o.get("timestamp")
                if ts:
                    if started_at is None:
                        started_at = ts
                    last_ts = ts
                typ = o.get("type")
                if typ == "session":
                    cwd = o.get("cwd") or cwd
                    continue
                if typ != "message":
                    continue
                m = o.get("message") or {}
                role = m.get("role")
                if role == "toolResult":
                    txt = _text_from_pi_content(m.get("content"))
                    r2, ctype = "tool", "tool_result"
                    content = ("[tool_result:%s] %s" % (m.get("toolName") or "?", txt)).strip()
                    if not txt:
                        content = "[tool_result:%s]" % (m.get("toolName") or "?")
                elif role in ("user", "assistant"):
                    txt = _text_from_pi_content(m.get("content"))
                    if not txt:
                        continue
                    content, r2, ctype = txt, role, "text"
                    if role == "user":
                        user_candidates.append(txt[:200])
                else:
                    continue
                seq += 1
                r = store.add_message(sid, self.tool, seq, ts, r2, content, ctype)
                if r == "new":
                    stats["new_messages"] += 1
                    touched = True

            if cwd is None:
                # 增量段里没有 session 行：从文件头部补 cwd（只读一小段）
                try:
                    with open(path, "rb") as f:
                        head = f.read(4096).decode("utf-8", "ignore")
                    for ln in head.splitlines():
                        try:
                            o2 = json.loads(ln)
                        except Exception:
                            continue
                        if o2.get("type") == "session":
                            cwd = o2.get("cwd")
                            break
                except OSError:
                    pass

            if touched or cur["offset_bytes"] == 0:
                prev = store.session(sid) or {}
                title = (_pick_title(user_candidates) or prev.get("title")
                         or "(%s) %s" % (self.tool, _clean_title(os.path.basename(path))))
                if started_at is None:
                    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
                store.upsert_session(sid, self.tool, (title or "")[:200], cwd or "",
                                     path, started_at, last_ts or now_iso(),
                                     "first-user" if user_candidates else "fallback")
                stats["new_sessions"] += 1
                store.bump_msg_count(sid)
            store.set_cursor(key, consumed, seq, mtime, size)
        store.commit()
        return stats


def _flatten_rich_text(raw):
    """Cursor richText（Lexical JSON）→ 纯文本；也兼容纯字符串。"""
    if not raw:
        return ""
    if isinstance(raw, str):
        if not raw.lstrip().startswith(("{", "[")):
            return raw
        try:
            raw = json.loads(raw)
        except Exception:
            return ""
    out = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text" and isinstance(n.get("text"), str):
                out.append(n["text"])
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(raw)
    return "".join(out)


class CursorScanner:
    """Cursor composers：globalStorage state.vscdb 的 cursorDiskKV 表（只读）。

    - composerData:<id> 存元数据 + fullConversationHeadersOnly（气泡顺序）
    - bubbleId:<composerId>:<bubbleId> 存单条气泡（type 1=用户 / 2=助手）
    """

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "cursor"
        self.root = _expand_root(root)

    def sources(self):
        p = self.root or os.path.expanduser(
            "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb")
        return [p] if os.path.exists(p) else []

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for db_path in self.sources():
            stats["files"] += 1
            try:
                conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
            except sqlite3.Error:
                continue
            try:
                try:
                    rows = conn.execute(
                        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'"
                    ).fetchall()
                except sqlite3.Error:
                    continue
                for key, value in rows:
                    cid = key.split(":", 1)[1]
                    try:
                        d = json.loads(value)
                    except Exception:
                        continue
                    headers = d.get("fullConversationHeadersOnly") or []
                    if not headers and isinstance(d.get("conversationMap"), dict) and d["conversationMap"]:
                        headers = [{"bubbleId": bid, "type": (b or {}).get("type")}
                                   for bid, b in d["conversationMap"].items() if isinstance(b, dict)]
                    if not headers:
                        continue
                    last_upd = d.get("lastUpdatedAt") or d.get("createdAt") or 0
                    ckey = "%s:%s:%s" % (self.tool, db_path, cid)
                    cur = store.get_cursor(ckey)
                    if cur and cur.get("offset_bytes") == last_upd and store.session(cid):
                        continue  # 未变化
                    seq = 0
                    touched = False
                    user_candidates = []
                    for h in headers:
                        bid = h.get("bubbleId") if isinstance(h, dict) else None
                        if not bid:
                            continue
                        brow = conn.execute(
                            "SELECT value FROM cursorDiskKV WHERE key=?",
                            ("bubbleId:%s:%s" % (cid, bid),)).fetchone()
                        if not brow:
                            continue
                        try:
                            b = json.loads(brow[0])
                        except Exception:
                            continue
                        txt = (b.get("text") or "").strip()
                        if not txt:
                            txt = _flatten_rich_text(b.get("richText")).strip()
                        if not txt:
                            continue
                        role = "user" if b.get("type") == 1 else "assistant"
                        if role == "user":
                            user_candidates.append(txt[:200])
                        seq += 1
                        r = store.add_message(cid, self.tool, seq, None, role, txt[:20000], "text")
                        if r == "new":
                            stats["new_messages"] += 1
                            touched = True
                    if touched or cur is None:
                        prev = store.session(cid) or {}
                        nm = (d.get("name") or "").strip()
                        title = nm or _pick_title(user_candidates) or prev.get("title") \
                            or "(%s) %s" % (self.tool, cid[:8])
                        started = _ms_iso(d.get("createdAt"))
                        updated = _ms_iso(last_upd) or now_iso()
                        store.upsert_session(cid, self.tool, title[:200], "",
                                             db_path, started or now_iso(), updated,
                                             "custom-title" if nm else
                                             ("first-user" if user_candidates else "fallback"))
                        stats["new_sessions"] += 1
                        store.bump_msg_count(cid)
                    store.set_cursor(ckey, last_upd, seq, None, len(headers))
                store.set_cursor("%s:%s" % (self.tool, db_path), int(time.time()), 0, None, None)
            finally:
                conn.close()
        store.commit()
        return stats


# ============================================================ WorkBuddy
def _wb_ts(v):
    """WorkBuddy 的时间戳是毫秒整数（1786675947929）；少数行给 ISO 字符串。"""
    if isinstance(v, (int, float)) and v:
        v = float(v)
        return time.strftime("%Y-%m-%dT%H:%M:%S",
                             time.localtime(v / 1000 if v > 1e11 else v))
    if isinstance(v, str) and v.strip():
        return v
    return None


def _text_from_wb_content(content):
    """WorkBuddy message.content：str 或 [{"type":"input_text"|"output_text","text":...}]。"""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t in ("input_text", "output_text", "text"):
                parts.append(b.get("text") or "")
            elif t in ("input_image", "image"):
                parts.append("[image]")
    return "\n".join(p for p in parts if p)


def _classify_wb_line(o):
    """WorkBuddy 会话行 → (role, content, ctype) 或 None。

    {"type":"message","role":"user"|"assistant","content":[...],"timestamp":<ms>}
    工具调用是独立的 function_call / function_call_result 行，不混在 message 里。
    """
    if o.get("type") != "message":
        return None
    role = o.get("role")
    if role not in ("user", "assistant"):
        return None
    txt = _text_from_wb_content(o.get("content"))
    if not txt:
        return None
    return (role, txt, "text")


def _wb_session_meta(base):
    """读取 WorkBuddy 主库 sessions 表：{sessionId: {title, custom_title, cwd, ...}}。

    WorkBuddy 界面上的任务名（如「F3173-工厂-产品数据支撑」）只存在这张表里：
    JSONL 的 ai-title 是模型早先补写的草稿标题，常缺失或滞后，缺了就只剩工作空间路径。
    库在 projects 的上一级（~/.workbuddy/workbuddy.db），被 WorkBuddy 占用时只读打开，
    失败就返回空表——标题退化为 JSONL 规则，采集本身不受影响。
    """
    base = base.rstrip(os.sep)
    db_path = os.path.join(os.path.dirname(base), "workbuddy.db")
    if not os.path.isfile(db_path):
        db_path = os.path.join(base, "workbuddy.db")
    if not os.path.isfile(db_path):
        return {}
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % quote(db_path), uri=True, timeout=2)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id,title,custom_title,cwd,created_at,updated_at FROM sessions"
        ).fetchall()
        conn.close()
    except Exception:
        return {}
    return {r["id"]: dict(r) for r in rows}


class WorkBuddyScanner:
    """WorkBuddy 会话：<root>/<project>/<uuid>.jsonl（自有 JSONL 格式，追加式）。

    每个 JSONL 对应工作空间里的一个任务（也有独立任务）；标题优先取主库
    sessions 表的 custom_title / title，JSONL 的 ai-title 与首条用户消息只作兜底。
    """

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "workbuddy"
        self.root = _expand_root(root)

    def _base(self):
        return (self.root or os.environ.get("HUB_WORKBUDDY_PROJECTS")
                or os.path.expanduser("~/.workbuddy/projects"))

    def sources(self):
        return sorted(glob.glob(os.path.join(self._base(), "*", "*.jsonl")))

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        meta_map = _wb_session_meta(self._base())
        for path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if size < cur["offset_bytes"]:
                cur = {"offset_bytes": 0, "msg_seq": 0}

            sid = os.path.splitext(os.path.basename(path))[0]
            proj = os.path.basename(os.path.dirname(path))
            meta = meta_map.get(sid) or {}
            with open(path, "rb") as f:
                f.seek(cur["offset_bytes"])
                chunk = f.read()
            consumed = cur["offset_bytes"] + len(chunk)
            if chunk.endswith(b"\n"):
                lines = chunk.split(b"\n")[:-1]
            else:
                parts = chunk.split(b"\n")
                lines = parts[:-1]
                consumed -= len(parts[-1])

            session_touched = False
            user_candidates = []
            seq = cur["msg_seq"]
            started_at = None
            custom_title = None
            last_ts = None
            title_hit = False
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    seq += 1
                    continue
                ts = _wb_ts(o.get("timestamp"))
                if ts:
                    last_ts = ts
                    if started_at is None:
                        started_at = ts
                typ = o.get("type")
                if typ == "ai-title":
                    t = o.get("aiTitle") or o.get("title")
                    if t and t != custom_title:
                        custom_title = t
                        title_hit = True
                if o.get("cwd"):
                    proj = o["cwd"]
                cls = _classify_wb_line(o)
                if cls is None:
                    continue
                role, content, ctype = cls
                if role == "user" and ctype == "text":
                    user_candidates.append(content[:200])
                seq += 1
                r = store.add_message(sid, self.tool, seq, ts, role, content, ctype, raw=None)
                if r == "new":
                    stats["new_messages"] += 1
                    session_touched = True

            # 标题优先级：主库用户改名 > 主库任务名 > JSONL ai-title > 首条用户消息 > 工作空间路径。
            # 主库任务名才是 WorkBuddy 界面里每个会话（任务）的名字；JSONL 的 ai-title
            # 常缺失/滞后，只作兜底，否则整列只会重复显示工作空间。
            prev = store.session(sid)
            db_custom = _clean_title(meta.get("custom_title"))
            db_title = _clean_title(meta.get("title"))
            picked = _pick_title(user_candidates)
            if db_custom:
                title, title_source = db_custom, "custom-title"
            elif db_title:
                title, title_source = db_title, "session-title"
            elif custom_title:
                title, title_source = custom_title, "ai-title"
            elif picked:
                title, title_source = picked, "first-user"
            elif prev and prev.get("title") and prev.get("title_source") not in (None, "", "fallback"):
                # 增量扫描只读到追加的正文、没读到标题行：沿用已有标题，别退回工作空间路径
                title, title_source = prev["title"], prev["title_source"]
            else:
                title, title_source = "(%s) %s" % (self.tool, _clean_title(proj)), "fallback"

            proj = meta.get("cwd") or proj
            started_at = (_wb_ts(meta.get("created_at")) or started_at
                          or time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime)))
            updated = max([x for x in (_wb_ts(meta.get("updated_at")), last_ts) if x],
                          default=now_iso())

            title_changed = not prev or prev.get("title") != title
            if session_touched or cur["offset_bytes"] == 0 or title_hit or title_changed:
                store.upsert_session(sid, self.tool, (title or "")[:200], proj, path,
                                     started_at, updated, title_source)
                if session_touched or cur["offset_bytes"] == 0:
                    stats["new_sessions"] += 1
                    store.bump_msg_count(sid)
            store.set_cursor(key, consumed, seq, mtime, size)
        store.commit()
        return stats


# ============================================================ ZCode
class ZCodeScanner(OpenCodeScanner):
    """ZCode 会话库与 OpenCode 同构（session / message / part 三表），复用其读取逻辑。

    库：~/.zcode/cli/db/db.sqlite；message.data 带 role，part.data 带 type/text。
    """

    DB_CANDIDATES = [
        os.path.expanduser("~/.zcode/cli/db/db.sqlite"),
    ]

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "zcode"
        self.root = _expand_root(root) or os.environ.get("HUB_ZCODE_DB")


# ============================================================ AutoClaw
_OC_MARKER_RE = _re.compile(r"<<<AUTOCLAW_[A-Z_]+>>>")


def _strip_oc_markers(txt):
    """剥离 AutoClaw 包装标记 <<<AUTOCLAW_XXX_START>>> / _END>>>，只留正文。"""
    return _OC_MARKER_RE.sub("", txt or "").strip()


def _oc_is_policy_noise(content):
    """AutoClaw 每轮会注入大段策略提醒（13000+ 字符，几乎全是 system-reminder），
    这类消息不是用户对话，整条跳过，避免污染会话与标题。"""
    if not content:
        return True
    return ("AUTOCLAW_STABLE_POLICY_REMINDER" in content
            or "AUTOCLAW_OUTPUT_PROTOCOL" in content)


def _oc_title_candidate(content):
    """AutoClaw 的 user 消息是长任务文本 / IM 批次，没有天然标题：
    逐行扫描，跳过空行、[方括号] 与 <标签> 标记行，取首个有意义的行截断 60 字。
    """
    if not content:
        return None
    for raw in content.split("\n"):
        line = raw.strip()
        if not line:
            continue
        line = line.lstrip("#>-* \t").strip()
        if not line or line.startswith("[") or line.startswith("<"):
            continue
        if _NOISE_TITLE.match(line):
            continue
        return line[:60]
    return None


class AutoClawScanner:
    """AutoClaw 会话：<root>/agents/<agent>/sessions/<uuid>.jsonl（追加式 JSONL）。

    行：{"type":"message","message":{"role":"user"|"assistant","content":...}}
    另有 session（带 cwd）/ model_change / compaction 等行；执行轨迹 .trajectory.jsonl 不采。
    """

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "autoclaw"
        self.root = _expand_root(root)

    def sources(self):
        # root 既可能是 <...>/.openclaw-autoclaw（适配器默认），也可能是它下面的 agents/
        # （内置工具登记的就是这一层）→ 两种都认，避免多拼一层 agents 导致采不到
        base = _expand_root(self.root or os.environ.get("HUB_AUTOCLAW_DIR")
                            or os.path.expanduser("~/.openclaw-autoclaw"))
        pats = [os.path.join(base, "*", "sessions", "*.jsonl")]
        if os.path.basename(base.rstrip("/")) != "agents":
            pats.append(os.path.join(base, "agents", "*", "sessions", "*.jsonl"))
        found = []
        for pat in pats:
            found += glob.glob(pat)
        return sorted(p for p in set(found) if not p.endswith(".trajectory.jsonl"))

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "%s:%s" % (self.tool, path)
            cur = store.get_cursor(key) or {"offset_bytes": 0, "msg_seq": 0}
            try:
                size = os.path.getsize(path)
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if size < cur["offset_bytes"]:
                cur = {"offset_bytes": 0, "msg_seq": 0}

            sid = os.path.splitext(os.path.basename(path))[0]
            proj = os.path.basename(os.path.dirname(os.path.dirname(path)))
            with open(path, "rb") as f:
                f.seek(cur["offset_bytes"])
                chunk = f.read()
            consumed = cur["offset_bytes"] + len(chunk)
            if chunk.endswith(b"\n"):
                lines = chunk.split(b"\n")[:-1]
            else:
                parts = chunk.split(b"\n")
                lines = parts[:-1]
                consumed -= len(parts[-1])

            session_touched = False
            user_candidates = []
            seq = cur["msg_seq"]
            started_at = None
            custom_title = None
            last_ts = None
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    seq += 1
                    continue
                ts = o.get("timestamp")
                if ts:
                    last_ts = ts
                    if started_at is None:
                        started_at = ts
                typ = o.get("type")
                if o.get("cwd"):
                    proj = o["cwd"]
                if typ == "compaction":
                    summary = o.get("summary")
                    if summary:
                        seq += 1
                        if store.add_message(sid, self.tool, seq, ts, "system",
                                             "summary: %s" % summary, "system") == "new":
                            stats["new_messages"] += 1
                            session_touched = True
                    continue
                if typ != "message":
                    continue
                msg = o.get("message") or {}
                role = msg.get("role")
                if role not in ("user", "assistant"):
                    continue
                content = _strip_oc_markers(_text_from_claude_content(msg.get("content")))
                if not content:
                    continue
                if _oc_is_policy_noise(content):
                    continue          # 策略注入消息，不入库也不参与标题
                if role == "user":
                    cand = _oc_title_candidate(content)
                    if cand:
                        user_candidates.append(cand)
                seq += 1
                r = store.add_message(sid, self.tool, seq, ts, role, content, "text", raw=None)
                if r == "new":
                    stats["new_messages"] += 1
                    session_touched = True

            if session_touched or cur["offset_bytes"] == 0:
                title = (custom_title or _pick_title(user_candidates)
                         or "(%s) %s" % (self.tool, _clean_title(proj)))
                if started_at is None:
                    started_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime))
                store.upsert_session(sid, self.tool, (title or "")[:200], proj, path,
                                     started_at, last_ts or now_iso(), "first-user")
                stats["new_sessions"] += 1
                store.bump_msg_count(sid)
            store.set_cursor(key, consumed, seq, mtime, size)
        store.commit()
        return stats


# ============================================================ Trae CN
class TraeScanner:
    """Trae CN：会话正文存在加密库，现阶段不采集。

    实测（2026-10-09）：会话正文在
      ~/Library/Application Support/Trae CN/ModularData/ai-chat/database.db
    该文件是 SQLCipher 加密库（文件头非 "SQLite format 3"），不解密读不出；
    工作区 state.vscdb 里的 ChatStore / chat.ChatSessionStore.index 只存界面状态
    （面板高度、标签栏），不含对话内容。故 sources() 返回空 —— 工具照常登记
    （Skills / MCP 仍可管理），会话侧留 0 条。若 Trae 后续开放明文导出，
    在此补 sources() / scan() 即可。
    """

    def __init__(self, tool_id=None, root=None):
        self.tool = tool_id or "trae-cn"
        self.root = _expand_root(root)

    def sources(self):
        return []

    def scan(self, store: Store):
        return {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0,
                "note": "Trae CN 会话库为加密存储（SQLCipher），暂不支持采集"}


ADAPTER_CLASSES = {
    "claude": ClaudeScanner,
    "codex": CodexScanner,
    "opencode": OpenCodeScanner,
    "pi": PiScanner,
    "cursor": CursorScanner,
    "workbuddy": WorkBuddyScanner,
    "zcode": ZCodeScanner,
    "autoclaw": AutoClawScanner,
    "trae-cn": TraeScanner,
}


def build_scanners(store):
    """按工具注册表构造启用的采集器（内置 + 自定义）。"""
    out = []
    for t in tools_registry.load_tools(store):
        if not t.get("enabled", True):
            continue
        cls = ADAPTER_CLASSES.get(t.get("adapter"))
        if cls is None:
            continue
        # 展开 ~ 后再交给扫描器（扫描器内部也会展开一次；这里是防回归的关键点）
        out.append(cls(tool_id=t["id"], root=_expand_root(t.get("root"))))
    return out


def scan_all(store: Store, tools=None):
    results = []
    for sc in build_scanners(store):
        if tools and sc.tool not in tools:
            continue
        try:
            results.append(sc.scan(store))
        except Exception as e:  # one broken source must not kill the refresh
            results.append({"tool": sc.tool, "error": str(e)})
    return results

# ============================================================ 只读试读（工具路径探测）
# 用途：登记/编辑工具时当场回答两件事——「按这个格式在这个路径下能读到东西吗」、
# 「这个路径看起来更像哪个已知格式」。避免用户选错格式后静默 0 条。
# 与真实采集共用同一套 sources() 规则，但绝不写库、不写 cursor、不动源文件。
PROBE_LAYOUT = {
    "claude": "<root>/*/*.jsonl",
    "codex": "<root>/sessions/**/*.jsonl",
    "opencode": "<root>（SQLite 数据库文件）",
    "pi": "<root>/**/*.jsonl",
    "cursor": "<root>（state.vscdb 数据库）",
    "workbuddy": "<root>/*/*.jsonl",
    "zcode": "<root>（SQLite 数据库文件）",
    "autoclaw": "<root>/agents/*/sessions/*.jsonl",
    "trae-cn": "会话库为 SQLCipher 加密（暂不采集）",
    "agents": "无会话采集（仅登记 Skills / MCP）",
}
PROBE_BUDGET_S = 2.0
PROBE_LIMIT = 200


def _walk_jsonl(base, deadline, limit=PROBE_LIMIT):
    """带预算的递归 *.jsonl 收集（仅 pi 用 <root>/**/*.jsonl，避免大目录卡死）。"""
    hits = []
    for dirpath, _dirnames, filenames in os.walk(base):
        if time.monotonic() > deadline:
            return hits, True
        for fn in filenames:
            if fn.endswith(".jsonl"):
                hits.append(os.path.join(dirpath, fn))
                if len(hits) >= limit:
                    return hits, True
    return hits, False


def probe_source(adapter, root):
    """只读试读：该格式在该路径下能匹配到几个候选文件/库（含样例名与失败原因）。"""
    out = {"adapter": adapter or "", "layout": PROBE_LAYOUT.get(adapter or "", ""),
           "files": 0, "sample": [], "readable": False, "note": "", "reason": ""}
    if not adapter:
        out["note"], out["reason"] = "未选择会话格式", "no-adapter"
        return out
    if adapter not in ADAPTER_CLASSES:
        out["note"], out["reason"] = "该格式没有采集器（只能登记 Skills / MCP）", "no-collector"
        return out
    if not str(root or "").strip():
        out["note"], out["reason"] = "未填会话路径", "no-root"
        return out
    p = os.path.expanduser(str(root).strip())
    if not os.path.exists(p):
        out["note"], out["reason"] = "路径不存在", "missing-path"
        return out
    if adapter == "trae-cn":
        out["note"], out["reason"] = "Trae CN 会话库为 SQLCipher 加密，登记后仍读不到正文", "encrypted"
        return out
    deadline = time.monotonic() + PROBE_BUDGET_S
    if adapter == "pi":
        files, truncated = _walk_jsonl(p, deadline)
    else:
        try:
            files = ADAPTER_CLASSES[adapter](tool_id="__probe__", root=p).sources()
        except Exception as e:
            out["note"], out["reason"] = "探测失败：%s" % str(e)[:120], "error"
            return out
        truncated = len(files) > PROBE_LIMIT
        files = files[:PROBE_LIMIT]
    # 只算真实文件：opencode / zcode / cursor 这类「给文件路径」的格式，
    # sources() 只判断 os.path.exists，若传目录也会“命中”，这里统一过滤掉
    files = [f for f in files if os.path.isfile(f)]
    out["files"] = len(files)
    out["sample"] = [os.path.basename(f) for f in files[:3]]
    out["readable"] = bool(files)
    out["reason"] = "ok" if files else "no-match"
    if truncated:
        out["note"] = "目录较大，仅统计前 %d 个" % PROBE_LIMIT
    return out


# ============================================================ 格式识别（内容嗅探）
# 目的：用户不该替 hub 回答「这是什么会话格式」。给一条路径，hub 自己认：
#   1) 路径形状（弱信号，用于区分同构格式）
#   2) 内容特征（强信号：JSONL 首几行的键 / SQLite 表名 / 加密库文件头）
FORMAT_SNIFF_BYTES = 256 * 1024


def _sniff_jsonl(path, max_lines=6):
    """读 JSONL 头部几行，收集出现过的键与 type 值（只读，不解析语义）。"""
    keys, types = set(), set()
    try:
        with open(path, "rb") as f:
            head = f.read(FORMAT_SNIFF_BYTES).decode("utf-8", "ignore")
    except OSError:
        return keys, types
    if "<<<AUTOCLAW_" in head:      # AutoClaw 在正文里注入自有标记
        types.add("autoclaw-marker")
    n = 0
    for line in head.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if not isinstance(o, dict):
            continue
        keys.update(o.keys())
        t = o.get("type")
        if isinstance(t, str):
            types.add(t)
        n += 1
        if n >= max_lines:
            break
    return keys, types


def _sniff_sqlite_tables(path):
    """SQLite 表名（只读）；非 SQLite 文件（如 SQLCipher）返回 None。"""
    try:
        with open(path, "rb") as f:
            if not f.read(16).startswith(b"SQLite format 3"):
                return None
    except OSError:
        return None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
        try:
            return {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        finally:
            conn.close()
    except sqlite3.Error:
        return None


def _jsonl_candidates(root, limit=20, max_depth=4):
    """目录下的 jsonl 候选（含根目录一级；限定层数与数量，跳过点目录）。"""
    out = []
    base = root.rstrip("/").count(os.sep)
    for dirpath, dirnames, filenames in os.walk(root):
        if dirpath.count(os.sep) - base >= max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.endswith(".jsonl"):
                out.append(os.path.join(dirpath, fn))
                if len(out) >= limit:
                    return out
    return out


def _classify_jsonl(keys, types):
    """单个 JSONL 文件的格式判定 → (adapter, evidence) 或 (None, None)。"""
    if "autoclaw-marker" in types:
        return "autoclaw", "JSONL 正文含 <<<AUTOCLAW_*>>> 标记（AutoClaw）"
    if "session_meta" in types or "response_item" in types or "turn_context" in types:
        return "codex", "JSONL 含 session_meta / response_item（Codex）"
    if "aiTitle" in keys or "ai-title" in types:
        return "workbuddy", "JSONL 含 ai-title / aiTitle（WorkBuddy）"
    if "parentUuid" in keys or "sessionId" in keys:
        return "claude", "JSONL 含 sessionId / parentUuid（Claude Code）"
    if "session" in types and "message" in keys:
        return "pi", "JSONL 首行 type=session + message（Pi-Agent）"
    if "compaction" in types or "compacted" in types:
        return "autoclaw", "JSONL 含 compaction 行（AutoClaw）"
    return None, None


def detect_format(root):
    """识别一个路径是什么会话格式（内容优先，路径形状兜底）。

    返回 {adapter, confidence(high|medium|low), evidence, family, reason}；
    认不出时 adapter=None, reason="unknown"。
    """
    out = {"adapter": None, "confidence": "", "evidence": "", "family": "", "reason": ""}
    if not str(root or "").strip():
        out["reason"] = "no-root"
        return out
    p = os.path.expanduser(str(root).strip())
    if not os.path.exists(p):
        out["reason"] = "missing-path"
        return out
    low = p.lower()

    # ---- 单文件：数据库类 ----
    if os.path.isfile(p):
        tables = _sniff_sqlite_tables(p)
        if tables is None:
            out["reason"] = "encrypted-or-not-sqlite"
            out["evidence"] = "文件头不是 SQLite（可能是 SQLCipher 加密库或非会话库）"
            if "trae" in low:
                out["adapter"], out["confidence"] = "trae-cn", "medium"
            return out
        if "cursorDiskKV" in tables:
            out.update(adapter="cursor", confidence="high", family="sqlite",
                       evidence="SQLite 表 cursorDiskKV（Cursor composer 库）")
            return out
        if "session" in tables and "message" in tables:
            # opencode 与 zcode 库同构，只能靠路径区分
            ad = "zcode" if ".zcode" in low else "opencode"
            out.update(adapter=ad, confidence="medium", family="opencode-sqlite",
                       evidence="SQLite 表 session + message（OpenCode / ZCode 同构，按路径判定）")
            return out
        out["reason"] = "unknown-sqlite"
        out["evidence"] = "SQLite 表：%s" % ", ".join(sorted(tables)[:6])
        return out

    # ---- 目录：按文件内容嗅探 ----
    files = _jsonl_candidates(p)
    if not files:
        out["reason"] = "no-files"
        return out
    # 逐文件分类投票：根目录可能混着非会话 jsonl（如 codex 的 history.jsonl）
    votes, evidence, keys_union = {}, {}, set()
    for f in files[:8]:
        k, t = _sniff_jsonl(f)
        keys_union |= k
        a, ev = _classify_jsonl(k, t)
        if a:
            votes[a] = votes.get(a, 0) + 1
            evidence.setdefault(a, ev)
    if not votes:
        out["reason"] = "unknown-jsonl"
        out["evidence"] = "识别不出已知会话格式（键：%s）" % ", ".join(sorted(keys_union)[:8])
        return out
    best = max(votes, key=lambda a: votes[a])
    out.update(adapter=best, family="jsonl",
               confidence="high" if votes[best] > 1 else "medium",
               evidence=evidence[best])
    return out
