//! 事件日志（契约8 + 评审 M1/M3）：状态变更与事件追加同事务；
//! 台账投影 = event_log 的 {actor, extra} 包裹结构（Tier 1：/api/ops 契约）。

use rusqlite::Connection;

use crate::error::{CoreError as CE, Result};
use crate::fsutil;

/// 领域事件。`kind` 对位 legacy ops.action；`payload.extra` 为各操作的字段契约
/// （spec_ops_sse 契约 8 逐字段钉住）。
pub struct Event<'a> {
    pub module: &'a str,
    pub actor: &'a str,
    pub kind: &'a str,
    pub subject: Option<&'a str>,
    pub outcome: &'a str,
    pub error_code: Option<&'a str>,
    pub extra: serde_json::Value,
    pub item_kind: Option<&'a str>,
    pub item_name: Option<&'a str>,
    pub item_version: Option<&'a str>,
    pub source_id: Option<i64>,
    pub target_id: Option<i64>,
}

/// 在事务内追加事件（M1：只接受事务，状态与留痕同事务原子）。
pub fn append(tx: &Connection, ev: &Event) -> Result<i64> {
    let payload = json_wrap(&ev.extra);
    tx.execute(
        "INSERT INTO event_log(ts, module, actor, kind, item_kind, item_name, \
         item_version, source_id, target_id, outcome, error_code, payload) \
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            fsutil::now_iso(),
            ev.module,
            ev.actor,
            ev.kind,
            ev.item_kind,
            ev.item_name,
            ev.item_version,
            ev.source_id,
            ev.target_id,
            ev.outcome,
            ev.error_code,
            payload
        ],
    )
    .map_err(CE::from)?;
    Ok(tx.last_insert_rowid())
}

fn json_wrap(extra: &serde_json::Value) -> String {
    // legacy detail 包裹契约：{"actor": …, "extra": {…}}（spec_ops_sse 契约 8）
    serde_json::json!({ "actor": "local", "extra": extra }).to_string()
}

/// /api/ops 行投影（Tier 1 形状：id/ts/module/action/status/item_*/target_id/
/// reason/detail/…，detail = JSON 字符串 {"actor","extra"}）。
pub fn query(
    conn: &Connection,
    module: Option<&str>,
    status: Option<&str>,
    q: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<(usize, Vec<serde_json::Value>)> {
    let mut where_clauses: Vec<String> = vec![];
    if let Some(m) = module.filter(|m| !m.is_empty() && *m != "all") {
        where_clauses.push(format!("module = '{}'", m.replace("'", "")));
    }
    if let Some(st) = status.filter(|s| !s.is_empty() && *s != "all") {
        where_clauses.push(format!("outcome = '{}'", st.replace("'", "")));
    }
    if let Some(qs) = q.filter(|s| !s.is_empty()) {
        let esc = qs.replace("'", "").replace('%', "");
        where_clauses.push(format!(
            "(IFNULL(item_name,'') LIKE '%{}%' OR kind LIKE '%{}%' OR IFNULL(reason,'') LIKE '%{}%' OR IFNULL(payload,'') LIKE '%{}%')",
            esc, esc, esc, esc
        ));
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    };
    let total: usize = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM event_log {}", where_sql),
            [],
            |r| r.get(0),
        )
        .map_err(CE::from)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, ts, module, actor, kind, item_kind, item_name, item_version, source_id, target_id, outcome, error_code, reason, payload FROM event_log {} ORDER BY id DESC LIMIT ?1 OFFSET ?2",
            where_sql
        ))
        .map_err(CE::from)?;
    let rows = stmt
        .query_map(rusqlite::params![limit, offset], |r| {
            let payload: String = r.get::<_, Option<String>>(13)?.unwrap_or_default();
            let extra: serde_json::Value =
                serde_json::from_str(&payload).unwrap_or(serde_json::json!({}));
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "ts": r.get::<_, String>(1)?,
                "module": r.get::<_, String>(2)?,
                "actor": r.get::<_, String>(3)?,
                "action": r.get::<_, String>(4)?,
                "item_kind": r.get::<_, Option<String>>(5)?,
                "item_name": r.get::<_, Option<String>>(6)?,
                "item_version": r.get::<_, Option<String>>(7)?,
                "source_id": r.get::<_, Option<i64>>(8)?,
                "target_id": r.get::<_, Option<i64>>(9)?,
                "status": r.get::<_, String>(10)?,
                "error_code": r.get::<_, Option<String>>(11)?,
                "reason": r.get::<_, Option<String>>(12)?,
                "detail": payload,
                "extra": extra.get("extra").cloned().unwrap_or(serde_json::json!({})),
            }))
        })
        .map_err(CE::from)?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(CE::from)?);
    }
    Ok((total, items))
}

/// 事件水位（/healthz 与 SSE Last-Event-ID 回放游标）。
pub fn max_id(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COALESCE(MAX(id),0) FROM event_log", [], |r| r.get(0))
        .map_err(crate::error::CoreError::from)
}

/// 按 id > cursor 回放（评审 M3：SSE 慢订阅者断线补发）。
pub fn replay_after(conn: &Connection, cursor: i64, limit: usize) -> Result<Vec<(i64, String, String)>> {
    let mut stmt = conn
        .prepare("SELECT id, kind, payload FROM event_log WHERE id > ?1 ORDER BY id LIMIT ?2")
        .map_err(CE::from)?;
    let rows = stmt
        .query_map(rusqlite::params![cursor, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(CE::from)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(CE::from)?);
    }
    Ok(out)
}
