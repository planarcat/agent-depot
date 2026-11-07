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
  repo_id INTEGER,                  -- 设置级远程仓库 id（remote_repos.id）
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

-- 设置级远程仓库：一份配置被多个模块共用；sources.repo_id 回指本表。
-- 模块勾选关系 = sources 里是否存在该 kind 的记录（不是本表上的字段）。
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
  origin TEXT,                      -- 来源：tool:<id>（由工具注册表同步；手动创建的为 NULL）
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

-- 本地目录：本地源的多目录登记（默认目录不在此表——registry_items.dir_id IS NULL 即默认）。
-- 目录来自「选择目录」链接的磁盘已有文件夹（原生选择器 / 手填路径；2026-10-31 起
-- 不再提供 hub 代建目录）。目录内容扫描后自动登记为手动条目（registry_items.dir_id
-- 指回本表），与新建/导入同权。
CREATE TABLE IF NOT EXISTS local_dirs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL DEFAULT 'linked',
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 目录 ↔ 分发目标 持久绑定：建连即全量同步，目录内容变化由同步 worker 自动跟随。
-- 绑定对象是 target（目标目录）而非 tool——Codex/OpenCode 共享同一 skills_dir 时一次同步双工具生效。
CREATE TABLE IF NOT EXISTS dir_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id INTEGER NOT NULL,              -- local_dirs.id
  target_id INTEGER NOT NULL,           -- targets.id（kind='skills_dir'）
  mode TEXT NOT NULL DEFAULT 'copy',    -- copy | link
  enabled INTEGER DEFAULT 1,            -- 0 = 暂停（不自动同步）
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_result TEXT,                     -- JSON {added,updated,removed,skipped,conflicts}
  UNIQUE(dir_id, target_id)
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
        tcols = [r[1] for r in store.db.execute("PRAGMA table_info(targets)").fetchall()]
        if "origin" not in tcols:
            store.db.execute("ALTER TABLE targets ADD COLUMN origin TEXT")
        # 远程仓主表关联：老库的 sources 需要补 repo_id 并回填主表记录
        scols = [r[1] for r in store.db.execute("PRAGMA table_info(sources)").fetchall()]
        if "repo_id" not in scols:
            store.db.execute("ALTER TABLE sources ADD COLUMN repo_id INTEGER")
        store.db.execute("CREATE INDEX IF NOT EXISTS idx_sources_repo ON sources(repo_id)")
        # 本地目录：registry_items.dir_id（NULL = 默认目录，存量手动条目零迁移）
        rcols = [r[1] for r in store.db.execute("PRAGMA table_info(registry_items)").fetchall()]
        if "dir_id" not in rcols:
            store.db.execute("ALTER TABLE registry_items ADD COLUMN dir_id INTEGER")
        # 条目所属集合子文件夹（关联目录自动发现）：NULL = 目录自身即条目根（普通模式）
        if "sub_path" not in rcols:
            store.db.execute("ALTER TABLE registry_items ADD COLUMN sub_path TEXT")
        # 本地目录布局：发现的子 skills/mcp 文件夹（JSON；NULL = 普通模式非容器目录）
        dcols = [r[1] for r in store.db.execute("PRAGMA table_info(local_dirs)").fetchall()]
        if "layout" not in dcols:
            store.db.execute("ALTER TABLE local_dirs ADD COLUMN layout TEXT")
        # 目录×目标绑定：channels 记录开启了哪些通道（skills,mcp）；存量绑定都是 skills 通道
        bcols = [r[1] for r in store.db.execute("PRAGMA table_info(dir_bindings)").fetchall()]
        if "channels" not in bcols:
            store.db.execute(
                "ALTER TABLE dir_bindings ADD COLUMN channels TEXT NOT NULL DEFAULT 'skills'")
        # 绑定内「不跟随」的条目名（JSON 数组）：排除 = 停止同步，但工具内已装文件保留
        if "excluded" not in bcols:
            store.db.execute(
                "ALTER TABLE dir_bindings ADD COLUMN excluded TEXT NOT NULL DEFAULT '[]'")
        store.db.commit()
    from . import remote_repos
    remote_repos.backfill(store)
    ensure_memory_line_schema(store)


# v0.7 记忆分发线：中间条目登记表 + 写回部署记录
MEMORY_LINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_tool TEXT NOT NULL,        -- 采集自哪个工具
  kind TEXT NOT NULL,               -- user_profile | project_memory | topics
  scope TEXT NOT NULL,              -- global | 项目标识（slug）
  name TEXT NOT NULL,               -- 源文件名（展示用）
  version INTEGER DEFAULT 1,
  hash TEXT,                        -- hub 中间体内容 hash（权威）
  prev_hash TEXT,
  last_source_hash TEXT,            -- 上次扫描时源文件的 hash（漂移检测基准）
  source_path TEXT,                 -- 源文件绝对路径
  updated_at TEXT,
  status TEXT DEFAULT 'ok',         -- ok | drifted
  UNIQUE(source_tool, kind, scope)
);
CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);

CREATE TABLE IF NOT EXISTS memory_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  tool TEXT NOT NULL,               -- 写回目标工具 id
  path TEXT NOT NULL,               -- 写出绝对路径
  deployed_hash TEXT,               -- 写出时 item 内容 hash
  deployed_at TEXT,
  status TEXT DEFAULT 'ok',         -- ok | drifted | removed
  UNIQUE(item_id, tool)
);
CREATE INDEX IF NOT EXISTS idx_memory_deploy_item ON memory_deployments(item_id);
"""


def ensure_memory_line_schema(store):
    """记忆分发线建表（幂等，随 ensure() 一并执行）。"""
    with store.lock:
        store.db.executescript(MEMORY_LINE_SCHEMA)
        store.db.commit()
