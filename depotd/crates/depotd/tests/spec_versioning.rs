//! 契约2 · 版本链与回退规格（原 tests/spec/spec_versioning.py，2026-11-17 迁入）。
//!
//! 契约原文：prev_hash/prev_version 链、versions 快照、回退前后互转存（可再切回）；
//! rollback 只作用于本地库，**不自动重新分发**；无快照/空快照 → 守卫拒绝；
//! 同秒多次写 → 快照 `-n` 后缀去碰撞。
//!
//! 断言强度：L2 + L3（磁盘快照/内容）+ L4（ops detail.restored_from）。

mod common;

use common::{assert_err_kw, assert_ok, Sandbox};
use serde_json::{json, Value};
use std::fs;
use std::thread;
use std::time::Duration;

fn skill_files(text: &str) -> Value {
    json!({
        "SKILL.md": format!("---\nname: x\nversion: 1.0\n---\n{text}"),
        "helper.py": format!("VALUE = '{text}'\n"),
    })
}

// ---------- 夹具（原 VersioningSpec 私有助手） ----------

fn mk(sb: &Sandbox, name: &str, text: &str) {
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": name, "files": skill_files(text)}),
    );
    assert_ok(&r, 200);
}

fn edit(sb: &Sandbox, name: &str, text: &str) {
    let r = sb.reqj(
        "PUT",
        &format!("/api/skills/registry/item/{name}"),
        &json!({"files": skill_files(text)}),
    );
    assert_ok(&r, 200);
}

fn rollback(sb: &Sandbox, name: &str, base: &str) -> common::Resp {
    sb.reqj(
        "POST",
        &format!("/api/{base}/registry/rollback"),
        &json!({"name": name}),
    )
}

fn read_local(sb: &Sandbox, name: &str, rel: &str) -> String {
    // 默认库条目落盘内容（hub/registry/skills/<name>/<rel>）。
    let p = sb.hub().join("registry").join("skills").join(name).join(rel);
    assert!(p.is_file(), "name={name} rel={rel}");
    fs::read_to_string(p).unwrap()
}

fn versions_dir(sb: &Sandbox, name: &str) -> std::path::PathBuf {
    sb.hub().join("registry").join(".versions").join("skills").join(name)
}

const WAIT: Duration = Duration::from_millis(1100); // 快照时间戳分辨率 1 秒：间隔 1.1s 保证排序

// ---------- 守卫 ----------

#[test]
fn test_ver_c2_rollback_guard_no_snapshot() {
    // 反例：从未编辑过（无快照）→ rollback 400 + 结构化错误。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "rb-guard", "v1");
    let r = rollback(&sb, "rb-guard", "skills");
    assert_err_kw(&r, 400, Some("快照"));
}

#[test]
fn test_ver_c2_rollback_guard_unknown_item() {
    // 反例：不存在的条目 → 400（无快照路径），不 500。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = rollback(&sb, "rb-ghost", "skills");
    assert_err_kw(&r, 400, Some("快照"));
}

// ---------- 回退与互转存 ----------

#[test]
fn test_ver_c2_rollback_roundtrip_swap() {
    // v1 → 编辑 v2 → 回退(内容/版本回 v1) → 再回退(互转存：回到 v2)。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "rb-a", "v1");
    edit(&sb, "rb-a", "v2");
    let r = rollback(&sb, "rb-a", "skills");
    assert_ok(&r, 200);
    assert!(read_local(&sb, "rb-a", "SKILL.md").contains("v1"));
    assert!(!r.body["restored_from"].is_null(), "{}", common::dump(&r)); // 快照名在响应里
    // 再回退：互转存（当前 v2 已在首次回退时转存）→ 回到 v2
    // 快照时间戳分辨率为 1 秒：间隔 1.1s 保证互转存快照按时间排序（同秒歧义见碰撞用例）
    thread::sleep(WAIT);
    let r2 = rollback(&sb, "rb-a", "skills");
    assert_ok(&r2, 200);
    assert!(read_local(&sb, "rb-a", "SKILL.md").contains("v2"));
}

#[test]
fn test_ver_c2_rollback_does_not_redeploy() {
    // 回退只作用于本地库：已分发到工具的文件保持原版本（不自动重发）。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "rb-dep", "v1");
    let tpath = sb.root().join("tgt-rb-dep");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "tgt-rb-dep", "kind": "skills_dir", "path": tpath.to_str().unwrap()}),
    );
    assert_ok(&r, 200);
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": ["rb-dep"], "target_ids": [tid]}),
    );
    assert_ok(&r, 200);
    edit(&sb, "rb-dep", "v2");
    let r = rollback(&sb, "rb-dep", "skills");
    assert_ok(&r, 200);
    // 回退不触发重分发：目标保持分发时内容（v1）；本地库已回 v1
    assert!(fs::read_to_string(tpath.join("rb-dep").join("SKILL.md")).unwrap().contains("v1"));
    assert!(read_local(&sb, "rb-dep", "SKILL.md").contains("v1"));
    // 部署行保留（未被回退清除）
    let r = sb.req("GET", "/api/skills/items?source=manual");
    let it = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("rb-dep"))
        .unwrap();
    assert!(!it["deployments"].is_null() && it["deployments"].as_array().map_or(false, |a| !a.is_empty()), "{it}");
}

// ---------- 快照碰撞 ----------

#[test]
fn test_ver_c2_snapshot_same_second_collision() {
    // 同秒连续两次编辑 → 两个快照（-n 后缀去碰撞），都能回退到达。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "snap-a", "v1");
    edit(&sb, "snap-a", "v2");
    edit(&sb, "snap-a", "v3"); // 同秒内 → 第二个快照 -1 后缀
    let vroot = versions_dir(&sb, "snap-a");
    let mut snaps: Vec<String> = fs::read_dir(&vroot)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    assert!(snaps.len() >= 2, "{snaps:?}");
    snaps.sort();
    // 逐级回退：v3 → v2 → v1（快照内容互不覆盖）
    let r = rollback(&sb, "snap-a", "skills");
    assert_ok(&r, 200);
    assert!(read_local(&sb, "snap-a", "SKILL.md").contains("v2"));
    thread::sleep(WAIT);
    let r = rollback(&sb, "snap-a", "skills");
    assert_ok(&r, 200);
    // 互转存语义（prev_* 交换 = undo/redo 切换）：再回退回到「上次回退前的版本」
    assert!(read_local(&sb, "snap-a", "SKILL.md").contains("v3"));
    thread::sleep(WAIT);
    let r = rollback(&sb, "snap-a", "skills");
    assert_ok(&r, 200);
    assert!(read_local(&sb, "snap-a", "SKILL.md").contains("v2")); // 再切回
    // 同秒碰撞：连续两次回退（同秒）→ 不 500（-n 后缀去碰撞），
    // 内容 ∈ 有效历史版本，快照目录无丢失
    let body = read_local(&sb, "snap-a", "SKILL.md");
    let r = rollback(&sb, "snap-a", "skills");
    assert_ok(&r, 200);
    let r = rollback(&sb, "snap-a", "skills");
    assert_ok(&r, 200); // 修复前此处 500：File exists
    let body2 = read_local(&sb, "snap-a", "SKILL.md");
    assert!(
        ["v1", "v2", "v3"].iter().any(|v| body2.contains(v)),
        "body={body} body2={body2}"
    );
    let _ = body;
}

// ---------- 台账（L4） ----------

#[test]
fn test_ver_c2_rollback_ops_detail() {
    // L4：rollback 台账 detail.restored_from + item_version 契约。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "rb-ops", "v1");
    edit(&sb, "rb-ops", "v2");
    let r = rollback(&sb, "rb-ops", "skills");
    assert_ok(&r, 200);
    let restored = r.body["restored_from"].clone();
    let r = sb.req("GET", "/api/ops?module=skills&q=rb-ops");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let rows: Vec<&Value> = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["action"] == json!("rollback") && x["item_name"] == json!("rb-ops"))
        .collect();
    assert!(!rows.is_empty(), "{}", common::dump(&r));
    let row = rows[0];
    assert_eq!(row["item_version"], json!("1.0"), "{row}");
    let det = common::Resp::parse_detail(row);
    assert_eq!(det["extra"]["restored_from"], restored, "{det}");
}

// ---------- prev_hash 链 ----------

#[test]
fn test_ver_c2_hash_chain_observable() {
    // 编辑留链的 HTTP 可观测口径：hash 变化；分发后编辑 → modified 标记。
    let _g = common::serial();
    let sb = common::sandbox();
    mk(&sb, "chain-a", "v1");
    let r = sb.req("GET", "/api/skills/registry");
    let h1 = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("chain-a"))
        .unwrap()["hash"]
        .clone();
    edit(&sb, "chain-a", "v2");
    let r = sb.req("GET", "/api/skills/registry");
    let row = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("chain-a"))
        .unwrap();
    assert_ne!(row["hash"], h1, "{row}"); // hash 前移
    assert_eq!(row["modified"], json!(false), "{row}"); // 未分发 → 无漂移
    // 绕过 API 直接改盘（默认库不被 scan_sync 扫描）→ modified 漂移标记
    let p = sb.hub().join("registry").join("skills").join("chain-a").join("SKILL.md");
    let mut content = fs::read_to_string(&p).unwrap();
    content.push_str("out-of-band-edit");
    fs::write(&p, content).unwrap();
    let r = sb.req("GET", "/api/skills/registry");
    let row = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("chain-a"))
        .unwrap();
    assert_eq!(row["modified"], json!(true), "{row}");
}

// ---------- mcp 侧（同一套磁盘语义） ----------

fn m_mk(sb: &Sandbox, name: &str) {
    let r = sb.reqj(
        "POST",
        "/api/mcp/registry/item",
        &json!({"name": name, "config": {"command": format!("demo-{name}"), "args": []}}),
    );
    assert_ok(&r, 200);
}

fn m_edit(sb: &Sandbox, name: &str, cmd: &str) {
    let r = sb.reqj(
        "PUT",
        &format!("/api/mcp/registry/item/{name}"),
        &json!({"config": {"command": cmd}}),
    );
    assert_ok(&r, 200);
}

#[test]
fn test_mver_c2_rollback_guard() {
    let _g = common::serial();
    let sb = common::sandbox();
    m_mk(&sb, "m-rb-guard");
    let r = sb.reqj("POST", "/api/mcp/registry/rollback", &json!({"name": "m-rb-guard"}));
    assert_err_kw(&r, 400, Some("快照"));
}

#[test]
fn test_mver_c2_rollback_roundtrip() {
    let _g = common::serial();
    let sb = common::sandbox();
    m_mk(&sb, "m-rb-a");
    m_edit(&sb, "m-rb-a", "edited-cmd");
    let r = sb.reqj("POST", "/api/mcp/registry/rollback", &json!({"name": "m-rb-a"}));
    assert_ok(&r, 200);
    // 回退后本地库内容回到初版 command
    let r = sb.req("GET", "/api/mcp/item/m-rb-a");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let body = r.body.to_string();
    assert!(body.contains("demo-m-rb-a"), "{body}");
    assert!(!body.contains("edited-cmd"), "{body}");
}
