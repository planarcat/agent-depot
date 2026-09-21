"""Incremental scanners for Claude Code / Codex CLI / OpenCode.

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

from .store import Store, now_iso


import re as _re

_NOISE_TITLE = _re.compile(
    r"^\s*(<(environment_context|app-context|user_instructions|system|turn_context|"
    "environment|context|turn_aborted|image\b|/image>)|# Files mentioned)",
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


class ClaudeScanner:
    tool = "claude"

    def sources(self):
        base = os.environ.get("HUB_CLAUDE_PROJECTS") or os.path.expanduser("~/.claude/projects")
        out = []
        for path in glob.glob(os.path.join(base, "*", "*.jsonl")):
            out.append(path)
        return out

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "claude:%s" % path
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
                title = custom_title or _pick_title(user_candidates) or "(claude) %s" % _clean_title(proj)
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
    tool = "codex"

    def sources(self):
        home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
        return glob.glob(os.path.join(home, "sessions", "**", "*.jsonl"), recursive=True)

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for path in self.sources():
            stats["files"] += 1
            key = "codex:%s" % path
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
                title = _pick_title(user_candidates) or "(codex) %s" % _clean_title(cwd or os.path.basename(path))
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
    tool = "opencode"

    DB_CANDIDATES = [
        os.path.expanduser("~/.local/share/opencode/opencode.db"),
        os.path.expanduser("~/.local/share/opencode/storage/db.sqlite"),  # older layout
    ]

    def _candidates(self):
        override = os.environ.get("HUB_OPENCODE_DB")
        return [override] if override else self.DB_CANDIDATES

    def sources(self):
        return [p for p in self._candidates() if os.path.exists(p)]

    def _connect_ro(self, path):
        uri = "file:%s?mode=ro&immutable=0" % path
        return sqlite3.connect(uri, uri=True)

    def scan(self, store: Store):
        stats = {"tool": self.tool, "files": 0, "new_messages": 0, "new_sessions": 0}
        for db_path in self.sources():
            stats["files"] += 1
            key = "opencode:%s" % db_path
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
                    skey = "opencode:%s:%s" % (db_path, sid)
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
                    store.upsert_session(sid, self.tool, (title or "(opencode)")[:200], directory or "", db_path,
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


ALL_SCANNERS = [ClaudeScanner(), CodexScanner(), OpenCodeScanner()]


def scan_all(store: Store, tools=None):
    results = []
    for sc in ALL_SCANNERS:
        if tools and sc.tool not in tools:
            continue
        try:
            results.append(sc.scan(store))
        except Exception as e:  # one broken source must not kill the refresh
            results.append({"tool": sc.tool, "error": str(e)})
    return results
