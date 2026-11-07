//! `depotd migrate --legacy <hub.db>`：六 Phase 迁移器。
//! Phase 1 预检 → Phase 2 quiesce（如实口径）→ Phase 3 建新库 →
//! Phase 4 搬数据（列交集拷贝）→ Phase 5 verify（legacy vs 新库逐表计数对账）→
//! Phase 6 adopt（对账全平才允许自动 adopt）。
//!
//! 失败语义：任何 Phase 失败 → 删除半成品 depot.db（不留下假库），错误向上抛。
//! 如实声明：Phase 2 在只读连接上无法执行 checkpoint（SQLITE_READONLY）——
//! 若 hub.db-wal 非零说明 legacy 仍有进程在写，本快照非静止，输出 WARNING。

use anyhow::{bail, Context};
use std::path::{Path, PathBuf};

const COPY_TABLES: &[&str] = &[
    "sessions", "messages", "cursor", "lineages", "migrations", "memories", "ledger",
    "memory_items", "memory_deployments", "sources", "snapshots", "items",
    "remote_repos", "registry_items", "local_dirs", "targets", "dir_bindings",
    "deployments", "config",
];

pub fn run(legacy: &str, adopt: bool) -> anyhow::Result<()> {
    let legacy_path = Path::new(legacy);
    if !legacy_path.is_file() {
        bail!("legacy 库不存在：{legacy}");
    }
    let hub: PathBuf = legacy_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| ".".into()).into());
    let db_path = hub.join("depot.db");

    // ---------- Phase 1：预检 ----------
    println!("[1/6] 预检 legacy 库：{}", legacy_path.display());
    let size = std::fs::metadata(legacy_path)?.len();
    println!("      大小 {} MB", size / 1024 / 1024);
    {
        let conn = rusqlite::Connection::open_with_flags(
            legacy_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .context("读取 legacy 表清单失败")?;
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        println!("      表 {} 个：{}", tables.len(), tables.join(", "));
    }

    // ---------- Phase 2：quiesce（如实口径） ----------
    println!("[2/6] quiesce：只读挂载不执行 checkpoint（只读连接上不可写）");
    let wal = PathBuf::from(format!("{}-wal", legacy_path.display()));
    let wal_size = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    if wal_size > 0 {
        println!(
            "      WARNING：hub.db-wal 仍有 {} MB 未合并——legacy 可能仍有进程在写，",
            wal_size / 1024 / 1024
        );
        println!("      本次搬到的不是静止快照；建议停 legacy 进程后重跑。");
    } else {
        println!("      WAL 已空，快照静止。");
    }

    // ---------- Phase 3：建新库 ----------
    println!("[3/6] 建新库 depot.db（SCHEMA_V1）");
    if db_path.exists() {
        bail!("目标已存在：{}（先移除或改名再迁移）", db_path.display());
    }
    let store = depot_core::Store::open(&db_path, 1)?;
    drop(store);

    // Phase 4-6：失败即清半成品
    let result = migrate_inner(legacy_path, &db_path, adopt);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(PathBuf::from(format!("{}-wal", db_path.display())));
        let _ = std::fs::remove_file(PathBuf::from(format!("{}-shm", db_path.display())));
        eprintln!("      迁移失败，已清除半成品 {}", db_path.display());
        return Err(e);
    }
    println!("完成：{}", db_path.display());
    Ok(())
}

fn migrate_inner(legacy_path: &Path, db_path: &Path, adopt: bool) -> anyhow::Result<()> {
    let conn = rusqlite::Connection::open(db_path)?;
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS legacy;",
        legacy_path.display().to_string().replace('\'', "''")
    ))?;

    // ---------- Phase 4：搬数据 ----------
    println!("[4/6] 搬数据（列交集拷贝；OR IGNORE 的漏行由 Phase 5 逐表对账兜底）");
    let mut copied: Vec<(String, i64)> = Vec::new();
    for t in COPY_TABLES {
        let has_legacy = conn
            .query_row(
                "SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name=?1",
                [t],
                |_| Ok(true),
            )
            .with_context(|| format!("探测 legacy.{t} 失败（I/O 错误按错误上报，不当『表缺失』吞掉）"))?;
        if !has_legacy {
            println!("      跳过 {}（legacy 无此表）", t);
            continue;
        }
        let legacy_count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM legacy.{t}"), [], |r| r.get(0))
            .with_context(|| format!("计数 legacy.{t} 失败"))?;
        if legacy_count == 0 {
            println!("      {t}: 0 行");
            copied.push((t.to_string(), 0));
            continue;
        }
        // 列交集
        let lcols = table_columns(&conn, "legacy", t)?;
        let ncols = table_columns(&conn, "main", t)?;
        let common: Vec<String> = lcols.into_iter().filter(|c| ncols.contains(c)).collect();
        if common.is_empty() {
            println!("      跳过 {t}（无共同列）");
            copied.push((t.to_string(), -1));
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
        copied.push((t.to_string(), legacy_count));
    }

    // ops → event_log 历史投影
    let has_ops = conn
        .query_row(
            "SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name='ops'",
            [],
            |_| Ok(true),
        )
        .context("探测 legacy.ops 失败")?;
    let mut ops_legacy_count = 0i64;
    if has_ops {
        ops_legacy_count = conn.query_row("SELECT COUNT(*) FROM legacy.ops", [], |r| r.get(0))?;
        let n = conn.execute(
            "INSERT OR IGNORE INTO main.event_log(ts, module, actor, kind, item_kind, item_name, \
             item_version, source_id, target_id, outcome, error_code, reason, payload) \
             SELECT ts, module, 'local', action, item_kind, item_name, item_version, \
             source_id, target_id, status, NULL, reason, \
             COALESCE(detail, json_object('actor','local','extra',json_object())) \
             FROM legacy.ops",
            [],
        )?;
        println!("      ops → event_log: {n} 行（legacy {ops_legacy_count} 行）");
        copied.push(("ops→event_log".to_string(), ops_legacy_count));
    }

    // ---------- Phase 5：verify（逐表计数对账） ----------
    println!("[5/6] verify：legacy vs 新库逐表计数对账");
    let mut diffs: Vec<String> = Vec::new();
    for (t, legacy_count) in &copied {
        if *legacy_count < 0 {
            continue; // 无共同列跳过
        }
        let main_count: i64 = if t == "ops→event_log" {
            conn.query_row("SELECT COUNT(*) FROM main.event_log", [], |r| r.get(0))?
        } else {
            conn.query_row(&format!("SELECT COUNT(*) FROM main.{t}"), [], |r| r.get(0))?
        };
        if main_count != *legacy_count {
            diffs.push(format!(
                "      差异 {t}: legacy={legacy_count} 新库={main_count}（丢 {} 行）",
                legacy_count - main_count
            ));
        }
    }
    if diffs.is_empty() {
        println!("      全部对平 ✓");
    } else {
        for d in &diffs {
            eprintln!("{d}");
        }
    }
    let (sessions, messages): (i64, i64) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM messages)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    println!("      基线：sessions={sessions} messages={messages}");

    // ---------- Phase 6：adopt ----------
    println!("[6/6] adopt：{}", if adopt { "自动" } else { "跳过（--no-adopt）" });
    if adopt {
        if !diffs.is_empty() {
            bail!(
                "对账存在 {} 处行数差异（见上），拒绝自动 adopt；\
                 核对 legacy 数据/约束后重跑，或用 --no-adopt 勘测",
                diffs.len()
            );
        }
        conn.execute_batch("DETACH DATABASE legacy;")?;
        println!("      对账全平，adopt 完成；legacy 保留原位（回退：删除 depot.db 即回到 hub.db）");
    } else if !diffs.is_empty() {
        bail!("--no-adopt 勘测模式：存在对账差异，请核对后重跑");
    }
    Ok(())
}

fn table_columns(
    conn: &rusqlite::Connection,
    schema: &str,
    table: &str,
) -> anyhow::Result<Vec<String>> {
    // schema 名不能拼进 PRAGMA 的表名段（PRAGMA table_info 不接受点号），
    // 用 schema-qualified 形式：PRAGMA <schema>.table_info(<table>)
    let mut s = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
    let rows = s.query_map([], |r| r.get::<_, String>(1))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
