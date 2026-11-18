//! 契约7+8 · SSE 端点层与台账 detail 字段（原 tests/spec/spec_ops_sse.py，2026-11-17 迁入）。
//!
//! 契约7：SSE hello 负载 {rev, backend, degraded, watch}；watcher 未启动 → 503；
//! change 事件负载原样下发；断连自动 unsubscribe。
//! 契约8：台账 detail 包裹结构 {actor, extra}；分发/回退/创建 等操作的
//! extra 字段逐字段钉住（引擎丢任一字段必须红）。

mod common;

use common::{assert_ok, SseEvent};
use serde_json::{json, Value};
use std::fs;
use std::io::BufRead;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

// ---------- 契约7 · SSE 端点层 ----------

#[test]
fn test_sse_c7_hello_shape() {
    // hello 事件负载契约：{rev, backend, degraded, watch}。
    let _g = common::serial();
    let sb = common::sandbox();
    let (status, events) = common::read_sse(&sb, 1.5);
    assert_eq!(status, 200);
    let hellos: Vec<Value> = events
        .iter()
        .filter(|e| e.event.as_deref() == Some("hello"))
        .filter_map(|e: &SseEvent| e.data.as_ref().and_then(|d| serde_json::from_str(d).ok()))
        .collect();
    assert!(!hellos.is_empty(), "events={events:?}");
    let h = &hellos[0];
    for key in ["rev", "backend", "degraded", "watch"] {
        assert!(h.get(key).is_some(), "hello 缺 {key}：{h}");
    }
}

#[test]
fn test_sse_c7_change_event_on_write() {
    // 写盘 → change 事件推送到订阅者（事件负载含 watcher 事件字段）。
    let _g = common::serial();
    let sb = common::sandbox();
    // 后台线程订阅：读到首个 change 事件即回报
    let (tx, rx) = mpsc::channel::<String>();
    let base = sb.base.clone();
    thread::spawn(move || {
        let reader = common::open_events_from(&base, Duration::from_secs(10));
        let mut ev: Option<String> = None;
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if let Some(v) = line.strip_prefix("event: ") {
                ev = Some(v.to_string());
            } else if let Some(d) = line.strip_prefix("data: ") {
                if ev.as_deref() == Some("change") {
                    let _ = tx.send(d.to_string());
                    break;
                }
            }
        }
    });
    thread::sleep(Duration::from_millis(800));
    // 写盘触发 watcher（往链接目录放一个文件）
    let probe_root = sb.root().join("sse-probe");
    let probe = probe_root.join("probe-skill");
    fs::create_dir_all(&probe).unwrap();
    fs::write(probe.join("SKILL.md"), "---\nname: probe-skill\n---\nx").unwrap();
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": probe_root.to_string_lossy(), "name": "sse-probe-dir"}),
    );
    assert_ok(&r, 200);
    let got = rx.recv_timeout(Duration::from_secs(8));
    assert!(got.is_ok(), "未收到 change 事件");
}

// ---------- 契约8 · 台账 detail 字段（逐操作 extra 契约） ----------

#[test]
fn test_ops_c8_distribute_and_rollback_detail() {
    // distribute：extra={files 计数, removed, mode}；rollback：
    // extra={restored_from}；create：extra={files, hash, dir}。
    let _g = common::serial();
    let sb = common::sandbox();
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": "ops-c8", "files": {"SKILL.md": "---\nname: ops-c8\nversion: 1.0\n---\nv1"}}),
    );
    assert_ok(&r, 200);
    let tpath = sb.root().join("ops-c8-tgt");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "ops-c8-tgt", "kind": "skills_dir", "path": tpath.to_string_lossy()}),
    );
    assert_ok(&r, 200);
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": ["ops-c8"], "target_ids": [tid]}),
    );
    assert_ok(&r, 200);
    let _ = sb.reqj(
        "PUT",
        "/api/skills/registry/item/ops-c8",
        &json!({"files": {"SKILL.md": "---\nname: ops-c8\nversion: 1.0\n---\nv2"}}),
    );
    std::thread::sleep(Duration::from_millis(1100)); // 快照时间戳分辨率 1 秒
    let r = sb.reqj("POST", "/api/skills/registry/rollback", &json!({"name": "ops-c8"}));
    assert_ok(&r, 200);
    let r = sb.req("GET", "/api/ops?module=skills&q=ops-c8");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let mut by_action: std::collections::BTreeMap<String, Vec<Value>> = Default::default();
    for row in r.body["items"].as_array().unwrap() {
        if row["item_name"] != json!("ops-c8") {
            continue;
        }
        let det = common::Resp::parse_detail(row);
        assert_eq!(det["actor"], json!("local"), "{row}"); // 包裹结构契约
        by_action
            .entry(row["action"].as_str().unwrap().to_string())
            .or_default()
            .push(det["extra"].clone());
    }
    assert!(by_action.contains_key("create"), "{:?}", by_action.keys());
    let create = &by_action["create"][0];
    assert!(create.get("files").is_some(), "{create}");
    assert!(create.get("hash").is_some(), "{create}");
    assert!(by_action.contains_key("distribute"), "{:?}", by_action.keys());
    let dist = &by_action["distribute"][0];
    for key in ["files", "mode", "removed"] {
        assert!(dist.get(key).is_some(), "distribute extra 缺 {key}：{dist}");
    }
    assert!(by_action.contains_key("rollback"), "{:?}", by_action.keys());
    let rb = &by_action["rollback"][0];
    assert!(rb.get("restored_from").is_some(), "{rb}");
}

#[test]
fn test_ops_c8_failed_reason_truncated() {
    // failed 记录：reason 截断 ≤200（超长错误不撑爆台账）。
    // 触发：名义合法（过 _NAME_RE）但目标处塞普通文件 → 应用阶段异常路径 failed。
    let _g = common::serial();
    let sb = common::sandbox();
    let name = "ops-trunc";
    let r = sb.reqj(
        "POST",
        "/api/skills/registry/item",
        &json!({"name": name, "files": {"SKILL.md": format!("---\nname: {name}\n---\nx")}}),
    );
    assert_ok(&r, 200);
    let tpath = sb.root().join("ops-failed-tgt");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "ops-failed-tgt", "kind": "skills_dir", "path": tpath.to_string_lossy()}),
    );
    assert_ok(&r, 200);
    // 目标处塞普通文件 → 应用阶段抛 NotADirectoryError → 异常路径 failed（带截断 reason）
    fs::write(tpath.join(name), "blocker").unwrap();
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/distribute",
        &json!({"names": [name], "target_ids": [tid]}),
    );
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let r = sb.req("GET", "/api/ops?module=skills&status=failed");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let failed: Vec<&Value> = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["status"] == json!("failed") && x["item_name"] == json!(name))
        .collect();
    assert!(!failed.is_empty(), "{}", common::dump(&r));
    for row in failed {
        let reason = row["reason"].as_str().unwrap_or("");
        assert!(reason.chars().count() <= 200, "reason 过长：{row}");
    }
}
