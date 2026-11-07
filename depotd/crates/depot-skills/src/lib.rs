//! Skills 领域：registry（手动条目/版本链）、分发四态、目录绑定、容器发现、targets。
//! 契约来源：tests/spec/spec_dispatch / spec_versioning / spec_bindings（Tier 1 行为真源）。

use std::path::{Path, PathBuf};
use std::collections::BTreeMap;

use depot_core::error::{Code, CoreError, Result};
use serde_json::json;
use depot_core::events::{self, Event};
use depot_core::fsutil;
use rusqlite::Connection;

pub mod extra;

pub const KIND: &str = "skills";

pub fn name_valid(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > 64 { return false; }
    if !b[0].is_ascii_alphanumeric() { return false; }
    b[1..].iter().all(|&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-')
}

pub fn registry_root(hub: &Path) -> PathBuf {
    depot_core::paths::registry_root(hub, KIND)
}

pub fn _item_root(conn: &Connection, hub: &Path, name: &str) -> PathBuf {
    let q = conn.query_row(
        "SELECT d.path AS p, r.sub_path AS sub FROM registry_items r \
         JOIN local_dirs d ON d.id = r.dir_id WHERE r.kind=?1 AND r.name=?2",
        rusqlite::params![KIND, name],
        |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        },
    );
    let (p, sub_opt) = match q { Ok(v) => v, Err(_) => return registry_root(hub) };
    if p.is_empty() { return registry_root(hub); }
    let sub = sub_opt.unwrap_or_default().replace('/', std::path::MAIN_SEPARATOR_STR);
    if sub.is_empty() { PathBuf::from(&p) } else { Path::new(&p).join(sub) }
}

pub fn item_dir(conn: &Connection, hub: &Path, name: &str) -> PathBuf {
    _item_root(conn, hub, name).join(name)
}

pub fn is_manual(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2 AND source_id IS NULL",
        rusqlite::params![KIND, name], |_| Ok(true)).unwrap_or(false)
}

fn safe_rel(rel: &str) -> bool {
    !rel.is_empty() && rel.len() <= 200 && !rel.contains("..") && !rel.contains('\\')
        && !rel.starts_with('/')
        && !rel.split('/').any(|seg| seg.starts_with(".hub"))
}

pub(crate) fn with_fm_field(fm: &str, key: &str, value: &str) -> String {
    if let Some(rest) = fm.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let (front, body) = (&rest[..end], &rest[end..]);
            if front.contains(&format!("{key}:")) {
                let lines: Vec<String> = front.lines().map(|l|
                    if l.starts_with(&format!("{key}:")) { format!("{key}: {value}") } else { l.to_string() }
                ).collect();
                return format!("---\n{}\n{body}", lines.join("\n"));
            }
            return format!("---\n{front}\n{key}: {value}\n{body}");
        }
    }
    format!("---\n{key}: {value}\n---\n{fm}")
}

pub fn fm_version(skill_md: &Path) -> Option<String> {
    let text = std::fs::read_to_string(skill_md).ok()?;
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    rest[..end].lines().find_map(|l| l.strip_prefix("version:").map(|v| v.trim().to_string()))
}

// ============ 手动条目 ============

pub fn create_manual(conn: &Connection, hub: &Path, name: &str, description: &str,
                     files: &serde_json::Value, dir_id: Option<i64>, actor: &str
) -> Result<serde_json::Value> {
    let name = name.trim();
    if !name_valid(name) {
        return ok_err("名称非法（字母数字开头，允许 . _ -，≤64 字符）");
    }
    let Some(obj) = files.as_object() else {
        return ok_err("缺少 SKILL.md（手动条目必须包含）");
    };
    if !obj.contains_key("SKILL.md") {
        return ok_err("缺少 SKILL.md（手动条目必须包含）");
    }
    let root = dir_root(conn, hub, dir_id, KIND)?;
    let dest = root.join(name);
    if dest.exists() { return ok_err("已存在同名条目"); }
    let tmp = PathBuf::from(format!("{}.hub-tmp-{}", dest.display(), std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| CoreError::io("建临时目录", e))?;
    let mut fm = obj.get("SKILL.md").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !description.is_empty() { fm = with_fm_field(&fm, "description", description); }
    fsutil::atomic_write_text(&tmp.join("SKILL.md"), &fm)?;
    for (rel, val) in obj {
        if rel == "SKILL.md" { continue; }
        if !safe_rel(rel) {
            let _ = fs::remove_dir_all(&tmp);
            return ok_err(&format!("非法文件路径：{rel}"));
        }
        let Some(text) = val.as_str() else {
            let _ = fs::remove_dir_all(&tmp);
            return ok_err("文件内容必须是文本");
        };
        let p = tmp.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = p.parent() { fs::create_dir_all(parent).map_err(|e| CoreError::io("建目录", e))?; }
        fsutil::atomic_write_text(&p, text)?;
    }
    fs::rename(&tmp, &dest).map_err(|e| CoreError::io("落库失败", e))?;
    let new_hash = fsutil::tree_hash(&dest)?;
    let version = fm_version(&dest.join("SKILL.md"));
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
         prev_version, prev_hash, source_hash_at, dir_id) \
         VALUES(?,?,NULL,?,?,?,?,?,NULL,?) \
         ON CONFLICT(kind,name) DO UPDATE SET version=excluded.version, \
         hash=excluded.hash, updated_at=excluded.updated_at, \
         prev_version=excluded.prev_version, prev_hash=excluded.prev_hash, \
         source_hash_at=NULL, dir_id=excluded.dir_id",
        rusqlite::params![KIND, name, version, new_hash, fsutil::now_iso(), pv, ph, dir_id],
    )
    .map_err(CoreError::from)?;
    events::append(conn, &Event { module: "skills",
        actor, kind: "create", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"files": obj.len(), "hash": new_hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("skill"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("name", name.into()), ("files", (obj.len() as i64).into()),
                 ("hash", new_hash[..12].to_string().into())]))
}

pub fn update_manual(conn: &Connection, hub: &Path, name: &str, files: &serde_json::Value,
                     actor: &str) -> Result<serde_json::Value> {
    if !is_manual(conn, name) {
        return ok_err("只支持编辑本地手动条目（该条目来自远程源）");
    }
    let dest = item_dir(conn, hub, name);
    if !dest.is_dir() { return ok_err("本地库目录缺失"); }
    let vroot = depot_core::paths::versions_root(hub, KIND, name);
    fs::create_dir_all(&vroot).map_err(|e| CoreError::io("建快照目录", e))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut snap = vroot.join(&stamp); let mut n = 1;
    while snap.exists() { snap = vroot.join(format!("{stamp}.{n}")); n += 1; }
    fsutil::copy_dir_all(&dest, &snap).map_err(|e| CoreError::io("快照失败", e))?;
    if let Some(obj) = files.as_object() {
        for (rel, val) in obj {
            // 路径穿越门禁（与 create_manual 同一道闸；Python mod_skills._safe_rel 对位）
            if !safe_rel(rel) {
                return ok_err(&format!("非法文件路径：{}", rel.chars().take(60).collect::<String>()));
            }
            let p = dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            match val.as_str() {
                None => { if p.exists() { fs::remove_file(&p).map_err(|e| CoreError::io("删文件", e))?; } }
                Some(text) => fsutil::atomic_write_text(&p, text)?,
            }
        }
        for d in walk_dirs(&dest) { if is_empty_dir(&d) { let _ = fs::remove_dir(&d); } }
    }
    let new_hash = fsutil::tree_hash(&dest)?;
    let prev = prev_version_hash(conn, name);
    conn.execute("UPDATE registry_items SET version=?, hash=?, updated_at=?, prev_version=?, prev_hash=? \
                  WHERE kind=? AND name=?",
                 rusqlite::params![fm_version(&dest.join("SKILL.md")), new_hash, fsutil::now_iso(),
                                   prev.0, prev.1, KIND, name]).map_err(CoreError::from)?;
    events::append(conn, &Event { module: "skills",
        actor, kind: "edit", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"files": files.as_object().map(|o| o.len()).unwrap_or(0),
            "hash": new_hash[..12].to_string()}),
        item_version: None, source_id: None,
                item_kind: Some("skill"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("name", name.into()), ("hash", new_hash[..12].to_string().into())]))
}

pub fn delete_manual(conn: &Connection, hub: &Path, name: &str, force: bool, actor: &str
) -> Result<serde_json::Value> {
    if !is_manual(conn, name) { return ok_err("条目不存在"); }
    let dep_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deployments WHERE item_kind='skill' AND item_name=?1 AND status='ok'",
        rusqlite::params![name], |r| r.get(0)).unwrap_or(0);
    if dep_count > 0 && !force {
        return ok_err(&format!("已写入 {dep_count} 个目标配置；确认后连同写入内容一起移除"));
    }
    let dest = item_dir(conn, hub, name);
    if dest.is_dir() {
        let vroot = depot_core::paths::versions_root(hub, KIND, name);
        fs::create_dir_all(&vroot).map_err(|e| CoreError::io("建快照目录", e))?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-deleted").to_string();
        let mut snap = vroot.join(&stamp); let mut n = 1;
        while snap.exists() { snap = vroot.join(format!("{stamp}.{n}")); n += 1; }
        fsutil::copy_dir_all(&dest, &snap).map_err(|e| CoreError::io("转存", e))?;
        let _ = fsutil::safe_rm(&dest, hub);
    }
    conn.execute("DELETE FROM deployments WHERE item_kind='skill' AND item_name=?1",
                 rusqlite::params![name]).map_err(CoreError::from)?;
    conn.execute("DELETE FROM registry_items WHERE kind=? AND name=?1",
                 rusqlite::params![KIND, name]).map_err(CoreError::from)?;
    events::append(conn, &Event { module: "skills",
        actor, kind: "delete", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"removed_from_targets": dep_count}),
        item_version: None, source_id: None,
                item_kind: Some("skill"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[]))
}

pub fn rollback_registry(conn: &Connection, hub: &Path, name: &str, actor: &str
) -> Result<serde_json::Value> {
    let vroot = depot_core::paths::versions_root(hub, KIND, name);
    if !vroot.is_dir() { return ok_err("没有可回退的版本快照"); }
    let mut snaps: Vec<String> = fs::read_dir(&vroot).map_err(|e| CoreError::io("读快照", e))?
        .filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.')).collect();
    snaps.sort();
    if snaps.is_empty() { return ok_err("版本快照为空"); }
    let latest = snaps.last().unwrap().clone();
    let dest = item_dir(conn, hub, name);
    if dest.is_dir() {
        // 同秒碰撞 -n 后缀（规格契约，2026-11-07 修复 bug 对位）
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-pre-rollback").to_string();
        let mut target = vroot.join(&stamp); let mut n = 1;
        while target.exists() { target = vroot.join(format!("{stamp}.{n}")); n += 1; }
        fs::rename(&dest, &target).map_err(|e| CoreError::io("转存当前版本", e))?;
    }
    fs::rename(vroot.join(&latest), &dest).map_err(|e| CoreError::io("回退", e))?;
    let new_hash = fsutil::tree_hash(&dest)?;
    let new_version = fm_version(&dest.join("SKILL.md"));
    let prev = prev_version_hash(conn, name);
    conn.execute("UPDATE registry_items SET version=?, hash=?, updated_at=?, prev_version=?, prev_hash=? \
                  WHERE kind=? AND name=?",
                 rusqlite::params![new_version.clone().or_else(|| prev.0.clone()), new_hash,
                                   fsutil::now_iso(), prev.0, prev.1, KIND, name])
        .map_err(CoreError::from)?;
    let version_out = new_version.clone().or_else(|| prev.0.clone());
    events::append(conn, &Event { module: "skills",
        actor, kind: "rollback", subject: Some(name), outcome: "ok", error_code: None,
        extra: serde_json::json!({"restored_from": latest}),
        item_version: version_out.as_deref(), source_id: None,
                item_kind: Some("skill"), item_name: Some(name), target_id: None,
    })?;
    Ok(json_ok(&[("hash", new_hash[..12].to_string().into()),
                 ("version", version_out.into()), ("restored_from", latest.into())]))
}

// ============ 分发四态 ============

#[derive(Debug, Clone, PartialEq)]
pub enum PlanStatus { Ok, Skipped, Conflict, Failed }

pub struct Plan {
    pub status: PlanStatus, pub action: String, pub reason: Option<String>,
    pub dest: PathBuf, pub files_new: BTreeMap<String, String>,
    pub files_changed: Vec<String>,
    pub conflicts: Vec<String>,
    pub managed: BTreeMap<String, String>, pub mode: String,
}

pub struct DeploymentRow {
    pub status: String, pub deployed_hash: String, pub detail: serde_json::Value,
}

pub fn get_deployment(conn: &Connection, name: &str, target_id: i64) -> Option<DeploymentRow> {
    conn.query_row(
        "SELECT status, COALESCE(deployed_hash,''), COALESCE(detail,'{}') FROM deployments \
         WHERE item_kind='skill' AND item_name=?1 AND target_id=?2",
        rusqlite::params![name, target_id],
        |r| Ok(DeploymentRow { status: r.get(0)?, deployed_hash: r.get(1)?,
            detail: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(serde_json::Value::Null) }),
    ).ok()
}

pub fn plan_skills_dir(conn: &Connection, hub: &Path, name: &str, target_path: &Path,
                       target_id: i64, force: bool, mode: &str) -> Result<Plan> {
    let mode = if mode.eq_ignore_ascii_case("link") { "link" } else { "copy" };
    let reg_dir = item_dir(conn, hub, name);
    let dest = target_path.join(name);
    let fail = |reason: &str| Plan { status: PlanStatus::Failed, action: String::new(),
        reason: Some(reason.into()), dest: dest.clone(), files_new: Default::default(),
        files_changed: vec![], conflicts: vec![], managed: Default::default(),
        mode: mode.into() };
    if !reg_dir.is_dir() { return Ok(fail("本地库中不存在该技能（先更新到本地）")); }
    let files_new = fsutil::list_files(&reg_dir)?;
    let new_hash = fsutil::tree_hash_from_files(&files_new);
    let is_link = dest.is_symlink();
    let mut dep = get_deployment(conn, name, target_id);
    // 已被清理过的部署记录（clean 断连/清理）：重新建连视为首次安装（spec 修复对位）
    if dep.as_ref().map(|d| d.status == "removed").unwrap_or(false) {
        dep = None;
    }
    let dep_mode = dep.as_ref().and_then(|d| d.detail.get("mode"))
        .and_then(|v| v.as_str()).unwrap_or("copy").to_string();
    let managed: BTreeMap<String, String> = dep.as_ref()
        .and_then(|d| d.detail.get("files")).and_then(|v| v.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default();
    let link_live = dep_mode == "link" && is_link
        && std::fs::read_link(&dest).map(|p| p == reg_dir).unwrap_or(false);

    if mode == "link" {
        if dep.is_some() && dep_mode == "link" && link_live {
            return Ok(Plan { status: PlanStatus::Skipped, action: String::new(),
                reason: Some("已是软链接（内容跟随本地库）".into()), dest, files_new,
                files_changed: vec![], conflicts: vec![], managed, mode: mode.into() });
        }
        if is_link && !link_live && !force {
            return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                reason: Some("目标位置已有指向别处的软链接；确认后用 force 替换".into()),
                dest, files_new, files_changed: vec![], conflicts: vec![], managed,
                mode: mode.into() });
        }
        if dest.is_dir() && !is_link && dep.is_none() && !force {
            let cur = fsutil::list_files(&dest)?;
            if !cur.is_empty() && cur != files_new {
                return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                    reason: Some(format!(
                        "目标位置已存在未托管的同名内容（{} 个文件）；确认后用 force 替换为软链接",
                        cur.len())),
                    dest, files_new, files_changed: vec![], conflicts: vec![], managed,
                    mode: mode.into() });
            }
        }
        let all: Vec<String> = files_new.keys().cloned().collect();
        return Ok(Plan { status: PlanStatus::Ok, action: "link".into(), reason: None, dest,
            files_new, files_changed: all, conflicts: vec![], managed, mode: mode.into() });
    }
    // copy 模式：软链接没有自身内容，直接清除后按文件副本落盘
    if is_link {
        if dep.is_none() && !force {
            return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                reason: Some("目标位置是未托管的软链接；确认后用 force 替换为文件副本".into()),
                dest, files_new, files_changed: vec![], conflicts: vec![], managed,
                mode: mode.into() });
        }
        let all: Vec<String> = files_new.keys().cloned().collect();
        return Ok(Plan { status: PlanStatus::Ok, action: "copy".into(), reason: None, dest,
            files_new, files_changed: all, conflicts: vec![], managed, mode: mode.into() });
    }
    if let Some(d) = &dep {
        if d.deployed_hash == new_hash {
            if dest.is_dir() {
                let cur = fsutil::list_files(&dest)?;
                let drifted: Vec<String> = managed
                    .iter()
                    .filter(|(f, h)| cur.get(*f).map(|c| c != *h).unwrap_or(true))
                    .map(|(f, _)| f.clone())
                    .collect();
                if drifted.is_empty() && !force {
                    return Ok(Plan { status: PlanStatus::Skipped, action: String::new(),
                        reason: Some("已是最新（幂等跳过）".into()), dest, files_new,
                        files_changed: vec![], conflicts: vec![], managed, mode: mode.into() });
                }
                if !drifted.is_empty() && !force {
                    return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                        reason: Some(format!("目标文件被手动修改：{}",
                            drifted.iter().take(3).cloned().collect::<Vec<_>>().join(", "))),
                        dest, files_new, files_changed: vec![], conflicts: drifted.clone(),
                        managed, mode: mode.into() });
                }
                let action = if drifted.is_empty() { "overwrite" } else { "restore" };
                return Ok(Plan { status: PlanStatus::Ok, action: action.into(), reason: None,
                    dest, files_new, files_changed: drifted.clone(), conflicts: drifted,
                    managed, mode: mode.into() });
            }
            if !force {
                return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                    reason: Some("目标目录缺失但记录存在".into()), dest, files_new,
                    files_changed: vec![], conflicts: vec![], managed, mode: mode.into() });
            }
            let all: Vec<String> = files_new.keys().cloned().collect();
            return Ok(Plan { status: PlanStatus::Ok, action: "recreate".into(), reason: None,
                dest, files_new, files_changed: all, conflicts: vec![], managed,
                mode: mode.into() });
        }
        // 已托管但本地有新版本：检测手改
        let cur = if dest.is_dir() { fsutil::list_files(&dest)? } else { Default::default() };
        let drifted: Vec<String> = managed
            .iter()
            .filter(|(f, h)| cur.get(*f).map(|c| c != *h).unwrap_or(true))
            .map(|(f, _)| f.clone())
            .collect();
        if !drifted.is_empty() && !force {
            return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                reason: Some(format!("目标文件被手动修改：{}",
                    drifted.iter().take(3).cloned().collect::<Vec<_>>().join(", "))),
                dest, files_new, files_changed: vec![], conflicts: drifted, managed,
                mode: mode.into() });
        }
        let files_changed: Vec<String> = files_new
            .iter()
            .filter(|(f, h)| managed.get(*f).map(|m| m != *h).unwrap_or(true))
            .map(|(f, _)| f.clone())
            .collect();
        return Ok(Plan { status: PlanStatus::Ok, action: "update".into(), reason: None,
            dest, files_new, files_changed, conflicts: drifted, managed, mode: mode.into() });
    }
    // 首次分发
    if dest.is_dir() {
        let cur = fsutil::list_files(&dest)?;
        if !cur.is_empty() && cur != files_new && !force {
            return Ok(Plan { status: PlanStatus::Conflict, action: String::new(),
                reason: Some(format!(
                    "目标位置已存在未托管的同名内容（{} 个文件）；确认后用 force 覆盖", cur.len())),
                dest, files_new, files_changed: vec![], conflicts: vec![], managed,
                mode: mode.into() });
        }
        if cur == files_new {
            return Ok(Plan { status: PlanStatus::Ok, action: "adopt".into(), reason: None,
                dest, files_new, files_changed: vec![], conflicts: vec![], managed,
                mode: mode.into() });
        }
    }
    let all: Vec<String> = files_new.keys().cloned().collect();
    let action = if dest.is_dir() { "update" } else { "create" };
    Ok(Plan { status: PlanStatus::Ok, action: action.into(), reason: None, dest, files_new,
        files_changed: all, conflicts: vec![], managed, mode: mode.into() })
}

pub fn apply_skills_dir(conn: &Connection, hub: &Path, name: &str, target_path: &Path,
                        target_id: i64, plan: &Plan) -> Result<serde_json::Value> {
    let dest = plan.dest.clone();
    let mut written = 0usize;
    let mut removed: Vec<String> = vec![];
    let detail_files: serde_json::Value;
    if plan.mode == "link" {
        if dest.is_dir() && !dest.is_symlink() {
            let bk = target_path.join(".hub-backup");
            let backup = backup_dir_entry(&bk, name)?;
            fsutil::copy_dir_all(&dest, &backup).map_err(|e| CoreError::io("备份旧副本", e))?;
        }
        if dest.symlink_metadata().is_ok() {
            if dest.is_dir() && !dest.is_symlink() {
                let _ = fs::remove_dir_all(&dest);
            } else {
                let _ = fs::remove_file(&dest);
            }
        }
        let src = item_dir(conn, hub, name);
        std::os::unix::fs::symlink(&src, &dest).map_err(|e| CoreError::io("建软链接", e))?;
        detail_files = serde_json::json!({});
        written = plan.files_new.len();
    } else {
        if dest.is_symlink() { fs::remove_file(&dest).map_err(|e| CoreError::io("清链接", e))?; }
        let backup_root = dest.join(".hub-backup");
        for rel in plan.managed.keys().chain(plan.files_new.keys()) {
            let cur = dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if cur.exists() {
                let same = plan.files_new.get(rel)
                    .map(|sha| fsutil::sha256_file(&cur).ok().as_deref() == Some(sha.as_str()))
                    .unwrap_or(false);
                if !same { let _ = fsutil::backup_file(&cur, &backup_root); }
            }
        }
        let src_root = item_dir(conn, hub, name);
        for (rel, _) in &plan.files_new {
            let src = src_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let data = fs::read(&src).map_err(|e| CoreError::io(format!("读源 {rel}"), e))?;
            fsutil::atomic_write_bytes(&dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)), &data)?;
            written += 1;
        }
        for rel in plan.managed.keys() {
            if !plan.files_new.contains_key(rel) {
                let p = dest.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                if p.exists() { fs::remove_file(&p).map_err(|e| CoreError::io("清托管", e))?; removed.push(rel.clone()); }
            }
        }
        for d in walk_dirs(&dest) { if is_empty_dir(&d) { let _ = fs::remove_dir(&d); } }
        detail_files = serde_json::to_value(&plan.files_new).unwrap_or(serde_json::json!({}));
    }
    let dep_hash = fsutil::tree_hash_from_files(&plan.files_new);
    let version: Option<String> = conn.query_row(
        "SELECT version FROM registry_items WHERE kind=? AND name=?",
        rusqlite::params![KIND, name], |r| r.get(0)).unwrap_or(None);
    let detail = serde_json::json!({"mode": plan.mode, "files": detail_files, "removed": removed});
    conn.execute("INSERT INTO deployments(item_kind, item_name, item_version, target_id, \
                  deployed_hash, deployed_at, status, detail) VALUES('skill',?,?,?,?,?,'ok',?) \
                  ON CONFLICT(item_kind, item_name, target_id) DO UPDATE SET \
                  item_version=excluded.item_version, deployed_hash=excluded.deployed_hash, \
                  deployed_at=excluded.deployed_at, status='ok', detail=excluded.detail",
                 rusqlite::params![name, version, target_id, dep_hash, fsutil::now_iso(),
                                   detail.to_string()]).map_err(CoreError::from)?;
    Ok(serde_json::json!({"written": written, "removed": removed}))
}

pub struct TargetRow {
    pub id: i64, pub name: String, pub kind: String, pub tool: Option<String>,
    pub path: String, pub format_key: Option<String>,
}

pub fn list_targets(conn: &Connection, kind: Option<&str>) -> Result<Vec<TargetRow>> {
    let mut stmt = conn.prepare("SELECT id, name, kind, COALESCE(tool,''), path, \
        COALESCE(format_key,'') FROM targets WHERE enabled=1 ORDER BY id").map_err(CoreError::from)?;
    let rows = stmt.query_map([], |r| Ok(TargetRow {
        id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, tool: r.get(3)?,
        path: r.get(4)?, format_key: r.get(5)?,
    })).map_err(CoreError::from)?;
    Ok(rows.filter_map(|r| r.ok())
        .filter(|t| kind.map(|k| t.kind == k).unwrap_or(true)).collect())
}

pub fn add_target(conn: &Connection, name: &str, kind: &str, tool: Option<&str>,
                  path: &str, format_key: Option<&str>) -> Result<serde_json::Value> {
    if !["skills_dir", "mcp_json", "mcp_toml"].contains(&kind) {
        return ok_err("kind 必须是 skills_dir / mcp_json / mcp_toml");
    }
    let path = shellexpand(path);
    if path.is_empty() { return ok_err("path 必填"); }
    conn.execute("INSERT INTO targets(name, kind, tool, path, format_key, created_at) \
                  VALUES(?,?,?,?,?,?)",
                 rusqlite::params![name, kind, tool, path, format_key, fsutil::now_iso()])
        .map_err(|e| CoreError::new(Code::AlreadyExists,
            format!("目标已存在（同路径同类型）或非法：{e}")))?;
    Ok(json_ok(&[("id", conn.last_insert_rowid().into()), ("name", name.into())]))
}

pub fn distribute_skills(conn: &Connection, hub: &Path, names: &[String], target_ids: &[i64],
                         dry_run: bool, force: bool, mode: &str, actor: &str
) -> Result<Vec<serde_json::Value>> {
    let _mode_n = if mode.eq_ignore_ascii_case("link") { "link" } else { "copy" };
    let all_targets = list_targets(conn, None)?;
    let mut results = Vec::new();
    for name in names {
        if !name_valid(name) {
            let tgts: Vec<&TargetRow> = all_targets.iter().filter(|t| target_ids.contains(&t.id)).collect();
            if tgts.is_empty() {
                results.push(json_fail(name, None, None, "非法条目名", mode, dry_run));
            } else {
                for t in tgts { results.push(json_fail(name, Some(&t.name), Some(t.id), "非法条目名", mode, dry_run)); }
            }
            continue;
        }
        for t in all_targets.iter().filter(|t| target_ids.contains(&t.id)) {
            let emit = |status: &str, action: Option<&str>, reason: Option<String>, logged: bool| {
                let mut r = serde_json::json!({"item": name, "target": t.name, "target_id": t.id,
                    "status": status, "mode": mode, "dry_run": dry_run});
                if let Some(a) = action { r["action"] = a.into(); }
                if let Some(rr) = reason { r["reason"] = rr.into(); }
                if logged && !dry_run {
                    let _ = events::append(conn, &Event { module: "skills",
                        actor, kind: "distribute", subject: Some(name),
                        outcome: if status == "ok" { "ok" } else { status },
                        error_code: None,
                        extra: serde_json::json!({"reason": r["reason"].clone(),
                            "action": r["action"].clone(), "mode": mode}),
        item_version: None, source_id: None,
                                item_kind: Some("skill"), item_name: Some(name), target_id: Some(t.id),
                    });
                }
                r
            };
            match plan_skills_dir(conn, hub, name, Path::new(&t.path), t.id, force, mode) {
                Ok(plan) if plan.status == PlanStatus::Ok && !dry_run => {
                    match apply_skills_dir(conn, hub, name, Path::new(&t.path), t.id, &plan) {
                        Ok(applied) => {
                            let mut r = emit("ok", Some(&plan.action), None, false);
                            r["files_changed"] = json!(plan.files_changed.len());
                            r["files_removed"] = json!(applied["removed"]
                                .as_array().map(|a| a.len()).unwrap_or(0));
                            results.push(r);
                            let _ = events::append(conn, &Event { module: "skills",
                                actor, kind: "distribute", subject: Some(name), outcome: "ok",
                                error_code: None,
                                extra: serde_json::json!({"files": applied["written"],
                                    "removed": applied["removed"], "mode": mode}),
        item_version: None, source_id: None,
                                        item_kind: Some("skill"), item_name: Some(name),
                                target_id: Some(t.id)});
                        }
                        Err(e) => {
                            let reason: String = e.message.chars().take(200).collect();
                            results.push(json_fail(name, Some(&t.name), Some(t.id), &reason, mode, dry_run));
                            let _ = events::append(conn, &Event { module: "skills",
                                actor, kind: "distribute", subject: Some(name), outcome: "failed",
                                error_code: Some(e.code.as_str()),
                                extra: serde_json::json!({"reason": reason}),
        item_version: None, source_id: None,
                                        item_kind: Some("skill"), item_name: Some(name), target_id: Some(t.id)});
                        }
                    }
                }
                Ok(plan) => {
                    let status = match plan.status { PlanStatus::Ok => "ok",
                        PlanStatus::Skipped => "skipped", PlanStatus::Conflict => "conflict",
                        PlanStatus::Failed => "failed" };
                    let reason = plan.reason.clone();
                    if plan.status == PlanStatus::Ok && dry_run {
                        let mut r = emit("ok", Some(&plan.action),
                            Some("dry-run（未写入）".to_string()), false);
                        r["dry_run"] = json!(true);
                        r["files_changed"] = json!(plan.files_changed.len());
                        results.push(r);
                        continue;
                    }
                    if !dry_run && plan.status == PlanStatus::Conflict {
                        let _ = events::append(conn, &Event { module: "skills",
                            actor, kind: "distribute", subject: Some(name), outcome: "conflict",
                            error_code: Some(Code::ConflictUnmanaged.as_str()),
                            extra: serde_json::json!({"reason": reason}),
        item_version: None, source_id: None,
                                    item_kind: Some("skill"), item_name: Some(name), target_id: Some(t.id)});
                    }
                    results.push(emit(status, Some(&plan.action), reason, false));
                }
                Err(e) => results.push(json_fail(name, Some(&t.name), Some(t.id),
                    &e.message.chars().take(200).collect::<String>(), mode, dry_run)),
            }
        }
    }
    Ok(results)
}

// ============ 目录绑定 ============

/// 目录内 mcp 条目名（extra.rs 绑定同步用）。
pub fn dir_item_names_mcp(conn: &Connection, dir_id: i64) -> Vec<String> {
    dir_item_names(conn, dir_id, "mcp")
}

pub fn dir_item_names(conn: &Connection, dir_id: i64, kind: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT name FROM registry_items WHERE kind=?1 AND dir_id=?2 ORDER BY name") else { return vec![] };
    stmt.query_map(rusqlite::params![kind, dir_id], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

pub fn bind_dirs(conn: &Connection, hub: &Path, dir_id: i64, target_ids: &[i64],
                 mode: &str, force: bool, actor: &str) -> Result<serde_json::Value> {
    let dir_exists: bool = conn.query_row("SELECT 1 FROM local_dirs WHERE id=?1",
        rusqlite::params![dir_id], |_| Ok(true)).unwrap_or(false);
    if !dir_exists { return ok_err("本地目录不存在"); }
    let mode_n = if mode.eq_ignore_ascii_case("link") { "link" } else { "copy" };
    let mut out = Vec::new();
    for tid in target_ids {
        let t = list_targets(conn, None).unwrap_or_default()
            .into_iter().find(|t| t.id == *tid);
        let Some(t) = t else {
            out.push(serde_json::json!({"ok": false, "error": format!("目标不存在（{tid}）")}));
            continue;
        };
        let dup: bool = conn.query_row("SELECT 1 FROM dir_bindings WHERE dir_id=? AND target_id=?",
            rusqlite::params![dir_id, tid], |_| Ok(true)).unwrap_or(false);
        if dup {
            out.push(serde_json::json!({"ok": false, "target": t.name, "error": "已建立连接"}));
            continue;
        }
        conn.execute("INSERT INTO dir_bindings(dir_id, target_id, mode, channels, created_at) \
                      VALUES(?,?,?,?,?)",
                     rusqlite::params![dir_id, tid, mode_n, "skills", fsutil::now_iso()])
            .map_err(CoreError::from)?;
        let bid = conn.last_insert_rowid();
        let agg = sync_binding(conn, hub, bid, dir_id, *tid, mode_n, force, actor)?;
        let count = dir_item_names(conn, dir_id, KIND).len();
        out.push(serde_json::json!({"ok": agg.failed == 0, "binding_id": bid,
            "target": t.name, "tool": t.tool, "channel": "skills", "skills": count,
            "added": agg.added, "updated": agg.updated, "skipped": agg.skipped,
            "conflicts": agg.conflicts, "failed": agg.failed, "excluded": agg.excluded,
            "removed": agg.removed}));
    }
    let ok = !out.is_empty() && out.iter().all(|x| x["ok"].as_bool().unwrap_or(false));
    Ok(serde_json::json!({"ok": ok, "results": out}))
}

#[derive(serde::Serialize)]
pub struct SyncAgg {
    pub added: usize, pub updated: usize, pub skipped: usize, pub conflicts: usize,
    pub failed: usize, pub excluded: usize, pub removed: usize,
}

pub fn sync_binding(conn: &Connection, hub: &Path, bid: i64, dir_id: i64, tid: i64,
                    mode: &str, force: bool, actor: &str) -> Result<SyncAgg> {
    let _tname: String = conn.query_row("SELECT name FROM targets WHERE id=?1",
        rusqlite::params![tid], |r| r.get(0)).unwrap_or_default();
    let all_names = dir_item_names(conn, dir_id, KIND);
    let excluded: Vec<String> = {
        let raw: String = conn.query_row("SELECT excluded FROM dir_bindings WHERE id=?1",
            rusqlite::params![bid], |r| r.get(0)).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&raw).unwrap_or_default()
    };
    let send: Vec<String> = all_names.iter().filter(|n| !excluded.contains(n)).cloned().collect();
    let results = distribute_skills(conn, hub, &send, &[tid], false, force, mode, actor)?;
    let mut agg = SyncAgg { added: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0,
        excluded: excluded.len(), removed: 0 };
    for r in &results {
        match r["status"].as_str() {
            Some("ok") => match r["action"].as_str() {
                Some("create") | Some("adopt") | Some("recreate") => agg.added += 1,
                _ => agg.updated += 1,
            },
            Some("skipped") => agg.skipped += 1,
            Some("conflict") => agg.conflicts += 1,
            _ => agg.failed += 1,
        }
    }
    conn.execute("UPDATE dir_bindings SET last_sync_at=?1, last_result=?2 WHERE id=?3",
                 rusqlite::params![fsutil::now_iso(),
                     serde_json::to_string(&agg).unwrap_or_default(), bid])
        .map_err(CoreError::from)?;
    Ok(agg)
}

// ============ 容器发现 ============

pub fn discover_layout(root: &Path) -> serde_json::Value {
    let mut out = serde_json::json!({"skills": [], "mcp": []});
    fn walk(dir: &Path, rel: &str, depth: usize, out: &mut serde_json::Value) {
        if depth > 4 { return; }
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut names: Vec<String> = entries.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for name in names {
            if name.starts_with('.') || [".git", ".hub-backup", ".versions", "node_modules",
                "__pycache__"].contains(&name.as_str()) || !name_valid(&name) { continue; }
            let full = dir.join(&name);
            if !full.is_dir() { continue; }
            let rel_child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if name == "skills" || name == "mcp" {
                let k = if name == "skills" { "skills" } else { "mcp" };
                let arr = out[k].as_array_mut().unwrap();
                if !arr.contains(&serde_json::Value::String(rel_child.clone())) {
                    arr.push(serde_json::Value::String(rel_child));
                }
                continue;
            }
            walk(&full, &rel_child, depth + 1, out);
        }
    }
    walk(root, "", 1, &mut out);
    out
}

pub struct FoundItem {
    pub kind: String, pub name: String, pub hash: String,
    pub version: Option<String>, pub sub: Option<String>,
}

pub fn scan_sync(conn: &Connection, _hub: &Path, dir_id: i64, name: &str, path: &Path
) -> Result<serde_json::Value> {
    let layout = discover_layout(path);
    let folder_mode = !layout["skills"].as_array().map(|a| a.is_empty()).unwrap_or(true)
        || !layout["mcp"].as_array().map(|a| a.is_empty()).unwrap_or(true);
    let layout_js = if folder_mode { Some(layout.to_string()) } else { None };
    let cur: Option<String> = conn.query_row("SELECT layout FROM local_dirs WHERE id=?1",
        rusqlite::params![dir_id], |r| r.get(0)).ok();
    if cur.as_deref() != layout_js.as_deref() {
        conn.execute("UPDATE local_dirs SET layout=?1 WHERE id=?2",
                     rusqlite::params![layout_js, dir_id]).map_err(CoreError::from)?;
    }
    let mut found: BTreeMap<String, FoundItem> = BTreeMap::new();
    if folder_mode {
        for kind in ["skills", "mcp"] {
            for sub in layout[kind].as_array().cloned().unwrap_or_default() {
                scan_into(&mut found, dir_id, path, sub.as_str().unwrap_or(""), kind)?;
            }
        }
    } else {
        scan_into(&mut found, dir_id, path, "", "skills")?;
        scan_into(&mut found, dir_id, path, "", "mcp")?;
    }
    let mut res = serde_json::json!({"added": [], "updated": [], "removed": [], "skipped": []});
    let mut mine: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT kind, name, version, hash FROM registry_items WHERE dir_id=?1") else { return Ok(res) };
    if let Ok(rows) = stmt.query_map(rusqlite::params![dir_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
    }) {
        for r in rows.flatten() { mine.push(r); }
    }
    for kind in ["skills", "mcp"] {
        for (nm, item) in &found {
            if item.kind != kind { continue; }
            let prev = mine.iter().find(|(k, n, _, _)| k == kind && n == nm).cloned();
            mine.retain(|(k, n, _, _)| !(k == kind && n == nm));
            if let Some((_, _, pv, ph)) = prev {
                if item.hash != ph.as_deref().unwrap_or("") {
                    conn.execute("UPDATE registry_items SET version=?, hash=?, updated_at=?, \
                                  prev_version=?, prev_hash=?, sub_path=? WHERE kind=? AND name=?",
                                 rusqlite::params![item.version, item.hash, fsutil::now_iso(),
                                     pv, ph, item.sub, kind, nm]).map_err(CoreError::from)?;
                    res["updated"].as_array_mut().unwrap().push(
                        serde_json::json!({"kind": kind, "name": nm}));
                }
                continue;
            }
            let clash: bool = conn.query_row(
                "SELECT 1 FROM registry_items WHERE kind=?1 AND name=?2",
                rusqlite::params![kind, nm], |_| Ok(true)).unwrap_or(false);
            if clash {
                res["skipped"].as_array_mut().unwrap().push(
                    serde_json::json!({"kind": kind, "name": nm, "reason": "重名"}));
                continue;
            }
            conn.execute("INSERT INTO registry_items(kind, name, source_id, version, hash, \
                          updated_at, prev_version, prev_hash, dir_id, sub_path) \
                          VALUES(?,?,NULL,?,?,?,?,?,?,?)",
                         rusqlite::params![kind, nm, item.version, item.hash, fsutil::now_iso(),
                             None::<String>, None::<String>, dir_id, item.sub])
                .map_err(CoreError::from)?;
            res["added"].as_array_mut().unwrap().push(serde_json::json!({"kind": kind, "name": nm}));
        }
    }
    for (kind, nm, _, _) in mine {
        conn.execute("DELETE FROM registry_items WHERE kind=?1 AND name=?2 AND dir_id=?3",
                     rusqlite::params![kind, nm, dir_id]).map_err(CoreError::from)?;
        res["removed"].as_array_mut().unwrap().push(serde_json::json!({"kind": kind, "name": nm}));
    }
    let _ = name;
    Ok(res)
}

fn scan_into(out: &mut BTreeMap<String, FoundItem>, dir_id: i64, root: &Path,
             sub: &str, kind: &str) -> Result<()> {
    let base = if sub.is_empty() { root.to_path_buf() }
        else { root.join(sub.replace('/', std::path::MAIN_SEPARATOR_STR)) };
    if !base.is_dir() { return Ok(()); }
    let Ok(entries) = fs::read_dir(&base) else { return Ok(()) };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    let sub_opt = if sub.is_empty() { None } else { Some(sub.to_string()) };
    for entry in names {
        let full = base.join(&entry);
        if kind == "skills" && full.is_dir() {
            if !full.join("SKILL.md").is_file() { continue; }
            let hash = fsutil::tree_hash(&full)?;
            out.insert(entry.clone(), FoundItem { kind: kind.into(), name: entry, hash,
                version: fm_version(&full.join("SKILL.md")), sub: sub_opt.clone() });
        } else if kind == "mcp" && entry.to_lowercase().ends_with(".json") {
            let Some(cfg) = fsutil::read_json(&full) else { continue };
            let is_mcp = cfg.as_object()
                .map(|o| o.contains_key("command") || o.contains_key("url")).unwrap_or(false);
            if !is_mcp { continue; }
            let sha = fsutil::sha256_file(&full)?;
            out.insert(entry.trim_end_matches(".json").to_string(), FoundItem {
                kind: kind.into(), name: entry.trim_end_matches(".json").to_string(),
                hash: sha, version: Some("v2".into()), sub: sub_opt.clone() });
        }
    }
    let _ = dir_id;
    Ok(())
}

// ============ helpers ============

use std::fs;

fn dir_root(conn: &Connection, hub: &Path, dir_id: Option<i64>, kind: &str) -> Result<PathBuf> {
    match dir_id {
        None | Some(0) => Ok(registry_root(hub)),
        Some(id) => {
            let p: Option<String> = conn.query_row("SELECT path FROM local_dirs WHERE id=?1",
                rusqlite::params![id], |r| r.get(0)).ok();
            match p {
                Some(p) => {
                    let layout: serde_json::Value = conn.query_row(
                        "SELECT layout FROM local_dirs WHERE id=?1", rusqlite::params![id],
                        |r| r.get::<_, Option<String>>(0)).ok().flatten()
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(serde_json::Value::Null);
                    let subs = layout[kind].as_array().cloned().unwrap_or_default();
                    let base = PathBuf::from(p);
                    if let Some(first) = subs.first() {
                        Ok(base.join(first.as_str().unwrap_or("")
                            .replace('/', std::path::MAIN_SEPARATOR_STR)))
                    } else { Ok(base) }
                }
                None => Err(CoreError::not_found("本地目录不存在")),
            }
        }
    }
}

fn prev_version_hash(conn: &Connection, name: &str) -> (Option<String>, Option<String>) {
    conn.query_row("SELECT version, hash FROM registry_items WHERE kind=? AND name=?",
        rusqlite::params![KIND, name],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))
        .unwrap_or((None, None))
}

fn backup_dir_entry(backup_root: &Path, name: &str) -> Result<PathBuf> {
    fs::create_dir_all(backup_root).map_err(|e| CoreError::io("建备份目录", e))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut target = backup_root.join(format!("{name}.{stamp}")); let mut n = 1;
    while target.exists() { target = backup_root.join(format!("{name}.{stamp}.{n}")); n += 1; }
    Ok(target)
}

fn walk_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() { rec(&p, out); out.push(p); }
        }
    }
    rec(root, &mut out);
    out
}

fn is_empty_dir(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false)
}

fn shellexpand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") { return format!("{home}/{rest}"); }
    }
    p.to_string()
}

fn ok_err(msg: &str) -> Result<serde_json::Value> {
    Ok(serde_json::json!({"ok": false, "error": msg}))
}

fn json_ok(pairs: &[(&str, serde_json::Value)]) -> serde_json::Value {
    let mut o = serde_json::json!({"ok": true});
    for (k, v) in pairs { o[k] = v.clone(); }
    o
}

fn json_fail(item: &str, target: Option<&str>, target_id: Option<i64>,
             reason: &str, mode: &str, dry_run: bool) -> serde_json::Value {
    serde_json::json!({"item": item,
        "target": target.map(|s| s.into()).unwrap_or(serde_json::Value::Null),
        "target_id": target_id.map(|i| i.into()).unwrap_or(serde_json::Value::Null),
        "status": "failed", "reason": reason, "mode": mode, "dry_run": dry_run})
}
