"""v0.4 统一建表：sources / snapshots / items / registry_items / targets / deployments / ops。

幂等：每次 ensure 均 CREATE IF NOT EXISTS；老库零迁移成本。
"""
SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- 'skills' | 'mcp'
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  subdir TEXT DEFAULT '',
  auth_ref TEXT,
  enabled INTEGER DEFAULT 1,
  poll_min INTEGER DEFAULT 0,       -- 0 = 不定时
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_commit TEXT,
  last_error TEXT,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  commit_hash TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  catalog_json TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  source_hash TEXT,
  version TEXT,
  meta TEXT,
  UNIQUE(source_id, name)
);

CREATE TABLE IF NOT EXISTS registry_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source_id INTEGER,
  version TEXT,
  hash TEXT,
  updated_at TEXT,
  prev_version TEXT,
  prev_hash TEXT,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- skills_dir | mcp_json | mcp_toml
  tool TEXT,                        -- claude|codex|opencode|cursor|plain
  path TEXT NOT NULL,
  format_key TEXT,                  -- mcp_json: mcpServers | mcp
  writable INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(kind, path)
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_kind TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_version TEXT,
  target_id INTEGER NOT NULL,
  deployed_hash TEXT,
  deployed_at TEXT,
  status TEXT DEFAULT 'ok',         -- ok | conflict | removed
  detail TEXT,                      -- JSON: {files:{rel:sha}} 或 {injected:{...}}
  UNIQUE(item_kind, item_name, target_id)
);

CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  item_kind TEXT,
  item_name TEXT,
  item_version TEXT,
  source_id INTEGER,
  target_id INTEGER,
  reason TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_module_ts ON ops(module, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ops_status ON ops(status);
"""


def ensure(store):
    with store.lock:
        store.db.executescript(SCHEMA)
        cols = [r[1] for r in store.db.execute("PRAGMA table_info(registry_items)").fetchall()]
        if "source_hash_at" not in cols:
            store.db.execute("ALTER TABLE registry_items ADD COLUMN source_hash_at TEXT")
        store.db.commit()
