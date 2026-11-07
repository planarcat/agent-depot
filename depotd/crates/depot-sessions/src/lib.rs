//! 会话解析（scanners.py 对位）：多工具 JSONL/SQLite 采集、内容搜索、导出。
//! 契约来源：spec_sessions（Tier 1）。

use std::path::{Path, PathBuf};

use depot_core::error::{CoreError, Result};
use rusqlite::Connection;

pub struct ScanStats {
    pub tool: String,
    pub files: usize,
    pub new_messages: usize,
    pub new_sessions: usize,
}

/// 扫描单个工具（tool_id 决定解析格式）。扫描即入库（messages/sessions），
/// cursor 断点存 scan_cursor 表（offset_bytes + msg_seq）。
pub fn scan_tool(
    conn: &Connection, tool: &str, root: &Path,
) -> Result<ScanStats> {
    let mut stats = ScanStats { tool: tool.into(), files: 0, new_messages: 0, new_sessions: 0 };
    let paths = source_files(tool, root);
    for path in paths {
        stats.files += 1;
        scan_jsonl(conn, tool, &path, &mut stats)?;
    }
    Ok(stats)
}

/// 各工具的源文件清单（对位 scanners.py sources()）。
fn source_files(tool: &str, root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let pattern = |dir: &Path| -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
        entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| {
            p.extension().map(|x| x == "jsonl").unwrap_or(false)
        }).collect()
    };
    match tool {
        // <root>/*/*.jsonl（项目子目录一层）
        "claude" | "workbuddy" => {
            let Ok(dirs) = std::fs::read_dir(root) else { return out };
            for d in dirs.filter_map(|e| e.ok()) {
                if d.path().is_dir() {
                    out.extend(pattern(&d.path()));
                }
            }
        }
        // <root>/sessions/**/*.jsonl（日期嵌套）
        "codex" => {
            fn rec(dir: &Path, out: &mut Vec<PathBuf>) {
                let Ok(entries) = std::fs::read_dir(dir) else { return };
                for e in entries.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.is_dir() { rec(&p, out); }
                    else if p.extension().map(|x| x == "jsonl").unwrap_or(false) { out.push(p); }
                }
            }
            rec(&root.join("sessions"), &mut out);
        }
        // <root>/**/*.jsonl
        "pi" => {
            fn rec2(dir: &Path, out: &mut Vec<PathBuf>) {
                let Ok(entries) = std::fs::read_dir(dir) else { return };
                for e in entries.filter_map(|e| e.ok()) {
                    let p = e.path();
                    if p.is_dir() { rec2(&p, out); }
                    else if p.extension().map(|x| x == "jsonl").unwrap_or(false) { out.push(p); }
                }
            }
            rec2(root, &mut out);
        }
        _ => {}
    }
    out.sort();
    out
}

/// JSONL 增量解析（claude/codex/pi 格式）。cursor 断点 + 坏行跳过 + 幂等。
fn scan_jsonl(
    conn: &Connection, tool: &str, path: &Path, stats: &mut ScanStats,
) -> Result<()> {
    let key = format!("{tool}:{}", path.display());
    let data = std::fs::read(path).unwrap_or_default();
    let size = data.len() as i64;
    let cursor: i64 = conn
        .query_row("SELECT COALESCE(offset_bytes,0) FROM cursor \
                    WHERE source_key=?1", rusqlite::params![key], |r| r.get(0))
        .unwrap_or(0);
    if size < cursor {
        // 文件被重写：重置断点
        conn.execute("DELETE FROM cursor WHERE source_key=?1", rusqlite::params![key])
            .map_err(CoreError::from)?;
    }
    let start = if size < cursor { 0 } else { cursor };
    let text = String::from_utf8_lossy(&data[start as usize..]).to_string();
    let mut offset = start;
    let mut msg_seq: i64 = conn
        .query_row("SELECT COALESCE(msg_seq,0) FROM cursor \
                    WHERE source_key=?1", rusqlite::params![key], |r| r.get(0))
        .unwrap_or(0);
    let sid_from_file = path.file_stem().and_then(|s| s.to_str())
        .map(|s| s.to_string()).unwrap_or_default();
    for line in text.split('\n') {
        offset += line.len() as i64 + 1;
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;                       // 坏行/空行跳过（契约 9）
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(sid) = extract_sid(tool, &v, &sid_from_file) else { continue };
        let Some((role, content)) = extract_message(tool, &v) else { continue };
        // 确保 sessions 行
        let exists: bool = conn.query_row("SELECT 1 FROM sessions WHERE sid=?1",
            rusqlite::params![sid], |_| Ok(true)).unwrap_or(false);
        if !exists {
            let title = first_user_text(&content).unwrap_or_else(|| "(无标题)".into());
            let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
            conn.execute("INSERT INTO sessions(sid, tool, title, cwd, source_file, started_at, \
                          updated_at, msg_count, title_source) VALUES(?,?,?,?,?,?,?,0,'fallback')",
                         rusqlite::params![sid, tool, title,
                             v.get("cwd").and_then(|c| c.as_str()).unwrap_or(""),
                             path.display().to_string(), ts, ts])
                .map_err(CoreError::from)?;
            stats.new_sessions += 1;
        }
        let hash = depot_core::fsutil::sha256_bytes(
            format!("{role}\0{content}").as_bytes())[..24].to_string();
        let dup: bool = conn.query_row(
            "SELECT 1 FROM messages WHERE sid=?1 AND hash=?2",
            rusqlite::params![sid, hash], |_| Ok(true)).unwrap_or(false);
        if dup { continue; }
        msg_seq += 1;
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        conn.execute("INSERT INTO messages(sid, tool, seq, ts, role, content, content_type, hash) \
                      VALUES(?,?,?,?,?,?,'text',?)",
                     rusqlite::params![sid, tool, msg_seq, ts, role, content, hash])
            .map_err(CoreError::from)?;
        stats.new_messages += 1;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE sid=?1",
            rusqlite::params![sid], |r| r.get(0)).unwrap_or(0);
        let last_ts: String = conn.query_row(
            "SELECT COALESCE(MAX(ts),'') FROM messages WHERE sid=?1",
            rusqlite::params![sid], |r| r.get(0)).unwrap_or_default();
        let starred: i64 = conn.query_row("SELECT starred FROM sessions WHERE sid=?1",
            rusqlite::params![sid], |r| r.get(0)).unwrap_or(0);
        conn.execute("UPDATE sessions SET msg_count=?2, updated_at=?3, starred=?4 WHERE sid=?1",
                     rusqlite::params![sid, count, last_ts, starred])
            .map_err(CoreError::from)?;
    }
    let payload = serde_json::json!({"offset_bytes": offset, "msg_seq": msg_seq}).to_string();
    conn.execute(
        "INSERT INTO cursor(source_key, offset_bytes, msg_seq) VALUES(?1,?2,?3) \
         ON CONFLICT(source_key) DO UPDATE SET offset_bytes=excluded.offset_bytes, \
         msg_seq=excluded.msg_seq",
        rusqlite::params![key, offset, msg_seq],
    )
    .map_err(CoreError::from)?;
    Ok(())
}

fn extract_sid(tool: &str, v: &serde_json::Value, file_fallback: &str) -> Option<String> {
    match tool {
        "claude" => v.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string()),
        "codex" => {
            if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                v.get("payload").and_then(|p| p.get("session_id"))
                    .and_then(|s| s.as_str()).map(|s| s.to_string())
            } else {
                v.get("payload").and_then(|p| p.get("session_id"))
                    .and_then(|s| s.as_str()).map(|s| s.to_string())
                    .or_else(|| Some(file_fallback.to_string()))
            }
        }
        "pi" => v.get("id").and_then(|s| s.as_str()).map(|s| s.to_string())
            .or_else(|| Some(file_fallback.to_string())),
        _ => Some(file_fallback.to_string()),
    }
}

fn extract_message(tool: &str, v: &serde_json::Value) -> Option<(String, String)> {
    match tool {
        "claude" => {
            let t = v.get("type").and_then(|t| t.as_str())?;
            if t != "user" && t != "assistant" { return None; }
            let msg = v.get("message")?;
            let role = msg.get("role").and_then(|r| r.as_str())?.to_string();
            let content = match msg.get("content") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(arr)) => arr.iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>().join(""),
                _ => return None,
            };
            Some((role, content))
        }
        "codex" => {
            if v.get("type").and_then(|t| t.as_str()) != Some("response_item") { return None; }
            let p = v.get("payload")?;
            if p.get("type").and_then(|t| t.as_str()) != Some("message") { return None; }
            let role = p.get("role").and_then(|r| r.as_str())?.to_string();
            let content = p.get("content").and_then(|c| c.as_array()).map(|arr| {
                arr.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>().join("")
            }).unwrap_or_default();
            // 过滤 env noise
            if content.contains("<environment_context>") { return None; }
            Some((role, content))
        }
        "pi" => {
            if v.get("type").and_then(|t| t.as_str()) != Some("message") { return None; }
            let msg = v.get("message")?;
            let role = msg.get("role").and_then(|r| r.as_str())?.to_string();
            let content = msg.get("content").and_then(|c| c.as_array()).map(|arr| {
                arr.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>().join("")
            }).unwrap_or_default();
            Some((role, content))
        }
        _ => None,
    }
}

fn first_user_text(content: &str) -> Option<String> {
    Some(content.chars().take(80).collect())
}

/// 内容搜索（LIKE 口径，Tier 1）。
pub fn search(conn: &Connection, q: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
    if q.is_empty() {
        return Err(CoreError::bad_request("搜索内容不能为空"));
    }
    let pattern = format!("%{}%", q.replace('%', "\\%"));
    let Ok(mut stmt) = conn.prepare(
        "SELECT m.sid, m.seq, m.role, m.content, s.title, s.tool, s.source_file \
         FROM messages m JOIN sessions s ON s.sid=m.sid \
         WHERE m.content LIKE ?1 ESCAPE '\\' ORDER BY s.updated_at DESC, m.seq LIMIT ?2")
    else { return Ok(vec![]) };
    let rows = stmt.query_map(rusqlite::params![pattern, limit as i64], |r| {
        Ok(serde_json::json!({
            "sid": r.get::<_, String>(0)?, "seq": r.get::<_, i64>(1)?,
            "role": r.get::<_, String>(2)?, "content": r.get::<_, String>(3)?,
            "title": r.get::<_, String>(4)?, "tool": r.get::<_, String>(5)?,
            "source_file": r.get::<_, String>(6)?}))
    }).map_err(CoreError::from)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 会话导出 Markdown。
pub fn export_markdown(conn: &Connection, sid: &str) -> Result<(String, String)> {
    let (title, tool): (String, String) = conn.query_row(
        "SELECT title, tool FROM sessions WHERE sid=?1", rusqlite::params![sid],
        |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| CoreError::not_found("会话不存在"))?;
    let Ok(mut stmt) = conn.prepare(
        "SELECT role, content, ts FROM messages WHERE sid=?1 ORDER BY seq") else {
        return Err(CoreError::not_found("会话不存在")) };
    let rows: Vec<(String, String, Option<String>)> = stmt
        .query_map(rusqlite::params![sid], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        }).map_err(CoreError::from)?
        .filter_map(|r| r.ok()).collect();
    let mut md = format!("# {title}\n\n- 工具: {tool}\n- 会话: {sid}\n\n");
    for (role, content, ts) in &rows {
        let ts_show = ts.as_deref().unwrap_or("");
        md.push_str(&format!("## {} ({ts_show})\n\n{content}\n\n", role.to_uppercase()));
    }
    Ok((title, md))
}
