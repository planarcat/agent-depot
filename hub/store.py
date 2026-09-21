"""SQLite-backed store for Agent Session Hub.

Database location: ~/.agent/hub/hub.db
Tables: sessions, messages, cursor (per-source incremental state),
ledger (audit trail of every operation), config (key-value).
"""
import hashlib
import json
import os
import sqlite3
import threading
import time

HUB_DIR = os.environ.get("AGENT_HUB_DIR") or os.path.expanduser("~/.agent/hub")
DB_PATH = os.path.join(HUB_DIR, "hub.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,              -- tool-specific native session id
  tool TEXT NOT NULL,                -- claude | codex | opencode
  title TEXT,
  cwd TEXT,
  source_file TEXT,                  -- absolute path of the source transcript
  started_at TEXT,
  updated_at TEXT,
  msg_count INTEGER DEFAULT 0,
  title_source TEXT,                 -- custom-title | first-user | slug | fallback
  starred INTEGER DEFAULT 0          -- 收藏标记
);
CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  tool TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- per-session order as read from source
  ts TEXT,
  role TEXT,                         -- user | assistant | tool | system
  content TEXT,                      -- text content (may be empty for tool-only events)
  content_type TEXT DEFAULT 'text',  -- text | tool_use | tool_result | system
  hash TEXT NOT NULL,                -- content hash for dedupe
  raw TEXT                           -- original event JSON (lossless fallback)
);
CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(sid, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_hash ON messages(sid, hash);

CREATE TABLE IF NOT EXISTS cursor (
  source_key TEXT PRIMARY KEY,       -- e.g. claude:<abs file path>
  offset_bytes INTEGER DEFAULT 0,    -- for JSONL sources
  msg_seq INTEGER DEFAULT 0,         -- messages stored so far (ordering anchor)
  mtime REAL,
  size INTEGER
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,              -- refresh | migrate | export | config
  detail TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


class Store:
    def __init__(self, db_path=None):
        os.makedirs(HUB_DIR, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(db_path or DB_PATH, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        # migrate older DBs: add starred column if missing
        cols = [r[1] for r in self.db.execute("PRAGMA table_info(sessions)").fetchall()]
        if "starred" not in cols:
            self.db.execute("ALTER TABLE sessions ADD COLUMN starred INTEGER DEFAULT 0")
        self.db.commit()

    # ---------- ledger / config ----------
    def log(self, action, detail):
        with self.lock:
          self.db.execute("INSERT INTO ledger(ts, action, detail) VALUES (?,?,?)",
                          (now_iso(), action, json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail))
          self.db.commit()

    def get_config(self, key, default=None):
        with self.lock:
          row = self.db.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
          return row["value"] if row else default

    def set_config(self, key, value):
        with self.lock:
            self.db.execute("INSERT INTO config(key,value) VALUES(?,?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))
            self.db.commit()

    # ---------- cursor ----------
    def get_cursor(self, source_key):
        with self.lock:
          row = self.db.execute("SELECT * FROM cursor WHERE source_key=?", (source_key,)).fetchone()
          return dict(row) if row else None

    def set_cursor(self, source_key, offset_bytes, msg_seq, mtime, size):
        with self.lock:
            self.db.execute(
                "INSERT INTO cursor(source_key, offset_bytes, msg_seq, mtime, size) VALUES(?,?,?,?,?) "
                "ON CONFLICT(source_key) DO UPDATE SET offset_bytes=excluded.offset_bytes, msg_seq=excluded.msg_seq, "
                "mtime=excluded.mtime, size=excluded.size",
                (source_key, offset_bytes, msg_seq, mtime, size))
            self.db.commit()

    # ---------- sessions ----------
    def upsert_session(self, sid, tool, title, cwd, source_file, started_at, updated_at,
                       title_source="fallback"):
        with self.lock:
            self.db.execute(
                "INSERT INTO sessions(sid, tool, title, cwd, source_file, started_at, updated_at, msg_count, title_source) "
                "VALUES(?,?,?,?,?,?,?,0,?) "
                "ON CONFLICT(sid) DO UPDATE SET title=excluded.title, cwd=excluded.cwd, "
                "updated_at=excluded.updated_at, title_source=excluded.title_source",
                (sid, tool, title, cwd, source_file, started_at, updated_at, title_source))

    def bump_msg_count(self, sid):
        with self.lock:
          self.db.execute("UPDATE sessions SET msg_count=(SELECT COUNT(*) FROM messages WHERE sid=?) WHERE sid=?",
                          (sid, sid))

    def commit(self):
        with self.lock:
            self.db.commit()

    # ---------- messages ----------
    @staticmethod
    def content_hash(role, content):
        h = hashlib.sha256()
        h.update((role or "").encode())
        h.update(b"\x00")
        h.update((content or "").encode())
        return h.hexdigest()[:24]

    def add_message(self, sid, tool, seq, ts, role, content, content_type="text", raw=None):
        """Insert message; dedupe by (sid, hash). Returns 'new' | 'dupe'."""
        h = self.content_hash(role, content)
        with self.lock:
            try:
                self.db.execute(
                    "INSERT INTO messages(sid, tool, seq, ts, role, content, content_type, hash, raw) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (sid, tool, seq, ts, role, content, content_type, h,
                     json.dumps(raw, ensure_ascii=False) if raw is not None else None))
                return "new"
            except sqlite3.IntegrityError:
                return "dupe"

    # ---------- queries ----------
    def list_sessions(self, tool=None, q=None):
        with self.lock:
          sql = "SELECT * FROM sessions WHERE 1=1"
          args = []
          if tool and tool != "all":
              sql += " AND tool=?"
              args.append(tool)
          if q:
              sql += " AND (title LIKE ? OR sid LIKE ?)"
              args.extend([f"%{q}%", f"%{q}%"])
          sql += " ORDER BY updated_at DESC"
          return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def counts_by_tool(self):
        with self.lock:
          rows = self.db.execute("SELECT tool, COUNT(*) n, MAX(updated_at) latest FROM sessions GROUP BY tool").fetchall()
          return {r["tool"]: {"count": r["n"], "latest": r["latest"]} for r in rows}

    def session(self, sid):
        with self.lock:
          row = self.db.execute("SELECT * FROM sessions WHERE sid=?", (sid,)).fetchone()
          return dict(row) if row else None

    def messages(self, sid):
        with self.lock:
          rows = self.db.execute(
              "SELECT seq, ts, role, content, content_type FROM messages WHERE sid=? ORDER BY seq", (sid,)).fetchall()
          return [dict(r) for r in rows]

    def ledger_recent(self, limit=30):
        with self.lock:
          rows = self.db.execute("SELECT * FROM ledger ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
          return [dict(r) for r in rows]


# ====================================================================
# Lineage / migration ledger (增量勾连底座)
# ====================================================================
LINEAGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS lineages (
  lid TEXT PRIMARY KEY,              -- lx-0001 style hub tag
  created_at TEXT NOT NULL,
  origin_tool TEXT,
  origin_sid TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lineages_origin ON lineages(origin_tool, origin_sid);
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid TEXT NOT NULL,                 -- lineage id
  ts TEXT NOT NULL,
  src_tool TEXT NOT NULL,
  src_sid TEXT NOT NULL,
  dst_tool TEXT NOT NULL,
  dst_sid TEXT,                      -- new native session id (may be NULL on failure)
  status TEXT NOT NULL,              -- ok | error
  src_msg_count INTEGER,             -- messages at migration time (增量基线)
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_migrations_src ON migrations(src_tool, src_sid);
CREATE INDEX IF NOT EXISTS idx_migrations_dst ON migrations(dst_tool, dst_sid);
CREATE INDEX IF NOT EXISTS idx_migrations_lid ON migrations(lid);
"""


def ensure_lineage_schema(store: Store):
    with store.lock:
        store.db.executescript(LINEAGE_SCHEMA)
        store.db.commit()


def _next_lid(store: Store) -> str:
    """Generate next lineage id lx-NNNN (monotonic per db)."""
    with store.lock:
        row = store.db.execute("SELECT COUNT(*) c FROM lineages").fetchone()
        n = (row["c"] if row else 0) + 1
        return "lx-%04d" % n


def find_or_create_lineage(store: Store, src_tool, src_sid, note=None) -> str:
    """A source session maps to exactly one lineage (its identity across tools)."""
    with store.lock:
        # 1) origin mapping in lineages table
        row = store.db.execute(
            "SELECT lid FROM lineages WHERE origin_tool=? AND origin_sid=?",
            (src_tool, src_sid)).fetchone()
        if row:
            return row["lid"]
        # 2) appeared as migration source
        row = store.db.execute(
            "SELECT lid FROM migrations WHERE src_tool=? AND src_sid=? LIMIT 1",
            (src_tool, src_sid)).fetchone()
        if row:
            return row["lid"]
        # 3) appeared as migration destination (session born from a migration)
        row = store.db.execute(
            "SELECT lid FROM migrations WHERE dst_tool=? AND dst_sid=? LIMIT 1",
            (src_tool, src_sid)).fetchone()
        if row:
            return row["lid"]
        lid = _next_lid(store)
        store.db.execute(
            "INSERT INTO lineages(lid, created_at, origin_tool, origin_sid, note) VALUES(?,?,?,?,?) "
            "ON CONFLICT(lid) DO NOTHING",
            (lid, now_iso(), src_tool, src_sid, note))
        store.db.commit()
        return lid


def record_migration(store: Store, lid, src_tool, src_sid, dst_tool, dst_sid, status, detail=None):
    with store.lock:
        row = store.db.execute("SELECT COUNT(*) c FROM messages WHERE sid=?", (src_sid,)).fetchone()
        src_count = row["c"] if row else 0
        store.db.execute(
            "INSERT INTO migrations(lid, ts, src_tool, src_sid, dst_tool, dst_sid, status, src_msg_count, detail) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (lid, now_iso(), src_tool, src_sid, dst_tool, dst_sid, status, src_count,
             json.dumps(detail, ensure_ascii=False) if detail and not isinstance(detail, str) else detail))
        store.db.commit()


def sync_status(store: Store, src_tool, src_sid, dst_tool):
    """Increment baseline: messages added since the last successful migration."""
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM migrations WHERE src_tool=? AND src_sid=? AND dst_tool=? AND status='ok' "
            "ORDER BY id DESC LIMIT 1", (src_tool, src_sid, dst_tool)).fetchone()
        if not row:
            return None
        cur = store.db.execute("SELECT COUNT(*) c FROM messages WHERE sid=?", (src_sid,)).fetchone()["c"]
        base = row["src_msg_count"]
        delta = None if base is None else max(0, cur - base)
    return {"last_ts": row["ts"], "last_dst_sid": row["dst_sid"],
            "base_count": base, "current_count": cur, "delta": delta}


def migration_history(store: Store, tool=None, sid=None, limit=50):
    """All migrations involving (tool, sid) as source or destination."""
    with store.lock:
        if tool and sid:
            rows = store.db.execute(
                "SELECT * FROM migrations WHERE (src_tool=? AND src_sid=?) OR (dst_tool=? AND dst_sid=?) "
                "ORDER BY id DESC LIMIT ?",
                (tool, sid, tool, sid, limit)).fetchall()
        else:
            rows = store.db.execute(
                "SELECT * FROM migrations ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def lineage_info(store: Store, tool, sid):
    """Lineage + full cross-tool history for a native session."""
    with store.lock:
        row = store.db.execute(
            "SELECT lid FROM migrations WHERE (src_tool=? AND src_sid=?) OR (dst_tool=? AND dst_sid=?) LIMIT 1",
            (tool, sid, tool, sid)).fetchone()
        if not row:
            return None
        lid = row["lid"]
        migs = store.db.execute("SELECT * FROM migrations WHERE lid=? ORDER BY id", (lid,)).fetchall()
        lin = store.db.execute("SELECT * FROM lineages WHERE lid=?", (lid,)).fetchone()
    return {
        "lid": lid,
        "created_at": lin["created_at"] if lin else None,
        "migrations": [dict(m) for m in migs],
    }


# ====================================================================
# Memory region (记忆区): hub.db + ~/.agent/hub/memory/*.md 双写
# ====================================================================
import textwrap

MEMORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',    -- note | migration-summary | manual
  title TEXT,
  body TEXT NOT NULL,
  refs TEXT,                            -- JSON: {sid?, lid?, tool?}
  source TEXT DEFAULT 'ui'
);
"""

MEMORY_DIR = os.path.join(HUB_DIR, "memory")


def ensure_memory_schema(store: Store):
    with store.lock:
        store.db.executescript(MEMORY_SCHEMA)
        store.db.commit()
    os.makedirs(MEMORY_DIR, exist_ok=True)


def add_memory(store: Store, body, title=None, kind="note", refs=None, source="ui"):
    """Insert memory row + write a Markdown twin for human reading."""
    with store.lock:
        cur = store.db.execute(
            "INSERT INTO memories(ts, kind, title, body, refs, source) VALUES(?,?,?,?,?,?)",
            (now_iso(), kind, title, body,
             json.dumps(refs, ensure_ascii=False) if refs else None, source))
        store.db.commit()
        mid = cur.lastrowid
    # markdown twin: append-only daily journal（人类可读 · 无删除问题）
    try:
        os.makedirs(MEMORY_DIR, exist_ok=True)
        day = time.strftime("%Y-%m-%d", time.localtime())
        jpath = os.path.join(MEMORY_DIR, day + ".md")
        with open(jpath, "a") as f:
            f.write("\n## [%s] %s\n\n- id: %d · kind: %s · refs: %s\n\n%s\n"
                    % (now_iso()[11:16], title or "(无标题)", mid, kind,
                       json.dumps(refs, ensure_ascii=False) if refs else "-", body))
    except OSError:
        pass
    return mid


def list_memories(store: Store, kind=None, limit=100):
    with store.lock:
        if kind:
            rows = store.db.execute(
                "SELECT * FROM memories WHERE kind=? ORDER BY id DESC LIMIT ?", (kind, limit)).fetchall()
        else:
            rows = store.db.execute(
                "SELECT * FROM memories ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def delete_memory(store: Store, mid):
    with store.lock:
        cur = store.db.execute("DELETE FROM memories WHERE id=?", (mid,))
        store.db.commit()
    return cur.rowcount > 0


# ====================================================================
# Search / export / star (v0.3 features)
# ====================================================================
EXPORT_DIR = os.path.join(HUB_DIR, "exports")


def set_star(store: Store, sid, starred=None):
    """Toggle (starred=None) or set star state. Returns new state."""
    with store.lock:
        row = store.db.execute("SELECT starred FROM sessions WHERE sid=?", (sid,)).fetchone()
        if not row:
            return None
        cur = row["starred"] or 0
        new = (1 - cur) if starred is None else (1 if starred else 0)
        store.db.execute("UPDATE sessions SET starred=? WHERE sid=?", (new, sid))
        store.db.commit()
    return new


def _like_escape(q):
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_messages(store: Store, q, limit=40):
    """Full-text-ish search over message content (LIKE, escaped). Returns grouped hits."""
    if not q or not q.strip():
        return []
    pat = "%%%s%%" % _like_escape(q.strip())
    with store.lock:
        rows = store.db.execute(
            "SELECT m.sid, m.tool, m.role, m.content, m.ts, s.title, s.starred "
            "FROM messages m LEFT JOIN sessions s ON s.sid = m.sid "
            "WHERE m.content LIKE ? ESCAPE '\\' "
            "ORDER BY m.id DESC LIMIT ?", (pat, limit * 5)).fetchall()
    grouped = {}
    low = q.strip().lower()
    for r in rows:
        sid = r["sid"]
        g = grouped.setdefault(sid, {"sid": sid, "tool": r["tool"], "title": r["title"],
                                     "starred": r["starred"] or 0, "hits": 0, "snippet": None})
        g["hits"] += 1
        if g["snippet"] is None:
            c = (r["content"] or "")
            idx = c.lower().find(low)
            if idx < 0:
                idx = 0
            start = max(0, idx - 30)
            snippet = c[start:start + 120].replace("\n", " ")
            g["snippet"] = ("…" if start > 0 else "") + snippet + ("…" if len(c) > start + 120 else "")
    out = list(grouped.values())
    out.sort(key=lambda x: -x["hits"])
    return out[:limit]


def export_markdown(store: Store, sid):
    """Export a session as a human-readable Markdown file. Returns (path, bytes)."""
    sess = store.session(sid)
    if not sess:
        return None, 0
    msgs = store.messages(sid)
    toolname = {"claude": "Claude Code", "codex": "Codex CLI", "opencode": "OpenCode"}.get(sess["tool"], sess["tool"])
    lines = ["# %s" % (sess.get("title") or "(无标题)"), "",
             "- 工具: %s" % toolname,
             "- 会话 ID: `%s`" % sid,
             "- 项目: `%s`" % (sess.get("cwd") or "-"),
             "- 消息数: %d" % (sess.get("msg_count") or len(msgs)),
             "- 导出时间: %s" % now_iso(), "", "---", ""]
    for m in msgs:
        role = m.get("role") or "?"
        ts = (m.get("ts") or "")[:16].replace("T", " ")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if m.get("content_type") == "tool_use":
            lines.append("> [tool] %s" % content.replace("\n", " ")[:300])
            lines.append("")
            continue
        if m.get("content_type") == "tool_result":
            lines.append("> [result] %s" % content.replace("\n", " ")[:300])
            lines.append("")
            continue
        lines.append("**%s**%s" % (role, (" · " + ts) if ts else ""))
        lines.append("")
        lines.append(content)
        lines.append("")
    body = "\n".join(lines) + "\n"
    os.makedirs(EXPORT_DIR, exist_ok=True)
    safe = "".join(ch for ch in sid if ch.isalnum() or ch in "-_")[:24]
    fname = "%s-%s-%s.md" % (sess["tool"], safe, time.strftime("%Y%m%d-%H%M%S"))
    path = os.path.join(EXPORT_DIR, fname)
    with open(path, "w") as f:
        f.write(body)
    return path, len(body.encode())
