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
  title_source TEXT                  -- custom-title | first-user | slug | fallback
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
