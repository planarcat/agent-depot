//! mod_mcp 余量端口：sources（git）、views、verify、tool_items/extract/
//! sync_to_targets、update_registry、targets（delete/seed）、items_view、dep_stale。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use depot_core::error::{Code, CoreError, Result};
use depot_core::events::{self, Event};
use depot_core::fsutil;
use depot_core::gitsrc;

use crate::{
    item_root, name_valid, normalize_config, registry_root, toml_block, find_toml_block,
    KIND,
};

fn is_manual_like(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2 AND source_id IS NULL",
        rusqlite::params![KIND, name],
        |_| Ok(true),
    )
    .unwrap_or(false)
}

pub const MODULE: &str = "mcp";

pub fn ok_err(msg: &str) -> Result<Value> {
    Ok(json!({"ok": false, "error": msg}))
}

fn log(conn: &Connection, kind: &str, outcome: &str, extra: Value,
       item_name: Option<&str>, target_id: Option<i64>) {
    let _ = events::append(conn, &Event {
        module: "mcp",
        actor: "local", kind, subject: None, outcome, error_code: None, extra,
        item_kind: Some("mcp"), item_name, target_id,
        item_version: None, source_id: None,
    });
}

pub fn registry_enabled(conn: &Connection) -> bool {
    match conn.query_row(
        "SELECT value FROM config WHERE key='modules.enabled.mcp'", [], |r| r.get::<_, String>(0),
    ) {
        Err(_) => true,
        Ok(v) => !matches!(v.as_str(), "0" | "false" | "off" | "no"),
    }
}

// ---------- sources ----------

pub fn add_source(conn: &Connection, name: Option<&str>, url: Option<&str>,
                  branch: Option<&str>, subdir: Option<&str>, auth_ref: Option<&str>) -> Result<Value> {
    let name = name.unwrap_or("").trim();
    let url = url.unwrap_or("").trim();
    if name.is_empty() || url.is_empty() {
        return ok_err("name 与 url 必填");
    }
    match conn.execute(
        "INSERT INTO sources(kind, name, url, branch, subdir, auth_ref, created_at) VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![
            KIND, name, url,
            branch.filter(|b| !b.trim().is_empty()).unwrap_or("main"),
            subdir.unwrap_or(""), auth_ref, fsutil::now_iso()
        ],
    ) {
        Ok(_) => {
            let sid = conn.last_insert_rowid();
            log(conn, "source:add", "ok", json!({"source_id": sid, "item_name": name}), Some(name), None);
            Ok(json!({"ok": true, "id": sid}))
        }
        Err(e) => ok_err(&format!("源已存在或非法：{e}")),
    }
}

pub fn list_sources(conn: &Connection) -> Vec<Value> {
    let sql = "SELECT s.id, s.kind, s.name, s.url, s.branch, s.subdir, s.auth_ref, s.enabled, \
        s.poll_min, s.created_at, s.last_sync_at, s.last_commit, s.last_error, s.repo_id, \
        (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS item_count, \
        (SELECT COUNT(*) FROM snapshots sn WHERE sn.source_id=s.id) AS snapshot_count, \
        (SELECT COUNT(*) FROM registry_items r WHERE r.kind=?1 AND r.source_id=s.id) AS registry_count \
        FROM sources s WHERE s.kind=?1 ORDER BY s.id";
    match conn.prepare(sql) {
        Ok(mut stmt) => stmt
            .query_map([KIND], |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?, "url": r.get::<_, String>(3)?,
                    "branch": r.get::<_, String>(4)?, "subdir": r.get::<_, String>(5)?,
                    "auth_ref": r.get::<_, Option<String>>(6)?,
                    "enabled": r.get::<_, i64>(7)? == 1,
                    "poll_min": r.get::<_, i64>(8)?,
                    "created_at": r.get::<_, String>(9)?,
                    "last_sync_at": r.get::<_, Option<String>>(10)?,
                    "last_commit": r.get::<_, Option<String>>(11)?,
                    "last_error": r.get::<_, Option<String>>(12)?,
                    "repo_id": r.get::<_, Option<i64>>(13)?,
                    "item_count": r.get::<_, i64>(14)?,
                    "snapshot_count": r.get::<_, i64>(15)?,
                    "registry_count": r.get::<_, i64>(16)?}))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

pub fn update_source(conn: &Connection, source_id: i64, fields: &Value) -> Result<Value> {
    const ALLOWED: [&str; 7] = ["enabled", "branch", "subdir", "auth_ref", "poll_min", "name", "url"];
    let Some(obj) = fields.as_object() else { return ok_err("无更新字段") };
    let sets: Vec<(&str, &Value)> = ALLOWED.iter().filter_map(|k| obj.get(*k).map(|v| (*k, v))).collect();
    if sets.is_empty() {
        return ok_err("无更新字段");
    }
    for (k, v) in &sets {
        let sv = match v {
            Value::String(s) => s.clone(),
            Value::Bool(b) => if *b { "1".into() } else { "0".into() },
            Value::Number(n) => n.to_string(),
            other => other.to_string(),
        };
        conn.execute(&format!("UPDATE sources SET {k}=?1 WHERE id=?2 AND kind=?3"),
                     rusqlite::params![sv, source_id, KIND])
            .map_err(CoreError::from)?;
    }
    log(conn, "source:update", "ok", json!({"source_id": source_id}), None, None);
    Ok(json!({"ok": true}))
}

pub fn delete_source(conn: &Connection, hub: &Path, source_id: i64) -> Result<Value> {
    let items: Vec<String> = match conn.prepare("SELECT name FROM items WHERE source_id=?1") {
        Ok(mut stmt) => stmt
            .query_map([source_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    let _ = conn.execute("DELETE FROM items WHERE source_id=?1", [source_id]);
    let _ = conn.execute("DELETE FROM snapshots WHERE source_id=?1", [source_id]);
    let _ = conn.execute("DELETE FROM sources WHERE id=?1 AND kind=?2", rusqlite::params![source_id, KIND]);
    // registry 条目转本地（mcp 简化口径：脱离源）
    for it in &items {
        let _ = conn.execute(
            "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, it],
        );
    }
    let _ = hub;
    log(conn, "source:delete", "ok", json!({"localized": items.len()}), None, Some(source_id));
    Ok(json!({"ok": true, "localized": items, "purged": []}))
}

fn source_cache(conn: &Connection, hub: &Path, source_id: i64) -> Option<(PathBuf, String, String, String, String)> {
    let (name, url, branch, subdir): (String, String, String, String) = conn
        .query_row(
            "SELECT name, url, branch, subdir FROM sources WHERE id=?1 AND kind=?2",
            rusqlite::params![source_id, KIND],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()?;
    Some((gitsrc::source_cache_dir(hub, KIND, &url, &branch, &subdir), name, url, branch, subdir))
}

pub fn pull_source(conn: &Connection, hub: &Path, source_id: i64, removed_action: Option<&str>) -> Result<Value> {
    let Some((cache, name, url, branch, subdir)) = source_cache(conn, hub, source_id) else {
        return ok_err("源不存在");
    };
    let (commit, resolved, _warn) = match gitsrc::ensure_cache(&cache, &url, &branch, None) {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute("UPDATE sources SET last_error=?1 WHERE id=?2",
                                 rusqlite::params![e, source_id]);
            log(conn, "pull", "failed", json!({}), Some(name.as_str()), Some(source_id));
            return ok_err(&e);
        }
    };
    let files = gitsrc::ls_tree(&cache, &commit, &subdir);
    let items = gitsrc::parse_mcp(&files, &cache, &commit, &subdir);
    if items.is_empty() {
        let msg = "源中没有解析到 MCP 条目（检查 mcp.json 或 mcp/*.json）";
        let _ = conn.execute("UPDATE sources SET last_error=?1 WHERE id=?2",
                             rusqlite::params![msg, source_id]);
        return ok_err(msg);
    }
    let old: Vec<(String, Option<String>)> = match conn.prepare("SELECT name, source_hash FROM items WHERE source_id=?1") {
        Ok(mut stmt) => stmt
            .query_map([source_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for it in &items {
        match old.iter().find(|(n, _)| *n == it.name) {
            None => added.push(it.name.clone()),
            Some((_, h)) if h.as_deref() != Some(it.source_hash.as_str()) => changed.push(it.name.clone()),
            _ => {}
        }
    }
    let removed: Vec<String> = old
        .iter()
        .filter(|(n, _)| !items.iter().any(|it| &it.name == n))
        .map(|(n, _)| n.clone())
        .collect();
    if !removed.is_empty() && removed_action.is_none() {
        let mut detail = Vec::new();
        for nm in &removed {
            let reg: bool = conn.query_row(
                "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2",
                rusqlite::params![KIND, nm], |_| Ok(true)).unwrap_or(false);
            let dep: i64 = conn.query_row(
                "SELECT COUNT(*) FROM deployments WHERE item_kind='mcp' AND item_name=?1 AND status='ok'",
                rusqlite::params![nm], |r| r.get(0)).unwrap_or(0);
            detail.push(json!({"name": nm, "in_registry": reg, "deployed_count": dep}));
        }
        return Ok(json!({"ok": true, "needs_action": true, "commit": commit,
            "added": added, "changed": changed, "removed": removed, "removed_detail": detail}));
    }
    for it in &items {
        conn.execute(
            "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) \
             VALUES(?,?,?,?,?,?,?) \
             ON CONFLICT(source_id, name) DO UPDATE SET path=excluded.path, \
             source_hash=excluded.source_hash, version=excluded.version, meta=excluded.meta",
            rusqlite::params![source_id, KIND, it.name, it.path, it.source_hash, commit, it.meta.to_string()],
        )
        .map_err(CoreError::from)?;
    }
    for nm in &removed {
        match removed_action {
            Some("localize") => {
                let _ = conn.execute(
                    "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL WHERE kind=?1 AND name=?2",
                    rusqlite::params![KIND, nm]);
            }
            _ => {
                let dest = reg_file(conn, nm);
                if dest.exists() {
                    let vroot = depot_core::paths::versions_root(hub, KIND, nm);
                    let _ = std::fs::create_dir_all(&vroot);
                    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
                    let _ = fsutil::rename_dir(&dest, &vroot.join(format!("{stamp}-source-deleted")));
                }
                let _ = conn.execute("DELETE FROM registry_items WHERE kind=?1 AND name=?2",
                                     rusqlite::params![KIND, nm]);
            }
        }
        let _ = conn.execute("DELETE FROM items WHERE source_id=?1 AND name=?2",
                             rusqlite::params![source_id, nm]);
    }
    conn.execute("UPDATE sources SET last_sync_at=?1, last_commit=?2, last_error=NULL, \
                  branch=COALESCE(?3, branch) WHERE id=?4",
                 rusqlite::params![fsutil::now_iso(), commit, resolved, source_id])
        .map_err(CoreError::from)?;
    log(conn, "pull", "ok", json!({"added": added, "changed": changed, "removed": removed,
        "removed_action": removed_action}), Some(name.as_str()), Some(source_id));
    Ok(json!({"ok": true, "commit": commit, "added": added, "changed": changed,
        "removed": removed, "removed_action": removed_action}))
}

// ---------- registry update / verify ----------

pub fn reg_file(conn: &Connection, name: &str) -> PathBuf {
    item_root(conn, name).join(format!("{name}.json"))
}

fn reg_cfg(conn: &Connection, name: &str) -> Option<Value> {
    let mut cur = fsutil::read_json(&reg_file(conn, name))?;
    if let Some(o) = cur.as_object_mut() {
        o.remove("name");
    }
    Some(cur)
}

pub fn update_registry(conn: &Connection, hub: &Path, names: &[String],
                       source_id: Option<i64>, force: bool) -> Vec<Value> {
    let mut results = Vec::new();
    for name in names {
        let row: Option<(i64, String, Option<String>, Value)> = {
            let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match source_id {
                Some(sid) => (
                    "SELECT source_id, source_hash, version, meta FROM items \
                     WHERE kind=?1 AND name=?2 AND source_id=?3 ORDER BY id DESC LIMIT 1",
                    vec![Box::new(KIND), Box::new(name), Box::new(sid)],
                ),
                None => (
                    "SELECT source_id, source_hash, version, meta FROM items \
                     WHERE kind=?1 AND name=?2 ORDER BY id DESC LIMIT 1",
                    vec![Box::new(KIND), Box::new(name)],
                ),
            };
            match conn.prepare(sql) {
                Ok(mut stmt) => {
                    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
                    stmt.query_row(refs.as_slice(), |r| {
                        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, String>(3)?))
                    })
                    .ok()
                    .map(|(sid, sh, v, meta)| (sid, sh, v,
                        serde_json::from_str(&meta).unwrap_or(json!({}))))
                }
                Err(_) => None,
            }
        };
        let Some((sid, src_hash, version, cfg)) = row else {
            results.push(json!({"item": name, "status": "failed", "reason": "源中没有该条目"}));
            continue;
        };
        let reg: Option<(Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT version, hash, source_hash_at FROM registry_items WHERE kind=?1 AND name=?2",
                rusqlite::params![KIND, name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let cur_hash = {
            let p = reg_file(conn, name);
            if p.exists() { fsutil::sha256_file(&p).ok() } else { None }
        };
        if let Some((_, reg_hash, _)) = &reg {
            if cur_hash.is_some() && reg_hash.is_some() && cur_hash != *reg_hash && !force {
                results.push(json!({"item": name, "status": "conflict-local-modified",
                    "reason": "本地库中该条目已被修改（force 覆盖）"}));
                log(conn, "update", "conflict", json!({"reason": "local-modified"}), Some(name), None);
                continue;
            }
        }
        if let Some((_, reg_hash, src_at)) = &reg {
            if src_at.as_deref() == Some(src_hash.as_str()) && cur_hash.as_deref() == reg_hash.as_deref() {
                results.push(json!({"item": name, "status": "unchanged", "version": reg.as_ref().and_then(|r| r.0.clone())}));
                continue;
            }
        }
        // materialize：登记在本地目录的条目写回其目录，否则 registry/mcp/<name>.json
        let reg_dir_id: Option<i64> = conn
            .query_row("SELECT dir_id FROM registry_items WHERE kind=?1 AND name=?2",
                       rusqlite::params![KIND, name], |r| r.get(0))
            .ok()
            .flatten();
        let root = match reg_dir_id {
            Some(d) if d > 0 => item_root(conn, name),
            _ => registry_root(&depot_core::paths::hub_dir()),
        };
        let _ = std::fs::create_dir_all(&root);
        let dest = root.join(format!("{name}.json"));
        if dest.exists() {
            let vroot = depot_core::paths::versions_root(hub, KIND, name);
            let _ = std::fs::create_dir_all(&vroot);
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
            let _ = fsutil::rename_dir(&dest, &vroot.join(&stamp));
        }
        if write_json_atomic(&dest, &cfg).is_err() {
            results.push(json!({"item": name, "status": "failed", "reason": "写入失败"}));
            continue;
        }
        let new_hash = fsutil::sha256_file(&dest).unwrap_or_default();
        let (pv, ph) = reg.as_ref().map(|r| (r.0.clone(), r.1.clone())).unwrap_or((None, None));
        conn.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, \
             prev_version, prev_hash, source_hash_at) VALUES(?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(kind, name) DO UPDATE SET source_id=excluded.source_id, \
             version=excluded.version, hash=excluded.hash, updated_at=excluded.updated_at, \
             prev_version=excluded.prev_version, prev_hash=excluded.prev_hash, \
             source_hash_at=excluded.source_hash_at",
            rusqlite::params![KIND, name, sid, version, new_hash, fsutil::now_iso(), pv, ph, src_hash],
        )
        .map_err(CoreError::from)
        .ok();
        let status = if reg.is_some() { "updated" } else { "installed" };
        results.push(json!({"item": name, "status": status,
            "version": version.as_deref().map(|v| v.chars().take(12).collect::<String>())}));
        log(conn, "update", "ok", json!({"source_id": sid}), Some(name), None);
    }
    results
}

fn write_json_atomic(path: &Path, v: &Value) -> Result<()> {
    let mut text = serde_json::to_string_pretty(v).unwrap_or_default();
    text.push('\n');
    fsutil::atomic_write_text(path, &text)
}

pub fn verify_item(conn: &Connection, name: &str) -> Value {
    let p = reg_file(conn, name);
    let Some(cfg) = fsutil::read_json(&p) else {
        return json!({"ok": false, "error": "本地库中不存在该条目（先更新到本地）"});
    };
    crate::verify_config(&cfg)
}

// ---------- tool_items / extract / sync_to_targets ----------

fn mcp_tools(conn: &Connection) -> Vec<Value> {
    depot_core::tools::load_tools(conn)
        .into_iter()
        .filter(|t| {
            t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
                && t.get("mcp_config").and_then(|c| c.as_str()).map(|c| !c.is_empty()).unwrap_or(false)
                && t.get("mcp_format").and_then(|f| f.as_str()).map(|f| !f.is_empty()).unwrap_or(false)
        })
        .collect()
}

/// 读工具 mcp_config → {server_name: cfg}。
pub fn read_tool_servers(tool: &Value) -> BTreeMap<String, Value> {
    let path = depot_core::tools::shellexpand(tool["mcp_config"].as_str().unwrap_or(""));
    if !path.is_file() {
        return BTreeMap::new();
    }
    let data: Option<Value> = if path.to_string_lossy().ends_with(".toml") {
        // TOML → JSON：仅取需要的 server 区块（toml crate）
        std::fs::read_to_string(&path).ok().and_then(|t| {
            t.parse::<toml::Value>().ok().map(|tv| json_from_toml(&tv))
        })
    } else {
        std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok())
    };
    let Some(mut data) = data else { return BTreeMap::new() };
    let fmt = tool["mcp_format"].as_str().unwrap_or("mcpServers");
    let mut cur = &mut data;
    for part in fmt.split('.') {
        if !cur.get(part).map(|v| v.is_object()).unwrap_or(false) {
            return BTreeMap::new();
        }
        cur = cur.get_mut(part).unwrap();
    }
    cur.as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, v)| v.is_object())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn json_from_toml(tv: &toml::Value) -> Value {
    match tv {
        toml::Value::String(s) => json!(s),
        toml::Value::Integer(i) => json!(i),
        toml::Value::Float(f) => json!(f),
        toml::Value::Boolean(b) => json!(b),
        toml::Value::Datetime(d) => json!(d.to_string()),
        toml::Value::Array(a) => Value::Array(a.iter().map(json_from_toml).collect()),
        toml::Value::Table(t) => {
            let mut m = serde_json::Map::new();
            for (k, v) in t {
                m.insert(k.clone(), json_from_toml(v));
            }
            Value::Object(m)
        }
    }
}

pub fn tool_items(conn: &Connection, tool_id: Option<&str>) -> Value {
    let tools: Vec<Value> = mcp_tools(conn)
        .into_iter()
        .filter(|t| tool_id.map(|id| t["id"].as_str() == Some(id)).unwrap_or(true))
        .collect();
    let reg_names: BTreeSet<String> = {
        match conn.prepare("SELECT name FROM registry_items WHERE kind=?1") {
            Ok(mut stmt) => stmt
                .query_map([KIND], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => BTreeSet::new(),
        }
    };
    let mut agg: BTreeMap<String, Value> = BTreeMap::new();
    for t in &tools {
        for (name, raw) in read_tool_servers(t) {
            let cur = agg.entry(name.clone()).or_insert_with(|| {
                json!({"name": name.clone(),
                    "state": if reg_names.contains(&name) { "synced" } else { "local_only" },
                    "tools": []})
            });
            if !reg_names.contains(&name) {
                cur["state"] = "local_only".into();
            } else {
                let cfg = normalize_config(&raw, &name).map(|mut c| {
                    if let Some(o) = c.as_object_mut() {
                        o.remove("name");
                    }
                    c
                });
                let reg = reg_cfg(conn, &name);
                if cfg.is_none() || cfg != reg {
                    cur["state"] = "diff".into();
                }
            }
            cur["tools"].as_array_mut().unwrap().push(json!({
                "id": t["id"], "name": t["name"]}));
        }
    }
    let order = |s: &str| match s { "local_only" => 0, "diff" => 1, _ => 2 };
    let mut items: Vec<Value> = agg.into_values().collect();
    items.sort_by(|a, b| {
        order(a["state"].as_str().unwrap_or("synced"))
            .cmp(&order(b["state"].as_str().unwrap_or("synced")))
            .then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    json!({"ok": true, "items": items})
}

pub fn extract(conn: &Connection, tool_id: &str, names: &[String]) -> Result<Value> {
    let tools: Vec<Value> = mcp_tools(conn)
        .into_iter()
        .filter(|t| t["id"].as_str() == Some(tool_id))
        .collect();
    if tools.is_empty() {
        return ok_err("工具不存在、未启用或没有已知 MCP 配置格式");
    }
    let servers = read_tool_servers(&tools[0]);
    let mut out = Vec::new();
    for raw_name in names {
        let name = raw_name.trim().to_string();
        let Some(raw) = servers.get(&name).filter(|v| v.is_object()) else {
            out.push(json!({"name": name, "ok": false, "error": "工具配置中不存在该条目"}));
            continue;
        };
        let Some(cfg) = normalize_config(raw, &name) else {
            out.push(json!({"name": name, "ok": false, "error": "配置非法：缺 command 或 url"}));
            continue;
        };
        let cur = reg_cfg(conn, &name);
        if cur.is_some() {
            let mut cfg_cmp = cfg.clone();
            if let Some(o) = cfg_cmp.as_object_mut() {
                o.remove("name");
            }
            if cur == Some(cfg_cmp) {
                out.push(json!({"name": name, "ok": true, "skipped": "已与本地库一致"}));
                continue;
            }
            if !is_manual_like(conn, &name) {
                out.push(json!({"name": name, "ok": false,
                    "error": "本地条目来自远程源，请通过源更新而不是提取覆盖"}));
                continue;
            }
        }
        let mut r = crate::write_manual(conn, &name, &cfg,
            if cur.is_some() { "提取自工具覆盖" } else { "提取自工具" }, None)?;
        r["name"] = json!(name);
        out.push(r);
    }
    let _ = events::append(conn, &Event {
        module: "mcp",
        actor: "local", kind: "mcp.extract", subject: None, outcome: "ok", error_code: None,
        extra: json!({"tool": tool_id, "names": names}),
        item_version: None, source_id: None,
                item_kind: Some("mcp"), item_name: None, target_id: None,
    });
    Ok(json!({"ok": true, "items": out}))
}

pub fn sync_to_targets(conn: &Connection, tool_id: &str, names: &[String], target_ids: &[i64]) -> Result<Value> {
    if tool_id.is_empty() {
        return ok_err("tool 必填");
    }
    let names: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    if names.is_empty() || target_ids.is_empty() {
        return ok_err("names 与 target_ids 必填");
    }
    let own: BTreeSet<i64> = {
        match conn.prepare("SELECT id FROM targets WHERE tool=?1 AND kind IN ('mcp_json','mcp_toml')") {
            Ok(mut stmt) => stmt
                .query_map([tool_id], |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => BTreeSet::new(),
        }
    };
    let valid: BTreeSet<i64> = {
        match conn.prepare("SELECT id FROM targets WHERE kind IN ('mcp_json','mcp_toml')") {
            Ok(mut stmt) => stmt
                .query_map([], |r| r.get::<_, i64>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => BTreeSet::new(),
        }
    };
    let tids: Vec<i64> = target_ids.iter().filter(|t| valid.contains(t) && !own.contains(t)).cloned().collect();
    if tids.is_empty() {
        return ok_err("没有可用的目标工具（源工具自身不作为目标）");
    }
    let ex = extract(conn, tool_id, &names)?;
    if ex["ok"].as_bool() != Some(true) {
        return Ok(ex);
    }
    let outgoing: Vec<String> = ex["items"].as_array().map(|a| {
        a.iter()
            .filter(|x| x["ok"].as_bool() == Some(true))
            .filter_map(|x| x["name"].as_str().map(|s| s.to_string()))
            .collect()
    }).unwrap_or_default();
    let results = if outgoing.is_empty() {
        vec![]
    } else {
        crate::distribute_mcp(conn, &outgoing, &tids, false, true, "local")?
    };
    log(conn, "tool-sync", "ok", json!({"tool": tool_id, "names": outgoing, "target_ids": tids}), None, None);
    Ok(json!({"ok": true, "extracted": ex["items"], "results": results}))
}

// ---------- targets ----------

pub fn delete_target(conn: &Connection, target_id: i64, force: bool) -> Result<Value> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deployments WHERE target_id=?1 AND status='ok'",
        [target_id], |r| r.get(0)).unwrap_or(0);
    if n > 0 && !force {
        return ok_err(&format!("目标上仍有 {n} 条部署记录；用 force 或先清理"));
    }
    conn.execute("DELETE FROM deployments WHERE target_id=?1", [target_id]).map_err(CoreError::from)?;
    conn.execute("DELETE FROM targets WHERE id=?1", [target_id]).map_err(CoreError::from)?;
    let _ = events::append(conn, &Event {
        module: "mcp",
        actor: "local", kind: "target:delete", subject: None, outcome: "ok", error_code: None,
        item_version: None, source_id: None,
                extra: json!({}), item_kind: Some("mcp"), item_name: None, target_id: Some(target_id),
    });
    Ok(json!({"ok": true}))
}

pub fn seed_defaults(conn: &Connection) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let defaults: Vec<(&str, &str, &str, String, Option<&str>)> = vec![
        ("Claude Code (全局)", "mcp_json", "claude", format!("{home}/.claude.json"), Some("mcpServers")),
        ("Codex CLI (全局)", "mcp_toml", "codex", format!("{home}/.codex/config.toml"), None),
        ("OpenCode (全局)", "mcp_json", "opencode", format!("{home}/.config/opencode/opencode.json"), Some("mcp")),
        ("Cursor (全局)", "mcp_json", "cursor", format!("{home}/.cursor/mcp.json"), Some("mcpServers")),
        ("WorkBuddy (全局)", "mcp_json", "workbuddy", format!("{home}/.workbuddy/mcp.json"), Some("mcpServers")),
        ("ZCode (全局)", "mcp_json", "zcode", format!("{home}/.zcode/cli/config.json"), Some("mcp.servers")),
        ("AutoClaw (全局)", "mcp_json", "autoclaw", format!("{home}/.openclaw-autoclaw/openclaw.json"), Some("mcp.servers")),
    ];
    let mut created = Vec::new();
    for (nm, kind, tool, path, fkey) in defaults {
        let p = Path::new(&path);
        if !p.exists() && !p.parent().map(|x| x.is_dir()).unwrap_or(false) {
            continue;
        }
        let n = conn.execute(
            "INSERT OR IGNORE INTO targets(name, kind, tool, path, format_key, created_at) VALUES(?,?,?,?,?,?)",
            rusqlite::params![nm, kind, tool, path, fkey, fsutil::now_iso()]).unwrap_or(0);
        if n > 0 {
            created.push(nm.to_string());
        }
    }
    if !created.is_empty() {
        let _ = events::append(conn, &Event {
            module: "mcp",
            actor: "local", kind: "targets:seed", subject: None, outcome: "ok", error_code: None,
        item_version: None, source_id: None,
                    extra: json!({"mcp": created}), item_kind: Some("mcp"), item_name: None, target_id: None,
        });
    }
    created
}

// ---------- views ----------

pub fn catalog_view(conn: &Connection, source_id: Option<i64>) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    if source_id.is_none() {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT r.name, r.version, r.dir_id, d.name FROM registry_items r \
             LEFT JOIN local_dirs d ON d.id=r.dir_id \
             WHERE r.kind=?1 AND r.source_id IS NULL ORDER BY r.name",
        ) {
            let rows: Vec<Value> = stmt
                .query_map([KIND], |r| {
                    Ok(json!({"name": r.get::<_, String>(0)?,
                        "version": r.get::<_, Option<String>>(1)?,
                        "dir_id": r.get::<_, Option<i64>>(2)?,
                        "dir_name": r.get::<_, Option<String>>(3)?,
                        "path": Value::Null, "source_hash": Value::Null,
                        "meta": Value::Null, "source_name": "本地"}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default();
            items.extend(rows);
        }
    }
    let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match source_id {
        Some(sid) => (
            "SELECT i.name, i.version, i.source_id, i.source_hash, i.meta, i.path, s.name \
             FROM items i JOIN sources s ON s.id=i.source_id \
             WHERE i.kind=?1 AND i.source_id=?2 ORDER BY i.name",
            vec![Box::new(KIND), Box::new(sid)],
        ),
        None => (
            "SELECT i.name, i.version, i.source_id, i.source_hash, i.meta, i.path, s.name \
             FROM items i JOIN sources s ON s.id=i.source_id WHERE i.kind=?1 ORDER BY i.name",
            vec![Box::new(KIND)],
        ),
    };
    if let Ok(mut stmt) = conn.prepare(sql) {
        let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
        let rows: Vec<Value> = stmt
            .query_map(refs.as_slice(), |r| {
                Ok(json!({
                    "name": r.get::<_, String>(0)?,
                    "version": r.get::<_, Option<String>>(1)?,
                    "source_id": r.get::<_, Option<i64>>(2)?,
                    "source_hash": r.get::<_, Option<String>>(3)?,
                    "meta": r.get::<_, Option<String>>(4)?,
                    "path": r.get::<_, Option<String>>(5)?,
                    "source_name": r.get::<_, String>(6)?}))
            })
            .map(|x| x.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();
        items.extend(rows);
    }
    let regs: HashMap<String, Value> = {
        match conn.prepare("SELECT name, version, hash, source_hash_at FROM registry_items WHERE kind=?1") {
            Ok(mut stmt) => stmt
                .query_map([KIND], |r| {
                    Ok((r.get::<_, String>(0)?, json!({
                        "version": r.get::<_, Option<String>>(1)?,
                        "hash": r.get::<_, Option<String>>(2)?,
                        "source_hash_at": r.get::<_, Option<String>>(3)?})))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    };
    let mut out = Vec::new();
    for it in &items {
        let name = it["name"].as_str().unwrap_or("");
        let manual = it["source_name"] == "本地" || it["path"].is_null();
        let reg = regs.get(name);
        let cfg: Value = if it["meta"].is_string() {
            it["meta"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(json!({}))
        } else if manual && reg.is_some() {
            fsutil::read_json(&reg_file(conn, name)).unwrap_or(json!({}))
        } else {
            json!({})
        };
        let st = if manual && reg.is_some() {
            "installed".to_string()
        } else if manual {
            "not-installed".to_string()
        } else {
            let cur = {
                let p = reg_file(conn, name);
                if p.exists() { fsutil::sha256_file(&p).ok() } else { None }
            };
            match (&reg, &cur) {
                (Some(r), Some(c)) if r["hash"].as_str().map(|h| !h.is_empty()).unwrap_or(false)
                    && Some(c.to_string()) != r["hash"].as_str().map(|s| s.to_string()) =>
                {
                    if Some(c.as_str()) != r["hash"].as_str() {
                        // hash != file hash → local-modified
                        "local-modified".to_string()
                    } else {
                        "installed".to_string()
                    }
                }
                _ => {
                    if let Some(r) = reg {
                        if r["source_hash_at"].is_string() && it["source_hash"].as_str() != r["source_hash_at"].as_str() {
                            "update-available".to_string()
                        } else {
                            "installed".to_string()
                        }
                    } else {
                        "not-installed".to_string()
                    }
                }
            }
        };
        let transport = cfg
            .get("type")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| if cfg.get("url").is_some() { "http".into() } else { "stdio".into() });
        let target_str = cfg
            .get("url")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                format!(
                    "{} {}",
                    cfg.get("command").and_then(|c| c.as_str()).unwrap_or(""),
                    cfg.get("args")
                        .and_then(|a| a.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
                        .unwrap_or_default()
                )
                .trim()
                .to_string()
            });
        out.push(json!({
            "name": name,
            "version": it["version"].as_str().map(|v| v.chars().take(12).collect::<String>()),
            "source_name": if it["source_name"].is_null() {
                json!(if manual { "本地" } else { "" })
            } else { it["source_name"].clone() },
            "source_id": if manual { Value::Null } else { it["source_id"].clone() },
            "manual": manual,
            "dir_id": it["dir_id"],
            "dir_name": it["dir_name"],
            "transport": transport,
            "target": target_str,
            "env_keys": cfg.get("env").and_then(|e| e.as_object())
                .map(|o| o.keys().cloned().collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>())
                .unwrap_or_default(),
            "status": st}));
    }
    out
}

pub fn registry_view(conn: &Connection) -> Vec<Value> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, version, hash, source_id, dir_id FROM registry_items WHERE kind=?1 ORDER BY name",
    ) else { return vec![] };
    let regs: Vec<Value> = stmt
        .query_map([KIND], |r| {
            Ok(json!({"name": r.get::<_, String>(0)?,
                "version": r.get::<_, Option<String>>(1)?,
                "hash": r.get::<_, Option<String>>(2)?,
                "source_id": r.get::<_, Option<i64>>(3)?,
                "dir_id": r.get::<_, Option<i64>>(4)?}))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let Ok(mut dstmt) = conn.prepare(
        "SELECT d.item_name, d.target_id, t.name FROM deployments d \
         LEFT JOIN targets t ON t.id=d.target_id WHERE d.item_kind='mcp' AND d.status='ok'",
    ) else { return vec![] };
    let deps: Vec<(String, Value)> = dstmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, json!({
                "target_id": r.get::<_, i64>(1)?, "target": r.get::<_, Option<String>>(2)?})))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let mut dep_map: HashMap<String, Vec<Value>> = HashMap::new();
    for (name, d) in deps {
        dep_map.entry(name).or_default().push(d);
    }
    let mut out = Vec::new();
    for r in &regs {
        let name = r["name"].as_str().unwrap_or("");
        let cur = {
            let p = reg_file(conn, name);
            if p.exists() { fsutil::sha256_file(&p).ok() } else { None }
        };
        let cfg = fsutil::read_json(&reg_file(conn, name)).unwrap_or(json!({}));
        let transport = cfg.get("type").and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| if cfg.get("url").is_some() { "http".into() } else { "stdio".into() });
        let target_str = cfg.get("url").and_then(|u| u.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{} {}",
                cfg.get("command").and_then(|c| c.as_str()).unwrap_or(""),
                cfg.get("args").and_then(|a| a.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "))
                    .unwrap_or_default()).trim().to_string());
        let reg_hash = r["hash"].as_str().unwrap_or("");
        out.push(json!({
            "name": name,
            "version": r["version"].as_str().map(|v| v.chars().take(12).collect::<String>()),
            "transport": transport, "target": target_str,
            "env_keys": cfg.get("env").and_then(|e| e.as_object())
                .map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "manual": r["source_id"].is_null(),
            "dir_id": r["dir_id"],
            "modified": cur.is_some() && !reg_hash.is_empty() && cur.as_deref() != Some(reg_hash),
            "deployments": dep_map.get(name).cloned().unwrap_or_default()}));
    }
    out
}

pub fn item_detail(conn: &Connection, name: &str) -> Option<Value> {
    let mut from_source = false;
    let mut cfg = fsutil::read_json(&reg_file(conn, name));
    if cfg.is_none() {
        let row: Option<(i64, Option<String>)> = conn
            .query_row(
                "SELECT source_id, path FROM items WHERE kind=?1 AND name=?2 ORDER BY id DESC LIMIT 1",
                rusqlite::params![KIND, name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let Some((_sid, _path)) = row else { return None };
        // 源缓存回落（需要 hub/sources 布局）；找不到配置 → None
        from_source = false;
        return None; // 简化：源缓存内容物化路径在 depotd 中按需扩展
    }
    let cfg = cfg.unwrap();
    let masked: Value = cfg
        .get("env")
        .and_then(|e| e.as_object())
        .map(|o| {
            let mut m = serde_json::Map::new();
            for (k, v) in o {
                m.insert(k.clone(), json!(depot_core::mcputil::mask_secret(v.as_str())));
            }
            Value::Object(m)
        })
        .unwrap_or(json!({}));
    let reg_row: Option<i64> = conn
        .query_row("SELECT dir_id FROM registry_items WHERE kind=?1 AND name=?2",
                   rusqlite::params![KIND, name], |r| r.get(0))
        .ok()
        .flatten();
    let dir_name: Option<String> = match reg_row {
        Some(did) => conn
            .query_row("SELECT name FROM local_dirs WHERE id=?1", [did], |r| r.get(0))
            .ok(),
        None => None,
    };
    let mut clean = cfg.clone();
    if let Some(o) = clean.as_object_mut() {
        o.remove("env");
        o.remove("name");
    }
    Some(json!({"name": name, "config": clean, "env_masked": masked,
        "from_source": from_source, "dir_id": reg_row, "dir_name": dir_name}))
}

pub fn items_view(conn: &Connection, source: Option<&str>, q: Option<&str>,
                  page: i64, per_page: i64, dir: Option<&str>) -> Value {
    let cat: Vec<Value> = match source {
        Some(s) if s.eq_ignore_ascii_case("manual") || s.eq_ignore_ascii_case("local") => {
            catalog_view(conn, None).into_iter().filter(|it| it["manual"] == true).collect()
        }
        _ => catalog_view(conn, source.and_then(|s| s.parse::<i64>().ok())),
    };
    let mut cat = cat;
    if dir.is_some() && (source.is_none() || source == Some("manual")) {
        let want: Option<i64> = match dir {
            Some("default") | Some("") => None,
            Some(d) => d.parse::<i64>().ok(),
            None => None,
        };
        cat.retain(|it| {
            it["manual"] == true
                && match (&it["dir_id"], want) {
                    (Value::Null, None) => true,
                    (Value::Null, _) => false,
                    (v, w) => v.as_i64() == w,
                }
        });
    }
    if let Some(qs) = q {
        let ql = qs.to_lowercase();
        cat.retain(|it| {
            it["name"].as_str().map(|n| n.to_lowercase().contains(&ql)).unwrap_or(false)
                || it["target"].as_str().map(|n| n.to_lowercase().contains(&ql)).unwrap_or(false)
        });
    }
    let total = cat.len() as i64;
    let page = page.max(1);
    let per_page = per_page.clamp(5, 100);
    let slice: Vec<Value> = cat.iter().skip(((page - 1) * per_page) as usize).take(per_page as usize).cloned().collect();
    let Ok(mut tstmt) = conn.prepare(
        "SELECT id, name, tool, path, kind, COALESCE(format_key,'') FROM targets \
         WHERE kind IN ('mcp_json','mcp_toml') ORDER BY id") else {
        return json!({"ok": true, "items": [], "total": 0, "page": 1, "per_page": per_page, "pages": 1, "targets": []}) };
    let trows: Vec<Value> = tstmt
        .query_map([], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                "tool": r.get::<_, Option<String>>(2)?, "path": r.get::<_, String>(3)?,
                "kind": r.get::<_, String>(4)?, "format_key": r.get::<_, String>(5)?}))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let trows: Vec<Value> = trows
        .into_iter()
        .filter(|t| depot_skills_visible(conn, t["tool"].as_str()))
        .collect();
    let visible_ids: BTreeSet<i64> = trows.iter().filter_map(|t| t["id"].as_i64()).collect();
    let Ok(mut dstmt) = conn.prepare(
        "SELECT d.item_name, d.target_id, d.deployed_at, d.detail FROM deployments d \
         WHERE d.item_kind='mcp' AND d.status='ok'") else {
        return json!({"ok": true, "items": [], "total": 0}) };
    let deps: Vec<(String, Value)> = dstmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, json!({
                "target_id": r.get::<_, i64>(1)?,
                "deployed_at": r.get::<_, Option<String>>(2)?,
                "detail": r.get::<_, Option<String>>(3)?})))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let deps: Vec<(String, Value)> = deps
        .into_iter()
        .filter(|(_, d)| visible_ids.contains(&d["target_id"].as_i64().unwrap_or(-1)))
        .collect();
    let tool_names = depot_skill_tool_names(conn);
    let mut dep_by_item: HashMap<String, HashMap<i64, &Value>> = HashMap::new();
    for (name, d) in &deps {
        dep_by_item.entry(name.clone()).or_default().insert(d["target_id"].as_i64().unwrap_or(0), d);
    }
    let mut targets = Vec::new();
    for t in &trows {
        let tid = t["id"].as_i64().unwrap_or(0);
        let mut tj = json!({"id": tid, "name": t["name"],
            "tool_name": t["tool"].as_str().and_then(|x| tool_names.get(x)).cloned(),
            "path": t["path"], "tool": t["tool"], "kind": t["kind"],
            "format_key": t["format_key"],
            "items": {"latest": 0, "stale": 0, "missing": 0, "total": 0}, "stale_names": []});
        for it in &cat {
            let name = it["name"].as_str().unwrap_or("");
            match dep_by_item.get(name).and_then(|m| m.get(&tid)) {
                Some(dep) => {
                    tj["items"]["total"] = json!(tj["items"]["total"].as_i64().unwrap_or(0) + 1);
                    if dep_stale(conn, name, dep, Some(t)) {
                        tj["items"]["stale"] = json!(tj["items"]["stale"].as_i64().unwrap_or(0) + 1);
                        tj["stale_names"].as_array_mut().unwrap().push(json!(name));
                    } else {
                        tj["items"]["latest"] = json!(tj["items"]["latest"].as_i64().unwrap_or(0) + 1);
                    }
                }
                None => {
                    tj["items"]["missing"] = json!(tj["items"]["missing"].as_i64().unwrap_or(0) + 1);
                }
            }
        }
        targets.push(tj);
    }
    let mut rows = Vec::new();
    for it in &slice {
        let name = it["name"].as_str().unwrap_or("");
        let mut per_target = Vec::new();
        for t in &trows {
            let tid = t["id"].as_i64().unwrap_or(0);
            match dep_by_item.get(name).and_then(|m| m.get(&tid)) {
                Some(dep) => per_target.push(json!({
                    "target_id": tid, "target": t["name"],
                    "state": if dep_stale(conn, name, dep, Some(t)) { "stale" } else { "latest" },
                    "deployed_at": dep["deployed_at"]})),
                None => per_target.push(json!({
                    "target_id": tid, "target": t["name"], "state": "missing",
                    "deployed_at": Value::Null})),
            }
        }
        let mut row = it.clone();
        row["per_target"] = json!(per_target);
        rows.push(row);
    }
    json!({"ok": true, "items": rows, "total": total, "page": page, "per_page": per_page,
        "pages": (total + per_page - 1) / per_page.max(1), "targets": targets})
}

fn depot_skills_visible(conn: &Connection, tool_id: Option<&str>) -> bool {
    // 与 depot_skills::extra::target_visible 同口径（mcp_config 路径键）
    let Some(tid) = tool_id else { return true };
    if tid == "plain" || tid.is_empty() {
        return true;
    }
    let t = depot_core::tools::tool_by_id(conn, tid);
    let Some(t) = t else { return false };
    if t.get("enabled").and_then(|e| e.as_bool()) != Some(true) {
        return false;
    }
    t.get("mcp_config").and_then(|p| p.as_str()).map(|p| !p.is_empty()).unwrap_or(false)
}

fn depot_skill_tool_names(conn: &Connection) -> HashMap<String, String> {
    depot_core::tools::load_tools(conn)
        .iter()
        .filter_map(|t| {
            Some((
                t["id"].as_str()?.to_string(),
                t["name"].as_str()?.to_string(),
            ))
        })
        .collect()
}

/// 工具端现状与本地库 config 是否一致（mcp 版 stale 判定）。
pub fn dep_stale(conn: &Connection, name: &str, dep: &Value, target: Option<&Value>) -> bool {
    let d: Value = dep
        .get("detail")
        .and_then(|x| x.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!({}));
    let Some(cfg) = reg_cfg(conn, name) else { return false };
    if let Some(t) = target {
        let path = depot_core::tools::shellexpand(t["path"].as_str().unwrap_or(""));
        if t["kind"].as_str() == Some("mcp_json") {
            let data = fsutil::read_json(&path);
            let fmt_key = d
                .get("format_key")
                .and_then(|f| f.as_str())
                .map(|s| s.to_string())
                .or_else(|| t.get("format_key").and_then(|f| f.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| "mcpServers".into());
            let Some(mut data) = data else { return false };
            let mut ok = true;
            let mut cursor: *mut serde_json::Value = &mut data;
            for part in fmt_key.split('.') {
                let c: &mut serde_json::Value = unsafe { &mut *cursor };
                match c.get_mut(part) {
                    Some(v) if v.is_object() => cursor = v as *mut serde_json::Value,
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                let c: &serde_json::Value = unsafe { &*cursor };
                let found = c.get(name).cloned();
                if let Some(v) = found {
                    return v != cfg;
                }
            }
        } else {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if let Some((s, e)) = find_toml_block(&text, name) {
                return text[s..e] != toml_block(name, &cfg);
            }
        }
    }
    if d.get("injected").is_some() {
        return d["injected"] != cfg;
    }
    if d.get("block_text").is_some() {
        return d["block_text"].as_str().map(|bt| Some(bt) != Some(toml_block(name, &cfg).as_str())).unwrap_or(false);
    }
    false
}
