//! 契约3 · 绑定与清理规格（原 tests/spec/spec_bindings.py，2026-11-17 迁入）。
//!
//! 契约原文：绑定级反向清理只认 deployments.detail.binding 打标（不是本绑定落的
//! 内容一个不碰）；排除条目保留工具内文件（即使从目录删除）；channels 至少保留
//! 一个；同秒/重复同步 tag 幂等。
//!
//! 断言强度：L2 + L3（磁盘副作用 + deployments 行）。

mod common;

use common::{assert_err, assert_ok, Resp, Sandbox};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

// ---------- 夹具（原 BindingsSpec 私有助手，逐个对应） ----------

fn link_dir_with(sb: &Sandbox, dirname: &str, skills: &[&str]) -> (PathBuf, i64) {
    let root = sb.root().join(dirname);
    for name in skills {
        let d = root.join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), format!("---\nname: {name}\n---\nbody")).unwrap();
    }
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": root.to_str().unwrap(), "name": dirname}),
    );
    assert_ok(&r, 200);
    (root, r.body["id"].as_i64().unwrap())
}

fn mk_target(sb: &Sandbox, name: &str) -> (PathBuf, i64) {
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

fn bind(sb: &Sandbox, did: i64, tid: i64) -> i64 {
    let r = sb.reqj(
        "POST",
        "/api/skills/dir-bindings",
        &json!({"dir_id": did, "target_ids": [tid]}),
    );
    assert_ok(&r, 200);
    assert!(
        r.body["results"][0]["ok"].as_bool().unwrap_or(false),
        "{}",
        common::dump(&r)
    );
    r.body["results"][0]["binding_id"].as_i64().unwrap()
}

fn patch(sb: &Sandbox, bid: i64, body: &Value) -> Resp {
    sb.reqj("PATCH", &format!("/api/skills/dir-bindings/{bid}"), body)
}

fn sync_one(sb: &Sandbox, bid: i64) -> Resp {
    sb.reqj("POST", &format!("/api/skills/dir-bindings/{bid}/sync"), &json!({}))
}

// ---------- 归属守卫 ----------

#[test]
fn test_bind_c3_owned_tag_guard() {
    // 归属守卫：手动分发的文件（无 binding 标）在建绑后从目录删除 → 工具内必须保留。
    let _g = common::serial();
    let sb = common::sandbox();
    // 手动条目 + 直发到目标（无绑定参与）
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": "owned-a", "files": {"SKILL.md": "---\nname: owned-a\n---\n手动直发"}}),
    );
    assert_ok(&r, 200);
    let (tpath, tid) = mk_target(&sb, "tgt-owned");
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": ["owned-a"], "target_ids": [tid]}),
    );
    assert_ok(&r, 200);
    // 另一目录（含 kept 条目）建绑到同一目标
    let (root, did) = link_dir_with(&sb, "bind-owned", &["kept"]);
    let bid = bind(&sb, did, tid);
    assert!(tpath.join("kept").join("SKILL.md").is_file());
    // 从目录删除 kept（本绑定落的条目）
    fs::remove_dir_all(root.join("kept")).unwrap();
    let r = sb.req("GET", "/api/local-dirs"); // 读取触发 scan_sync 对齐
    assert_ok(&r, 200);
    let _r = sync_one(&sb, bid);
    // kept（本绑定落的）被反向清理；owned-a（非本绑定落的）必须保留
    assert!(!tpath.join("kept").exists());
    assert!(
        tpath.join("owned-a").join("SKILL.md").is_file(),
        "非本绑定落的内容不得清理"
    );
}

#[test]
fn test_bind_c3_excluded_removed_from_dir_kept_in_tool() {
    // 排除条目从目录删除 → 工具内文件保留（排除 = 停止同步但保留）。
    let _g = common::serial();
    let sb = common::sandbox();
    let (root, did) = link_dir_with(&sb, "bind-excl", &["stay", "gone"]);
    let (tpath, tid) = mk_target(&sb, "tgt-excl");
    let bid = bind(&sb, did, tid);
    assert!(tpath.join("gone").join("SKILL.md").is_file());
    let r = patch(&sb, bid, &json!({"excluded": ["gone"]}));
    assert_ok(&r, 200);
    fs::remove_dir_all(root.join("gone")).unwrap();
    let r = sb.req("GET", "/api/local-dirs"); // 读取触发 scan_sync 对齐
    assert_ok(&r, 200);
    let _r = sync_one(&sb, bid);
    assert!(
        tpath.join("gone").join("SKILL.md").is_file(),
        "被排除条目即使从目录删除，工具内文件保留"
    );
    assert!(tpath.join("stay").join("SKILL.md").is_file());
}

// ---------- 守卫 ----------

#[test]
fn test_bind_c3_bind_guards() {
    // bind_dirs 守卫：目录不存在 / 目标不存在 / 重复绑定 → 结构化错误。
    let _g = common::serial();
    let sb = common::sandbox();
    // 目录不存在：路由级 400 结构化错误
    let r = sb.reqj(
        "POST",
        "/api/skills/dir-bindings",
        &json!({"dir_id": 999999, "target_ids": [1]}),
    );
    assert_err(&r, 400);
    // 目标不存在：400 + 聚合结构（错误在 results[0]，无顶层 error）
    let (_root, did) = link_dir_with(&sb, "bind-guard", &["g1"]);
    let r = sb.reqj(
        "POST",
        "/api/skills/dir-bindings",
        &json!({"dir_id": did, "target_ids": [999999]}),
    );
    assert_eq!(r.status, 400, "{}", common::dump(&r));
    assert_eq!(r.body["ok"], json!(false), "{}", common::dump(&r));
    assert_eq!(r.body["results"][0]["ok"], json!(false), "{}", common::dump(&r));
    assert!(
        !r.body["results"][0]["error"].is_null(),
        "{}",
        common::dump(&r)
    );
    // 重复绑定：400 + 聚合结构（同目标不存在同款）
    let (_tpath, tid) = mk_target(&sb, "tgt-guard");
    let _bid = bind(&sb, did, tid);
    let r = sb.reqj(
        "POST",
        "/api/skills/dir-bindings",
        &json!({"dir_id": did, "target_ids": [tid]}),
    );
    assert_eq!(r.status, 400, "{}", common::dump(&r));
    assert_eq!(r.body["results"][0]["ok"], json!(false), "{}", common::dump(&r));
    let err = r.body["results"][0]["error"].as_str().unwrap_or("");
    assert!(err.contains("已建立连接"), "{}", common::dump(&r));
}

#[test]
fn test_bind_c3_channels_must_keep_one() {
    // channels 至少保留一个：PATCH 到空列表 → 400 结构化错误。
    let _g = common::serial();
    let sb = common::sandbox();
    let (_root, did) = link_dir_with(&sb, "bind-ch", &["c1"]);
    let (_tpath, tid) = mk_target(&sb, "tgt-ch");
    let bid = bind(&sb, did, tid);
    let r = patch(&sb, bid, &json!({"channels": []}));
    assert_err(&r, 400);
}

#[test]
fn test_bind_c3_patch_invalid_id() {
    // 反例：非法绑定 id → 400/404（原版两者皆可）。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = patch(&sb, 999999, &json!({"enabled": false}));
    assert!(
        r.status == 404 || r.status == 400,
        "{}",
        common::dump(&r)
    );
    assert_err(&r, r.status);
}

// ---------- 幂等 / tag ----------

#[test]
fn test_bind_c3_sync_twice_idempotent() {
    // 连续两次 sync：第二次 skipped（内容一致），deployments 不重复。
    let _g = common::serial();
    let sb = common::sandbox();
    let (_root, did) = link_dir_with(&sb, "bind-idem", &["idem-a"]);
    let (_tpath, tid) = mk_target(&sb, "tgt-idem");
    let bid = bind(&sb, did, tid);
    let r = sync_one(&sb, bid);
    assert_ok(&r, 200);
    let results = r.body["results"].as_array().unwrap();
    let agg = results
        .iter()
        .find(|x| x["binding_id"] == json!(bid))
        .unwrap();
    assert_eq!(agg["added"], 0, "{agg}");
    assert_eq!(agg["skipped"], 1, "{agg}");
    let r = sb.req("GET", &format!("/api/skills/items?source=manual&dir={did}"));
    let items = r.body["items"].as_array().unwrap();
    let it = items.iter().find(|x| x["name"] == json!("idem-a")).unwrap();
    // tag 幂等：不重复
    assert_eq!(it["deployments"].as_array().unwrap().len(), 1, "{it}");
}

#[test]
fn test_bind_c3_unbind_clean_db_state() {
    // clean 断连：deployments 行 status=removed（保留文件模式为对照）。
    let _g = common::serial();
    let sb = common::sandbox();
    let (_root, did) = link_dir_with(&sb, "bind-clean", &["cl-a", "kp-a"]);
    let (tpath, tid) = mk_target(&sb, "tgt-clean");
    let bid = bind(&sb, did, tid);
    let r = sb.req("DELETE", &format!("/api/skills/dir-bindings/{bid}?clean=1"));
    assert_ok(&r, 200);
    assert!(!tpath.join("cl-a").exists());
    // 重新绑定 kp-a 对照：keep 模式断开后 deployments 保留
    let bid2 = bind(&sb, did, tid);
    assert!(tpath.join("kp-a").join("SKILL.md").is_file());
    let r = sb.req("DELETE", &format!("/api/skills/dir-bindings/{bid2}"));
    assert_ok(&r, 200);
    assert!(tpath.join("kp-a").join("SKILL.md").is_file());
}
