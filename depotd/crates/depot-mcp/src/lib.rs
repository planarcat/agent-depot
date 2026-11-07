//! MCP 领域：JSON/TOML 注入、registry CRUD、verify、回退（spec_mcp Tier 1 行为真源）。

use std::path::{Path, PathBuf};

use depot_core::error::{Code, CoreError, Result};
use depot_core::events::{self, Event};
use depot_core::fsutil;
use rusqlite::Connection;

pub const KIND: &str = "mcp";
const BLOCK_OPEN: &str = "# >>> hub:managed: ";
const BLOCK_CLOSE: &str = "# <<< hub:managed: ";

pub mod extra;

pub fn name_valid(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}

pub fn registry_root(hub: &Path) -> PathBuf {
    depot_core::paths::registry_root(hub, KIND)
}

/// 条目根：local_dirs（+集合子文件夹）或默认库。修 bug 对位（2026-11-07）。
pub fn item_root(conn: &Connection, name: &str) -> PathBuf {
    let q = conn.query_row(
        "SELECT d.path AS p, r.sub_path AS sub FROM registry_items r \
         JOIN local_dirs d ON d.id = r.dir_id WHERE r.kind='mcp' AND r.name=?1",
        rusqlite::params![name],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
    );
    match q {
        Ok((p, sub)) => {
            let s = sub.unwrap_or_default().replace('/', std::path::MAIN_SEPARATOR_STR);
            if s.is_empty() { PathBuf::from(&p) } else { Path::new(&p).join(s) }
        }
        Err(_) => registry_root(&depot_core::paths::hub_dir()),
    }
}

pub fn reg_path(name: &str, root: &Path) -> PathBuf {
    root.join(format!("{name}.json"))
}

/// 白名单归一：只保留 command/args/env/url/headers/type/transport/cwd；无 command/url → None。
pub fn normalize_config(cfg: &serde_json::Value, name: &str) -> Option<serde_json::Value> {
    const ALLOWED: [&str; 8] = ["command", "args", "env", "url", "headers", "type", "transport", "cwd"];
    let obj = cfg.as_object()?;
    let mut out = serde_json::Map::new();
    for k in ALLOWED {
        if let Some(v) = obj.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    }
    if !out.contains_key("command") && !out.contains_key("url") {
        return None;
    }
    out.insert("name".into(), serde_json::Value::String(name.into()));
    Some(serde_json::Value::Object(out))
}

// ============ 注入 plan/apply ============

/// 嵌套取 section（Python _section_get 口径）：途中层缺失/非 dict → 替换为 {}，
/// 末层保证是 dict（spec_mcp 钉现状：非 dict 层静默替换）。
pub(crate) fn section_get<'a>(
    data: &'a mut serde_json::Value, key_path: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    let mut cur: &mut serde_json::Value = data;
    for part in key_path.split('.') {
        if !cur.get(part).map(|v| v.is_object()).unwrap_or(false) {
            // Python 口径：途中层缺失/非 dict → 静默替换该层为 {}
            match cur.as_object_mut() {
                Some(o) => {
                    o.insert(part.to_string(), serde_json::json!({}));
                }
                None => {
                    *cur = serde_json::json!({ part: {} });
                }
            }
        }
        let next = cur.get_mut(part).unwrap();
        // 裸指针重绑定续循环（借用链限制的标准解法）
        cur = unsafe { &mut *(next as *mut serde_json::Value) };
    }
    if !cur.is_object() {
        *cur = serde_json::json!({});
    }
    cur.as_object_mut().unwrap()
}

pub fn plan_mcp_json(
    conn: &Connection, name: &str, target_path: &Path, format_key: &str, force: bool,
) -> Result<serde_json::Value> {
    let src = reg_path(name, &item_root(conn, name));
    let Some(cfg) = fsutil::read_json(&src) else {
        return Ok(json_fail3(name, "本地库中不存在该条目"));
    };
    let injected = strip_name(&cfg, name);
    let mut data = if target_path.is_file() {
        match fsutil::read_json(target_path) {
            Some(d) if d.is_object() => d,
            _ => return Ok(json_fail3(name, "目标文件不是合法 JSON")),
        }
    } else {
        serde_json::json!({})
    };
    let dep_status: Option<String> = dep_status(conn, name, target_path);
    let dep_injected: Option<serde_json::Value> = dep_detail(conn, name, target_path)
        .and_then(|d| d.get("injected").cloned());
    let section = section_get(&mut data, format_key);
    match section.get(name).cloned() {
        Some(cur) => {
            let removed = dep_status.as_deref() == Some("removed");
            let managed = dep_injected.as_ref().map(|e| e == &cur).unwrap_or(false);
            if removed || dep_injected.is_none() {
                // 无托管记录（removed 或从未注入）→ 视为首写
                Ok(json_ok_plan(name, &injected, data))
            } else if managed && cur == injected && !force {
                Ok(json_skip(name))
            } else if !managed && !force {
                Ok(json_conflict(name, "目标处同名条目非本托管注入（force 覆盖）"))
            } else if managed && cur != injected && !force {
                Ok(json_conflict(name, "托管注入被外部手改（force 覆盖）"))
            } else {
                Ok(json_ok_plan(name, &injected, data))
            }
        }
        None => Ok(json_ok_plan(name, &injected, data)),
    }
}

pub fn apply_mcp_json(
    conn: &Connection, name: &str, target_path: &Path, format_key: &str,
    new_cfg: serde_json::Value, actor: &str,
) -> Result<serde_json::Value> {
    let mut data = fsutil::read_json(target_path).unwrap_or(serde_json::json!({}));
    let backup = fsutil::backup_file(target_path, &target_path.parent().unwrap().join(".hub-backup"))
        .ok()
        .map(|p| p.display().to_string());
    let section = section_get(&mut data, format_key);
    section.insert(name.to_string(), new_cfg.clone());
    fsutil::atomic_write_text(target_path, &serde_json::to_string_pretty(&data).unwrap_or_default())?;
    let detail = serde_json::json!({"injected": new_cfg, "format_key": format_key,
        "backup": backup});
    upsert_deployment(conn, name, target_path, &detail)?;
    let _ = events::append(conn, &Event { module: "mcp",
        actor, kind: "distribute", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"target": target_path.display().to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[]))
}

pub fn plan_mcp_toml(
    conn: &Connection, name: &str, target_path: &Path, force: bool,
) -> Result<serde_json::Value> {
    let src = reg_path(name, &item_root(conn, name));
    let Some(cfg) = fsutil::read_json(&src) else {
        return Ok(json_fail3(name, "本地库中不存在该条目"));
    };
    let injected = strip_name(&cfg, name);
    let block = toml_block(name, &injected);
    let text = if target_path.exists() {
        std::fs::read_to_string(target_path).unwrap_or_default()
    } else {
        String::new()
    };
    let dep_status: Option<String> = dep_status(conn, name, target_path);
    let dep_block: Option<String> = dep_detail(conn, name, target_path)
        .and_then(|d| d.get("block_text").and_then(|v| v.as_str()).map(|s| s.to_string()));
    match find_toml_block(&text, name) {
        Some((s0, e0)) => {
            let cur = &text[s0..e0];
            let removed = dep_status.as_deref() == Some("removed");
            let managed = dep_block.as_ref().map(|b| b == cur).unwrap_or(false);
            if removed || dep_block.is_none() {
                Ok(json_ok_plan_toml(name, &injected, block.to_string(), text))
            } else if managed && cur == block && !force {
                Ok(json_skip(name))
            } else if !managed && !force {
                Ok(json_conflict(name, "TOML 托管块被外部手改（force 覆盖）"))
            } else {
                Ok(json_ok_plan_toml(name, &injected, block.to_string(), text))
            }
        }
        None => Ok(json_ok_plan_toml(name, &injected, block.to_string(), text)),
    }
}

pub fn apply_mcp_toml(
    conn: &Connection, name: &str, target_path: &Path, block: &str,
    full_text_after: String, actor: &str,
) -> Result<serde_json::Value> {
    let mut text = full_text_after;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&block);
    if !text.ends_with('\n') {
        text.push('\n');
    }
    fsutil::atomic_write_text(target_path, &text)?;
    let detail = serde_json::json!({"block_text": block});
    upsert_deployment(conn, name, target_path, &detail)?;
    let _ = events::append(conn, &Event { module: "mcp",
        actor, kind: "distribute", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"target": target_path.display().to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[]))
}

pub fn distribute_mcp(
    conn: &Connection, names: &[String], target_ids: &[i64],
    dry_run: bool, force: bool, actor: &str,
) -> Result<Vec<serde_json::Value>> {
    let all = list_targets(conn);
    let targets: Vec<_> = all.into_iter().filter(|t| target_ids.contains(&t.id)).collect();
    let mut results = Vec::new();
    for name in names {
        if !name_valid(name) {
            if targets.is_empty() {
                results.push(json_fail3(name, "非法条目名"));
            } else {
                for t in &targets {
                    results.push(json_fail3(name, "非法条目名"));
                }
            }
            continue;
        }
        for t in &targets {
            let r = if t.kind == "mcp_json" {
                let fk = if t.format_key.is_empty() { "mcpServers".to_string() } else { t.format_key.clone() };
                match plan_mcp_json(conn, name, Path::new(&t.path), &fk, force) {
                    Ok(p) => {
                        if p["status"].as_str() == Some("ok") && !dry_run {
                            let cfg = p["new_cfg"].clone();
                            let after = p["after"].clone();
                            apply_mcp_json(conn, name, Path::new(&t.path), &fk, cfg, actor)?;
                            let _ = after;
                        }
                        p
                    }
                    Err(e) => json_fail3(name, &e.message),
                }
            } else {
                match plan_mcp_toml(conn, name, Path::new(&t.path), force) {
                    Ok(p) => {
                        if p["status"].as_str() == Some("ok") && !dry_run {
                            let block = p["block"].as_str().unwrap_or("").to_string();
                            let after = p["after"].as_str().unwrap_or("").to_string();
                            apply_mcp_toml(conn, name, Path::new(&t.path), &block, after, actor)?;
                        }
                        p
                    }
                    Err(e) => json_fail3(name, &e.message),
                }
            };
            results.push(r);
        }
    }
    Ok(results)
}

pub struct TargetRow {
    pub id: i64, pub name: String, pub kind: String,
    pub tool: Option<String>, pub path: String, pub format_key: String,
}

pub fn list_targets(conn: &Connection) -> Vec<TargetRow> {
    let Ok(mut stmt) = conn.prepare("SELECT id, name, kind, COALESCE(tool,''), path,         COALESCE(format_key,'') FROM targets WHERE enabled=1 ORDER BY id") else { return vec![] };
    stmt.query_map([], |r| Ok(TargetRow {
        id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, tool: r.get(3)?,
        path: r.get(4)?, format_key: r.get(5)?,
    })).map(|rows| rows.filter_map(|r| r.ok()).collect()).unwrap_or_default()
}

// ============ registry CRUD ============

pub fn create_manual(
    conn: &Connection, name: &str, config: &serde_json::Value, dir_id: Option<i64>, actor: &str,
) -> Result<serde_json::Value> {
    let name = name.trim();
    if !name_valid(name) {
        return ok_err("名称非法（字母数字开头，允许 . _ -，≤64 字符）");
    }
    let Some(cfg) = normalize_config(config, name) else {
        return ok_err("config 非法：需要 command 或 url（键白名单：command/args/env/url/headers/type/transport/cwd）");
    };
    let root = match dir_id {
        None | Some(0) => registry_root(&depot_core::paths::hub_dir()),
        Some(id) => {
            let p: Option<String> = conn.query_row("SELECT path FROM local_dirs WHERE id=?1",
                rusqlite::params![id], |r| r.get(0)).ok();
            match p {
                Some(p) => {
                    let d = conn.query_row("SELECT layout FROM local_dirs WHERE id=?1",
                        rusqlite::params![id], |r| r.get::<_, Option<String>>(0)).ok().flatten();
                    let layout: serde_json::Value = d.and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(serde_json::Value::Null);
                    let subs = layout["mcp"].as_array().cloned().unwrap_or_default();
                    let base = PathBuf::from(&p);
                    match subs.first() {
                        Some(f) => base.join(f.as_str().unwrap_or("").replace('/', std::path::MAIN_SEPARATOR_STR)),
                        None => base,
                    }
                }
                None => return ok_err("本地目录不存在"),
            }
        }
    };
    let dest = reg_path(name, &root);
    if dest.exists() { return ok_err("已存在同名条目"); }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CoreError::io("建目录", e))?;
    }
    fsutil::atomic_write_text(&dest, &serde_json::to_string_pretty(&cfg).unwrap_or_default())?;
    let hash = fsutil::sha256_file(&dest)?;
    conn.execute("INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, dir_id) \
                  VALUES('mcp',?,NULL,'v2',?,?,?) ON CONFLICT(kind,name) DO UPDATE SET \
                  hash=excluded.hash, updated_at=excluded.updated_at, dir_id=excluded.dir_id",
                 rusqlite::params![name, hash, fsutil::now_iso(), dir_id]).map_err(CoreError::from)?;
    events::append(conn, &Event { module: "mcp",
        actor, kind: "create", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"hash": hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("name", name.into()), ("hash", hash[..12].to_string().into())]))
}

pub fn update_manual(conn: &Connection, name: &str, config: &serde_json::Value, actor: &str
) -> Result<serde_json::Value> {
    let manual: bool = conn.query_row(
        "SELECT 1 FROM registry_items WHERE kind='mcp' AND name=?1 AND source_id IS NULL",
        rusqlite::params![name], |_| Ok(true)).unwrap_or(false);
    if !manual { return ok_err("只支持编辑本地手动条目（该条目来自远程源，请用「更新到本地」）"); }
    let Some(cfg) = normalize_config(config, name) else {
        return ok_err("config 非法：需要 command 或 url");
    };
    let dest = reg_path(name, &item_root(conn, name));
    if dest.exists() {
        let vroot = depot_core::paths::versions_root(&depot_core::paths::hub_dir(), KIND, name);
        std::fs::create_dir_all(&vroot).map_err(|e| CoreError::io("建快照目录", e))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut snap = vroot.join(&stamp); let mut n = 1;
        while snap.exists() { snap = vroot.join(format!("{stamp}.{n}")); n += 1; }
        fs::rename(&dest, &snap).map_err(|e| CoreError::io("快照", e))?;
    }
    fsutil::atomic_write_text(&dest, &serde_json::to_string_pretty(&cfg).unwrap_or_default())?;
    let hash = fsutil::sha256_file(&dest)?;
    let prev = prev_hash(conn, name);
    conn.execute(
        "UPDATE registry_items SET hash=?1, updated_at=?2, prev_version=?3, prev_hash=?4 \
         WHERE kind='mcp' AND name=?5",
        rusqlite::params![
            hash,
            fsutil::now_iso(),
            Option::<String>::Some("v2".into()),
            prev,
            name
        ],
    )
    .map_err(CoreError::from)?;
    events::append(conn, &Event { module: "mcp",
        actor, kind: "edit", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"hash": hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("name", name.into()), ("hash", hash[..12].to_string().into())]))
}

pub fn delete_manual(conn: &Connection, name: &str, force: bool, actor: &str) -> Result<serde_json::Value> {
    let manual: bool = conn.query_row(
        "SELECT 1 FROM registry_items WHERE kind='mcp' AND name=?1 AND source_id IS NULL",
        rusqlite::params![name], |_| Ok(true)).unwrap_or(false);
    if !manual { return ok_err("远程条目不能在此删除（用「移除源」）"); }
    let deps: Vec<(i64, String)> = {
        let Ok(mut stmt) = conn.prepare("SELECT target_id, detail FROM deployments \
            WHERE item_kind='mcp' AND item_name=?1 AND status='ok'") else { return ok_err("查询失败") };
        stmt.query_map(rusqlite::params![name], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }).map(|rows| rows.filter_map(|r| r.ok()).collect()).unwrap_or_default()
    };
    if !deps.is_empty() && !force {
        return ok_err(&format!("已写入 {} 个目标配置；确认后连同写入内容一起移除", deps.len()));
    }
    // 逐目标摘除（injected 不匹配不碰）
    for (tid, detail) in &deps {
        let det: serde_json::Value = serde_json::from_str(detail).unwrap_or(serde_json::Value::Null);
        let (t_path, t_kind): (String, String) = conn.query_row(
            "SELECT path, kind FROM targets WHERE id=?1", rusqlite::params![tid],
            |r| Ok((r.get(0)?, r.get(1)?))).unwrap_or_default();
        if t_kind == "mcp_json" {
            let mut data = match fsutil::read_json(Path::new(&t_path)) {
                Some(d) if d.is_object() => d,
                _ => continue,
            };
            let fk = det.get("format_key").and_then(|v| v.as_str()).unwrap_or("mcpServers");
            let section = section_get(&mut data, fk);
            let injected = det.get("injected").cloned();
            if let Some(cur) = section.get(name).cloned() {
                if injected.is_none() || Some(&cur) == injected.as_ref() {
                    section.remove(name);
                    fsutil::atomic_write_text(Path::new(&t_path),
                        &serde_json::to_string_pretty(&data).unwrap_or_default())?;
                }
            }
        } else {
            let text = fs::read_to_string(&t_path).unwrap_or_default();
            if let Some((s, e)) = find_toml_block(&text, name) {
                let new_text = format!("{}{}", &text[..s], &text[e..]);
                fsutil::atomic_write_text(Path::new(&t_path), &new_text)?;
            }
        }
        conn.execute("UPDATE deployments SET status='removed' WHERE item_kind='mcp' \
                      AND item_name=?1 AND target_id=?2",
                     rusqlite::params![name, tid]).map_err(CoreError::from)?;
    }
    // registry 文件转存 -deleted
    let dest = reg_path(name, &item_root(conn, name));
    if dest.exists() {
        let vroot = depot_core::paths::versions_root(&depot_core::paths::hub_dir(), KIND, name);
        std::fs::create_dir_all(&vroot).map_err(|e| CoreError::io("建快照目录", e))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-deleted").to_string();
        let mut snap = vroot.join(&stamp); let mut n = 1;
        while snap.exists() { snap = vroot.join(format!("{stamp}.{n}")); n += 1; }
        fs::rename(&dest, &snap).map_err(|e| CoreError::io("转存", e))?;
    }
    conn.execute("DELETE FROM registry_items WHERE kind='mcp' AND name=?1",
                 rusqlite::params![name]).map_err(CoreError::from)?;
    events::append(conn, &Event { module: "mcp",
        actor, kind: "delete", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"removed_from_targets": deps.len()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[]))
}

pub fn rollback_registry(conn: &Connection, name: &str, actor: &str) -> Result<serde_json::Value> {
    let vroot = depot_core::paths::versions_root(&depot_core::paths::hub_dir(), KIND, name);
    if !vroot.is_dir() { return ok_err("没有可回退的版本快照"); }
    let mut snaps: Vec<String> = fs::read_dir(&vroot).map_err(|e| CoreError::io("读快照", e))?
        .filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.')).collect();
    snaps.sort();
    if snaps.is_empty() { return ok_err("版本快照为空"); }
    let latest = snaps.last().unwrap().clone();
    let dest = reg_path(name, &item_root(conn, name));
    if dest.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-pre-rollback").to_string();
        let mut target = vroot.join(&stamp); let mut n = 1;
        while target.exists() { target = vroot.join(format!("{stamp}.{n}")); n += 1; }
        fs::rename(&dest, &target).map_err(|e| CoreError::io("转存", e))?;
    }
    fs::rename(vroot.join(&latest), &dest).map_err(|e| CoreError::io("回退", e))?;
    let hash = fsutil::sha256_file(&dest)?;
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT version, hash, prev_version, prev_hash FROM registry_items \
             WHERE kind='mcp' AND name=?1",
            [name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    let (cur_version, cur_hash, prev_version, _prev_hash) = row
        .unwrap_or((None, None, None, None));
    let new_version = prev_version.clone().or_else(|| cur_version.clone());
    conn.execute(
        "UPDATE registry_items SET version=?1, hash=?2, updated_at=?3, prev_version=?4, \
         prev_hash=?5 WHERE kind='mcp' AND name=?6",
        rusqlite::params![
            new_version, hash, fsutil::now_iso(), cur_version, cur_hash, name
        ],
    )
    .map_err(CoreError::from)?;
    events::append(conn, &Event { module: "mcp",
        actor, kind: "rollback", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"restored_from": latest}),
        item_version: new_version.as_deref(), source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("hash", hash[..12].to_string().into()),
                 ("version", new_version.into()), ("restored_from", latest.into())]))
}

// ============ helpers ============

fn get_deployment(conn: &Connection, name: &str, target_path: &Path) -> Option<serde_json::Value> {
    let tid: i64 = conn.query_row("SELECT id FROM targets WHERE path=?1",
        rusqlite::params![target_path.display().to_string()], |r| r.get(0)).ok()?;
    conn.query_row("SELECT detail FROM deployments WHERE item_kind='mcp' AND item_name=?1 \
                    AND target_id=?2", rusqlite::params![name, tid],
        |r| r.get::<_, String>(0)).ok()
        .and_then(|d| serde_json::from_str(&d).ok())
}

fn upsert_deployment(conn: &Connection, name: &str, target_path: &Path, detail: &serde_json::Value
) -> Result<()> {
    let tid: i64 = conn.query_row("SELECT id FROM targets WHERE path=?1",
        rusqlite::params![target_path.display().to_string()], |r| r.get(0))
        .map_err(|_| CoreError::not_found("目标不存在"))?;
    let hash = fsutil::sha256_file(target_path).unwrap_or_default();
    conn.execute("INSERT INTO deployments(item_kind, item_name, target_id, deployed_hash, \
                  deployed_at, status, detail) VALUES('mcp',?,?,?,?,'ok',?) \
                  ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET \
                  deployed_hash=excluded.deployed_hash, deployed_at=excluded.deployed_at, \
                  status='ok', detail=excluded.detail",
                 rusqlite::params![name, tid, hash, fsutil::now_iso(), detail.to_string()])
        .map_err(CoreError::from)?;
    Ok(())
}

fn strip_name(cfg: &serde_json::Value, name: &str) -> serde_json::Value {
    let mut v = cfg.clone();
    if let Some(o) = v.as_object_mut() { o.remove("name"); }
    let _ = name;
    v
}

pub fn toml_block(name: &str, cfg: &serde_json::Value) -> String {
    let mut lines = vec![format!("{BLOCK_OPEN}{name} >>>"),
                         format!("[mcp_servers.{name}]")];
    if let Some(cmd) = cfg.get("command").and_then(|v| v.as_str()) {
        lines.push(format!("command = {}", serde_json::json!(cmd)));
    }
    if let Some(args) = cfg.get("args").and_then(|v| v.as_array()) {
        lines.push(format!("args = {}", serde_json::json!(args)));
    }
    if let Some(url) = cfg.get("url").and_then(|v| v.as_str()) {
        lines.push(format!("url = {}", serde_json::json!(url)));
    }
    if let Some(env) = cfg.get("env").and_then(|v| v.as_object()) {
        lines.push(String::new());
        lines.push(format!("[mcp_servers.{name}.env]"));
        for (k, v) in env {
            let s = match v { serde_json::Value::String(s) => s.clone(), other => other.to_string() };
            lines.push(format!("{k} = {}", serde_json::json!(s)));
        }
    }
    lines.push(format!("{BLOCK_CLOSE}{name} <<<"));
    lines.join("\n")
}

/// 返回托管块字节区间 (start, end)。
pub fn find_toml_block(text: &str, name: &str) -> Option<(usize, usize)> {
    let open = format!("{BLOCK_OPEN}{name} >>>");
    let close = format!("{BLOCK_CLOSE}{name} <<<");
    let s = text.find(&open)?;
    let e = text[s..].find(&close)? + s + close.len();
    Some((s, e))
}

fn dep_status(conn: &Connection, name: &str, target_path: &Path) -> Option<String> {
    let tid: i64 = conn.query_row("SELECT id FROM targets WHERE path=?1",
        rusqlite::params![target_path.display().to_string()], |r| r.get(0)).ok()?;
    conn.query_row("SELECT status FROM deployments WHERE item_kind='mcp' AND item_name=?1                     AND target_id=?2", rusqlite::params![name, tid], |r| r.get(0)).ok()
}

fn dep_detail(conn: &Connection, name: &str, target_path: &Path) -> Option<serde_json::Value> {
    let tid: i64 = conn.query_row("SELECT id FROM targets WHERE path=?1",
        rusqlite::params![target_path.display().to_string()], |r| r.get(0)).ok()?;
    let raw: String = conn.query_row("SELECT COALESCE(detail,'{}') FROM deployments         WHERE item_kind='mcp' AND item_name=?1 AND target_id=?2",
        rusqlite::params![name, tid], |r| r.get(0)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn prev_hash(conn: &Connection, name: &str) -> Option<String> {
    conn.query_row("SELECT hash FROM registry_items WHERE kind='mcp' AND name=?1",
        rusqlite::params![name], |r| r.get(0)).ok()
}

fn ok_err(msg: &str) -> Result<serde_json::Value> {
    Ok(serde_json::json!({"ok": false, "error": msg}))
}

fn json_ok(pairs: &[(&str, serde_json::Value)]) -> serde_json::Value {
    let mut o = serde_json::json!({"ok": true});
    for (k, v) in pairs { o[k] = v.clone(); }
    o
}

fn json_fail3(item: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "failed", "reason": reason})
}

#[allow(dead_code)]
fn json_fail2(item: &str, reason: &str, dry_run: bool) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "failed", "reason": reason, "dry_run": dry_run})
}

#[allow(dead_code)]
fn json_conflict(item: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "conflict", "reason": reason})
}

#[allow(dead_code)]
fn json_skip(item: &str) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "skipped", "reason": "内容一致（幂等）"})
}

#[allow(dead_code)]
fn json_ok_plan(item: &str, injected: &serde_json::Value, after: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "ok", "new_cfg": injected, "after": after})
}

#[allow(dead_code)]
fn json_ok_plan_toml(item: &str, _injected: &serde_json::Value, block: String, after: String) -> serde_json::Value {
    serde_json::json!({"item": item, "status": "ok", "block": block, "after": after})
}

use std::fs;

/// 手动条目写入（Python _write_manual 对位）：写 registry/mcp/<name>.json（或本地目录），
/// 登记版本链，记台账。返回 {ok, action, ...}。
pub fn write_manual(
    conn: &Connection, name: &str, cfg: &serde_json::Value, action: &str,
    dir_id: Option<i64>,
) -> Result<serde_json::Value> {
    use depot_core::error::CoreError;
    if !name_valid(name) {
        return ok_err("名称非法（字母数字开头，允许 . _ -，≤64 字符）");
    }
    let Some(cfg) = normalize_config(cfg, name) else {
        return ok_err("config 非法：需要 command 或 url");
    };
    let root = match dir_id {
        None | Some(0) => registry_root(&depot_core::paths::hub_dir()),
        Some(id) => {
            let p: Option<String> = conn
                .query_row("SELECT path FROM local_dirs WHERE id=?1", [id], |r| r.get(0))
                .ok();
            match p {
                Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
                _ => return ok_err("本地目录不存在"),
            }
        }
    };
    let _ = std::fs::create_dir_all(&root);
    let dest = root.join(format!("{name}.json"));
    if dest.exists() {
        let vroot = depot_core::paths::versions_root(&depot_core::paths::hub_dir(), KIND, name);
        let _ = std::fs::create_dir_all(&vroot);
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut snap = vroot.join(&stamp);
        let mut n = 1;
        while snap.exists() {
            snap = vroot.join(format!("{stamp}-{n}"));
            n += 1;
        }
        let _ = std::fs::rename(&dest, &snap);
    }
    let mut text = serde_json::to_string_pretty(&cfg).unwrap_or_default();
    text.push('\n');
    depot_core::fsutil::atomic_write_text(&dest, &text)?;
    let new_hash = depot_core::fsutil::sha256_file(&dest)?;
    let prev: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT version, hash FROM registry_items WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (pv, ph) = prev.unwrap_or((None, None));
    conn.execute(
        "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, \
         prev_version, prev_hash, source_hash_at, dir_id, sub_path) \
         VALUES(?,?,NULL,?,?,?,?,?,NULL,?,NULL) \
         ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, \
         updated_at=excluded.updated_at, prev_version=excluded.prev_version, \
         prev_hash=excluded.prev_hash, source_hash_at=NULL, dir_id=excluded.dir_id",
        rusqlite::params![
            KIND, name,
            Some("v1"),
            new_hash, depot_core::fsutil::now_iso(), pv, ph, dir_id
        ],
    )
    .map_err(CoreError::from)?;
    let _ = depot_core::events::append(conn, &depot_core::events::Event {
        module: "mcp",
        actor: "local", kind: "manual", subject: Some(name), outcome: "ok",
        error_code: None,
        extra: serde_json::json!({"action": action, "hash": new_hash[..12.min(new_hash.len())].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: Some(name), target_id: None,
    });
    Ok(serde_json::json!({"ok": true, "action": action,
        "hash": new_hash[..12.min(new_hash.len())].to_string()}))
}

/// 连接验证（Python mcpverify.verify 简化对位）：stdio 检查 command 可执行，
/// http 检查 url 可达（HEAD/GET 快速超时）；返回 {ok, transport, ...}。
pub fn verify_config(cfg: &serde_json::Value) -> serde_json::Value {
    let transport = cfg.get("type").and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| if cfg.get("url").is_some() { "http".into() } else { "stdio".into() });
    if transport == "stdio" {
        let cmd = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
        if cmd.is_empty() {
            return serde_json::json!({"ok": false, "error": "缺少 command", "transport": "stdio"});
        }
        // 无 shell 探测（cmd 可能来自远程源的 mcp.json，不可信——禁止内插进 sh -c）
        let executable = if cmd.contains('/') {
            std::path::Path::new(cmd).exists()
        } else {
            let path = std::env::var("PATH").unwrap_or_default();
            std::env::split_paths(&path).any(|dir| {
                let p = dir.join(cmd);
                p.is_file() && std::fs::metadata(&p).map(|m| !m.is_dir()).unwrap_or(false)
            })
        };
        if !executable {
            return serde_json::json!({"ok": false, "error": format!("命令不可执行：{cmd}"),
                "transport": "stdio"});
        }
        return serde_json::json!({"ok": true, "transport": "stdio", "server_name": cfg.get("name")});
    }
    let url = cfg.get("url").and_then(|u| u.as_str()).unwrap_or("");
    if url.is_empty() {
        return serde_json::json!({"ok": false, "error": "缺少 url", "transport": "http"});
    }
    // 快速可达性检查（curl HEAD，2s 超时）
    let ok = std::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-m", "2", "-I", url])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        serde_json::json!({"ok": true, "transport": "http", "server_name": cfg.get("name")})
    } else {
        serde_json::json!({"ok": false, "error": format!("连接失败：{url}"), "transport": "http"})
    }
}
