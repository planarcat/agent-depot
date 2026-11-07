//! 存储层：SQLite WAL + 单写连接（Mutex 串行）+ 只读池。
//!
//! 评审修订（v3 §5.3/4）：per-connection PRAGMA（WAL/synchronous=NORMAL/busy_timeout/
//! foreign_keys）；读连接 `query_only=1`；命令级串行由上层命令执行器保证（本层提供
//! `with_write_txn`：BEGIN IMMEDIATE → 领域 → 事件追加 → commit，事件发射绑 Transaction）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{CoreError, Result};

pub struct Store {
    /// 单写连接（命令执行器串行投递；本层仍提供互斥以防直用）。
    write: Arc<Mutex<Connection>>,
    /// 只读连接池（WAL 并发读）。
    readers: Vec<Arc<Mutex<Connection>>>,
    /// 'static 引用（open 时一次性提升；池与进程同寿，守卫可安全跨作用域返回）。
    /// SAFETY：Arc::into_raw 消费一份 +1 的引用计数且永不归还——引用计数永不
    /// 归零即 'static 成立；仅本函数单点构造。
    write_static: &'static Mutex<Connection>,
    readers_static: Vec<&'static Mutex<Connection>>,
    next_reader: std::sync::atomic::AtomicUsize,
    pub hub_dir: PathBuf,
}

const SCHEMA_V1: &str = r#"
-- v3 严格化：结构对齐 legacy hub.db（Tier 1 数据面），新增 event_log 与
-- schedule（死表占位：schedule 实际存 config 表，见 tools::get_config）。
-- legacy `ops` 表由 event_log 替代（迁移器投影历史行）。
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  title TEXT,
  cwd TEXT,
  source_file TEXT,
  started_at TEXT,
  updated_at TEXT,
  msg_count INTEGER DEFAULT 0,
  title_source TEXT,
  starred INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT,
  role TEXT,
  content TEXT,
  content_type TEXT DEFAULT 'text',
  hash TEXT,
  raw TEXT,
  UNIQUE(sid, hash)
);
CREATE INDEX IF NOT EXISTS idx_messages_sid ON messages(sid, seq);

CREATE TABLE IF NOT EXISTS cursor (
  source_key TEXT PRIMARY KEY,
  offset_bytes INTEGER DEFAULT 0,
  msg_seq INTEGER DEFAULT 0,
  mtime REAL,
  size INTEGER
);

CREATE TABLE IF NOT EXISTS lineages (
  lid TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  origin_tool TEXT,
  origin_sid TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lineages_origin ON lineages(origin_tool, origin_sid);
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lid TEXT NOT NULL,
  ts TEXT NOT NULL,
  src_tool TEXT NOT NULL,
  src_sid TEXT NOT NULL,
  dst_tool TEXT NOT NULL,
  dst_sid TEXT,
  status TEXT NOT NULL,
  src_msg_count INTEGER,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT,
  body TEXT NOT NULL,
  refs TEXT,
  source TEXT DEFAULT 'ui',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  hash TEXT,
  prev_hash TEXT,
  last_source_hash TEXT,
  source_path TEXT,
  updated_at TEXT,
  status TEXT DEFAULT 'ok',
  UNIQUE(source_tool, kind, scope)
);
CREATE TABLE IF NOT EXISTS memory_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  deployed_hash TEXT,
  deployed_at TEXT,
  status TEXT DEFAULT 'ok',
  UNIQUE(item_id, tool)
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  subdir TEXT DEFAULT '',
  auth_ref TEXT,
  enabled INTEGER DEFAULT 1,
  poll_min INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_commit TEXT,
  last_error TEXT,
  repo_id INTEGER,
  UNIQUE(kind, name)
);
CREATE INDEX IF NOT EXISTS idx_sources_repo ON sources(repo_id);

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

CREATE TABLE IF NOT EXISTS remote_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  subdir TEXT DEFAULT '',
  auth_ref TEXT,
  poll_min INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(url, branch, subdir)
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
  source_hash_at TEXT,
  dir_id INTEGER,
  sub_path TEXT,
  UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS local_dirs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL DEFAULT 'linked',
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  layout TEXT
);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  path TEXT NOT NULL,
  format_key TEXT,
  writable INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  origin TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(kind, path)
);

CREATE TABLE IF NOT EXISTS dir_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'copy',
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_result TEXT,
  channels TEXT NOT NULL DEFAULT 'skills',
  excluded TEXT NOT NULL DEFAULT '[]',
  UNIQUE(dir_id, target_id)
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_kind TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_version TEXT,
  target_id INTEGER NOT NULL,
  deployed_hash TEXT,
  deployed_at TEXT,
  status TEXT DEFAULT 'ok',
  detail TEXT,
  binding_id INTEGER,
  UNIQUE(item_kind, item_name, target_id)
);

CREATE INDEX IF NOT EXISTS idx_migrations_src ON migrations(src_tool, src_sid);
CREATE INDEX IF NOT EXISTS idx_migrations_dst ON migrations(dst_tool, dst_sid);
CREATE INDEX IF NOT EXISTS idx_migrations_lid ON migrations(lid);
CREATE INDEX IF NOT EXISTS idx_memory_items_tool ON memory_items(source_tool, kind, scope);
CREATE INDEX IF NOT EXISTS idx_memory_deploy_item ON memory_deployments(item_id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 事件日志（v3 §1.1：命令→事件→投影；append-only，id 单调即全局序）。
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  module TEXT NOT NULL DEFAULT 'system',
  actor TEXT NOT NULL DEFAULT 'local',
  kind TEXT NOT NULL,
  item_kind TEXT,
  item_name TEXT,
  item_version TEXT,
  source_id INTEGER,
  target_id INTEGER,
  outcome TEXT NOT NULL DEFAULT 'ok',
  error_code TEXT,
  reason TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_kind_ts ON event_log(kind, ts);

CREATE TABLE IF NOT EXISTS schedule (
  scope TEXT PRIMARY KEY,
  interval_min INTEGER,
  enabled INTEGER DEFAULT 0,
  last_run TEXT
);
"#;

pub struct WriteTxn<'a> {
    pub tx: rusqlite::Transaction<'a>,
}

impl Store {
    /// 打开/创建库：写连接 + N 只读连接；全部连接逐个设 PRAGMA（评审修订 5.3-4）。
    pub fn open(db_path: &Path, read_pool_size: usize) -> Result<Store> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::io(format!("创建数据目录 {}", parent.display()), e))?;
        }
        let write = Self::open_conn(db_path, false)?;
        write
            .execute_batch(SCHEMA_V1)
            .map_err(CoreError::from)?;
        let mut readers = Vec::new();
        let mut readers_static = Vec::new();
        for _ in 0..read_pool_size.max(1) {
            let r = Arc::new(Mutex::new(Self::open_conn(db_path, true)?));
            readers_static.push(unsafe { &*Arc::into_raw(r.clone()) });
            readers.push(r);
        }
        let write_arc = Arc::new(Mutex::new(write));
        let write_static: &'static Mutex<Connection> =
            unsafe { &*Arc::into_raw(write_arc.clone()) };
        Ok(Store {
            write: write_arc,
            readers,
            write_static,
            readers_static,
            next_reader: std::sync::atomic::AtomicUsize::new(0),
            hub_dir: db_path.parent().unwrap_or(Path::new(".")).to_path_buf(),
        })
    }

    fn open_conn(db_path: &Path, read_only: bool) -> Result<Connection> {
        let flags = if read_only {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
        };
        let conn = Connection::open_with_flags(db_path, flags)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if read_only {
            conn.pragma_update(None, "query_only", "ON")?;
        }
        Ok(conn)
    }

    /// 写事务：BEGIN IMMEDIATE → 领域闭包（内可 emit 事件）→ commit。
    /// 事件发射只接受事务引用（编译期保证「状态变更与留痕原子」，评审 M1）。
    pub fn with_write_txn<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction) -> Result<T>,
    ) -> Result<T> {
        let conn = self.write.lock().unwrap();
        let tx = conn
            .unchecked_transaction()
            .map_err(CoreError::from)?;
        match f(&tx) {
            Ok(v) => {
                tx.commit().map_err(CoreError::from)?;
                Ok(v)
            }
            Err(e) => {
                let _ = tx.rollback();
                Err(e)
            }
        }
    }

    /// 写连接直用（命令执行器内）。
    pub fn write_conn(&self) -> Arc<Mutex<Connection>> {
        self.write.clone()
    }

    /// 只读连接轮询（WAL 读不阻塞写）。
    pub fn read_conn(&self) -> Arc<Mutex<Connection>> {
        let i = self
            .next_reader
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Arc::clone(&self.readers[i % self.readers.len()])
    }

    /// 'static 只读连接引用（守卫可跨作用域返回，无需 unsafe）。
    pub fn read_static(&self) -> &'static Mutex<Connection> {
        let i = self
            .next_reader
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.readers_static[i % self.readers_static.len()]
    }

    /// 'static 写连接引用。
    pub fn write_static(&self) -> &'static Mutex<Connection> {
        self.write_static
    }

    /// 停机：checkpoint 收回 WAL（评审 M6）。
    pub fn checkpoint(&self) -> Result<()> {
        let conn = self.write.lock().unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(CoreError::from)?;
        Ok(())
    }
}
