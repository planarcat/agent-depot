//! 契约 · 链接目录扫描与容器发现（原 tests/spec/spec_dir_scan.py，2026-11-17 迁入）。
//!
//! 契约原文（2026-11-14 agent-skills 事故，discover_layout 两守）：
//! 1. 技能原子性：自带 SKILL.md 的目录是单个条目，其内部树（references/、收编的
//!    上游技能副本）不再下钻找容器——vendored 副本不得被收编为条目；
//! 2. 空壳容器不记录：skills/、mcp/ 里没有有效条目时不算容器，也不把目录抬进
//!    容器模式（否则根层条目全部落空）；
//! 3. 真容器（有货）仍按容器模式扫子条目；无容器走根层扫描（根层每个带
//!    SKILL.md 的子目录 = 一个条目）。
//!
//! 断言强度：L2 响应 shape + L3 local_dirs.layout / 条目清单副作用。

mod common;

use common::{assert_ok, Sandbox};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

// ---------- 夹具（原 DirScanSpec 私有助手） ----------

fn mk_skill(root: &Path, rel: &str) {
    let d = root.join(rel);
    fs::create_dir_all(&d).unwrap();
    let name = rel.split('/').next_back().unwrap();
    fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\nbody")).unwrap();
}

fn link(sb: &Sandbox, root: &Path, name: &str) -> i64 {
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": root.to_str().unwrap(), "name": name}),
    );
    assert_ok(&r, 200);
    r.body["id"].as_i64().unwrap()
}

fn resync(sb: &Sandbox) -> Vec<Value> {
    let r = sb.req("GET", "/api/local-dirs"); // 读取触发 scan_sync
    assert_ok(&r, 200);
    r.body["dirs"].as_array().cloned().unwrap_or_default()
}

/// API 已把 layout 解析成对象或 null（null = 无容器）。
fn layout(sb: &Sandbox, did: i64) -> Option<Value> {
    let row = resync(sb).into_iter().find(|x| x["id"] == json!(did)).unwrap();
    match row.get("layout") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok().filter(|v| !v.is_null()),
        Some(v) => Some(v.clone()),
    }
}

fn items(sb: &Sandbox, did: i64) -> Vec<String> {
    let r = sb.req(
        "GET",
        &format!("/api/skills/items?source=manual&dir={did}&per_page=100"),
    );
    assert_ok(&r, 200);
    let mut names: Vec<String> = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|it| it["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    names
}

// ---------- 技能原子性（2026-11-14 事故复现夹具） ----------

#[test]
fn test_scan_atomic_skill_not_descended() {
    // 自带 SKILL.md 的目录内部不下钻：vendored references/skills 不收编。
    let _g = common::serial();
    let sb = common::sandbox();
    let root = sb.root().join("atomic-dir");
    mk_skill(&root, "plain-a");
    mk_skill(&root, "router"); // 单条目：内部树非容器
    mk_skill(&root, "router/references/skills/html-a");
    mk_skill(&root, "router/references/skills/html-b");
    let did = link(&sb, &root, "atomic-dir");
    assert!(
        layout(&sb, did).is_none(),
        "技能内部树不得发现容器（否则 vendored 副本被收编）"
    );
    assert_eq!(items(&sb, did), vec!["plain-a".to_string(), "router".to_string()]);
}

#[test]
fn test_scan_empty_container_not_folder_mode() {
    // 空壳 skills/ 不算容器：目录退回根层扫描，根层条目不落空。
    let _g = common::serial();
    let sb = common::sandbox();
    let root = sb.root().join("empty-ctr");
    fs::create_dir_all(root.join("skills")).unwrap(); // 空容器
    mk_skill(&root, "real-a");
    let did = link(&sb, &root, "empty-ctr");
    assert!(layout(&sb, did).is_none(), "空壳容器不得抬进容器模式");
    assert_eq!(items(&sb, did), vec!["real-a".to_string()]);
}

#[test]
fn test_scan_real_container_mode_kept() {
    // 真容器（有货）仍按容器模式：只收容器子条目，layout 记录发现。
    let _g = common::serial();
    let sb = common::sandbox();
    let root = sb.root().join("real-ctr");
    fs::create_dir_all(root.join("skills")).unwrap();
    mk_skill(&root, "skills/ta");
    mk_skill(&root, "skills/tb");
    let did = link(&sb, &root, "real-ctr");
    assert_eq!(
        layout(&sb, did),
        Some(json!({"skills": ["skills"], "mcp": []}))
    );
    assert_eq!(items(&sb, did), vec!["ta".to_string(), "tb".to_string()]);
}

#[test]
fn test_scan_mcp_container_needs_valid_entry() {
    // mcp 容器判据与收录一致：无 command/url 的 .json 不算货。
    let _g = common::serial();
    let sb = common::sandbox();
    let root = sb.root().join("mcp-ctr");
    let ctr = root.join("mcp");
    fs::create_dir_all(&ctr).unwrap();
    fs::write(ctr.join("broken.json"), json!({"port": 1}).to_string()).unwrap(); // 无 command/url：无效
    let did = link(&sb, &root, "mcp-ctr");
    assert!(layout(&sb, did).is_none(), "空壳 mcp 容器不得记录");
    fs::write(ctr.join("good.json"), json!({"command": "npx"}).to_string()).unwrap(); // 有效条目 → 容器成立
    assert_eq!(
        layout(&sb, did),
        Some(json!({"skills": [], "mcp": ["mcp"]}))
    );
}
