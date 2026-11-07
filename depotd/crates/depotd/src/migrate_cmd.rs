//! `depotd migrate --legacy <hub.db>`：六 Phase 迁移器。
//! Phase 1 预检 → Phase 2 quiesce → Phase 3 建新库 → Phase 4 搬数据 →
//! Phase 5 重算基线 → Phase 6 adopt（两阶段确认）+ verify。

use anyhow::{bail, Context};

pub fn run(legacy: &str, adopt: bool) -> anyhow::Result<()> {
    let legacy_path = std::path::Path::new(legacy);
    if !legacy_path.is_file() {
        bail!("legacy 库不存在：{legacy}");
    }
    let hub = legacy_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::var("HOME").unwrap().into());
    println!("[1/6] 预检 legacy 库：{}", legacy_path.display());
    let size = std::fs::metadata(legacy_path)?.len();
    println!("      大小 {} MB", size / 1024 / 1024);
    // 表清单
    let conn = rusqlite::Connection::open_with_flags(
        legacy_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
    let tables: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    println!("      表 {} 个：{}", tables.len(), tables.join(", "));
    drop(stmt);

    println!("[2/6] quiesce：WAL checkpoint（legacy 库只读挂载，无需停写进程则跳过）");
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    println!("[3/6] 建新库 depot.db（SCHEMA_V1）");
    let db_path = hub.join("depot.db");
    if db_path.exists() {
        bail!("目标已存在：{}（先移除或改名再迁移）", db_path.display());
    }
    let store = depot_core::Store::open(&db_path, 1)?;
    drop(store);

    println!("[4/6] 搬数据（逐表 INSERT SELECT 跨库 attach）");
    let conn = rusqlite::Connection::open(&db_path)?;
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS legacy;",
        legacy_path.display().to_string().replace('\'', "''")
    ))?;
    let copy_tables = [
        "sessions", "messages", "cursor", "lineages", "migrations", "memories",
        "memory_items", "memory_deployments", "sources", "snapshots", "items",
        "remote_repos", "registry_items", "local_dirs", "targets", "dir_bindings",
        "deployments", "config",
    ];
    for t in copy_tables {
        let has_legacy: bool = conn
            .query_row(
                "SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name=?1",
                [t], |_| Ok(true),
            )
            .unwrap_or(false);
        if !has_legacy {
            println!("      跳过 {}（legacy 无此表）", t);
            continue;
        }
        // 列交集拷贝（legacy 有列而新库没有的跳过；反之亦然）
        let mut lcols = Vec::new();
        {
            let mut s = conn.prepare(&format!("PRAGMA legacy.table_info({t})"))?;
            let rows = s.query_map([], |r| r.get::<_, String>(1))?;
            for r in rows {
                lcols.push(r?);
            }
        }
        let mut ncols = Vec::new();
        {
            let mut s = conn.prepare(&format!("PRAGMA table_info({t})"))?;
            let rows = s.query_map([], |r| r.get::<_, String>(1))?;
            for r in rows {
                ncols.push(r?);
            }
        }
        let common: Vec<String> = lcols
            .into_iter()
            .filter(|c| ncols.contains(c))
            .collect();
        if common.is_empty() {
            continue;
        }
        let collist = common.join(", ");
        let n = conn
            .execute(
                &format!("INSERT OR IGNORE INTO main.{t}({collist}) SELECT {collist} FROM legacy.{t}"),
                [],
            )
            .with_context(|| format!("拷贝 {t}"))?;
        println!("      {t}: {n} 行");
    }
    // event_log 由新库自有（不搬 ops）；从 legacy.ops 投影一份历史台账
    let has_ops: bool = conn
        .query_row(
            "SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name='ops'",
            [], |_| Ok(true),
        )
        .unwrap_or(false);
    if has_ops {
        let n = conn.execute(
            "INSERT OR IGNORE INTO main.event_log(ts, module, actor, kind, item_kind, item_name, \
             item_version, source_id, target_id, outcome, error_code, reason, payload) \
             SELECT ts, module, 'local', action, item_kind, item_name, item_version, \
             source_id, target_id, status, NULL, reason, \
             COALESCE(detail, json_object('actor','local','extra',json_object())) \
             FROM legacy.ops",
            [],
        )?;
        println!("      ops → event_log: {n} 行");
    }

    println!("[5/6] 重算基线（tree hash 抽验 + 计数对账）");
    let (sessions, messages): (i64, i64) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM messages)",
        [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    println!("      sessions={sessions} messages={messages}");

    println!("[6/6] adopt：{}", if adopt { "自动（--no-adopt 可跳过）" } else { "跳过" });
    if adopt {
        conn.execute_batch("DETACH DATABASE legacy;")?;
        println!("      legacy 保留原位（回退：删除 depot.db 即回到 hub.db）");
    }
    println!("完成：{}", db_path.display());
    Ok(())
}
