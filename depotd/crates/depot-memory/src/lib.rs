//! 记忆线（mod_memory + hub/store.py 笔记函数端口）：
//! 笔记 CRUD/搜索/导出 + 记忆中间体扫描/编辑/采纳/分发/总览。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use depot_core::error::{CoreError, Result};
use depot_core::fsutil;

pub const MODULE: &str = "memory";
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const SCAN_BUDGET_S: f64 = 3.0;

pub fn ok_err(msg: &str) -> Result<Value> {
    Ok(json!({"ok": false, "error": msg}))
}

/// 各工具记忆布局（探测制候选位）。
pub fn layouts() -> Value {
    json!({
        "trae-cn": {"global": "~/.trae-cn/memory/user_profile.md",
            "projects_dir": "~/.trae-cn/memory/projects",
            "project_file": "project_memory.md", "topics_file": "topics.md"},
        "claude": {"global": "~/.claude/CLAUDE.md"},
        "codex": {"global": "~/.codex/AGENTS.md"},
        "opencode": {"global": "~/.config/opencode/AGENTS.md"},
        "workbuddy": {"global": "~/.workbuddy/MEMORY.md"},
        "zcode": {"projects_dir": "~/.zcode/cli/memories/projects",
            "project_file": "memory/MEMORY.md"}
    })
}

pub fn has_layout(tool_id: &str) -> bool {
    layouts().get(tool_id).is_some()
}

fn layout_get(tool_id: &str, key: &str) -> Option<String> {
    layouts()
        .get(tool_id)?
        .get(key)?
        .as_str()
        .map(|s| s.to_string())
}

pub fn kind_label(kind: &str) -> String {
    match kind {
        "user_profile" => "用户画像".to_string(),
        "project_memory" => "项目记忆".to_string(),
        "topics" => "topics".to_string(),
        other => other.to_string(),
    }
}

pub fn memstore_root() -> PathBuf {
    depot_core::paths::hub_dir().join("memory").join("store")
}

fn safe_scope(scope: &str) -> String {
    let s: String = scope
        .chars()
        .map(|ch| if ch.is_alphanumeric() || "._@-".contains(ch) { ch } else { '-' })
        .collect();
    let t = s.trim_matches(|c| c == '-' || c == '.');
    if t.is_empty() { "global".into() } else { t.chars().take(120).collect() }
}

pub fn memstore_path(item: &Value) -> PathBuf {
    let scope = safe_scope(item["scope"].as_str().unwrap_or("global"));
    let tool = item["source_tool"].as_str().unwrap_or("unknown");
    let kind = item["kind"].as_str().unwrap_or("user_profile");
    memstore_root()
        .join(scope)
        .join(format!("{tool}__{kind}.md"))
}

fn expand(p: &str) -> PathBuf {
    depot_core::tools::shellexpand(p)
}

// ============ 笔记（memories 表 + markdown 双写） ============

pub fn memory_dir() -> PathBuf {
    depot_core::paths::hub_dir().join("memory")
}

pub fn add_note(conn: &Connection, body: &str, title: Option<&str>) -> Result<Value> {
    let body = body.trim();
    if body.is_empty() {
        return ok_err("内容不能为空");
    }
    conn.execute(
        "INSERT INTO memories(ts, kind, title, body, source) VALUES(?,?,?,?,?)",
        rusqlite::params![fsutil::now_iso(), "note", title, body, "ui"],
    )
    .map_err(CoreError::from)?;
    let mid = conn.last_insert_rowid();
    // markdown twin：append-only 日志（人类可读）
    let _ = std::fs::create_dir_all(memory_dir());
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let jpath = memory_dir().join(format!("{day}.md"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&jpath) {
        use std::io::Write;
        let hm = &fsutil::now_iso()[11..16];
        let _ = writeln!(
            f,
            "\n## [{hm}] {}\n\n- id: {mid} · kind: note · refs: -\n\n{body}\n",
            title.unwrap_or("(无标题)")
        );
    }
    Ok(json!({"ok": true, "id": mid}))
}

pub fn list_notes(conn: &Connection, limit: i64) -> Vec<Value> {
    match conn.prepare("SELECT id, ts, kind, COALESCE(title,''), body FROM memories ORDER BY id DESC LIMIT ?1") {
        Ok(mut stmt) => stmt
            .query_map([limit], |r| {
                Ok(json!({"id": r.get::<_, i64>(0)?, "ts": r.get::<_, Option<String>>(1)?,
                    "kind": r.get::<_, String>(2)?, "title": r.get::<_, String>(3)?,
                    "body": r.get::<_, String>(4)?}))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

pub fn delete_note(conn: &Connection, id: i64) -> Result<Value> {
    let n = conn
        .execute("DELETE FROM memories WHERE id=?1", [id])
        .map_err(CoreError::from)?;
    if n == 0 {
        return ok_err("条目不存在");
    }
    Ok(json!({"ok": true}))
}

pub fn search_notes(conn: &Connection, q: &str, limit: i64) -> Vec<Value> {
    if q.trim().is_empty() {
        return vec![];
    }
    let pat = format!("%{}%", q.trim().replace('%', "\\%"));
    match conn.prepare(
        "SELECT id, ts, kind, COALESCE(title,''), body FROM memories \
         WHERE body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT ?2",
    ) {
        Ok(mut stmt) => stmt
            .query_map(rusqlite::params![pat, limit], |r| {
                let body: String = r.get(4)?;
                // 字符边界安全切片（字节索引会切进多字节字符 → panic）；
                // 优先原串精确命中，否则退到小写副本索引（snippet 可能小写化，可接受退化）
                let low = q.to_lowercase();
                let idx = body.find(q).unwrap_or_else(|| body.to_lowercase().find(&low).unwrap_or(0));
                let floor = |mut i: usize| -> usize {
                    while i > 0 && !body.is_char_boundary(i) { i -= 1; }
                    i
                };
                let ceil = |mut i: usize| -> usize {
                    while i < body.len() && !body.is_char_boundary(i) { i += 1; }
                    i
                };
                let start = floor(idx.saturating_sub(30));
                let end = ceil((idx + 120).min(body.len()));
                let snippet: String = body[start..end].replace('\n', " ");
                Ok(json!({"id": r.get::<_, i64>(0)?, "ts": r.get::<_, Option<String>>(1)?,
                    "kind": r.get::<_, String>(2)?, "title": r.get::<_, String>(3)?,
                    "body": body,
                    "snippet": format!("{}{}{}",
                        if start > 0 { "…" } else { "" }, snippet,
                        if body.len() > end { "…" } else { "" })}))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

pub fn export_notes(conn: &Connection, fmt: &str) -> Value {
    let mems = list_notes(conn, 10000);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    if fmt == "json" {
        return json!({"filename": format!("memories-{stamp}.json"),
            "mime": "application/json",
            "content": serde_json::to_string_pretty(&mems).unwrap_or_default()});
    }
    let mut lines = vec![
        "# Agent Hub 记忆导出".to_string(),
        String::new(),
        format!("- 导出时间: {}", fsutil::now_iso()),
        format!("- 条数: {}", mems.len()),
        String::new(),
        "---".to_string(),
        String::new(),
    ];
    for m in &mems {
        lines.push(format!("## {}", m["title"].as_str().unwrap_or("(无标题)")));
        lines.push(String::new());
        lines.push(format!(
            "- 时间: {} · 类型: {}",
            m["ts"].as_str().unwrap_or("-"),
            m["kind"].as_str().unwrap_or("note")
        ));
        lines.push(String::new());
        lines.push(m["body"].as_str().unwrap_or("").to_string());
        lines.push(String::new());
    }
    lines.push(String::new());
    json!({"filename": format!("memories-{stamp}.md"),
        "mime": "text/markdown; charset=utf-8", "content": lines.join("\n")})
}

// ============ 记忆中间体（memory_items） ============

struct Slot {
    kind: &'static str,
    scope: String,
    path: PathBuf,
    name: String,
}

fn global_slots(tool_id: &str) -> Vec<Slot> {
    let Some(g) = layout_get(tool_id, "global") else { return vec![] };
    let p = expand(&g);
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    vec![Slot { kind: "user_profile", scope: "global".into(), path: p, name }]
}

fn project_slots(tool_id: &str, deadline: std::time::Instant) -> (Vec<Slot>, bool) {
    let Some(pdir) = layout_get(tool_id, "projects_dir") else { return (vec![], false) };
    let pdir = expand(&pdir);
    if !pdir.is_dir() {
        return (vec![], false);
    }
    let mut slots = Vec::new();
    let Ok(rd) = std::fs::read_dir(&pdir) else { return (vec![], false) };
    let mut slugs: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    slugs.sort();
    for slug in slugs {
        if deadline.elapsed().as_secs_f64() > SCAN_BUDGET_S {
            return (slots, true);
        }
        let slug_s = slug.to_string_lossy().to_string();
        if slug_s.starts_with('.') {
            continue;
        }
        for (key, kind) in [("project_file", "project_memory"), ("topics_file", "topics")] {
            let Some(rel) = layout_get(tool_id, key) else { continue };
            let p = pdir.join(&slug_s).join(&rel);
            if p.is_file() {
                slots.push(Slot {
                    kind,
                    scope: slug_s.clone(),
                    name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    path: p,
                });
            }
        }
    }
    (slots, false)
}

fn read_file(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    if data.len() > MAX_FILE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&data).to_string())
}

fn upsert_item(conn: &Connection, tool_id: &str, slot: &Slot, content: &str) -> &'static str {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let src_hash = hex::encode(h.finalize());
    let row: Option<(i64, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT id, hash, last_source_hash FROM memory_items \
             WHERE source_tool=?1 AND kind=?2 AND scope=?3",
            rusqlite::params![tool_id, slot.kind, slot.scope],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    match row {
        None => {
            if conn
                .execute(
                    "INSERT INTO memory_items(source_tool, kind, scope, name, version, hash, \
                     prev_hash, last_source_hash, source_path, updated_at, status) \
                     VALUES(?,?,?,?,1,?,NULL,?,?,?,'ok')",
                    rusqlite::params![
                        tool_id, slot.kind, slot.scope, slot.name, src_hash, src_hash,
                        slot.path.to_string_lossy(), fsutil::now_iso()
                    ],
                )
                .is_err()
            {
                return "failed";
            }
            let item = json!({"scope": slot.scope, "source_tool": tool_id, "kind": slot.kind});
            if fsutil::atomic_write_text(&memstore_path(&item), content).is_err() {
                return "failed";
            }
            "imported"
        }
        Some((_id, hash, last_src)) => {
            if last_src.as_deref() == Some(src_hash.as_str()) && hash.as_deref() == Some(src_hash.as_str()) {
                return "unchanged";
            }
            if last_src.as_deref() != Some(src_hash.as_str()) {
                // 工具端自己改了记忆文件 → 标记漂移，hub 内容不动（人工选边）
                let _ = conn.execute(
                    "UPDATE memory_items SET status='drifted', source_path=?1, updated_at=?2 \
                     WHERE source_tool=?3 AND kind=?4 AND scope=?5",
                    rusqlite::params![
                        slot.path.to_string_lossy(), fsutil::now_iso(), tool_id, slot.kind, slot.scope
                    ],
                );
                return "drifted";
            }
            "unchanged"
        }
    }
}

fn probe_caps(tool_id: &str) -> (bool, bool) {
    let deadline = std::time::Instant::now();
    let mut slots = global_slots(tool_id);
    let (mut p, _to) = project_slots(tool_id, deadline);
    slots.append(&mut p);
    let readable = slots.iter().any(|s| s.path.is_file());
    let mut writable = false;
    if let Some(g) = layout_get(tool_id, "global") {
        if let Some(parent) = expand(&g).parent() {
            writable = parent.is_dir();
        }
    }
    if !writable {
        if let Some(pd) = layout_get(tool_id, "projects_dir") {
            writable = expand(&pd).is_dir();
        }
    }
    (readable, writable)
}

fn save_caps(conn: &Connection, tool_id: &str, readable: bool, writable: bool, degraded: bool, error: Option<&str>) {
    let raw = depot_core::tools::get_config(conn, "memory_line.caps");
    let mut caps: BTreeMap<String, Value> = raw
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default();
    caps.insert(
        tool_id.to_string(),
        json!({"readable": readable, "writable": writable, "degraded": degraded,
               "error": error, "at": fsutil::now_iso()}),
    );
    depot_core::tools::set_config(conn, "memory_line.caps",
        &serde_json::to_string(&caps).unwrap_or_default());
}

pub fn load_caps(conn: &Connection) -> BTreeMap<String, Value> {
    depot_core::tools::get_config(conn, "memory_line.caps")
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default()
}

/// 扫描采集：逐工具探测槽位 → 导入/对账中间体 + 对账写回漂移。
pub fn scan_tools(conn: &Connection, tool_ids: Option<&[String]>) -> Vec<Value> {
    let tools: Vec<Value> = depot_core::tools::load_tools(conn)
        .into_iter()
        .filter(|t| {
            t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
                && tool_ids
                    .map(|ids| t["id"].as_str().map(|id| ids.contains(&id.to_string())).unwrap_or(false))
                    .unwrap_or(true)
        })
        .collect();
    let mut results = Vec::new();
    for t in tools {
        let tid = t["id"].as_str().unwrap_or("").to_string();
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_secs_f64(SCAN_BUDGET_S);
        let mut r = json!({"tool": tid, "name": t["name"], "readable": false, "writable": false,
            "imported": 0, "unchanged": 0, "drifted": 0, "target_drift": 0,
            "degraded": false, "error": Value::Null, "elapsed_ms": 0});
        let (mut slots, timed_out) = {
            let mut s = global_slots(&tid);
            let (mut p, to) = project_slots(&tid, deadline);
            let degraded = to;
            s.append(&mut p);
            (s, degraded)
        };
        if timed_out {
            r["degraded"] = json!(true);
        }
        for s in &slots {
            if !s.path.is_file() {
                continue;
            }
            let Some(content) = read_file(&s.path) else { continue };
            r["readable"] = json!(true);
            match upsert_item(conn, &tid, s, &content) {
                "imported" => r["imported"] = json!(r["imported"].as_i64().unwrap_or(0) + 1),
                "drifted" => r["drifted"] = json!(r["drifted"].as_i64().unwrap_or(0) + 1),
                _ => r["unchanged"] = json!(r["unchanged"].as_i64().unwrap_or(0) + 1),
            }
            if deadline.elapsed().as_secs_f64() > SCAN_BUDGET_S {
                r["degraded"] = json!(true);
                break;
            }
        }
        if r["degraded"] != json!(true) {
            let n = reconcile_deployments(conn, &tid);
            r["target_drift"] = json!(n);
        }
        let (readable, writable) = probe_caps(&tid);
        r["readable"] = json!(readable);
        r["writable"] = json!(writable);
        save_caps(conn, &tid, readable, writable, r["degraded"] == json!(true), None);
        r["elapsed_ms"] = json!(started.elapsed().as_millis() as i64);
        let _ = depot_core::events::append(conn, &depot_core::events::Event {
            module: "memory",
            actor: "local", kind: "scan", subject: None,
            outcome: if r["error"].is_null() { "ok" } else { "failed" },
            error_code: None,
            extra: json!({"tool": tid, "imported": r["imported"], "unchanged": r["unchanged"],
                          "drifted": r["drifted"], "target_drift": r["target_drift"],
                          "degraded": r["degraded"], "elapsed_ms": r["elapsed_ms"]}),
        item_version: None, source_id: None,
                    item_kind: None, item_name: None, target_id: None,
        });
        results.push(r);
    }
    results
}

fn reconcile_deployments(conn: &Connection, tool_id: &str) -> i64 {
    let deps: Vec<(i64, String, Option<String>, String)> = {
        match conn.prepare(
            "SELECT d.id, d.path, d.deployed_hash, d.status FROM memory_deployments d \
             JOIN memory_items i ON i.id=d.item_id WHERE d.tool=?1 AND d.status!='removed'",
        ) {
            Ok(mut stmt) => stmt
                .query_map([tool_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let mut n = 0;
    for (id, path, deployed_hash, status) in deps {
        let cur = {
            let p = PathBuf::from(&path);
            if p.is_file() {
                fsutil::sha256_file(&p).ok()
            } else {
                None
            }
        };
        let new_status = if cur.is_some() && cur == deployed_hash { "ok" } else { "drifted" };
        if new_status != status {
            let _ = conn.execute("UPDATE memory_deployments SET status=?1 WHERE id=?2",
                                 rusqlite::params![new_status, id]);
            if new_status == "drifted" {
                n += 1;
            }
        }
    }
    n
}

fn get_item(conn: &Connection, item_id: i64) -> Option<Value> {
    conn.query_row(
        "SELECT id, source_tool, kind, scope, name, version, hash, prev_hash, \
         last_source_hash, source_path, updated_at, status FROM memory_items WHERE id=?1",
        [item_id],
        |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "source_tool": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?, "scope": r.get::<_, String>(3)?,
                "name": r.get::<_, String>(4)?, "version": r.get::<_, i64>(5)?,
                "hash": r.get::<_, Option<String>>(6)?,
                "prev_hash": r.get::<_, Option<String>>(7)?,
                "last_source_hash": r.get::<_, Option<String>>(8)?,
                "source_path": r.get::<_, Option<String>>(9)?,
                "updated_at": r.get::<_, Option<String>>(10)?,
                "status": r.get::<_, String>(11)?}))
        },
    )
    .ok()
}

fn item_content(row: &Value) -> Option<String> {
    std::fs::read_to_string(memstore_path(row)).ok()
}

pub fn edit_item(conn: &Connection, item_id: i64, content: &str) -> Result<Value> {
    let Some(row) = get_item(conn, item_id) else { return ok_err("条目不存在") };
    if content.len() > MAX_FILE_BYTES {
        return ok_err("内容超过 2MB 上限");
    }
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let new_hash = hex::encode(h.finalize());
    let old_hash = row["hash"].clone();
    let version: i64 = row["version"].as_i64().unwrap_or(1);
    conn.execute(
        "UPDATE memory_items SET hash=?1, prev_hash=?2, version=version+1, updated_at=?3, \
         status=CASE WHEN status='drifted' THEN 'drifted' ELSE 'ok' END WHERE id=?4",
        rusqlite::params![new_hash, old_hash.as_str(), fsutil::now_iso(), item_id],
    )
    .map_err(CoreError::from)?;
    fsutil::atomic_write_text(&memstore_path(&row), content)?;
    let _ = depot_core::events::append(conn, &depot_core::events::Event {
        module: "memory",
        actor: "local", kind: "edit", subject: None, outcome: "ok", error_code: None,
        extra: json!({"item_id": item_id, "hash": new_hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some(row["kind"].as_str().unwrap_or("")), item_name: row["name"].as_str(),
        target_id: None,
    });
    Ok(json!({"ok": true, "hash": new_hash[..12].to_string(), "version": version + 1}))
}

pub fn adopt_source(conn: &Connection, item_id: i64) -> Result<Value> {
    let Some(row) = get_item(conn, item_id) else { return ok_err("条目不存在") };
    let src = row["source_path"].as_str().unwrap_or("");
    let p = PathBuf::from(src);
    if src.is_empty() || !p.is_file() {
        return ok_err(&format!("源文件不存在：{}", if src.is_empty() { "-" } else { src }));
    }
    let Some(content) = read_file(&p) else { return ok_err("源文件不可读或超限") };
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let src_hash = hex::encode(h.finalize());
    let old_hash = row["hash"].clone();
    conn.execute(
        "UPDATE memory_items SET hash=?1, prev_hash=?2, version=version+1, \
         last_source_hash=?3, updated_at=?4, status='ok' WHERE id=?5",
        rusqlite::params![src_hash, old_hash.as_str(), src_hash, fsutil::now_iso(), item_id],
    )
    .map_err(CoreError::from)?;
    fsutil::atomic_write_text(&memstore_path(&row), &content)?;
    let _ = depot_core::events::append(conn, &depot_core::events::Event {
        module: "memory",
        actor: "local", kind: "adopt", subject: None, outcome: "ok", error_code: None,
        extra: json!({"item_id": item_id, "hash": src_hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some(row["kind"].as_str().unwrap_or("")), item_name: row["name"].as_str(),
        target_id: None,
    });
    Ok(json!({"ok": true, "hash": src_hash[..12].to_string()}))
}

pub fn delete_item(conn: &Connection, item_id: i64) -> Result<Value> {
    let _ = conn.execute("DELETE FROM memory_deployments WHERE item_id=?1", [item_id]);
    let n = conn
        .execute("DELETE FROM memory_items WHERE id=?1", [item_id])
        .map_err(CoreError::from)?;
    if n == 0 {
        return ok_err("条目不存在");
    }
    Ok(json!({"ok": true}))
}

pub fn get_item_full(conn: &Connection, item_id: i64) -> Result<Value> {
    let Some(mut row) = get_item(conn, item_id) else { return ok_err("条目不存在") };
    let content = item_content(&row).unwrap_or_default();
    let src = row["source_path"].as_str().unwrap_or("").to_string();
    let src_hash = {
        let p = PathBuf::from(&src);
        if !src.is_empty() && p.is_file() {
            fsutil::sha256_file(&p).ok()
        } else {
            None
        }
    };
    row["content"] = json!(content);
    row["source_changed"] = json!(match (&src_hash, row["last_source_hash"].as_str()) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    });
    row["source_hash"] = json!(src_hash);
    Ok(row)
}

fn target_path(row: &Value, tool_id: &str) -> Option<PathBuf> {
    let kind = row["kind"].as_str()?;
    let scope = row["scope"].as_str()?;
    if scope == "global" {
        return layout_get(tool_id, "global").map(|g| expand(&g));
    }
    if tool_id != row["source_tool"].as_str()? {
        return None;
    }
    let rel = if kind == "project_memory" {
        layout_get(tool_id, "project_file")?
    } else if kind == "topics" {
        layout_get(tool_id, "topics_file")?
    } else {
        return None;
    };
    if scope.starts_with('/') || scope.ends_with('/') || scope.contains("/../") {
        return None;
    }
    let pd = layout_get(tool_id, "projects_dir")?;
    Some(expand(&pd).join(scope).join(rel))
}

fn record_deployment(conn: &Connection, item_id: i64, tool_id: &str, path: &Path, item_hash: &str) {
    let _ = conn.execute(
        "INSERT INTO memory_deployments(item_id, tool, path, deployed_hash, deployed_at, status) \
         VALUES(?,?,?,?,?,?) ON CONFLICT(item_id, tool) DO UPDATE SET \
         path=excluded.path, deployed_hash=excluded.deployed_hash, \
         deployed_at=excluded.deployed_at, status='ok'",
        rusqlite::params![
            item_id, tool_id, path.to_string_lossy(), item_hash, fsutil::now_iso(), "ok"
        ],
    );
}

/// 中间体 → 目标工具记忆文件。冲突不覆盖，force 才写。
pub fn distribute(conn: &Connection, item_ids: &[i64], tool_ids: &[String], force: bool) -> Vec<Value> {
    let mut results = Vec::new();
    for iid in item_ids {
        let Some(row) = get_item(conn, *iid) else {
            results.push(json!({"item_id": iid, "status": "failed", "reason": "条目不存在"}));
            continue;
        };
        let Some(content) = item_content(&row) else {
            results.push(json!({"item_id": iid, "item": row["name"],
                "status": "failed", "reason": "中间体内容缺失"}));
            continue;
        };
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(content.as_bytes());
        let item_hash = hex::encode(h.finalize());
        for tid in tool_ids {
            let base = json!({"item_id": iid, "item": row["name"], "kind": row["kind"],
                "scope": row["scope"], "tool": tid});
            let Some(tpath) = target_path(&row, tid) else {
                results.push(merge(&base, json!({"status": "failed",
                    "reason": "该工具没有对应的记忆写入位"})));
                continue;
            };
            let Some(parent) = tpath.parent().map(|p| p.to_path_buf()) else { continue };
            if !parent.is_dir() {
                results.push(merge(&base, json!({"status": "failed",
                    "reason": format!("目标目录不存在：{}", parent.display())})));
                continue;
            }
            let cur_hash = if tpath.is_file() { fsutil::sha256_file(&tpath).ok() } else { None };
            let dep: Option<(i64, Option<String>)> = conn
                .query_row(
                    "SELECT id, deployed_hash FROM memory_deployments WHERE item_id=?1 AND tool=?2",
                    rusqlite::params![iid, tid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            if cur_hash.as_deref() == Some(item_hash.as_str()) {
                record_deployment(conn, *iid, tid, &tpath, &item_hash);
                results.push(merge(&base, json!({"status": "skipped", "reason": "已是最新"})));
                continue;
            }
            let conflict = match &dep {
                Some((_, Some(dh))) if cur_hash.as_deref() != Some(dh.as_str()) => {
                    Some("目标文件在上次写回后被改动".to_string())
                }
                Some(_) => None,
                None if cur_hash.is_some() => Some("目标位置已存在未托管内容".to_string()),
                None => None,
            };
            if let Some(reason) = conflict.filter(|_| !force) {
                results.push(merge(&base, json!({"status": "conflict", "reason": reason})));
                let _ = depot_core::events::append(conn, &depot_core::events::Event { module: "memory",
                    actor: "local", kind: "distribute", subject: None, outcome: "conflict",
                    error_code: None, extra: merge(&base, json!({"reason": reason})),
        item_version: None, source_id: None,
                            item_kind: Some(row["kind"].as_str().unwrap_or("")),
                    item_name: row["name"].as_str(), target_id: None,
                });
                continue;
            }
            if cur_hash.is_some() {
                let backup_root = tpath
                    .parent()
                    .unwrap_or(Path::new("/"))
                    .join(".hub-backup");
                let _ = fsutil::backup_file(&tpath, &backup_root);
            }
            match fsutil::atomic_write_text(&tpath, &content) {
                Ok(_) => {
                    record_deployment(conn, *iid, tid, &tpath, &item_hash);
                    results.push(merge(&base, json!({"status": "ok",
                        "path": tpath.to_string_lossy()})));
                    let _ = depot_core::events::append(conn, &depot_core::events::Event { module: "memory",
                        actor: "local", kind: "distribute", subject: None, outcome: "ok",
                        error_code: None,
                        extra: merge(&base, json!({"path": tpath.to_string_lossy(), "force": force})),
        item_version: None, source_id: None,
                                item_kind: Some(row["kind"].as_str().unwrap_or("")),
                        item_name: row["name"].as_str(), target_id: None,
                    });
                }
                Err(e) => {
                    results.push(merge(&base, json!({"status": "failed",
                        "reason": e.to_string().chars().take(200).collect::<String>()})));
                }
            }
        }
    }
    results
}

fn merge(base: &Value, extra: Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    if let Some(e) = extra.as_object() {
        for (k, v) in e {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// 总览：工具能力（探测缓存）+ 中间条目 + 逐目标部署状态。
pub fn overview(conn: &Connection) -> Value {
    let caps = load_caps(conn);
    let mut tools = Vec::new();
    for t in depot_core::tools::load_tools(conn) {
        if t.get("enabled").and_then(|e| e.as_bool()) != Some(true) {
            continue;
        }
        let tid = t["id"].as_str().unwrap_or("").to_string();
        if !has_layout(&tid) {
            continue;
        }
        let c = caps.get(&tid).cloned().unwrap_or(json!({}));
        tools.push(json!({
            "id": tid, "name": t["name"],
            "color": t.get("color").and_then(|c| c.as_i64()).unwrap_or(0),
            "readable": c.get("readable").and_then(|b| b.as_bool()).unwrap_or(false),
            "writable": c.get("writable").and_then(|b| b.as_bool()).unwrap_or(false),
            "degraded": c.get("degraded").and_then(|b| b.as_bool()).unwrap_or(false),
            "error": c.get("error").cloned().unwrap_or(Value::Null),
            "has_layout": true,
            "scanned": c.get("at").is_some()}));
    }
    let items: Vec<Value> = {
        match conn.prepare("SELECT id, source_tool, kind, scope, name, version, hash, \
                            prev_hash, last_source_hash, source_path, updated_at, status \
                            FROM memory_items ORDER BY source_tool, kind, scope") {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok(json!({"id": r.get::<_, i64>(0)?, "source_tool": r.get::<_, String>(1)?,
                        "kind": r.get::<_, String>(2)?, "scope": r.get::<_, String>(3)?,
                        "name": r.get::<_, String>(4)?, "version": r.get::<_, i64>(5)?,
                        "hash": r.get::<_, Option<String>>(6)?,
                        "prev_hash": r.get::<_, Option<String>>(7)?,
                        "last_source_hash": r.get::<_, Option<String>>(8)?,
                        "source_path": r.get::<_, Option<String>>(9)?,
                        "updated_at": r.get::<_, Option<String>>(10)?,
                        "status": r.get::<_, String>(11)?}))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let deps: Vec<(i64, Value)> = {
        match conn.prepare(
            "SELECT item_id, tool, path, status, deployed_at FROM memory_deployments \
             WHERE status!='removed'",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, json!({
                        "tool": r.get::<_, String>(1)?, "path": r.get::<_, String>(2)?,
                        "status": r.get::<_, String>(3)?,
                        "deployed_at": r.get::<_, Option<String>>(4)?})))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let mut dep_map: std::collections::HashMap<i64, Vec<Value>> = std::collections::HashMap::new();
    for (iid, d) in deps {
        dep_map.entry(iid).or_default().push(d);
    }
    let mut out = Vec::new();
    for mut it in items {
        let iid = it["id"].as_i64().unwrap_or(0);
        it["kind_label"] = json!(kind_label(it["kind"].as_str().unwrap_or("")));
        it["deployments"] = json!(dep_map.get(&iid).cloned().unwrap_or_default());
        out.push(it);
    }
    json!({"tools": tools, "items": out, "memstore": memstore_root().to_string_lossy()})
}
