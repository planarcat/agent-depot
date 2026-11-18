//! 契约1 · 分发语义规格（原 tests/spec/spec_dispatch.py，2026-11-17 迁入）。
//!
//! 契约原文（Plans/Rust化-全盘复盘与迁移方案.md §1.3）：
//! 1. 分发四态：conflict / adopt / skipped / drift 判定、逐文件原子写、
//!    `.hub-backup` 备份、托管清单 {rel: sha256}；
//!    copy 与 link 两种表示互斥，切换时清除另一种表示。
//! 2. 防穿越：distribute 的 name 直接参与 dest 拼接，非法名必须拒绝（2026-11-07 修复后钉住）。
//!
//! 断言强度：L2（响应 shape）+ L3（磁盘副作用：文件内容逐字节/软链接指向/备份）
//! + L4（ops 台账 detail 字段）。错误响应钉结构不钉文案（common::assert_err）。

mod common;

use common::{assert_ok, Resp, Sandbox};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

// ---------- 夹具（原 DispatchSpec 私有助手与模块级 skill_files） ----------

fn skill_files(text: &str, extra: Option<&[(&str, &str)]>) -> Value {
    let mut files = json!({
        "SKILL.md": format!("---\nname: x\nversion: 1.0\n---\n{text}"),
        "helper.py": format!("VALUE = '{text}'\n"),
    });
    if let Some(pairs) = extra {
        for (k, v) in pairs {
            files[*k] = json!(v);
        }
    }
    files
}

fn mk_skill(sb: &Sandbox, name: &str, files: &Value) {
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": name, "files": files}),
    );
    assert_ok(&r, 200);
}

fn mk_target(sb: &Sandbox, name: &str) -> (std::path::PathBuf, i64) {
    let path = sb.root().join(name);
    fs::create_dir_all(&path).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": name, "kind": "skills_dir", "path": path.to_str().unwrap()}),
    );
    assert_ok(&r, 200);
    (path, r.body["id"].as_i64().unwrap())
}

fn distribute(sb: &Sandbox, names: &[&str], tid: i64, extra: &[(&str, Value)]) -> Resp {
    let mut body = json!({"names": names, "target_ids": [tid]});
    for (k, v) in extra {
        body[*k] = v.clone();
    }
    sb.reqj("POST", "/api/skills/distribute", &body)
}

fn one(r: &Resp) -> Value {
    assert_eq!(r.status, 200, "{}", common::dump(r));
    assert_eq!(r.body["results"].as_array().unwrap().len(), 1, "{}", common::dump(r));
    r.body["results"][0].clone()
}

fn dep_of(sb: &Sandbox, item: &str, tid: i64) -> Value {
    let r = sb.req("GET", "/api/skills/items?source=manual");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let it = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!(item))
        .unwrap();
    let deps: Vec<&Value> = it["deployments"]
        .as_array()
        .map(|a| a.iter().filter(|x| x["target_id"] == json!(tid)).collect())
        .unwrap_or_default();
    assert_eq!(deps.len(), 1, "{it}");
    deps[0].clone()
}

// ---------- adopt ----------

#[test]
fn test_disp_c1_adopt_identical_preexisting() {
    // 首次分发且目标已有内容与新内容完全一致 → action=adopt（不覆盖不改写）。
    let _g = common::serial();
    let sb = common::sandbox();
    let files = skill_files("adopt-body", None);
    mk_skill(&sb, "adopt-a", &files);
    let (tpath, tid) = mk_target(&sb, "tgt-adopt");
    // 目标预置完全一致内容（用户自己装过同样文件）
    for (rel, text) in files.as_object().unwrap() {
        let full = tpath.join("adopt-a").join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text.as_str().unwrap()).unwrap();
    }
    let r = one(&distribute(&sb, &["adopt-a"], tid, &[]));
    assert_eq!(r["status"], json!("ok"), "{r}");
    assert_eq!(r["action"], json!("adopt"), "{r}");
    assert_eq!(r["files_changed"], json!(0), "{r}"); // 一致 → 零文件变更
}

// ---------- 目录缺失 / recreate ----------

#[test]
fn test_disp_c1_dest_missing_conflict_then_recreate() {
    // 已分发 → 手删目标条目目录 → 再分发 conflict；force → recreate 恢复全部文件。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "recreate-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-recreate");
    let _ = one(&distribute(&sb, &["recreate-a"], tid, &[]));
    fs::remove_dir_all(tpath.join("recreate-a")).unwrap();
    let r = one(&distribute(&sb, &["recreate-a"], tid, &[]));
    assert_eq!(r["status"], json!("conflict"), "{r}"); // 记录存在但目标没了：需 force
    let r2 = one(&distribute(&sb, &["recreate-a"], tid, &[("force", json!(true))]));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    assert_eq!(r2["action"], json!("recreate"), "{r2}");
    assert!(tpath.join("recreate-a").join("SKILL.md").is_file());
}

// ---------- 未托管软链接 ----------

#[test]
fn test_disp_c1_unmanaged_symlink_conflict() {
    // copy 分发遇目标处未托管软链接 → conflict；force 替换链接为托管副本。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "sym-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-sym");
    let other = sb.root().join("sym-other");
    fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(&other, tpath.join("sym-a")).unwrap();
    let r = one(&distribute(&sb, &["sym-a"], tid, &[]));
    assert_eq!(r["status"], json!("conflict"), "{r}");
    let r2 = one(&distribute(&sb, &["sym-a"], tid, &[("force", json!(true))]));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    let p = tpath.join("sym-a");
    assert!(!p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false));
    assert!(p.join("SKILL.md").is_file());
}

// ---------- reg_dir 缺失 / dest 是文件 ----------

#[test]
fn test_disp_c1_reg_dir_missing_failed() {
    // 分发未登记条目 → failed（本地库不存在），不产生副作用。
    let _g = common::serial();
    let sb = common::sandbox();
    let (tpath, tid) = mk_target(&sb, "tgt-missing");
    let r = one(&distribute(&sb, &["no-such-skill"], tid, &[]));
    assert_eq!(r["status"], json!("failed"), "{r}");
    assert!(!tpath.join("no-such-skill").exists());
}

#[test]
fn test_disp_c1_dest_is_file_failed() {
    // 目标处同名位置是普通文件（非目录）→ failed，不破坏该文件。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "filed-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-filed");
    let blocker = tpath.join("filed-a");
    fs::write(&blocker, "user-file").unwrap();
    let r = one(&distribute(&sb, &["filed-a"], tid, &[]));
    assert_eq!(r["status"], json!("failed"), "{r}");
    assert_eq!(fs::read_to_string(&blocker).unwrap(), "user-file"); // 用户文件原样保留
}

// ---------- drift + 新版本叠加 ----------

#[test]
fn test_disp_c1_drift_with_new_version_conflict() {
    // 分发后：本地升级到 v2 + 目标被手改 → 双重冲突 → conflict；force restore。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "drift-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-drift");
    let _ = one(&distribute(&sb, &["drift-a"], tid, &[]));
    // 本地升级 v2
    let r = sb.reqj(
        "PUT",
        "/api/skills/registry/item/drift-a",
        &json!({"files": skill_files("v2", None)}),
    );
    assert_ok(&r, 200);
    // 目标被手改（drift）
    let p = tpath.join("drift-a").join("SKILL.md");
    let mut content = fs::read_to_string(&p).unwrap();
    content.push_str("manual-edit");
    fs::write(&p, content).unwrap();
    let r = one(&distribute(&sb, &["drift-a"], tid, &[]));
    assert_eq!(r["status"], json!("conflict"), "{r}");
    let r2 = one(&distribute(&sb, &["drift-a"], tid, &[("force", json!(true))]));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    assert!(
        fs::read_to_string(tpath.join("drift-a").join("SKILL.md")).unwrap().contains("v2"),
        "restore 到本地库 v2"
    );
    assert!(
        fs::read_to_string(tpath.join("drift-a").join("helper.py")).unwrap().contains("v2"),
        "helper.py restore 到 v2"
    );
}

// ---------- link 模式（5 分支） ----------

#[test]
fn test_disp_c2_link_first_and_follows() {
    // 首次 link 分发 → 软链接指向本地库条目；本地改内容，工具端免分发跟随。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "link-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-link");
    let r = one(&distribute(&sb, &["link-a"], tid, &[("mode", json!("link"))]));
    assert_eq!(r["status"], json!("ok"), "{r}");
    let dest = tpath.join("link-a");
    let md = dest.symlink_metadata().unwrap();
    assert!(md.file_type().is_symlink(), "{r}");
    assert!(dest.join("SKILL.md").is_file());
    // 本地库改内容 → 软链接免分发跟随
    let _ = sb.reqj(
        "PUT",
        "/api/skills/registry/item/link-a",
        &json!({"files": skill_files("v2", None)}),
    );
    assert!(
        fs::read_to_string(dest.join("helper.py")).unwrap().contains("v2"),
        "软链接应跟随本地库更新"
    );
}

#[test]
fn test_disp_c2_link_twice_skipped() {
    // 已是本托管软链接 → 再 link 分发 skipped（幂等）。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "link-b", &skill_files("v1", None));
    let (_tpath, tid) = mk_target(&sb, "tgt-link-b");
    let _ = one(&distribute(&sb, &["link-b"], tid, &[("mode", json!("link"))]));
    let r = one(&distribute(&sb, &["link-b"], tid, &[("mode", json!("link"))]));
    assert_eq!(r["status"], json!("skipped"), "{r}");
}

#[test]
fn test_disp_c2_link_elsewhere_conflict() {
    // 目标软链接指向别处（未托管）→ link 分发 conflict；force 接管。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "link-c", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-link-c");
    let other = sb.root().join("link-other");
    fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(&other, tpath.join("link-c")).unwrap();
    let r = one(&distribute(&sb, &["link-c"], tid, &[("mode", json!("link"))]));
    assert_eq!(r["status"], json!("conflict"), "{r}");
    let r2 = one(&distribute(
        &sb,
        &["link-c"],
        tid,
        &[("mode", json!("link")), ("force", json!(true))],
    ));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    let md = tpath.join("link-c").symlink_metadata().unwrap();
    assert!(md.file_type().is_symlink());
}

#[test]
fn test_disp_c2_copy_then_link_switch() {
    // copy → link 互斥切换：旧托管副本整体备份进 .hub-backup，dest 变软链接。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "sw-a", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-sw");
    let _ = one(&distribute(&sb, &["sw-a"], tid, &[])); // copy
    let r = one(&distribute(&sb, &["sw-a"], tid, &[("mode", json!("link"))]));
    assert_eq!(r["status"], json!("ok"), "{r}");
    let dest = tpath.join("sw-a");
    let md = dest.symlink_metadata().unwrap();
    assert!(md.file_type().is_symlink());
    let backups = tpath.join(".hub-backup");
    assert!(backups.is_dir());
    let mut backed: Vec<String> = fs::read_dir(&backups)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("sw-a."))
        .collect();
    assert!(!backed.is_empty(), "旧副本备份在案");
    backed.sort();
    let bk = backups.join(&backed[0]);
    assert!(bk.join("SKILL.md").is_file()); // <name>.<ts>/ 平铺
    assert!(fs::read_to_string(bk.join("SKILL.md")).unwrap().contains("v1"));
}

#[test]
fn test_disp_c2_link_then_copy_switch() {
    // link → copy 互斥切换：dest 变回实体目录且内容等值。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "sw-b", &skill_files("v1", None));
    let (tpath, tid) = mk_target(&sb, "tgt-sw-b");
    let _ = one(&distribute(&sb, &["sw-b"], tid, &[("mode", json!("link"))]));
    let r = one(&distribute(&sb, &["sw-b"], tid, &[("mode", json!("copy"))]));
    assert_eq!(r["status"], json!("ok"), "{r}");
    let dest = tpath.join("sw-b");
    let md = dest.symlink_metadata().unwrap();
    assert!(!md.file_type().is_symlink());
    assert!(fs::read_to_string(dest.join("SKILL.md")).unwrap().contains("v1"));
}

// ---------- 内容等值 + 托管清单 ----------

#[test]
fn test_disp_c3_content_equality_and_managed_list() {
    // 多文件条目分发：目标逐文件内容字节等值（含嵌套目录）；
    // 部署行 hash 与本地库 hash 一致（items_view.deployments）。
    let _g = common::serial();
    let sb = common::sandbox();
    let files = skill_files(
        "eq",
        Some(&[("nested/deep.txt", "深层内容\n"), ("notes.md", "中文注释")]),
    );
    mk_skill(&sb, "eq-a", &files);
    let (tpath, tid) = mk_target(&sb, "tgt-eq");
    let r = one(&distribute(&sb, &["eq-a"], tid, &[]));
    assert_eq!(r["status"], json!("ok"), "{r}");
    for (rel, text) in files.as_object().unwrap() {
        let p = tpath.join("eq-a").join(rel);
        assert!(p.is_file(), "{rel}");
        assert_eq!(fs::read_to_string(&p).unwrap(), text.as_str().unwrap(), "{rel}"); // 字节等值
    }
    // 部署行：deployed_hash 与本地库 hash 一致
    let r = sb.req("GET", "/api/skills/registry");
    let reg = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("eq-a"))
        .unwrap();
    let dep = dep_of(&sb, "eq-a", tid);
    // registry 视图给 12 位截断 hash；部署行存完整 64 位 → 前缀一致即同内容
    assert!(
        dep["hash"].as_str().unwrap().starts_with(reg["hash"].as_str().unwrap()),
        "reg={} dep={}",
        reg["hash"],
        dep["hash"]
    );
    // 空目录结构也被复制（nested 目录存在）
    assert!(tpath.join("eq-a").join("nested").is_dir());
}

// ---------- 防穿越（2026-11-07 修复后钉住） ----------

#[test]
fn test_disp_c4_traversal_name_rejected() {
    // 反例：name=../evil 直接拒绝（非法条目名），目标目录外无任何写入。
    let _g = common::serial();
    let sb = common::sandbox();
    let (tpath, tid) = mk_target(&sb, "tgt-trav");
    let r = one(&distribute(&sb, &["../evil"], tid, &[]));
    assert_eq!(r["status"], json!("failed"), "{r}");
    assert!(!tpath.parent().unwrap().join("evil").exists());
    assert!(!sb.root().join("evil").exists());
}

#[test]
fn test_disp_c4_traversal_name_mcp_rejected() {
    // 反例（mcp）：name=../evil 拒绝，不写目标配置目录之外。
    let _g = common::serial();
    let sb = common::sandbox();
    let cfg = sb.root().join("mcp.json");
    fs::write(&cfg, "{}").unwrap();
    let r = sb.reqj(
        "POST",
        "/api/mcp/targets",
        &json!({"name": "trav-m", "kind": "mcp_json", "path": cfg.to_str().unwrap(),
                "format_key": "mcpServers"}),
    );
    assert_ok(&r, 200);
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/mcp/distribute",
        &json!({"names": ["../evil"], "target_ids": [tid]}),
    );
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    assert_eq!(r.body["results"][0]["status"], json!("failed"), "{}", common::dump(&r));
    assert_eq!(
        r.body["results"][0]["reason"],
        json!("非法条目名"),
        "{}",
        common::dump(&r)
    );
    assert_eq!(fs::read_to_string(&cfg).unwrap(), "{}"); // 配置未被写坏
}

// ---------- 台账（L4） ----------

#[test]
fn test_disp_c4_ops_detail_contract() {
    // L4：分发台账 detail 契约字段 {files: {rel: sha}, removed, mode}；
    // 冲突记录 reason 在案。
    let _g = common::serial();
    let sb = common::sandbox();
    mk_skill(&sb, "ops-a", &skill_files("v1", None));
    let (_tpath, tid) = mk_target(&sb, "tgt-ops");
    let _ = one(&distribute(&sb, &["ops-a"], tid, &[]));
    let r = sb.req("GET", "/api/ops?module=skills&q=ops-a");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let rows: Vec<&Value> = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["action"] == json!("distribute") && x["item_name"] == json!("ops-a"))
        .collect();
    assert!(!rows.is_empty(), "{}", common::dump(&r));
    let det = Resp::parse_detail(rows[0]); // detail 可能是 JSON 字符串
    assert_eq!(det["actor"], json!("local"), "{det}"); // 包裹结构
    let extra = &det["extra"];
    assert_eq!(extra["mode"], json!("copy"), "{extra}");
    assert_eq!(extra["files"], json!(2), "{extra}"); // 文件计数
    assert_eq!(extra["removed"], json!([]), "{extra}");
}
