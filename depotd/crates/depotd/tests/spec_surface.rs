//! 契约5 · Surface 面：错误分支矩阵 / 双零路由 / 幂等矩阵
//! （原 tests/spec/spec_surface.py，2026-11-17 迁入）。
//!
//! 断言强度：L0-L2 为主（状态码 + shape），部分 L3。逐条钉现状——
//! 允许的状态码区间是显式决策点，改动任何一条都应过审。

mod common;

use common::{assert_err, assert_err_kw, assert_ok, Sandbox};
use serde_json::{json, Value};
use std::fs;

// ---------- 错误分支矩阵（SurfaceErrorMatrix） ----------

#[test]
fn test_err_403_static_traversal() {
    // 反例：/assets 路径穿越 → 403，不泄露服务端文件。
    let _g = common::serial();
    let sb = common::sandbox();
    for evil in ["/assets/../server.py", "/assets/../hub/store.py", "/assets/%2e%2e/server.py"] {
        let r = sb.req("GET", evil);
        assert!(
            [403u16, 404].contains(&r.status),
            "{evil} → status={}",
            r.status
        );
        let body = if r.body.is_object() {
            serde_json::to_string(&r.body).unwrap()
        } else {
            format!("{}", r.body)
        };
        let body = body[..body.len().min(200)].to_string();
        assert!(!body.contains("import os"), "{evil}: {body}"); // 服务端源码不泄露
    }
}

#[test]
fn test_err_head_requests() {
    // HEAD：钉现状——/ 与 /api/* 一律 200（不做 404 判定）；响应无 body。
    let _g = common::serial();
    let sb = common::sandbox();
    for path in ["/", "/api/state", "/api/nope"] {
        let r = sb.req("HEAD", path);
        assert_eq!(r.status, 200, "{path}");
        assert!(r.body.is_null(), "{path} HEAD 响应不应有 body：{}", r.body);
    }
}

#[test]
fn test_err_unknown_paths_404() {
    // 未知 GET/POST 路径 → 404 结构化 JSON（不 500）。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/definitely-not-a-route");
    assert_eq!(r.status, 404, "{}", common::dump(&r));
    let r = sb.reqj("POST", "/api/definitely-not-a-route", &json!({}));
    assert_eq!(r.status, 404, "{}", common::dump(&r));
}

#[test]
fn test_err_star_and_memory_delete_400() {
    // star 缺 sid / memory delete 缺 id → 400。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj("POST", "/api/star", &json!({}));
    assert_err(&r, 400);
    let r = sb.reqj("POST", "/api/memory/delete", &json!({}));
    assert_err(&r, 400);
}

#[test]
fn test_err_search_empty_q() {
    // 搜索空 q → 400。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/search?q=");
    assert_err(&r, 400);
}

// ---------- 审计确认的双零路由（SurfaceDoubleZeroRoutes） ----------

#[test]
fn test_sz_doctor_backup_opsexport() {
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/doctor");
    assert_eq!(r.status, 200, "{}", common::dump(&r)); // 聚合 ok 反映检查项（沙箱中 False 合法）
    let checks = r.body["checks"].as_array().expect("checks 应为列表");
    for chk in checks {
        assert!(chk.get("name").is_some(), "{chk}");
        assert!(chk.get("ok").is_some(), "{chk}");
    }
    // /api/backup 是二进制下载（非 JSON）：原始请求
    let (status, blob) = sb.bytes("/api/backup");
    assert_eq!(status, 200);
    assert!(blob.len() > 100, "非空备份体，len={}", blob.len());
    // CSV 导出
    let (status, csv) = sb.bytes("/api/ops/export?format=csv");
    assert_eq!(status, 200);
    let head = &csv[..csv.len().min(200)];
    assert!(
        head.windows(6).any(|w| w == b"module"),
        "CSV 文本头应含 module：{:?}",
        String::from_utf8_lossy(head)
    );
    let r = sb.req("GET", "/api/ops/export?format=json");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    assert!(r.body.is_array() || r.body.is_object(), "{}", common::dump(&r));
}

#[test]
fn test_sz_modules_toggle_gate() {
    // 模块开关（显式 enabled 布尔，非切换）：禁用 → 模块路由 503；启用恢复。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/skills/sources");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let r = sb.reqj("POST", "/api/modules/skills/toggle", &json!({"enabled": false}));
    assert_ok(&r, 200);
    let r = sb.req("GET", "/api/skills/sources");
    assert_err(&r, 503);
    let r = sb.reqj("POST", "/api/modules/skills/toggle", &json!({"enabled": true}));
    assert_ok(&r, 200);
    let r = sb.req("GET", "/api/skills/sources");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    // 未知模块 toggle → 404
    let r = sb.reqj("POST", "/api/modules/ghost/toggle", &json!({"enabled": true}));
    assert_err(&r, 404);
}

#[test]
fn test_sz_remote_repos_crud() {
    // remote-repos：POST 登记 / PATCH 更新 / 400 分支。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj(
        "POST",
        "/api/remote-repos",
        &json!({"name": "spec-repo", "url": "https://example.com/spec.git",
                "branch": "main", "subdir": "", "modules": ["skills"]}),
    );
    assert_ok(&r, 200);
    let rid = match r.body.get("id").filter(|v| !v.is_null()) {
        Some(v) => v.clone(),
        None => r.body["repo"]["id"].clone(),
    };
    assert!(!rid.is_null(), "{}", common::dump(&r));
    let r = sb.reqj("POST", "/api/remote-repos", &json!({"name": "", "url": ""}));
    assert_err(&r, 400);
    let r = sb.reqj(
        "PATCH",
        &format!("/api/remote-repos/{rid}"),
        &json!({"branch": "dev"}),
    );
    assert_ok(&r, 200);
    let r = sb.reqj("PATCH", "/api/remote-repos/abc", &json!({}));
    assert_err(&r, 400);
    let r = sb.req("GET", "/api/remote-repos");
    let row = r.body["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("spec-repo"))
        .unwrap();
    assert_eq!(row["branch"], json!("dev"), "{row}");
}

#[test]
fn test_sz_targets_delete_and_seed() {
    // targets：DELETE（含幂等：目标不存在也 ok=True）/ seed 幂等。
    let _g = common::serial();
    let sb = common::sandbox();
    let tpath = sb.root().join("sz-tgt");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "sz-tgt", "kind": "skills_dir", "path": tpath.to_string_lossy()}),
    );
    assert_ok(&r, 200);
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.req("DELETE", &format!("/api/skills/targets/{tid}"));
    assert_ok(&r, 200);
    let r = sb.req("DELETE", &format!("/api/skills/targets/{tid}"));
    assert_ok(&r, 200); // 幂等删除（历史决策点：是否改 404）
    let r = sb.reqj("POST", "/api/skills/targets/seed", &json!({}));
    assert_ok(&r, 200);
}

#[test]
fn test_sz_tools_reorder_detect_unwire() {
    // tools：reorder / detect / wire→unwire 往返。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/tools");
    assert_ok(&r, 200);
    let ids: Vec<Value> = r.body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    if ids.len() >= 2 {
        let mut rev = ids.clone();
        rev.reverse();
        let r = sb.reqj("POST", "/api/tools/reorder", &json!({"order": rev}));
        if r.body.get("ok").is_some() {
            assert_ok(&r, 200);
        } else {
            assert_eq!(r.status, 200, "{}", common::dump(&r));
        }
    }
    // detect：无内容目录 → 结构化返回（adapter 可为空）
    let empty = sb.root().join("detect-empty");
    fs::create_dir_all(&empty).unwrap();
    let r = sb.reqj("POST", "/api/tools/detect", &json!({"root": empty.to_string_lossy()}));
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    // unwire：未接线工具 → 结构化错误（404/400 均为合法拒绝形态）
    let r = sb.reqj("POST", "/api/tools/agents/unwire-memory", &json!({}));
    assert!([200u16, 400, 404].contains(&r.status), "{}", common::dump(&r));
}

#[test]
fn test_sz_remaining_routes_touch() {
    // 矩阵双零收口：lineage/preview/watch/memory overview+scan/seed。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/lineage?tool=claude&sid=ghost");
    assert!([200u16, 400, 404].contains(&r.status), "{}", common::dump(&r));
    let r = sb.req("GET", "/api/sync/preview?source=ghost&target=ghost");
    assert!([200u16, 400, 404].contains(&r.status), "{}", common::dump(&r));
    let r = sb.req("GET", "/api/watch");
    assert!([200u16, 503].contains(&r.status), "{}", common::dump(&r)); // watcher 未启动 → 503 合法
    let r = sb.req("GET", "/api/memory/overview");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let r = sb.reqj("POST", "/api/memory/scan", &json!({}));
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let r = sb.reqj("POST", "/api/skills/targets/seed", &json!({}));
    assert_ok(&r, 200);
}

#[test]
fn test_sz_attachment_guards() {
    // attachment：缺参数 → 400。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/attachment");
    assert_err(&r, 400);
    let r = sb.req("GET", "/api/attachment?sid=ghost&path=x");
    assert!([400u16, 404].contains(&r.status), "{}", common::dump(&r));
}

#[test]
fn test_sz_skills_source_sync_local() {
    // skills 源 sync-local：登记源后调用，结构化返回（内容为空亦 ok/error 合法）。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj(
        "POST",
        "/api/skills/sources",
        &json!({"name": "spec-src", "kind": "skills", "url": "https://example.com/spec.git"}),
    );
    assert_ok(&r, 200);
    let sid = match r.body.get("id").filter(|v| !v.is_null()) {
        Some(v) => v.clone(),
        None => r.body["source"]["id"].clone(),
    };
    assert!(!sid.is_null(), "{}", common::dump(&r));
    let r = sb.reqj("POST", &format!("/api/skills/sources/{sid}/sync-local"), &json!({}));
    assert!([200u16, 400].contains(&r.status), "{}", common::dump(&r)); // 无本地缓存 → 结构化拒绝
    let r = sb.reqj("POST", "/api/skills/sources/999999/sync-local", &json!({}));
    assert_err(&r, r.status); // 结构化拒绝
}

#[test]
fn test_sz_memory_item_lifecycle_guards() {
    // memory item：GET/PUT/DELETE/adopt 未知 id。钉实际口径（逐方法混合）：
    // GET/DELETE → 404；PUT/adopt → 400；error 文案同为"条目不存在"。
    let _g = common::serial();
    let sb = common::sandbox();
    let expect = [("GET", 404u16), ("PUT", 400), ("DELETE", 404), ("POST", 400)];
    for (method, code) in expect {
        let path = if method == "POST" {
            "/api/memory/item/999999/adopt"
        } else {
            "/api/memory/item/999999"
        };
        let r = match method {
            "GET" => sb.req("GET", path),
            "PUT" => sb.reqj("PUT", path, &json!({"content": "x"})),
            _ => sb.reqj(method, path, &json!({})),
        };
        assert_err_kw(&r, code, Some("不存在"));
    }
    let r = sb.reqj("POST", "/api/memory/distribute", &json!({}));
    assert!([200u16, 400].contains(&r.status), "{}", common::dump(&r)); // 空 memory → ok 空 / 400 皆合法
}

#[test]
fn test_sz_tool_items_extract_sync_guards() {
    // tool-items / extract / tool-sync（skills + mcp）：未知工具 → 结构化错误。
    let _g = common::serial();
    let sb = common::sandbox();
    for prefix in ["skills", "mcp"] {
        let r = sb.req("GET", &format!("/api/{prefix}/tool-items?tool=ghost"));
        assert!([200u16, 400, 404].contains(&r.status), "{}", common::dump(&r));
        let r = sb.reqj(
            "POST",
            &format!("/api/{prefix}/extract"),
            &json!({"tool": "ghost", "name": "x"}),
        );
        assert_err(&r, r.status); // 结构化拒绝（400/404 均合法形态）
        let r = sb.reqj(
            "POST",
            &format!("/api/{prefix}/tool-sync"),
            &json!({"tool": "ghost", "names": []}),
        );
        assert_err(&r, r.status);
    }
}

// ---------- 幂等矩阵（IdempotencyMatrix）：每个写操作执行两次的期望行为 ----------

#[test]
fn test_idem_create_manual_twice() {
    // create ×2：第二次 400 重名（登记以先到者为准）。
    let _g = common::serial();
    let sb = common::sandbox();
    let body = json!({"name": "idem-create", "files": {"SKILL.md": "---\nname: idem-create\n---\nx"}});
    let r = sb.reqj("POST", "/api/skills/registry/item", &body);
    assert_ok(&r, 200);
    let r = sb.reqj("POST", "/api/skills/registry/item", &body);
    assert_err(&r, 400);
}

#[test]
fn test_idem_memory_add_twice() {
    // memory add ×2：两条独立记录（追加语义，非 upsert）。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj("POST", "/api/memory/add", &json!({"body": "规格夹具：幂等记忆"}));
    assert_ok(&r, 200);
    let r = sb.reqj("POST", "/api/memory/add", &json!({"body": "规格夹具：幂等记忆"}));
    assert_ok(&r, 200);
    let r = sb.req("GET", "/api/memories");
    assert_ok(&r, 200);
    let items = r.body["memories"]
        .as_array()
        .cloned()
        .or_else(|| r.body["items"].as_array().cloned())
        .unwrap_or_default();
    let hit = items.iter().filter(|x| x.to_string().contains("幂等记忆")).count();
    assert_eq!(hit, 2, "{items:?}");
}

#[test]
fn test_idem_star_twice() {
    // star ×2：toggle 语义（第二次还原第一次），非重复写入。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.req("GET", "/api/sessions");
    assert_ok(&r, 200);
    let sessions = r.body["sessions"].as_array().cloned().unwrap_or_default();
    if sessions.is_empty() {
        return; // 原版同款：无会话夹具则跳过断言（合法形态）
    }
    let sid = sessions[0]["sid"].clone();
    let r1 = sb.reqj("POST", "/api/star", &json!({"sid": sid}));
    assert_ok(&r1, 200);
    let st1 = r1.body["starred"].as_bool().unwrap();
    let r2 = sb.reqj("POST", "/api/star", &json!({"sid": sid}));
    assert_ok(&r2, 200);
    assert_eq!(
        r2.body["starred"].as_bool().unwrap(),
        !st1,
        "star 应为 toggle：{r1:?} vs {r2:?}"
    );
}

#[test]
fn test_idem_distribute_twice() {
    // distribute ×2：第二次 skipped（内容一致）。API 级补钉：results[0].status=skipped。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": "idem-dist", "files": {"SKILL.md": "---\nname: idem-dist\n---\nx"}}),
    );
    assert_ok(&r, 200);
    let tpath = sb.root().join("idem-tgt");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "idem-tgt", "kind": "skills_dir", "path": tpath.to_string_lossy()}),
    );
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": ["idem-dist"], "target_ids": [tid]}),
    );
    assert_eq!(r.body["results"][0]["status"], json!("ok"), "{}", common::dump(&r));
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": ["idem-dist"], "target_ids": [tid]}),
    );
    assert_eq!(r.body["results"][0]["status"], json!("skipped"), "{}", common::dump(&r));
}

#[test]
fn test_idem_link_dir_twice() {
    // link ×2：同路径第二次 400。
    let _g = common::serial();
    let sb = common::sandbox();
    let ext = sb.root().join("idem-dir");
    fs::create_dir_all(&ext).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": ext.to_string_lossy(), "name": "idem-dir"}),
    );
    assert_ok(&r, 200);
    let r = sb.reqj("POST", "/api/local-dirs/link", &json!({"path": ext.to_string_lossy()}));
    assert_err(&r, 400);
}
