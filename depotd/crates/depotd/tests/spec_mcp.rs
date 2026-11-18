//! 契约4 · MCP 注入规格（原 tests/spec/spec_mcp.py，2026-11-17 迁入）。
//!
//! 契约原文：JSON 嵌套 key（mcp.servers，ZCode 真实路径）+ TOML `# >>> hub:managed: <name> >>>`
//! 托管块、手改检测（不带 force → conflict）、摘除时 injected 不匹配不碰、
//! delete 守卫（已写入目标须确认）、非法目标 JSON → failed。
//!
//! 断言强度：L2 + L3（配置文件逐字节结构 + 备份）。

mod common;

use common::{assert_err_kw, assert_ok, Sandbox};
use serde_json::{json, Value};
use std::fs;

fn mk_mcp_item(sb: &Sandbox, name: &str, command: Option<&str>) {
    let r = sb.reqj(
        "POST",
        "/api/mcp/registry/item",
        &json!({"name": name, "config": {"command": command.unwrap_or(&format!("cmd-{name}")), "args": []}}),
    );
    assert_ok(&r, 200);
}

fn mk_json_target(
    sb: &Sandbox,
    name: &str,
    format_key: &str,
    initial: Option<Value>,
) -> (std::path::PathBuf, i64) {
    let cfg = sb.root().join(format!("{name}.json"));
    fs::write(&cfg, serde_json::to_string(&initial.unwrap_or(json!({}))).unwrap()).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/mcp/targets",
        &json!({"name": name, "kind": "mcp_json", "path": cfg.to_str().unwrap(),
                "format_key": format_key}),
    );
    assert_ok(&r, 200);
    (cfg, r.body["id"].as_i64().unwrap())
}

fn mk_toml_target(sb: &Sandbox, name: &str, initial: &str) -> (std::path::PathBuf, i64) {
    let cfg = sb.root().join(format!("{name}.toml"));
    fs::write(&cfg, initial).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/mcp/targets",
        &json!({"name": name, "kind": "mcp_toml", "path": cfg.to_str().unwrap()}),
    );
    assert_ok(&r, 200);
    (cfg, r.body["id"].as_i64().unwrap())
}

fn dist(sb: &Sandbox, names: &[&str], tid: i64, force: Option<bool>) -> Value {
    let mut body = json!({"names": names, "target_ids": [tid]});
    if let Some(f) = force {
        body["force"] = json!(f);
    }
    let r = sb.reqj("POST", "/api/mcp/distribute", &body);
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    r.body["results"][0].clone()
}

fn delete_item(sb: &Sandbox, name: &str, force: bool) -> common::Resp {
    let body = if force { json!({"force": true}) } else { json!({}) };
    sb.reqj("DELETE", &format!("/api/mcp/registry/item/{name}"), &body)
}

// ---------- 嵌套 key（ZCode 真实路径，此前零覆盖） ----------

#[test]
fn test_mcp_c4_nested_key_inject_and_remove() {
    // format_key=mcp.servers：注入写入嵌套 section；摘除同步移除。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_json_target(
        &sb,
        "nest",
        "mcp.servers",
        Some(json!({"mcp": {"servers": {}, "other": {"keep": 1}}})),
    );
    mk_mcp_item(&sb, "nest-a", None);
    let r = dist(&sb, &["nest-a"], tid, None);
    assert_eq!(r["status"], json!("ok"), "{r}");
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(data["mcp"]["servers"]["nest-a"]["command"], json!("cmd-nest-a"), "{data}");
    assert_eq!(data["mcp"]["other"], json!({"keep": 1}), "{data}"); // 邻居 section 不动
    // 摘除：嵌套键同步移除，邻居保留（已写入目标：delete 须 force，守卫另有专测）
    let r = delete_item(&sb, "nest-a", true);
    assert_ok(&r, 200);
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert!(
        data["mcp"]["servers"].get("nest-a").is_none(),
        "{data}"
    );
    assert_eq!(data["mcp"]["other"], json!({"keep": 1}), "{data}");
}

#[test]
fn test_mcp_c4_section_put_overwrites_nondict_layer() {
    // 反例钉现状：目标层是非 dict（数组）→ 静默替换为对象。
    // （破坏性写入无 conflict——历史上需显式决策是否保留该行为，现钉住）
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_json_target(
        &sb,
        "nd",
        "mcp.servers",
        Some(json!({"mcp": {"servers": ["a", "b"]}})),
    );
    mk_mcp_item(&sb, "nd-a", None);
    let r = dist(&sb, &["nd-a"], tid, None);
    assert_eq!(r["status"], json!("ok"), "{r}"); // 钉现状：不冲突、直接替换
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(data["mcp"]["servers"]["nd-a"]["command"], json!("cmd-nd-a"), "{data}");
}

// ---------- 手改检测 ----------

#[test]
fn test_mcp_c4_json_manual_edit_conflict() {
    // 托管注入后被外部手改、不带 force → conflict；force 才覆盖。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_json_target(&sb, "edit-j", "mcpServers", None);
    mk_mcp_item(&sb, "edit-a", None);
    assert_eq!(dist(&sb, &["edit-a"], tid, None)["status"], json!("ok"));
    let mut data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    data["mcpServers"]["edit-a"]["command"] = json!("user-tampered");
    fs::write(&cfg, serde_json::to_string(&data).unwrap()).unwrap();
    let r = dist(&sb, &["edit-a"], tid, None);
    assert_eq!(r["status"], json!("conflict"), "{r}");
    let r2 = dist(&sb, &["edit-a"], tid, Some(true));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(data["mcpServers"]["edit-a"]["command"], json!("cmd-edit-a"));
}

#[test]
fn test_mcp_c4_toml_manual_edit_conflict() {
    // TOML 托管块被手改、不带 force → conflict；force 重写。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_toml_target(&sb, "edit-t", "[other]\nkey = 1\n");
    mk_mcp_item(&sb, "edit-b", None);
    assert_eq!(dist(&sb, &["edit-b"], tid, None)["status"], json!("ok"));
    let text = fs::read_to_string(&cfg).unwrap().replace("cmd-edit-b", "tampered-cmd");
    fs::write(&cfg, text).unwrap();
    let r = dist(&sb, &["edit-b"], tid, None);
    assert_eq!(r["status"], json!("conflict"), "{r}");
    let r2 = dist(&sb, &["edit-b"], tid, Some(true));
    assert_eq!(r2["status"], json!("ok"), "{r2}");
    let out = fs::read_to_string(&cfg).unwrap();
    assert!(out.contains("cmd-edit-b"), "{out}");
    assert!(out.contains("[other]"), "{out}"); // 原生表保留
}

// ---------- TOML 块被手删 / 末尾换行 ----------

#[test]
fn test_mcp_c4_toml_block_deleted_recreate() {
    // 托管块被手删（dep 在案）→ 再分发重建块。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_toml_target(&sb, "del-t", "");
    mk_mcp_item(&sb, "del-a", None);
    assert_eq!(dist(&sb, &["del-a"], tid, None)["status"], json!("ok"));
    let text = fs::read_to_string(&cfg).unwrap();
    let start = text
        .find("# >>> hub:managed: del-a >>>")
        .expect("真实托管块标记应在案");
    fs::write(&cfg, &text[..start]).unwrap(); // 手删托管块
    let r = dist(&sb, &["del-a"], tid, None);
    assert_eq!(r["status"], json!("ok"), "{r}"); // 重建
    assert!(fs::read_to_string(&cfg).unwrap().contains("cmd-del-a"));
}

#[test]
fn test_mcp_c4_toml_trailing_newline() {
    // 注入后文件末尾必须有换行（POSIX 文本文件契约）。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_toml_target(&sb, "nl-t", "");
    mk_mcp_item(&sb, "nl-a", None);
    assert_eq!(dist(&sb, &["nl-a"], tid, None)["status"], json!("ok"));
    assert!(fs::read_to_string(&cfg).unwrap().ends_with('\n'));
}

// ---------- 非法目标 ----------

#[test]
fn test_mcp_c4_invalid_target_json_failed() {
    // 目标文件不是合法 JSON → failed（不产生部分写入）。
    let _g = common::serial();
    let sb = common::sandbox();
    let cfg = sb.root().join("broken.json");
    fs::write(&cfg, "{not-json").unwrap();
    let r = sb.reqj(
        "POST",
        "/api/mcp/targets",
        &json!({"name": "broken", "kind": "mcp_json", "path": cfg.to_str().unwrap(),
                "format_key": "mcpServers"}),
    );
    assert_ok(&r, 200);
    mk_mcp_item(&sb, "brk-a", None);
    let r = dist(&sb, &["brk-a"], r.body["id"].as_i64().unwrap(), None);
    assert_eq!(r["status"], json!("failed"), "{r}");
    assert_eq!(fs::read_to_string(&cfg).unwrap(), "{not-json"); // 原样保留
}

// ---------- delete 守卫 / -deleted 转存 ----------

#[test]
fn test_mcp_c4_delete_guard_and_versions_move() {
    // delete 守卫：已写入目标 → 不带 force 拒绝；force 后注入摘除 +
    // registry 文件转存 .versions/<name>/…-deleted。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_json_target(&sb, "del-g", "mcpServers", None);
    mk_mcp_item(&sb, "del-g-a", None);
    assert_eq!(dist(&sb, &["del-g-a"], tid, None)["status"], json!("ok"));
    let r = delete_item(&sb, "del-g-a", false); // 不带 force
    assert_err_kw(&r, 400, Some("目标配置"));
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert!(!data["mcpServers"]["del-g-a"].is_null(), "{data}");
    let r = delete_item(&sb, "del-g-a", true);
    assert_ok(&r, 200);
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert!(data["mcpServers"].get("del-g-a").is_none(), "{data}");
    let vroot = sb.hub().join("registry").join(".versions").join("mcp").join("del-g-a");
    assert!(vroot.is_dir(), "vroot={}", vroot.display());
    let has_deleted = std::fs::read_dir(&vroot)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().ends_with("-deleted"));
    assert!(has_deleted, "vroot={}", vroot.display());
}

#[test]
fn test_mcp_c4_delete_injected_mismatch_kept() {
    // 反例：注入内容被外部整个替换 → delete force 也不碰目标（injected 不匹配）。
    let _g = common::serial();
    let sb = common::sandbox();
    let (cfg, tid) = mk_json_target(&sb, "mis-m", "mcpServers", None);
    mk_mcp_item(&sb, "mis-a", None);
    assert_eq!(dist(&sb, &["mis-a"], tid, None)["status"], json!("ok"));
    let mut data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    data["mcpServers"]["mis-a"] = json!({"command": "completely-different"});
    fs::write(&cfg, serde_json::to_string(&data).unwrap()).unwrap();
    let r = delete_item(&sb, "mis-a", true);
    assert_ok(&r, 200);
    let data: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(
        data["mcpServers"]["mis-a"]["command"],
        json!("completely-different") // 不碰用户手改内容
    );
}
