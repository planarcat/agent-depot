//! mod_skills 余量端口：sources（git pull/sync-local）、views（catalog/registry/
//! items/detail/diff）、import、tool_items/extract/sync_to_targets、
//! update_registry/_materialize、绑定视图与变更（cleanup/tag/sync_all）、
//! targets（delete/seed）、模块开关。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use depot_core::error::{Code, CoreError, Result};
use depot_core::events::{self, Event};
use depot_core::fsutil;
use depot_core::gitsrc;

use crate::{item_dir, is_manual, name_valid, registry_root, with_fm_field, KIND};

pub const MODULE: &str = "skills";

// ---------- 本地小助手（与 lib.rs 内私有版一致） ----------

pub fn ok_err(msg: &str) -> Result<Value> {
    Ok(json!({"ok": false, "error": msg}))
}

fn ok2(v: Value) -> Result<Value> {
    Ok(v)
}

fn log_op(conn: &Connection, action: &str, outcome: &str, ev: Event) {
    // 传 kind/outcome 覆盖（Event 字段顺序无关，这里复用调用方构造的其余字段）
    let mut ev2 = ev;
    ev2.kind = action;
    ev2.outcome = outcome;
    if ev2.module.is_empty() {
        ev2.module = "skills";
    }
    let _ = events::append(conn, &ev2);
}

/// frontmatter description。
fn fm_desc(p: &Path) -> String {
    std::fs::read_to_string(p)
        .ok()
        .map(|t| {
            gitsrc::parse_frontmatter(&t)
                .get("description")
                .cloned()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

/// 全部 registry 条目名 → 条目目录（批量，避免逐条 SQL 风暴）。
pub fn item_dirs_map(conn: &Connection, hub: &Path) -> HashMap<String, PathBuf> {
    let mut stmt = match conn.prepare(
        "SELECT name FROM registry_items WHERE kind=?1 AND dir_id IS NULL") { Ok(t) => t, Err(_) => return HashMap::new() };
    let defaults: Vec<String> = stmt
        .query_map([KIND], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let mut out = HashMap::new();
    for n in defaults {
        out.insert(n.clone(), item_dir(conn, hub, &n));
    }
    out
}

/// 新建指定的目标目录根；dir_id 为空 → 默认库。
pub fn dir_root(conn: &Connection, dir_id: Option<i64>) -> std::result::Result<PathBuf, String> {
    match dir_id {
        None | Some(0) => Ok(registry_root(&depot_core::paths::hub_dir())),
        Some(id) => {
            let p: Option<String> = conn
                .query_row("SELECT path FROM local_dirs WHERE id=?1", [id], |r| r.get(0))
                .ok();
            match p {
                Some(p) if !p.is_empty() => Ok(PathBuf::from(p)),
                _ => Err(format!("本地目录不存在（id={id}）")),
            }
        }
    }
}

fn name_conflict(conn: &Connection, hub: &Path, name: &str, root: &Path) -> Option<String> {
    if !name_valid(name) {
        return Some("名称非法（字母数字开头，允许 . _ -，≤64 字符）".into());
    }
    let src_row: Option<String> = conn
        .query_row(
            "SELECT s.name FROM items i JOIN sources s ON s.id=i.source_id \
             WHERE i.kind=?1 AND i.name=?2 LIMIT 1",
            rusqlite::params![KIND, name],
            |r| r.get(0),
        )
        .ok();
    if let Some(s) = src_row {
        return Some(format!("已存在同名条目（来自源仓库 {s}）；重名会被拦截"));
    }
    let reg: Option<i64> = conn
        .query_row(
            "SELECT COALESCE(source_id,-1) FROM registry_items WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, name],
            |r| r.get(0),
        )
        .ok();
    if let Some(sid) = reg {
        return Some(format!(
            "已存在同名条目（{}）",
            if sid < 0 { "本地" } else { "远程" }
        ));
    }
    if root.join(name).is_dir() {
        return Some("已存在同名目录".into());
    }
    let _ = hub;
    None
}

fn fm_version_of(conn: &Connection, hub: &Path, name: &str) -> Option<String> {
    let p = item_dir(conn, hub, name).join("SKILL.md");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| {
            gitsrc::parse_frontmatter(&t)
                .get("version")
                .filter(|v| !v.is_empty())
                .cloned()
        })
}

fn sub_for_root(conn: &Connection, dir_id: Option<i64>, root: &Path) -> Option<String> {
    let did = dir_id?;
    let dpath: Option<String> = conn
        .query_row("SELECT path FROM local_dirs WHERE id=?1", [did], |r| r.get(0))
        .ok()?;
    let droot = PathBuf::from(dpath?);
    let rel = root.strip_prefix(&droot).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() || s == "." { None } else { Some(s) }
}

fn register_manual(
    conn: &Connection, hub: &Path, name: &str,
    root: Option<&Path>, dir_id: Option<i64>,
) -> Result<String> {
    let base = match root {
        Some(r) => r.to_path_buf(),
        None => registry_root(hub),
    };
    let new_hash = fsutil::tree_hash(&base.join(name))?;
    let prev: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT version, hash FROM registry_items WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (pv, ph) = prev.unwrap_or((None, None));
    let sub = sub_for_root(conn, dir_id, &base);
    conn.execute(
        "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, \
         prev_version, prev_hash, source_hash_at, dir_id, sub_path) \
         VALUES(?,?,NULL,?,?,?,?,?,NULL,?,?) \
         ON CONFLICT(kind, name) DO UPDATE SET version=excluded.version, hash=excluded.hash, \
         updated_at=excluded.updated_at, prev_version=excluded.prev_version, \
         prev_hash=excluded.prev_hash, source_hash_at=NULL, dir_id=excluded.dir_id, \
         sub_path=excluded.sub_path",
        rusqlite::params![
            KIND, name,
            fm_version_of(conn, hub, name),
            new_hash, fsutil::now_iso(), pv, ph, dir_id, sub
        ],
    )
    .map_err(CoreError::from)?;
    Ok(new_hash)
}

fn backup_registry_dir(conn: &Connection, hub: &Path, name: &str) -> Option<PathBuf> {
    let dest = item_dir(conn, hub, name);
    if !dest.is_dir() {
        return None;
    }
    let vroot = depot_core::paths::versions_root(hub, KIND, name);
    let _ = std::fs::create_dir_all(&vroot);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut backup = vroot.join(&stamp);
    let mut n = 1;
    while backup.exists() {
        backup = vroot.join(format!("{stamp}-{n}"));
        n += 1;
    }
    fsutil::copy_dir_all(&dest, &backup).ok()?;
    Some(backup)
}

pub fn registry_enabled(conn: &Connection) -> bool {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM config WHERE key='modules.enabled.skills'",
            [], |r| r.get(0),
        )
        .ok();
    match v {
        None => true,
        Some(v) => !matches!(v.as_str(), "0" | "false" | "off" | "no"),
    }
}

// ---------- sources ----------

pub fn add_source(
    conn: &Connection, name: Option<&str>, url: Option<&str>,
    branch: Option<&str>, subdir: Option<&str>, auth_ref: Option<&str>,
) -> Result<Value> {
    let name = name.unwrap_or("").trim();
    let url = url.unwrap_or("").trim();
    if name.is_empty() || url.is_empty() {
        return ok_err("name 与 url 必填");
    }
    let r = conn.execute(
        "INSERT INTO sources(kind, name, url, branch, subdir, auth_ref, created_at) \
         VALUES(?,?,?,?,?,?,?)",
        rusqlite::params![
            KIND, name, url,
            branch.filter(|b| !b.trim().is_empty()).unwrap_or("main"),
            subdir.unwrap_or(""), auth_ref, fsutil::now_iso()
        ],
    );
    match r {
        Ok(_) => {
            let sid = conn.last_insert_rowid();
            log_op(conn, "source:add", "ok", Event { module: "skills",
                actor: "local", kind: "", subject: None, outcome: "",
                error_code: None, extra: json!({"source_id": sid, "item_name": name}),
        item_version: None, source_id: None,
                        item_kind: None, item_name: Some(name), target_id: None,
            });
            ok2(json!({"ok": true, "id": sid}))
        }
        Err(e) => ok_err(&format!("源已存在或非法：{e}")),
    }
}

pub fn list_sources(conn: &Connection) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT s.id, s.kind, s.name, s.url, s.branch, s.subdir, s.auth_ref, s.enabled, \
         s.poll_min, s.created_at, s.last_sync_at, s.last_commit, s.last_error, s.repo_id, \
         (SELECT COUNT(*) FROM items i WHERE i.source_id=s.id) AS item_count, \
         (SELECT COUNT(*) FROM snapshots sn WHERE sn.source_id=s.id) AS snapshot_count, \
         (SELECT COUNT(*) FROM registry_items r WHERE r.kind=?1 AND r.source_id=s.id) AS registry_count \
         FROM sources s WHERE s.kind=?1 ORDER BY s.id") { Ok(t) => t, Err(_) => return vec![] };
    stmt.query_map([KIND], |r| {
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
            "registry_count": r.get::<_, i64>(16)?,
        }))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn update_source(conn: &Connection, source_id: i64, fields: &Value) -> Result<Value> {
    const ALLOWED: [&str; 7] = ["enabled", "branch", "subdir", "auth_ref", "poll_min", "name", "url"];
    let Some(obj) = fields.as_object() else { return ok_err("无更新字段") };
    let sets: Vec<(&str, &Value)> = ALLOWED
        .iter()
        .filter_map(|k| obj.get(*k).map(|v| (*k, v)))
        .collect();
    if sets.is_empty() {
        return ok_err("无更新字段");
    }
    for (k, v) in &sets {
        let sql = format!("UPDATE sources SET {k}=?1 WHERE id=?2 AND kind=?3");
        let sv = match v {
            Value::String(s) => s.clone(),
            Value::Bool(b) => if *b { "1".into() } else { "0".into() },
            Value::Number(n) => n.to_string(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        conn.execute(&sql, rusqlite::params![sv, source_id, KIND])
            .map_err(CoreError::from)?;
    }
    log_op(conn, "source:update", "ok", Event {
        module: "skills",
        actor: "local", kind: "", subject: None, outcome: "",
        error_code: None, extra: json!({"source_id": source_id}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: Some(source_id),
    });
    ok2(json!({"ok": true}))
}

fn purge_registry_item(conn: &Connection, hub: &Path, name: &str) {
    let dest = registry_root(hub).join(name);
    if dest.is_dir() {
        let _ = backup_registry_dir(conn, hub, name);
        let _ = fsutil::safe_rm(&dest, hub);
    }
    let _ = conn.execute(
        "DELETE FROM registry_items WHERE kind=?1 AND name=?2",
        rusqlite::params![KIND, name],
    );
}

pub fn delete_source(conn: &Connection, hub: &Path, source_id: i64, removed_action: Option<&str>) -> Result<Value> {
    let src: Option<(String, String, String, String, Option<i64>)> = conn
        .query_row(
            "SELECT name, url, branch, subdir, repo_id FROM sources WHERE id=?1 AND kind=?2",
            rusqlite::params![source_id, KIND],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let items: Vec<String> = {
        match conn.prepare("SELECT name FROM items WHERE source_id=?1") {
        Ok(mut stmt) => stmt.query_map([source_id], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
        }
    };
    let _ = conn.execute("DELETE FROM items WHERE source_id=?1", [source_id]);
    let _ = conn.execute("DELETE FROM snapshots WHERE source_id=?1", [source_id]);
    let _ = conn.execute("DELETE FROM sources WHERE id=?1 AND kind=?2", rusqlite::params![source_id, KIND]);
    if let Some((name, url, branch, subdir, _repo_id)) = &src {
        let cache = gitsrc::source_cache_dir(hub, KIND, url, branch, subdir);
        if cache.is_dir() {
            let _ = std::fs::remove_dir_all(&cache);
        }
        let _ = name;
    }
    let mut localized = Vec::new();
    let mut purged = Vec::new();
    for it in &items {
        let reg: bool = conn
            .query_row(
                "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2",
                rusqlite::params![KIND, it], |_| Ok(true),
            )
            .unwrap_or(false);
        if !reg {
            continue;
        }
        if removed_action == Some("delete") {
            purge_registry_item(conn, hub, it);
            purged.push(it.clone());
        } else {
            let _ = conn.execute(
                "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL \
                 WHERE kind=?1 AND name=?2",
                rusqlite::params![KIND, it],
            );
            localized.push(it.clone());
        }
    }
    log_op(conn, "source:delete", "ok", Event {
        module: "skills",
        actor: "local", kind: "", subject: None, outcome: "",
        error_code: None,
        extra: json!({"localized": localized, "purged": purged,
                      "removed_action": removed_action.unwrap_or("keep")}),
        item_version: None, source_id: None,
                item_kind: None,
        item_name: match src.as_ref() { Some(s) => Some(s.0.as_str()), None => None },
        target_id: Some(source_id),
    });
    ok2(json!({"ok": true, "localized": localized, "purged": purged}))
}

/// 把本地缓存里已存在的 HEAD 同步进索引（不联网）。
pub fn sync_from_cache(conn: &Connection, hub: &Path, source_id: i64) -> Result<Value> {
    let src = src_row(conn, source_id);
    let Some((name, url, branch, subdir, last_commit)) = src else {
        return ok_err("源不存在");
    };
    let cache = gitsrc::source_cache_dir(hub, KIND, &url, &branch, &subdir);
    if !cache.join(".git").is_dir() {
        return ok_err("本地还没有该源的缓存（需要先联网拉取一次）");
    }
    let r = gitsrc::run_git(&["rev-parse", "HEAD"], Some(&cache), std::time::Duration::from_secs(20));
    let commit = r.out.trim().to_string();
    if r.code != 0 || commit.is_empty() {
        return ok_err("读取本地缓存提交失败");
    }
    if commit == last_commit.unwrap_or_default() {
        return ok2(json!({"ok": true, "commit": commit, "added": [], "changed": [],
            "removed": [], "unchanged": true, "message": "本地缓存与索引一致，无需同步"}));
    }
    let files = gitsrc::ls_tree(&cache, &commit, &subdir);
    let items = gitsrc::parse_skills(&files, &cache, &commit, &subdir);
    if items.is_empty() {
        return ok_err("本地缓存里没解析到任何 skill");
    }
    let (added, changed, removed) = apply_items(conn, source_id, &items, &commit, &subdir, &files, &cache, "skill");
    log_op(conn, "sync-local", "ok", Event {
        module: "skills",
        actor: "local", kind: "", subject: None, outcome: "",
        error_code: None,
        extra: json!({"commit": commit, "added": added.len(),
                      "changed": changed.len(), "removed": removed.len()}),
        item_version: None, source_id: None,
                item_kind: None, item_name: Some(name.as_str()), target_id: Some(source_id),
    });
    ok2(json!({"ok": true, "commit": commit, "added": added, "changed": changed, "removed": removed}))
}

fn src_row(conn: &Connection, source_id: i64) -> Option<(String, String, String, String, Option<String>)> {
    conn.query_row(
        "SELECT name, url, branch, subdir, last_commit FROM sources WHERE id=?1 AND kind=?2",
        rusqlite::params![source_id, KIND],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )
    .ok()
}

/// items 表差分应用（pull / sync-local 共用后半段）。
fn apply_items(
    conn: &Connection, source_id: i64,
    items: &[gitsrc::SourceItem], commit: &str, _subdir: &str,
    _files: &BTreeMap<String, String>, _cache: &Path, dep_kind: &str,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let old: HashMap<String, Option<String>> = {
        match conn.prepare(
            "SELECT name, source_hash FROM items WHERE source_id=?1") {
        Ok(mut stmt) => stmt.query_map([source_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
        }
    };
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for it in items {
        match old.get(&it.name) {
            None => added.push(it.name.clone()),
            Some(prev) if prev.as_deref() != Some(it.source_hash.as_str()) => {
                changed.push(it.name.clone())
            }
            _ => {}
        }
    }
    for it in items {
        let version = it.version.clone().unwrap_or_else(|| commit.to_string());
        conn.execute(
            "INSERT INTO items(source_id, kind, name, path, source_hash, version, meta) \
             VALUES(?,?,?,?,?,?,?) \
             ON CONFLICT(source_id, name) DO UPDATE SET path=excluded.path, \
             source_hash=excluded.source_hash, version=excluded.version, meta=excluded.meta",
            rusqlite::params![
                source_id, dep_kind, it.name, it.path, it.source_hash, version,
                it.meta.to_string()
            ],
        )
        .map_err(CoreError::from)
        .ok();
    }
    let removed: Vec<String> = old
        .keys()
        .filter(|n| !items.iter().any(|it| &it.name == *n))
        .cloned()
        .collect();
    (added, changed, removed)
}

/// fetch + 解析 + 快照 + 条目差分。
pub fn pull_source(
    conn: &Connection, hub: &Path, source_id: i64,
    _force: bool, removed_action: Option<&str>,
) -> Result<Value> {
    let Some((name, url, branch, subdir, _lc)) = src_row(conn, source_id) else {
        return ok_err("源不存在");
    };
    let cache = gitsrc::source_cache_dir(hub, KIND, &url, &branch, &subdir);
    let (commit, resolved, _warn) = match gitsrc::ensure_cache(&cache, &url, &branch, None) {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.execute(
                "UPDATE sources SET last_error=?1 WHERE id=?2",
                rusqlite::params![e, source_id],
            );
            log_op(conn, "pull", "failed", Event { module: "skills",
                actor: "local", kind: "", subject: None, outcome: "",
                error_code: None, extra: json!({}),
        item_version: None, source_id: None,
                        item_kind: None, item_name: Some(name.as_str()), target_id: Some(source_id),
            });
            return ok_err(&e);
        }
    };
    let files = gitsrc::ls_tree(&cache, &commit, &subdir);
    let items = gitsrc::parse_skills(&files, &cache, &commit, &subdir);
    if items.is_empty() {
        let msg = "源中没有解析到任何 skill（检查目录结构：需含 SKILL.md）";
        let _ = conn.execute(
            "UPDATE sources SET last_error=?1 WHERE id=?2",
            rusqlite::params![msg, source_id],
        );
        return ok_err(msg);
    }
    let (added, changed, removed) = {
        // 先差分（不写库）判断 removed 是否需要 needs_action
        let old: Vec<(String, Option<String>)> = {
            match conn.prepare("SELECT name, source_hash FROM items WHERE source_id=?1") {
            Ok(mut stmt) => stmt.query_map([source_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
            }
        };
        let mut a = Vec::new();
        let mut c = Vec::new();
        for it in &items {
            match old.iter().find(|(n, _)| *n == it.name) {
                None => a.push(it.name.clone()),
                Some((_, h)) if h.as_deref() != Some(it.source_hash.as_str()) => c.push(it.name.clone()),
                _ => {}
            }
        }
        let rm: Vec<String> = old
            .iter()
            .filter(|(n, _)| !items.iter().any(|it| &it.name == n))
            .map(|(n, _)| n.clone())
            .collect();
        (a, c, rm)
    };
    if !removed.is_empty() && removed_action.is_none() {
        let mut detail = Vec::new();
        for nm in &removed {
            let reg: bool = conn
                .query_row(
                    "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2",
                    rusqlite::params![KIND, nm], |_| Ok(true),
                )
                .unwrap_or(false);
            let dep: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM deployments WHERE item_kind='skill' AND item_name=?1 AND status='ok'",
                    rusqlite::params![nm], |r| r.get(0),
                )
                .unwrap_or(0);
            detail.push(json!({"name": nm, "in_registry": reg, "deployed_count": dep}));
        }
        return ok2(json!({"ok": true, "needs_action": true, "commit": commit,
            "added": added, "changed": changed, "removed": removed,
            "removed_detail": detail}));
    }
    let (a2, c2, rm2) = apply_items(conn, source_id, &items, &commit, &subdir, &files, &cache, "skill");
    for nm in &rm2 {
        match removed_action {
            Some("localize") => {
                let _ = conn.execute(
                    "UPDATE registry_items SET source_id=NULL, source_hash_at=NULL \
                     WHERE kind=?1 AND name=?2",
                    rusqlite::params![KIND, nm],
                );
            }
            _ => purge_registry_item(conn, hub, nm),
        }
        let _ = conn.execute("DELETE FROM items WHERE source_id=?1 AND name=?2",
                             rusqlite::params![source_id, nm]);
    }
    conn.execute(
        "INSERT INTO snapshots(source_id, commit_hash, taken_at, item_count, catalog_json) \
         VALUES(?,?,?,?,?)",
        rusqlite::params![source_id, commit, fsutil::now_iso(), items.len(),
            serde_json::to_string(&items).unwrap_or_default()],
    )
    .map_err(CoreError::from)?;
    conn.execute(
        "UPDATE sources SET last_sync_at=?1, last_commit=?2, last_error=NULL, \
         branch=COALESCE(?3, branch) WHERE id=?4",
        rusqlite::params![fsutil::now_iso(), commit, resolved, source_id],
    )
    .map_err(CoreError::from)?;
    log_op(conn, "pull", "ok", Event {
        module: "skills",
        actor: "local", kind: "", subject: None, outcome: "",
        error_code: None,
        extra: json!({"added": a2, "changed": c2, "removed": rm2,
                      "removed_action": removed_action}),
        item_version: None, source_id: None,
                item_kind: None, item_name: Some(name.as_str()), target_id: Some(source_id),
    });
    // 拉取即落库：新增/变更条目自动物化进本地库
    let mut materialized = Vec::new();
    if !a2.is_empty() || !c2.is_empty() {
        let mut names = a2.clone();
        names.extend(c2.clone());
        materialized = update_registry(conn, hub, &names, Some(source_id), false);
    }
    ok2(json!({"ok": true, "commit": commit, "added": a2, "changed": c2, "removed": rm2,
        "removed_action": removed_action, "materialized": materialized}))
}

// ---------- update_registry / materialize ----------

pub fn registry_current_hash(conn: &Connection, hub: &Path, name: &str) -> Option<String> {
    let d = item_dir(conn, hub, name);
    if !d.is_dir() {
        return None;
    }
    fsutil::tree_hash(&d).ok()
}

fn materialize(
    conn: &Connection, hub: &Path, source_id: i64, name: &str, path: &str, commit: &str,
) -> std::result::Result<BTreeMap<String, String>, String> {
    let src = src_row(conn, source_id);
    let Some((_, url, branch, subdir, _)) = src else {
        return Err("源不存在".into());
    };
    let cache = gitsrc::source_cache_dir(hub, KIND, &url, &branch, &subdir);
    let files = gitsrc::ls_tree(&cache, commit, "");
    let prefix = if path == "." || path.is_empty() {
        String::new()
    } else {
        format!("{}/", path.trim_end_matches('/'))
    };
    let dest = registry_root(hub).join(name);
    let tmp = dest.with_file_name(format!(
        "{}.hub-tmp-{}",
        name,
        std::process::id()
    ));
    if tmp.is_dir() {
        let _ = fsutil::safe_rm(&tmp, hub);
    }
    let _ = std::fs::create_dir_all(&tmp);
    let mut written = BTreeMap::new();
    let mut failed_files: Vec<String> = Vec::new();
    let expected = files
        .keys()
        .filter(|rel| prefix.is_empty() || rel.starts_with(&prefix))
        .count();
    for (rel, _blob) in &files {
        if !prefix.is_empty() && !rel.starts_with(&prefix) {
            continue;
        }
        let rel_short = if prefix.is_empty() { rel.as_str() } else { &rel[prefix.len()..] };
        let Some(data) = gitsrc::show_bytes(&cache, commit, rel) else {
            failed_files.push(rel_short.to_string());
            continue;
        };
        let target = tmp.join(rel_short);
        match fsutil::atomic_write_bytes(&target, &data) {
            Ok(()) => {
                written.insert(rel_short.to_string(), fsutil::sha256_bytes(&data));
            }
            Err(e) => failed_files.push(format!("{rel_short}: {e}")),
        }
    }
    // 半装守卫：成功数 < 期望数 → 不换目录、不返回残缺树（否则 registry 记错误
    // hash，之后每次同步都 conflict-local-modified）
    if written.len() < expected {
        let _ = fsutil::safe_rm(&tmp, hub);
        return Err(format!(
            "物化不完整：{}/{} 文件写入成功；失败：{}",
            written.len(),
            expected,
            failed_files.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    if dest.is_dir() {
        let vroot = depot_core::paths::versions_root(hub, KIND, name);
        let _ = std::fs::create_dir_all(&vroot);
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let mut backup = vroot.join(&stamp);
        let mut n = 1;
        while backup.exists() {
            backup = vroot.join(format!("{stamp}-{n}"));
            n += 1;
        }
        let _ = fsutil::rename_dir(&dest, &backup);
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(written)
}

/// 源 → 本地库。逐条结果；本地被改且 force=False → conflict-local-modified。
pub fn update_registry(
    conn: &Connection, hub: &Path, names: &[String],
    source_id: Option<i64>, force: bool,
) -> Vec<Value> {
    let mut results = Vec::new();
    for name in names {
        let row: Option<(i64, String, Option<String>, Option<String>)> = {
            let sql = if source_id.is_some() {
                "SELECT source_id, source_hash, version, path FROM items \
                 WHERE kind=?1 AND name=?2 AND source_id=?3 ORDER BY id DESC LIMIT 1"
            } else {
                "SELECT source_id, source_hash, version, path FROM items \
                 WHERE kind=?1 AND name=?2 ORDER BY id DESC LIMIT 1"
            };
            let r = match source_id {
                Some(sid) => conn.query_row(sql, rusqlite::params![KIND, name, sid], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                }),
                None => conn.query_row(sql, rusqlite::params![KIND, name], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                }),
            };
            r.ok()
        };
        let Some((sid, src_hash, version, path)) = row else {
            results.push(json!({"item": name, "status": "failed", "reason": "源中没有该条目"}));
            continue;
        };
        let reg: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT version, hash, source_hash_at, prev_version FROM registry_items \
                 WHERE kind=?1 AND name=?2",
                rusqlite::params![KIND, name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let commit: Option<String> = conn
            .query_row("SELECT last_commit FROM sources WHERE id=?1", [sid], |r| r.get(0))
            .ok()
            .flatten();
        let Some(commit) = commit else {
            results.push(json!({"item": name, "status": "failed", "reason": "源尚未拉取"}));
            continue;
        };
        let cur_hash = registry_current_hash(conn, hub, name);
        if let Some((_, reg_hash, _, _)) = &reg {
            if cur_hash.is_some() && reg_hash.is_some() && cur_hash != *reg_hash && !force {
                results.push(json!({"item": name, "status": "conflict-local-modified",
                    "reason": "本地库中该技能已被修改（保留本地；可 force 覆盖）"}));
                let _ = events::append(conn, &Event { module: "skills",
                    actor: "local", kind: "update", subject: Some(name),
                    outcome: "conflict", error_code: None,
                    extra: json!({"reason": "local-modified", "source_id": sid}),
        item_version: None, source_id: None,
                            item_kind: Some("skill"), item_name: Some(name), target_id: None,
                });
                continue;
            }
        }
        if let Some((_, reg_hash, src_at, _)) = &reg {
            if src_at.as_deref() == Some(src_hash.as_str()) && cur_hash == *reg_hash {
                let v = reg.as_ref().and_then(|r| r.0.clone());
                results.push(json!({"item": name, "status": "unchanged", "version": v}));
                continue;
            }
        }
        let written = match materialize(conn, hub, sid, name, &path.unwrap_or_default(), &commit) {
            Ok(w) => w,
            Err(e) => {
                results.push(json!({"item": name, "status": "failed",
                    "reason": e.chars().take(200).collect::<String>()}));
                continue;
            }
        };
        let new_hash = fsutil::tree_hash_from_files(&written);
        let (pv, ph) = reg
            .as_ref()
            .map(|r| (r.0.clone(), r.1.clone()))
            .unwrap_or((None, None));
        conn.execute(
            "INSERT INTO registry_items(kind, name, source_id, version, hash, updated_at, \
             prev_version, prev_hash, source_hash_at) VALUES(?,?,?,?,?,?,?,?,?) \
             ON CONFLICT(kind, name) DO UPDATE SET source_id=excluded.source_id, \
             version=excluded.version, hash=excluded.hash, updated_at=excluded.updated_at, \
             prev_version=excluded.prev_version, prev_hash=excluded.prev_hash, \
             source_hash_at=excluded.source_hash_at",
            rusqlite::params![
                KIND, name, sid, version, new_hash, fsutil::now_iso(),
                pv, ph, src_hash
            ],
        )
        .map_err(CoreError::from)
        .ok();
        let status = if reg.is_some() { "updated" } else { "installed" };
        results.push(json!({"item": name, "status": status, "version": version,
            "hash": new_hash[..12.min(new_hash.len())].to_string(),
            "files": written.len()}));
        let _ = events::append(conn, &Event {
            module: "skills",
            actor: "local", kind: "update", subject: Some(name), outcome: "ok",
            error_code: None, extra: json!({"source_id": sid}),
        item_version: None, source_id: None,
                    item_kind: Some("skill"), item_name: Some(name), target_id: None,
        });
    }
    results
}

// ---------- import_local ----------

pub fn import_local(
    conn: &Connection, hub: &Path, src_path: Option<&str>, name: Option<&str>,
    overwrite: bool, dir_id: Option<i64>,
) -> Result<Value> {
    let raw = src_path.unwrap_or("").trim();
    let src = dunce_path(raw);
    if !src.is_dir() {
        return ok_err(&format!("目录不存在：{}", if raw.is_empty() { "（空）" } else { raw }));
    }
    let hub_real = fsutil_canonical(hub);
    if src == hub_real || src.starts_with(&hub_real) {
        return ok_err("不能从 hub 自身目录导入");
    }
    let name = name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        });
    let existing: Option<i64> = if is_manual(conn, &name) {
        conn.query_row(
            "SELECT COALESCE(dir_id,-1) FROM registry_items WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, name], |r| r.get(0),
        )
        .ok()
    } else {
        None
    };
    if existing.is_some() && !overwrite {
        return ok_err(&format!("已存在同名手动条目 {name}；可勾选覆盖更新"));
    }
    let eff_dir = existing.filter(|d| *d >= 0).or(dir_id);
    let root = match dir_root(conn, eff_dir) {
        Ok(r) => r,
        Err(e) => return ok_err(&e),
    };
    if existing.is_none() {
        if let Some(err) = name_conflict(conn, hub, &name, &root) {
            return ok_err(&err);
        }
    }
    // 收集文件（跳 .git/.hub-backup/.versions/node_modules/__pycache__/.DS_Store）
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    collect_files(&src, &src, &mut files);
    if !files.contains_key("SKILL.md") {
        return ok_err("目录中未找到 SKILL.md（导入的条目必须包含）");
    }
    let dest = root.join(&name);
    if existing.is_some() {
        let _ = backup_registry_dir(conn, hub, &name);
        if let Ok(cur) = fsutil::list_files(&dest) {
            for rel in cur.keys() {
                if !files.contains_key(rel) {
                    let _ = std::fs::remove_file(dest.join(rel));
                }
            }
        }
        for (rel, full) in &files {
            if let Ok(data) = std::fs::read(full) {
                let _ = fsutil::atomic_write_bytes(&dest.join(rel), &data);
            }
        }
    } else {
        let tmp = dest.with_file_name(format!("{}.hub-tmp-{}", name, std::process::id()));
        if tmp.is_dir() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        let _ = std::fs::create_dir_all(&tmp);
        for (rel, full) in &files {
            if let Ok(data) = std::fs::read(full) {
                let _ = fsutil::atomic_write_bytes(&tmp.join(rel), &data);
            }
        }
        std::fs::rename(&tmp, &dest).map_err(CoreError::from)?;
    }
    let new_hash = register_manual(conn, hub, &name, Some(&root), eff_dir)?;
    log_op(conn, "import", "ok", Event {
        module: "skills",
        actor: "local", kind: "", subject: None, outcome: "",
        error_code: None,
        extra: json!({"files": files.len(), "from": src.to_string_lossy(),
                      "overwrite": existing.is_some(), "hash": new_hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("skill"), item_name: Some(name.as_str()), target_id: None,
    });
    ok2(json!({"ok": true, "name": name, "files": files.len(),
        "hash": new_hash[..12.min(new_hash.len())].to_string(),
        "overwritten": existing.is_some()}))
}

fn dunce_path(p: &str) -> PathBuf {
    let expanded = if p.starts_with("~") {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(&p[1..].trim_start_matches('/'))
    } else {
        PathBuf::from(p)
    };
    expanded
}

fn fsutil_canonical(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn collect_files(base: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        let full = e.path();
        if full.is_dir() {
            if matches!(name.as_str(), ".git" | ".hub-backup" | ".versions" | "node_modules" | "__pycache__") {
                continue;
            }
            collect_files(base, &full, out);
        } else if name == ".DS_Store" {
            continue;
        } else {
            if let Ok(rel) = full.strip_prefix(base) {
                let rel_s = rel.to_string_lossy().replace('\\', "/");
                if safe_rel_public(&rel_s) {
                    out.insert(rel_s, full);
                }
            }
        }
    }
}

/// 条目内相对路径白名单校验（防穿越/隐藏备份文件）。
pub fn safe_rel_public(rel: &str) -> bool {
    !rel.is_empty()
        && rel.len() <= 200
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.starts_with(".hub"))
}

// ---------- tool_items / extract / sync_to_targets ----------

/// 启用了 skills_dir 的工具（config 表 tools 注册表，无独立表）。
fn skill_tools(conn: &Connection) -> Vec<(String, String, String)> {
    // (id, name, skills_dir)
    depot_core::tools::load_tools(conn)
        .iter()
        .filter(|t| {
            t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
                && t.get("skills_dir").and_then(|s| s.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
        })
        .filter_map(|t| {
            Some((
                t["id"].as_str()?.to_string(),
                t["name"].as_str()?.to_string(),
                t["skills_dir"].as_str()?.to_string(),
            ))
        })
        .collect()
}

pub fn tool_items(conn: &Connection, hub: &Path, tool_id: Option<&str>) -> Value {
    let tools = skill_tools(conn);
    let tools: Vec<_> = tools
        .into_iter()
        .filter(|t| tool_id.map(|id| t.0 == id).unwrap_or(true))
        .collect();
    let reg: HashMap<String, Option<String>> = {
        match conn.prepare("SELECT name, hash FROM registry_items WHERE kind=?1") {
        Ok(mut stmt) => stmt.query_map([KIND], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
        }
    };
    let mut agg: BTreeMap<String, Value> = BTreeMap::new();
    let mut hashed: HashMap<PathBuf, String> = HashMap::new();
    for (id, tname, sdir) in &tools {
        let root = shellexpand_path(sdir);
        if !root.is_dir() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let entry = e.file_name().to_string_lossy().to_string();
            if !e.path().is_dir() || entry.starts_with('.') {
                continue;
            }
            let cur = agg.entry(entry.clone()).or_insert_with(|| {
                json!({"name": entry,
                    "state": if reg.contains_key(&entry) { "synced" } else { "local_only" },
                    "tools": []})
            });
            if !reg.contains_key(&entry) {
                cur["state"] = "local_only".into();
            } else {
                let h = hashed
                    .entry(e.path())
                    .or_insert_with(|| fsutil::tree_hash(&e.path()).unwrap_or_default());
                if reg.get(&entry).cloned().flatten().as_deref() != Some(h.as_str()) {
                    cur["state"] = "diff".into();
                }
            }
            cur["tools"].as_array_mut().unwrap().push(json!({"id": id, "name": tname}));
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

fn shellexpand_path(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(p)
    }
}

pub fn extract(conn: &Connection, hub: &Path, tool_id: &str, names: &[String]) -> Result<Value> {
    let tools: Vec<_> = skill_tools(conn).into_iter().filter(|t| t.0 == tool_id).collect();
    if tools.is_empty() {
        return ok_err("工具不存在、未启用或没有 skills 目录");
    }
    let root = shellexpand_path(&tools[0].2);
    let mut out = Vec::new();
    for raw in names {
        let name = raw.trim().to_string();
        let single = !name.is_empty()
            && name != "." && name != ".."
            && Path::new(&name).file_name().map(|f| f.to_string_lossy() == name).unwrap_or(false);
        let src = if single { root.join(&name) } else { PathBuf::from("/nonexistent") };
        if !src.is_dir() {
            out.push(json!({"name": name, "ok": false, "error": "工具中不存在该条目"}));
            continue;
        }
        // 已登记在本地目录的条目：收编覆盖也写回它所在的目录
        let reg_dir_id: Option<i64> = conn
            .query_row(
                "SELECT dir_id FROM registry_items WHERE kind=?1 AND name=?2 AND source_id IS NULL",
                rusqlite::params![KIND, name], |r| r.get(0),
            )
            .ok()
            .flatten();
        let dest = match reg_dir_id {
            Some(did) if did > 0 => item_dir(conn, hub, &name),
            _ => registry_root(hub).join(&name),
        };
        let existed = dest.is_dir();
        if existed {
            if registry_current_hash(conn, hub, &name).as_deref()
                == fsutil::tree_hash(&src).ok().as_deref()
            {
                out.push(json!({"name": name, "ok": true, "skipped": "已与本地库一致"}));
                continue;
            }
            let _ = backup_registry_dir(conn, hub, &name);
            let hub_real = fsutil_canonical(hub);
            if fsutil_canonical(&dest).starts_with(&hub_real) {
                let _ = fsutil::safe_rm(&dest, hub);
            } else {
                let _ = std::fs::remove_dir_all(&dest);
            }
        }
        fsutil::copy_dir_all(&src, &dest).map_err(CoreError::from)?;
        let n_files = fsutil::list_files(&dest).map(|f| f.len()).unwrap_or(0);
        let _ = register_manual(conn, hub, &name, Some(dest.parent().unwrap_or(Path::new("/"))), reg_dir_id);
        let _ = n_files;
        out.push(json!({"name": name, "ok": true,
            "action": if existed { "覆盖本地库" } else { "已收编" }}));
    }
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "skills.extract", subject: None, outcome: "ok",
        error_code: None, extra: json!({"tool": tool_id, "names": names}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "items": out}))
}

pub fn sync_to_targets(
    conn: &Connection, hub: &Path, tool_id: &str, names: &[String],
    target_ids: &[i64], mode: &str,
) -> Result<Value> {
    let mode = if mode.eq_ignore_ascii_case("link") { "link" } else { "copy" };
    if tool_id.is_empty() {
        return ok_err("tool 必填");
    }
    let names: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    if names.is_empty() || target_ids.is_empty() {
        return ok_err("names 与 target_ids 必填");
    }
    let own: BTreeSet<i64> = {
        match conn.prepare(
            "SELECT id FROM targets WHERE kind='skills_dir' AND tool=?1") {
        Ok(mut stmt) => stmt.query_map([tool_id], |r| r.get::<_, i64>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => BTreeSet::new(),
        }
    };
    let valid: BTreeSet<i64> = {
        match conn.prepare("SELECT id FROM targets WHERE kind='skills_dir'") {
        Ok(mut stmt) => stmt.query_map([], |r| r.get::<_, i64>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => BTreeSet::new(),
        }
    };
    let tids: Vec<i64> = target_ids
        .iter()
        .filter(|t| valid.contains(t) && !own.contains(t))
        .cloned()
        .collect();
    if tids.is_empty() {
        return ok_err("没有可用的目标工具（源工具自身不作为目标）");
    }
    let ex = extract(conn, hub, tool_id, &names)?;
    if ex["ok"].as_bool() != Some(true) {
        return Ok(ex);
    }
    let outgoing: Vec<String> = ex["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|x| x["ok"].as_bool() == Some(true))
                .filter_map(|x| x["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let results = if outgoing.is_empty() {
        vec![]
    } else {
        crate::distribute_skills(conn, hub, &outgoing, &tids, false, true, mode, "local")?
    };
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "tool-sync", subject: None, outcome: "ok",
        error_code: None,
        extra: json!({"tool": tool_id, "names": outgoing, "target_ids": tids, "mode": mode}),
        item_version: None, source_id: None,
                item_kind: Some("skill"), item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "extracted": ex["items"], "results": results}))
}

// ---------- bindings：视图 + 变更 + 清理 ----------

pub fn list_dir_bindings(conn: &Connection, dir_id: Option<i64>) -> Vec<Value> {
    let sql = if dir_id.is_some() {
        "SELECT b.*, d.name AS dir_name, d.path AS dir_path, \
         t.name AS target_name, t.path AS target_path, t.tool AS tool, t.kind AS target_kind \
         FROM dir_bindings b JOIN local_dirs d ON d.id=b.dir_id JOIN targets t ON t.id=b.target_id \
         WHERE b.dir_id=?1 ORDER BY b.id"
    } else {
        "SELECT b.*, d.name AS dir_name, d.path AS dir_path, \
         t.name AS target_name, t.path AS target_path, t.tool AS tool, t.kind AS target_kind \
         FROM dir_bindings b JOIN local_dirs d ON d.id=b.dir_id JOIN targets t ON t.id=b.target_id \
         ORDER BY b.id"
    };
    let mut stmt = match conn.prepare(sql) { Ok(t) => t, Err(_) => return vec![] };
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
        Ok(json!({
            "id": r.get::<_, i64>(0)?, "dir_id": r.get::<_, i64>(1)?,
            "target_id": r.get::<_, i64>(2)?, "mode": r.get::<_, String>(3)?,
            "enabled": r.get::<_, i64>(4)? == 1,
            "created_at": r.get::<_, String>(5)?,
            "last_sync_at": r.get::<_, Option<String>>(6)?,
            "last_result": r.get::<_, Option<String>>(7)?,
            "channels": r.get::<_, String>(8)?,
            "excluded": r.get::<_, String>(9)?,
            "dir_name": r.get::<_, String>(10)?,
            "dir_path": r.get::<_, String>(11)?,
            "target_name": r.get::<_, String>(12)?,
            "target_path": r.get::<_, String>(13)?,
            "tool": r.get::<_, Option<String>>(14)?,
            "target_kind": r.get::<_, String>(15)?,
        }))
    };
    let rows: Vec<Value> = match dir_id {
        Some(d) => stmt.query_map([d], map).map(|x| x.filter_map(|r| r.ok()).collect()).unwrap_or_default(),
        None => stmt.query_map([], map).map(|x| x.filter_map(|r| r.ok()).collect()).unwrap_or_default(),
    };
    rows.into_iter()
        .map(|mut r| {
            r["channels"] = json!(r["channels"]
                .as_str()
                .unwrap_or("skills")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>());
            r["excluded"] = serde_json::from_str::<Value>(r["excluded"].as_str().unwrap_or("[]"))
                .unwrap_or(json!([]));
            r["last_result"] = r["last_result"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null);
            r
        })
        .collect()
}

fn channels_of(kind: &str) -> &'static str {
    if kind.starts_with("mcp_") { "mcp" } else { "skills" }
}

fn agg_distribute(results: &[Value]) -> Value {
    let mut agg = json!({"added": 0, "updated": 0, "skipped": 0, "conflicts": 0, "failed": 0});
    for r in results {
        match r["status"].as_str() {
            Some("ok") => {
                let key = matches!(r["action"].as_str(), Some("create") | Some("adopt") | Some("recreate"));
                let k = if key { "added" } else { "updated" };
                agg[k] = json!(agg[k].as_i64().unwrap_or(0) + 1);
            }
            Some("skipped") => agg["skipped"] = json!(agg["skipped"].as_i64().unwrap_or(0) + 1),
            Some("conflict") => agg["conflicts"] = json!(agg["conflicts"].as_i64().unwrap_or(0) + 1),
            _ => agg["failed"] = json!(agg["failed"].as_i64().unwrap_or(0) + 1),
        }
    }
    agg
}

/// 给本轮分发产生的部署记录打上绑定标记（removed 反向清理只认自己落过的）。
fn tag_binding_deployments(conn: &Connection, target_id: i64, names: &[String], binding_id: i64, item_kind: &str) {
    for name in names {
        let rows: Vec<i64> = {
            let mut stmt = match conn.prepare(
                "SELECT id, detail FROM deployments WHERE item_kind=?1 AND target_id=?2 \
                 AND item_name=?3 AND status='ok'") { Ok(t) => t, Err(_) => continue };
            stmt.query_map(rusqlite::params![item_kind, target_id, name], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map(|rs| rs.filter_map(|r| r.ok()).map(|(id, _)| id).collect())
            .unwrap_or_default()
        };
        for id in rows {
            let detail_raw: Option<String> = conn
                .query_row("SELECT detail FROM deployments WHERE id=?1", [id], |r| r.get(0))
                .ok()
                .flatten();
            let mut detail: Value = detail_raw
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(json!({}));
            if detail.get("binding").and_then(|b| b.as_i64()) == Some(binding_id) {
                continue;
            }
            detail["binding"] = json!(binding_id);
            let _ = conn.execute(
                "UPDATE deployments SET detail=?1 WHERE id=?2",
                rusqlite::params![detail.to_string(), id],
            );
        }
    }
}

/// 把本绑定写进目标配置的一个 mcp 条目摘掉（json / toml 两种）。
fn remove_mcp_deployment(dep: &Value, target: &Value) -> bool {
    let path = shellexpand_path(target["path"].as_str().unwrap_or(""));
    let detail: Value = dep
        .get("detail")
        .and_then(|d| d.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!({}));
    let name = dep["item_name"].as_str().unwrap_or("");
    if target["kind"].as_str() == Some("mcp_json") {
        let data = fsutil::read_json(&path);
        let Some(mut data) = data.filter(|d| d.is_object()) else { return false };
        let fmt_key = detail
            .get("format_key")
            .and_then(|f| f.as_str())
            .unwrap_or("mcpServers")
            .to_string();
        let section = get_section_mut(&mut data, &fmt_key);
        if section.get(name).is_none() {
            return false;
        }
        if let Some(injected) = detail.get("injected") {
            if section.get(name) != Some(injected) {
                return false; // 用户改过这份配置，不碰
            }
        }
        if let Some(o) = section.as_object_mut() {
            o.remove(name);
        }
        write_json_atomic(&path, &data).is_ok()
    } else {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        match depot_mcp_block_find(&text, name) {
            Some((s, e)) => fsutil::atomic_write_text(&path, format!("{}{}", &text[..s], &text[e..]).as_str()).is_ok(),
            None => false,
        }
    }
}

/// 嵌套取 section（途中层非 dict → 静默替换）。
fn get_section_mut<'a>(data: &'a mut Value, key_path: &str) -> &'a mut Value {
    let mut cur = data;
    for part in key_path.split('.') {
        if !cur.get(part).map(|v| v.is_object()).unwrap_or(false) {
            if let Some(o) = cur.as_object_mut() {
                o.insert(part.to_string(), json!({}));
            }
        }
        let idx = cur.as_object_mut().unwrap();
        cur = idx.get_mut(part).unwrap();
    }
    cur
}

fn write_json_atomic(path: &Path, v: &Value) -> Result<()> {
    let mut text = serde_json::to_string_pretty(v).unwrap_or_default();
    text.push('\n');
    fsutil::atomic_write_text(path, &text)
}

/// TOML 管理块定位（`# >>> hub:managed: <name> >>>` … `# <<< hub:managed: <name> <<<`）。
fn depot_mcp_block_find(text: &str, name: &str) -> Option<(usize, usize)> {
    let begin = format!("# >>> hub:managed: {name} >>>");
    let end = format!("# <<< hub:managed: {name} <<<");
    let s = text.find(&begin)?;
    let e = text.find(&end)? + end.len();
    Some((s, e))
}

/// 目录里消失的条目：按托管清单反向清理（skill 删文件，mcp 从目标配置摘条目）。
fn cleanup_removed_for_binding(conn: &Connection, hub: &Path, b: &Value, current_names: &[String]) -> Vec<String> {
    let target_id = b["target_id"].as_i64().unwrap_or(0);
    let trow: Option<Value> = target_row(conn, target_id);
    let kind = if trow
        .as_ref()
        .and_then(|t| t["kind"].as_str())
        .map(|k| k.starts_with("mcp_"))
        .unwrap_or(false)
    {
        "mcp"
    } else {
        "skill"
    };
    let deps: Vec<Value> = {
        let mut stmt = match conn.prepare(
            "SELECT id, item_name, detail FROM deployments \
             WHERE item_kind=?1 AND target_id=?2 AND status='ok'") { Ok(t) => t, Err(_) => return vec![] };
        stmt.query_map(rusqlite::params![kind, target_id], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?,
                "item_name": r.get::<_, String>(1)?,
                "detail": r.get::<_, Option<String>>(2)?}))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    };
    let mut removed = Vec::new();
    for dep in &deps {
        let name = dep["item_name"].as_str().unwrap_or("");
        if current_names.contains(&name.to_string()) {
            continue;
        }
        let detail: Value = dep
            .get("detail")
            .and_then(|d| d.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(json!({}));
        if detail.get("binding").and_then(|x| x.as_i64()) != b["id"].as_i64() {
            continue; // 不是本绑定落的内容，一个不碰
        }
        if kind == "mcp" {
            if let Some(t) = &trow {
                if remove_mcp_deployment(dep, t) {
                    let _ = conn.execute(
                        "UPDATE deployments SET status='removed' WHERE id=?1",
                        [dep["id"].as_i64().unwrap_or(0)],
                    );
                    removed.push(name.to_string());
                }
            }
            continue;
        }
        if let Some(t) = &trow {
            let base = Path::new(t["path"].as_str().unwrap_or("")).join(name);
            if base.is_dir() {
                for rel in detail.get("files").and_then(|f| f.as_object()).into_iter().flatten() {
                    let p = base.join(rel.0);
                    if p.is_file() {
                        let _ = std::fs::remove_file(&p);
                    }
                }
                let backup_dir = base.join(".hub-backup");
                if backup_dir.is_dir() {
                    let _ = std::fs::remove_dir_all(&backup_dir);
                }
                prune_empty_dirs(&base);
                if base.is_dir() && std::fs::read_dir(&base).map(|rd| rd.count()).unwrap_or(1) == 0 {
                    let _ = std::fs::remove_dir_all(&base);
                }
            }
        }
        let _ = conn.execute(
            "UPDATE deployments SET status='removed' WHERE id=?1",
            [dep["id"].as_i64().unwrap_or(0)],
        );
        removed.push(name.to_string());
        let _ = events::append(conn, &Event {
            module: "skills",
            actor: "local", kind: "binding:sync", subject: None, outcome: "ok",
            error_code: None,
            extra: json!({"removed": true, "binding": b["id"]}),
        item_version: None, source_id: None,
                    item_kind: Some("skill"), item_name: Some(name), target_id: Some(target_id),
        });
    }
    let _ = hub;
    removed
}

fn prune_empty_dirs(base: &Path) {
    let Ok(rd) = std::fs::read_dir(base) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        if e.path().is_dir() {
            prune_empty_dirs(&e.path());
            if std::fs::read_dir(&e.path()).map(|d| d.count()).unwrap_or(1) == 0 {
                let _ = std::fs::remove_dir(&e.path());
            }
        }
    }
}

fn target_row(conn: &Connection, tid: i64) -> Option<Value> {
    conn.query_row(
        "SELECT id, name, kind, tool, path, COALESCE(format_key,'') FROM targets WHERE id=?1",
        [tid],
        |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?, "tool": r.get::<_, Option<String>>(3)?,
                "path": r.get::<_, String>(4)?, "format_key": r.get::<_, String>(5)?}))
        },
    )
    .ok()
}

/// 执行一个绑定的同步：按通道分发（skills / mcp）+ 反向清理 + 记录结果。
pub fn sync_binding_full(conn: &Connection, hub: &Path, b: &Value, force: bool) -> Value {
    let binding_id = b["id"].as_i64().unwrap_or(0);
    let dir_id = b["dir_id"].as_i64().unwrap_or(0);
    let target_id = b["target_id"].as_i64().unwrap_or(0);
    // excluded 是 JSON 字符串列：解析失败 = 数据损坏，拒绝同步（空集会让用户
    // 明确排除的条目被强制分发——越权写入）
    let excluded: BTreeSet<String> = match b["excluded"] {
        Value::String(ref raw) => match serde_json::from_str::<Vec<String>>(raw) {
            Ok(list) => list.into_iter().collect(),
            Err(e) => {
                let _ = events::append(conn, &Event { module: MODULE,
                    actor: "local", kind: "binding:sync", subject: None,
                    outcome: "failed", error_code: None,
                    extra: json!({"binding": binding_id,
                        "reason": format!("excluded 数据损坏：{e}")}),
                    item_version: None, source_id: None,
                    item_kind: None, item_name: None, target_id: None,
                });
                return json!({"added": 0, "updated": 0, "skipped": 0, "conflicts": 0,
                    "failed": 1, "removed": 0,
                    "error": format!("excluded 数据损坏：{e}")});
            }
        },
        ref v @ Value::Array(_) => v.as_array().unwrap()
            .iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        _ => BTreeSet::new(),
    };
    let tkind = target_row(conn, target_id)
        .and_then(|t| t["kind"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "skills_dir".into());
    let all_names: Vec<String>;
    let mut agg: Value;
    if tkind.starts_with("mcp_") {
        all_names = crate::dir_item_names_mcp(conn, dir_id);
        let send: Vec<String> = all_names.iter().filter(|n| !excluded.contains(n.as_str())).cloned().collect();
        let results = depot_mcp_distribute(conn, &send, &[target_id], false, force);
        agg = agg_distribute(&results);
        tag_binding_deployments(conn, target_id, &send, binding_id, "mcp");
    } else {
        all_names = crate::dir_item_names(conn, dir_id, KIND);
        let send: Vec<String> = all_names.iter().filter(|n| !excluded.contains(n.as_str())).cloned().collect();
        let mode = b["mode"].as_str().unwrap_or("copy");
        let results = crate::distribute_skills(conn, hub, &send, &[target_id], false, force, mode, "local")
            .unwrap_or_default();
        agg = agg_distribute(&results);
        tag_binding_deployments(conn, target_id, &send, binding_id, "skill");
    }
    agg["excluded"] = json!(all_names.iter().filter(|n| excluded.contains(n.as_str())).count());
    let mut keep = all_names.clone();
    keep.extend(excluded.iter().cloned());
    let removed = cleanup_removed_for_binding(conn, hub, b, &keep);
    agg["removed"] = json!(removed.len());
    let _ = conn.execute(
        "UPDATE dir_bindings SET last_sync_at=?1, last_result=?2 WHERE id=?3",
        rusqlite::params![fsutil::now_iso(), agg.to_string(), binding_id],
    );
    let failed = agg["failed"].as_i64().unwrap_or(0);
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "binding:sync", subject: None,
        outcome: if failed > 0 { "failed" } else { "ok" },
        error_code: None,
        extra: {
            let mut e = agg.clone();
            e["binding"] = json!(binding_id);
            e
        },
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: Some(target_id),
    });
    agg
}

/// depot-mcp::distribute_mcp 转发（运行时注入，避免 crate 间环）。
/// SAFETY：OnceLock 单次写入；仅在 router 构建期 set、请求期只读——
/// 未注入时记录 error 日志并返回空结果（不做静默假成功之外的事）。
static MCP_DISTRIBUTE: std::sync::OnceLock<
    fn(&Connection, &[String], &[i64], bool, bool) -> Vec<Value>,
> = std::sync::OnceLock::new();

pub fn set_mcp_distribute(f: fn(&Connection, &[String], &[i64], bool, bool) -> Vec<Value>) {
    let _ = MCP_DISTRIBUTE.set(f);
}

fn depot_mcp_distribute(conn: &Connection, names: &[String], tids: &[i64], dry: bool, force: bool) -> Vec<Value> {
    match MCP_DISTRIBUTE.get() {
        Some(f) => f(conn, names, tids, dry, force),
        None => {
            tracing::error!("MCP 分发函数未注入（router 未初始化？）：mcp 通道绑定同步跳过");
            vec![]
        }
    }
}

pub fn bind_dirs_full(conn: &Connection, hub: &Path, dir_id: i64, target_ids: &[i64],
                      mode: &str, force: bool) -> Result<Value> {
    let dpath: Option<(String, String)> = conn
        .query_row("SELECT name, path FROM local_dirs WHERE id=?1", [dir_id],
            |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let Some((dname, _dpath)) = dpath else { return ok_err("本地目录不存在") };
    let mode = if mode.eq_ignore_ascii_case("link") { "link" } else { "copy" };
    let mut out: Vec<Value> = Vec::new();
    for tid in target_ids {
        let Some(t) = target_row(conn, *tid) else {
            out.push(json!({"ok": false, "error": format!("目标不存在（{tid}）")}));
            continue;
        };
        let channel = channels_of(t["kind"].as_str().unwrap_or("skills_dir"));
        let path_key = if channel == "mcp" { "mcp_config" } else { "skills_dir" };
        if !target_visible(conn, t["tool"].as_str(), path_key) {
            out.push(json!({"ok": false, "target": t["name"], "error": "工具已停用或目标不可见"}));
            continue;
        }
        let dup: bool = conn
            .query_row(
                "SELECT 1 FROM dir_bindings WHERE dir_id=?1 AND target_id=?2",
                rusqlite::params![dir_id, tid], |_| Ok(true),
            )
            .unwrap_or(false);
        if dup {
            out.push(json!({"ok": false, "target": t["name"], "error": "已建立连接"}));
            continue;
        }
        conn.execute(
            "INSERT INTO dir_bindings(dir_id, target_id, mode, channels, created_at) \
             VALUES(?,?,?,?,?)",
            rusqlite::params![dir_id, tid, mode, channel, fsutil::now_iso()],
        )
        .map_err(CoreError::from)?;
        let bid = conn.last_insert_rowid();
        let b = json!({"id": bid, "dir_id": dir_id, "target_id": tid, "mode": mode,
            "channels": channel, "excluded": "[]",
            "dir_name": dname, "target_name": t["name"]});
        let agg = sync_binding_full(conn, hub, &b, force);
        let count = if channel == "mcp" {
            crate::dir_item_names_mcp(conn, dir_id).len()
        } else {
            crate::dir_item_names(conn, dir_id, KIND).len()
        };
        let mut entry = agg.clone();
        entry["ok"] = json!(agg["failed"].as_i64().unwrap_or(0) == 0);
        entry["binding_id"] = json!(bid);
        entry["target"] = t["name"].clone();
        entry["tool"] = t["tool"].clone();
        entry["channel"] = json!(channel);
        entry[channel] = json!(count);
        out.push(entry);
        let _ = events::append(conn, &Event {
            module: "skills",
            actor: "local", kind: "binding:bind", subject: None, outcome: "ok",
            error_code: None,
            extra: json!({"binding": bid, "dir": dname, "target": t["name"],
                          "mode": mode, "channel": channel, "items": count}),
        item_version: None, source_id: None,
                    item_kind: None, item_name: None, target_id: Some(*tid),
        });
    }
    let all_ok = !out.is_empty() && out.iter().all(|x| x["ok"].as_bool() == Some(true));
    Ok(json!({"ok": all_ok, "results": out}))
}

/// 分发目标是否应展示（工具停用或对应路径为空 → 隐藏）。
pub fn target_visible(conn: &Connection, tool_id: Option<&str>, path_key: &str) -> bool {
    let Some(tid) = tool_id else { return true };
    if tid == "plain" || tid.is_empty() {
        return true;
    }
    let t = depot_core::tools::tool_by_id(conn, tid);
    let Some(t) = t else { return false };
    if t.get("enabled").and_then(|e| e.as_bool()) != Some(true) {
        return false;
    }
    t.get(path_key).and_then(|p| p.as_str()).map(|p| !p.is_empty()).unwrap_or(false)
}

pub fn set_binding_enabled(conn: &Connection, binding_id: i64, enabled: bool) -> Result<Value> {
    let ok: bool = conn
        .query_row("SELECT 1 FROM dir_bindings WHERE id=?1", [binding_id], |_| Ok(true))
        .unwrap_or(false);
    if !ok {
        return ok_err("绑定不存在");
    }
    conn.execute(
        "UPDATE dir_bindings SET enabled=?1 WHERE id=?2",
        rusqlite::params![if enabled { 1 } else { 0 }, binding_id],
    )
    .map_err(CoreError::from)?;
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: if enabled { "binding:resume" } else { "binding:pause" },
        subject: None, outcome: "ok", error_code: None,
        extra: json!({"binding": binding_id}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "enabled": enabled}))
}

pub fn set_binding_excluded(conn: &Connection, hub: &Path, binding_id: i64, excluded: &Value) -> Result<Value> {
    let names: Vec<String> = match excluded {
        Value::String(s) => s.split(',').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        _ => vec![],
    };
    let mut names = names;
    names.sort();
    names.dedup();
    let row: Option<Value> = binding_row(conn, binding_id);
    let Some(mut b) = row else { return ok_err("绑定不存在") };
    conn.execute(
        "UPDATE dir_bindings SET excluded=?1 WHERE id=?2",
        rusqlite::params![serde_json::to_string(&names).unwrap_or_default(), binding_id],
    )
    .map_err(CoreError::from)?;
    b["excluded"] = json!(names);
    let agg = sync_binding_full(conn, hub, &b, false);
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "binding:excluded", subject: None, outcome: "ok",
        error_code: None, extra: json!({"binding": binding_id, "excluded": names}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "excluded": names, "sync": agg}))
}

pub fn set_binding_channels(conn: &Connection, hub: &Path, binding_id: i64, channels: &Value) -> Result<Value> {
    let list: Vec<String> = match channels {
        Value::String(s) => s.split(',').map(|x| x.trim().to_string()).collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        _ => vec![],
    };
    let wanted: Vec<&str> = ["skills", "mcp"].iter().filter(|c| list.contains(&c.to_string())).cloned().collect();
    if wanted.is_empty() {
        return ok_err("至少要保留一个通道");
    }
    let row: Option<(Value, String)> = conn
        .query_row(
            "SELECT b.id, t.kind FROM dir_bindings b JOIN targets t ON t.id=b.target_id WHERE b.id=?1",
            [binding_id],
            |r| {
                Ok((
                    json!({"id": r.get::<_, i64>(0)?}),
                    r.get::<_, String>(1)?,
                ))
            },
        )
        .ok();
    let Some((mut b, tkind)) = row else { return ok_err("绑定不存在") };
    let cap = channels_of(&tkind);
    if !wanted.contains(&cap) {
        return ok_err(&format!("该目标的通道是 {cap}，不能只留 {wanted:?}"));
    }
    conn.execute(
        "UPDATE dir_bindings SET channels=?1 WHERE id=?2",
        rusqlite::params![wanted.join(","), binding_id],
    )
    .map_err(CoreError::from)?;
    b["channels"] = json!(wanted.join(","));
    let agg = sync_binding_full(conn, hub, &b, false);
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "binding:channels", subject: None, outcome: "ok",
        error_code: None, extra: json!({"binding": binding_id, "channels": wanted}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "channels": wanted, "sync": agg}))
}

fn binding_row(conn: &Connection, binding_id: i64) -> Option<Value> {
    conn.query_row(
        "SELECT b.id, b.dir_id, b.target_id, b.mode, b.channels, b.excluded, \
         d.name AS dir_name, t.name AS target_name \
         FROM dir_bindings b JOIN local_dirs d ON d.id=b.dir_id JOIN targets t ON t.id=b.target_id \
         WHERE b.id=?1",
        [binding_id],
        |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "dir_id": r.get::<_, i64>(1)?,
                "target_id": r.get::<_, i64>(2)?, "mode": r.get::<_, String>(3)?,
                "channels": r.get::<_, String>(4)?, "excluded": r.get::<_, String>(5)?,
                "dir_name": r.get::<_, String>(6)?, "target_name": r.get::<_, String>(7)?}))
        },
    )
    .ok()
}

pub fn unbind(conn: &Connection, hub: &Path, binding_id: i64, clean: bool) -> Result<Value> {
    let Some(b) = binding_row(conn, binding_id) else { return ok_err("绑定不存在") };
    let cleaned = if clean {
        let mut bb = b.clone();
        bb["excluded"] = json!([]);
        cleanup_removed_for_binding(conn, hub, &bb, &[])
    } else {
        vec![]
    };
    conn.execute("DELETE FROM dir_bindings WHERE id=?1", [binding_id])
        .map_err(CoreError::from)?;
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "binding:unlink", subject: None, outcome: "ok",
        error_code: None,
        extra: json!({"binding": binding_id, "dir": b["dir_name"],
                      "target": b["target_name"], "cleaned": cleaned.len(),
                      "files_kept": !clean}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: None,
    });
    ok2(json!({"ok": true, "cleaned": cleaned.len(), "files_kept": !clean}))
}

/// 某目录内容变化后的绑定跟随。
pub fn sync_dir_bindings(conn: &Connection, hub: &Path, dir_id: i64, force: bool) -> Vec<Value> {
    let mut out = Vec::new();
    for b in list_dir_bindings(conn, Some(dir_id)) {
        if b["enabled"].as_bool() != Some(true) {
            continue;
        }
        let agg = sync_binding_full(conn, hub, &b, force);
        let mut row = serde_json::Map::new();
        row.insert("binding_id".into(), b["id"].clone());
        row.insert("target".into(), b["target_name"].clone());
        for (k, v) in agg_object(&agg) { row.insert(k, v); }
        out.push(Value::Object(row));
    }
    out
}

fn agg_object(v: &Value) -> serde_json::Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// 全部目录：扫描（拾取外部变化）→ 绑定跟随。
pub fn sync_all_bindings(conn: &Connection, hub: &Path) -> Vec<Value> {
    let mut summary = Vec::new();
    let dirs: Vec<(i64, String)> = {
        match conn.prepare("SELECT id, path FROM local_dirs ORDER BY id") {
        Ok(mut stmt) => stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
        }
    };
    for (did, dpath) in dirs {
        let p = PathBuf::from(&dpath);
        if !p.is_dir() {
            continue; // 目录消失/无权限：不影响其余目录
        }
        let _ = crate::scan_sync(conn, hub, did, &dir_name(conn, did), &p);
        for r in sync_dir_bindings(conn, hub, did, false) {
            summary.push(r);
        }
    }
    summary
}

fn dir_name(conn: &Connection, did: i64) -> String {
    conn.query_row("SELECT name FROM local_dirs WHERE id=?1", [did], |r| r.get(0))
        .unwrap_or_default()
}

// ---------- targets：delete / seed ----------

pub fn delete_target(conn: &Connection, target_id: i64, force: bool) -> Result<Value> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deployments WHERE target_id=?1 AND status='ok'",
            [target_id], |r| r.get(0),
        )
        .unwrap_or(0);
    if n > 0 && !force {
        return ok_err(&format!("目标上仍有 {n} 条部署记录；用 force 或先清理"));
    }
    conn.execute("DELETE FROM deployments WHERE target_id=?1", [target_id])
        .map_err(CoreError::from)?;
    conn.execute("DELETE FROM targets WHERE id=?1", [target_id])
        .map_err(CoreError::from)?;
    let _ = events::append(conn, &Event {
        module: "skills",
        actor: "local", kind: "target:delete", subject: None, outcome: "ok",
        error_code: None, extra: json!({}),
        item_version: None, source_id: None,
                item_kind: None, item_name: None, target_id: Some(target_id),
    });
    ok2(json!({"ok": true}))
}

pub fn seed_defaults(conn: &Connection) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let defaults: Vec<(&str, &str, &str, String)> = vec![
        ("Claude Skills (全局)", "skills_dir", "claude", format!("{home}/.claude/skills")),
        ("Agents (全局)", "skills_dir", "agents", format!("{home}/.agents/skills")),
        ("WorkBuddy Skills (全局)", "skills_dir", "workbuddy", format!("{home}/.workbuddy/skills")),
        ("ZCode Skills (全局)", "skills_dir", "zcode", format!("{home}/.zcode/skills")),
        ("AutoClaw Skills (全局)", "skills_dir", "autoclaw", format!("{home}/.openclaw-autoclaw/skills")),
    ];
    let mut created = Vec::new();
    for (nm, kind, tool, path) in defaults {
        let p = Path::new(&path);
        if !p.is_dir() && !p.parent().map(|x| x.is_dir()).unwrap_or(false) {
            continue;
        }
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO targets(name, kind, tool, path, format_key, created_at) \
                 VALUES(?,?,?,?,NULL,?)",
                rusqlite::params![nm, kind, tool, path, fsutil::now_iso()],
            )
            .unwrap_or(0);
        if n > 0 {
            created.push(nm.to_string());
        }
    }
    if !created.is_empty() {
        let _ = events::append(conn, &Event {
            module: "skills",
            actor: "local", kind: "targets:seed", subject: None, outcome: "ok",
            error_code: None, extra: json!({"created": created}),
        item_version: None, source_id: None,
                    item_kind: None, item_name: None, target_id: None,
        });
    }
    created
}

// ---------- views ----------

fn item_status(conn: &Connection, hub: &Path, name: &str, reg: Option<&Value>, src_hash: Option<&str>, src_at: Option<&str>) -> String {
    let Some(reg) = reg else { return "not-installed".into() };
    let cur = registry_current_hash(conn, hub, name);
    if cur.is_some() && reg["hash"].is_string() && !reg["hash"].as_str().unwrap_or("").is_empty()
        && cur.as_deref() != reg["hash"].as_str()
    {
        return "local-modified".into();
    }
    if src_hash.is_some() && src_at.is_some() && src_hash != src_at {
        return "update-available".into();
    }
    "installed".into()
}

pub fn catalog_view(conn: &Connection, hub: &Path, source_id: Option<i64>) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    if source_id.is_none() {
        let mut stmt = match conn.prepare(
            "SELECT r.name, r.version, r.dir_id, d.name FROM registry_items r \
             LEFT JOIN local_dirs d ON d.id=r.dir_id \
             WHERE r.kind=?1 AND r.source_id IS NULL ORDER BY r.name") { Ok(t) => t, Err(_) => return vec![] };
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
    let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match source_id {
        Some(sid) => (
            "SELECT i.name, i.version, i.source_id, i.source_hash, i.meta, i.path, s.name \
             FROM items i JOIN sources s ON s.id=i.source_id \
             WHERE i.kind=?1 AND i.source_id=?2 ORDER BY i.name",
            vec![Box::new(KIND), Box::new(sid)],
        ),
        None => (
            "SELECT i.name, i.version, i.source_id, i.source_hash, i.meta, i.path, s.name \
             FROM items i JOIN sources s ON s.id=i.source_id \
             WHERE i.kind=?1 ORDER BY i.name",
            vec![Box::new(KIND)],
        ),
    };
    let mut stmt = match conn.prepare(sql) { Ok(t) => t, Err(_) => return vec![] };
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
                "source_name": r.get::<_, String>(6)?,
            }))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    items.extend(rows);
    let regs: HashMap<String, Value> = {
        match conn.prepare(
            "SELECT name, version, hash, source_hash_at, dir_id FROM registry_items WHERE kind=?1") {
        Ok(mut stmt) => stmt.query_map([KIND], |r| {
            Ok((
                r.get::<_, String>(0)?,
                json!({"version": r.get::<_, Option<String>>(1)?,
                    "hash": r.get::<_, Option<String>>(2)?,
                    "source_hash_at": r.get::<_, Option<String>>(3)?,
                    "dir_id": r.get::<_, Option<i64>>(4)?}),
            ))
        })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
        }
    };
    let dirs = item_dirs_map(conn, hub);
    let mut out = Vec::new();
    for it in &items {
        let name = it["name"].as_str().unwrap_or("");
        let manual = it["source_name"] == "本地" || it["path"].is_null();
        let reg = regs.get(name);
        let st = if manual && reg.is_some() {
            "installed".to_string()
        } else if manual {
            "not-installed".to_string()
        } else {
            item_status(
                conn, hub, name,
                reg,
                it["source_hash"].as_str(),
                reg.and_then(|r| r["source_hash_at"].as_str()),
            )
        };
        let desc = if it["meta"].is_string() {
            it["meta"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|m| m.get("description").and_then(|d| d.as_str()).map(|s| s.to_string()))
                .unwrap_or_default()
        } else if manual {
            let d = dirs.get(name).cloned().unwrap_or_else(|| item_dir(conn, hub, name));
            fm_desc(&d.join("SKILL.md"))
        } else {
            String::new()
        };
        out.push(json!({
            "name": name,
            "version": it["version"],
            "source_name": if it["source_name"].is_null() {
                json!(if manual { "本地" } else { "" })
            } else { it["source_name"].clone() },
            "source_id": if manual { Value::Null } else { it["source_id"].clone() },
            "manual": manual,
            "dir_id": it["dir_id"],
            "dir_name": it["dir_name"],
            "description": desc,
            "status": st,
            "local_version": reg.map(|r| r["version"].clone()).unwrap_or(Value::Null),
        }));
    }
    out
}

pub fn registry_view(conn: &Connection, hub: &Path) -> Vec<Value> {
    let mut stmt = match conn.prepare(
        "SELECT name, version, hash, updated_at, source_id, dir_id FROM registry_items \
         WHERE kind=?1 ORDER BY name") { Ok(t) => t, Err(_) => return vec![] };
    let regs: Vec<Value> = stmt
        .query_map([KIND], |r| {
            Ok(json!({"name": r.get::<_, String>(0)?,
                "version": r.get::<_, Option<String>>(1)?,
                "hash": r.get::<_, Option<String>>(2)?,
                "updated_at": r.get::<_, Option<String>>(3)?,
                "source_id": r.get::<_, Option<i64>>(4)?,
                "dir_id": r.get::<_, Option<i64>>(5)?}))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let mut dstmt = match conn.prepare(
        "SELECT d.item_name, d.target_id, d.deployed_hash, t.name FROM deployments d \
         LEFT JOIN targets t ON t.id=d.target_id \
         WHERE d.item_kind='skill' AND d.status='ok'") { Ok(t) => t, Err(_) => return vec![] };
    let deps: Vec<(String, Value)> = dstmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, json!({
                "target_id": r.get::<_, i64>(1)?,
                "hash": r.get::<_, Option<String>>(2)?,
                "target": r.get::<_, Option<String>>(3)?})))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let mut dep_map: HashMap<String, Vec<Value>> = HashMap::new();
    for (name, d) in deps {
        dep_map.entry(name).or_default().push(d);
    }
    let dirs = item_dirs_map(conn, hub);
    let mut out = Vec::new();
    for r in &regs {
        let name = r["name"].as_str().unwrap_or("");
        let item_dir_path = dirs
            .get(name)
            .cloned()
            .unwrap_or_else(|| registry_root(hub).join(name));
        let cur_hash = if item_dir_path.is_dir() {
            fsutil::tree_hash(&item_dir_path).ok()
        } else {
            None
        };
        let reg_hash = r["hash"].as_str().unwrap_or("");
        out.push(json!({
            "name": name, "version": r["version"],
            "hash": reg_hash.chars().take(12).collect::<String>(),
            "updated_at": r["updated_at"],
            "manual": r["source_id"].is_null(),
            "dir_id": r["dir_id"],
            "modified": cur_hash.is_some() && !reg_hash.is_empty() && cur_hash.as_deref() != Some(reg_hash),
            "deployments": dep_map.get(name).cloned().unwrap_or_default(),
        }));
    }
    out
}

pub fn item_detail(conn: &Connection, hub: &Path, name: &str) -> Option<Value> {
    let mut reg_dir = item_dir(conn, hub, name);
    let mut from_source = false;
    if !reg_dir.is_dir() {
        let row: Option<(i64, Option<String>)> = conn
            .query_row(
                "SELECT source_id, path FROM items WHERE kind=?1 AND name=?2 ORDER BY id DESC LIMIT 1",
                rusqlite::params![KIND, name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let Some((sid, path)) = row else { return None };
        let Some(path) = path else { return None };
        let src = source_cache_path(conn, hub, sid)?;
        let cand = src.join(path);
        if !cand.is_dir() {
            return None;
        }
        reg_dir = cand;
        from_source = true;
    }
    let files = fsutil::list_files(&reg_dir).ok()?;
    let skill_md = std::fs::read_to_string(reg_dir.join("SKILL.md"))
        .ok()
        .map(|t| t.chars().take(12000).collect::<String>());
    let reg: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT version, dir_id FROM registry_items WHERE kind=?1 AND name=?2",
            rusqlite::params![KIND, name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let dir_name = reg
        .as_ref()
        .and_then(|(_, did)| *did)
        .and_then(|did| {
            conn.query_row("SELECT name FROM local_dirs WHERE id=?1", [did], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        });
    Some(json!({
        "name": name, "skill_md": skill_md,
        "files": files.keys().collect::<Vec<_>>(),
        "version": reg.as_ref().and_then(|r| r.0.clone()),
        "manual": reg.is_some() && is_manual(conn, name),
        "dir_id": reg.as_ref().and_then(|r| r.1),
        "dir_name": dir_name,
        "from_source": from_source,
    }))
}

fn source_cache_path(conn: &Connection, hub: &Path, source_id: i64) -> Option<PathBuf> {
    let (url, branch, subdir): (String, String, String) = conn
        .query_row(
            "SELECT url, branch, subdir FROM sources WHERE id=?1",
            [source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok()?;
    Some(gitsrc::source_cache_dir(hub, KIND, &url, &branch, &subdir))
}

pub fn diff_registry_vs_source(conn: &Connection, hub: &Path, name: &str, source_id: Option<i64>) -> Result<Value> {
    let row: Option<(i64, Option<String>)> = {
        let (sql, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match source_id {
            Some(sid) => (
                "SELECT source_id, path FROM items WHERE kind=?1 AND name=?2 AND source_id=?3 \
                 ORDER BY id DESC LIMIT 1",
                vec![Box::new(KIND), Box::new(name), Box::new(sid)],
            ),
            None => (
                "SELECT source_id, path FROM items WHERE kind=?1 AND name=?2 ORDER BY id DESC LIMIT 1",
                vec![Box::new(KIND), Box::new(name)],
            ),
        };
        match conn.prepare(sql) {
            Ok(mut stmt) => {
                let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
                stmt.query_row(refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?))).ok()
            }
            Err(_) => None,
        }
    };
    let Some((sid, path)) = row else { return ok_err("源中没有该条目") };
    let commit: Option<String> = conn
        .query_row("SELECT last_commit FROM sources WHERE id=?1", [sid], |r| r.get(0))
        .ok()
        .flatten();
    let Some(commit) = commit else { return ok_err("源尚未拉取") };
    let Some(cache) = source_cache_path(conn, hub, sid) else {
        return ok_err("源不存在");
    };
    let prefix = match path.as_deref() {
        Some(p) if p != "." && !p.is_empty() => format!("{}/", p.trim_end_matches('/')),
        _ => String::new(),
    };
    let files = gitsrc::ls_tree(&cache, &commit, "");
    let reg_dir = registry_root(hub).join(name);
    let mut diffs = Vec::new();
    for (rel, _) in &files {
        if !prefix.is_empty() && !rel.starts_with(&prefix) {
            continue;
        }
        let rel_short = if prefix.is_empty() { rel.as_str() } else { &rel[prefix.len()..] };
        let src_text = gitsrc::show_bytes(&cache, &commit, rel)
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default();
        let cur_path = reg_dir.join(rel_short);
        let cur_text = std::fs::read_to_string(&cur_path).unwrap_or_default();
        if src_text != cur_text {
            diffs.push(unified_diff(&cur_text, &src_text,
                &format!("local/{rel_short}"), &format!("source/{rel_short}")));
        }
    }
    ok2(json!({"ok": true, "name": name, "commit": commit,
        "diff": if diffs.is_empty() { "（无差异）".to_string() } else { diffs.join("\n") }}))
}

/// 统一 diff（简化 unified 格式，带 @@ 头）。
pub fn unified_diff(a: &str, b: &str, from: &str, to: &str) -> String {
    let al: Vec<&str> = a.lines().collect();
    let bl: Vec<&str> = b.lines().collect();
    // LCS 简化实现：逐行标记
    let mut out = format!("--- {from}\n+++ {to}\n");
    let n = al.len().max(bl.len());
    let mut i = 0;
    let mut any = false;
    let mut hunk: Vec<String> = Vec::new();
    while i < n {
        let x = al.get(i);
        let y = bl.get(i);
        match (x, y) {
            (Some(x), Some(y)) if x == y => {
                if !hunk.is_empty() {
                    hunk.push(format!(" {x}"));
                }
            }
            (Some(x), Some(y)) => {
                any = true;
                hunk.push(format!("-{x}"));
                hunk.push(format!("+{y}"));
            }
            (Some(x), None) => {
                any = true;
                hunk.push(format!("-{x}"));
            }
            (None, Some(y)) => {
                any = true;
                hunk.push(format!("+{y}"));
            }
            (None, None) => break,
        }
        i += 1;
    }
    if any {
        out.push_str(&format!("@@ -1,{} +1,{} @@\n", al.len(), bl.len()));
        for l in hunk {
            out.push_str(&l);
            out.push('\n');
        }
    }
    out
}

// ---------- items_view ----------

pub fn items_view(
    conn: &Connection, hub: &Path,
    source: Option<&str>, q: Option<&str>, page: i64, per_page: i64, dir: Option<&str>,
) -> Value {
    let cat: Vec<Value> = match source {
        Some(s) if s.eq_ignore_ascii_case("manual") || s.eq_ignore_ascii_case("local") => {
            catalog_view(conn, hub, None).into_iter().filter(|it| it["manual"] == true).collect()
        }
        _ => catalog_view(conn, hub, source.and_then(|s| s.parse::<i64>().ok())),
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
                || it["description"].as_str().map(|n| n.to_lowercase().contains(&ql)).unwrap_or(false)
        });
    }
    let total = cat.len() as i64;
    let page = page.max(1);
    let per_page = per_page.clamp(5, 100);
    let start = ((page - 1) * per_page) as usize;
    let slice: Vec<Value> = cat
        .iter()
        .skip(start)
        .take(per_page as usize)
        .cloned()
        .collect();
    // 可见目标（skills_dir + 工具启停过滤）
    let Ok(mut tstmt) = conn.prepare(
        "SELECT id, name, tool, path FROM targets WHERE kind='skills_dir' ORDER BY id") else {
        return json!({"ok": true, "items": [], "total": 0, "page": 1, "per_page": per_page,
            "pages": 1, "targets": []}) };
    let trows: Vec<Value> = tstmt
        .query_map([], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                "tool": r.get::<_, Option<String>>(2)?, "path": r.get::<_, String>(3)?}))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let trows: Vec<Value> = trows
        .into_iter()
        .filter(|t| target_visible(conn, t["tool"].as_str(), "skills_dir"))
        .collect();
    let visible_ids: BTreeSet<i64> = trows.iter().filter_map(|t| t["id"].as_i64()).collect();
    let Ok(mut dstmt) = conn.prepare(
        "SELECT d.item_name, d.target_id, d.item_version, d.deployed_hash, d.deployed_at, \
         t.name FROM deployments d LEFT JOIN targets t ON t.id=d.target_id \
         WHERE d.item_kind='skill' AND d.status='ok'") else {
        return json!({"ok": true, "items": [], "total": 0}) };
    let deps: Vec<(String, Value)> = dstmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, json!({
                "target_id": r.get::<_, i64>(1)?,
                "item_version": r.get::<_, Option<String>>(2)?,
                "deployed_hash": r.get::<_, Option<String>>(3)?,
                "deployed_at": r.get::<_, Option<String>>(4)?,
                "target_name": r.get::<_, Option<String>>(5)?})))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let deps: Vec<(String, Value)> = deps
        .into_iter()
        .filter(|(_, d)| visible_ids.contains(&d["target_id"].as_i64().unwrap_or(-1)))
        .collect();
    let regs = registry_view(conn, hub);
    let reg_map: HashMap<String, &Value> = regs.iter().map(|r| (r["name"].as_str().unwrap_or("").to_string(), r)).collect();
    let full_hash: HashMap<String, Option<String>> = {
        match conn.prepare("SELECT name, hash FROM registry_items WHERE kind=?1") {
        Ok(mut stmt) => stmt.query_map([KIND], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
        }
    };
    let tool_names = tool_names_map(conn);
    let dep_by_item: HashMap<String, HashMap<i64, &Value>> = {
        let mut m: HashMap<String, HashMap<i64, &Value>> = HashMap::new();
        for (name, d) in &deps {
            m.entry(name.clone()).or_default().insert(d["target_id"].as_i64().unwrap_or(0), d);
        }
        m
    };
    // 目标统计
    let mut targets: Vec<Value> = Vec::new();
    for t in &trows {
        let tid = t["id"].as_i64().unwrap_or(0);
        let mut tj = json!({"id": tid, "name": t["name"], "tool": t["tool"],
            "tool_name": t["tool"].as_str().and_then(|x| tool_names.get(x)).cloned(),
            "path": t["path"],
            "items": {"latest": 0, "stale": 0, "missing": 0, "total": 0},
            "stale_names": []});
        for it in &cat {
            let name = it["name"].as_str().unwrap_or("");
            match dep_by_item.get(name).and_then(|m| m.get(&tid)) {
                Some(dep) => {
                    tj["items"]["total"] = json!(tj["items"]["total"].as_i64().unwrap_or(0) + 1);
                    if dep_stale(conn, hub, dep, t, name, &full_hash) {
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
    // 行
    let mut rows = Vec::new();
    for it in &slice {
        let name = it["name"].as_str().unwrap_or("");
        let reg = reg_map.get(name);
        let mut per_target = Vec::new();
        for t in &trows {
            let tid = t["id"].as_i64().unwrap_or(0);
            match dep_by_item.get(name).and_then(|m| m.get(&tid)) {
                Some(dep) => {
                    let stale = dep_stale(conn, hub, dep, t, name, &full_hash);
                    per_target.push(json!({
                        "target_id": tid, "target": t["name"],
                        "state": if stale { "stale" } else { "latest" },
                        "deployed_version": dep["item_version"],
                        "local_version": reg.map(|r| r["version"].clone()).unwrap_or(Value::Null),
                        "deployed_at": dep["deployed_at"]}));
                }
                None => per_target.push(json!({
                    "target_id": tid, "target": t["name"], "state": "missing",
                    "deployed_version": Value::Null,
                    "local_version": reg.map(|r| r["version"].clone()).unwrap_or(Value::Null),
                    "deployed_at": Value::Null})),
            }
        }
        let mut row = it.clone();
        row["hash"] = reg.map(|r| r["hash"].clone()).unwrap_or(json!(""));
        row["updated_at"] = reg.map(|r| r["updated_at"].clone()).unwrap_or(Value::Null);
        row["modified"] = reg.map(|r| r["modified"].clone()).unwrap_or(json!(false));
        row["deployments"] = reg
            .map(|r| r["deployments"].clone())
            .unwrap_or(json!([]));
        row["per_target"] = json!(per_target);
        rows.push(row);
    }
    json!({"ok": true, "items": rows, "total": total, "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) / per_page.max(1),
        "targets": targets})
}

fn dep_stale(
    conn: &Connection, hub: &Path, dep: &Value, target: &Value, name: &str,
    full_hash: &HashMap<String, Option<String>>,
) -> bool {
    let detail: Value = dep
        .get("detail")
        .and_then(|d| d.as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(json!({}));
    if detail.get("mode").and_then(|m| m.as_str()) == Some("link") {
        let dest = Path::new(target["path"].as_str().unwrap_or("")).join(name);
        let reg_dir = item_dir(conn, hub, name);
        if dest.is_symlink() && real_path(&dest) == real_path(&reg_dir) {
            return false;
        }
    }
    let h = full_hash.get(name).cloned().flatten();
    let deployed = dep["deployed_hash"].as_str().unwrap_or("");
    matches!((h.as_deref(), deployed),
        (Some(h), d) if !d.is_empty() && d != h)
}

fn real_path(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

pub fn tool_names_map(conn: &Connection) -> HashMap<String, String> {
    let mut stmt = match conn.prepare("SELECT id, name FROM tools") { Ok(t) => t, Err(_) => return HashMap::new() };
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}
