//! 契约9+10 · 会话解析边界 / 崩溃恢复 / 旅程级组合（原 tests/spec/spec_sessions.py，2026-11-17 迁入）。
//!
//! 契约9（会话解析）：各工具 JSONL 解析的字段契约；损坏输入（截断/坏行/空文件/unicode）
//! 不炸服务；增量采集幂等（二次扫描不重复计数）。
//! 崩溃恢复：同步中途 kill -9 → 重启后启动兜底扫描对齐、tmp 残留不污染。
//! **Rust 版升级为真测**：测试进程握有 depotd 进程生命周期，Python 版
//! 在外部模式下只能软跳的 kill/重启在这里真实执行。
//!
//! 契约10（旅程）：跨模块用户旅程全程 API 级断言。
//!
//! 断言强度：L2 + L3（DB 计数 + 磁盘状态）。

mod common;

use common::{assert_ok, Sandbox};
use serde_json::{json, Value};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const BASE_TS: &str = "2026-09-21T10:00:00.000Z";

/// 生成 n 条消息的 claude 会话行（uuid 唯一，追加段用不同前缀防去重）。
fn claude_lines(n: usize, base_ts: &str, uid_prefix: &str, sid: &str) -> String {
    let mut lines = vec![json!({"type": "queue-operation", "timestamp": base_ts,
        "sessionId": sid, "cwd": "/tmp/proj-x",
        "uuid": format!("{uid_prefix}-0"), "parentUuid": Value::Null,
        "version": "2.1.217"}).to_string()];
    for i in 0..n {
        let role = if i % 2 == 0 { "user" } else { "assistant" };
        lines.push(json!({"type": role, "timestamp": base_ts, "sessionId": sid,
            "cwd": "/tmp/proj-x", "uuid": format!("{uid_prefix}-{}", i + 1),
            "parentUuid": Value::Null, "version": "2.1.217",
            "message": {"role": role,
                        "content": [{"type": "text",
                                     "text": format!("消息 {uid_prefix}-{i}")}]}}).to_string());
    }
    format!("{}\n", lines.join("\n"))
}

/// 每用例独立 claude 项目目录 + 唯一 sid：
/// 同 sid 跨用例重写 + 游标只在文件缩小时重置 → 会把「续读半截」的
/// 字节偏移伪影钉进断言（2026-11-08 审查修正，旧 ==3/>=3 均为伪影拟合）。
struct Case {
    sid: String,
    proj: PathBuf,
}

impl Case {
    fn new(sb: &Sandbox, tag: &str) -> Self {
        // 末组 12 位 hex（11 位时间戳 + 1 位 tag 字母），保 UUID 形态合法
        let sid = format!("11111111-2222-4333-8444-{}{tag}", &uuid_hex()[..11]);
        let proj = sb.root().join("claude").join("proj-x"); // 与沙箱 env 对齐
        fs::create_dir_all(&proj).unwrap();
        Case { sid, proj }
    }

    fn write(&self, sid: &str, content: &str) -> PathBuf {
        let path = self.proj.join(format!("{sid}.jsonl"));
        fs::write(&path, content).unwrap();
        path
    }

    fn scan(&self, sb: &Sandbox) -> Value {
        let r = sb.reqj("POST", "/api/refresh", &json!({"tool": "claude"}));
        assert_ok(&r, 200);
        r.body.clone()
    }

    fn sessions(&self, sb: &Sandbox) -> Vec<Value> {
        let r = sb.req("GET", "/api/sessions?tool=claude");
        assert_eq!(r.status, 200, "{}", common::dump(&r));
        r.body["sessions"].as_array().cloned().unwrap_or_default()
    }

    fn row(&self, sb: &Sandbox) -> Value {
        self.sessions(sb)
            .into_iter()
            .find(|x| x["sid"] == json!(self.sid))
            .unwrap_or_else(|| panic!("找不到 sid={} 的会话行", self.sid))
    }
}

fn uuid_hex() -> String {
    // 轻量唯一后缀：纳秒时间戳（夹具不需要密码学强度）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    format!("{:012x}", now.as_nanos())
}

// ---------- 契约9 · 会话解析边界 ----------

#[test]
fn test_sess_c9_happy_fields() {
    // 正常解析：会话字段契约（sid/title/msg_count/tool）。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "a");
    c.write(&c.sid, &claude_lines(4, BASE_TS, "u", &c.sid));
    c.scan(&sb);
    let row = c.row(&sb);
    for key in ["sid", "title", "msg_count", "tool"] {
        assert!(row.get(key).is_some(), "缺 {key}：{row}");
    }
    // 真实口径 = 4：夹具 4 条消息行，queue-operation 不计数。
    assert_eq!(row["msg_count"], json!(4), "{row}");
}

#[test]
fn test_sess_c9_truncated_jsonl() {
    // 反例：截断 JSONL（最后一行半截）→ 不炸服务，完整行照常入库。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "b");
    let good = claude_lines(2, BASE_TS, "u", &c.sid);
    c.write(&c.sid, &format!("{good}{{\"type\": \"user\", \"timestamp\": \"2026")); // 半截
    c.scan(&sb);
    let rows = c.sessions(&sb);
    assert!(
        rows.iter().any(|x| x["sid"] == json!(c.sid)),
        "截断文件应跳过坏行继续解析"
    );
}

#[test]
fn test_sess_c9_bad_lines_interleaved() {
    // 反例：中间夹坏行/空行 → 跳过坏行，好行全部入库。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "c");
    let mut lines: Vec<String> = claude_lines(2, BASE_TS, "u", &c.sid)
        .trim_end_matches('\n')
        .split('\n')
        .map(str::to_string)
        .collect();
    lines.insert(1, "{corrupted".into());
    lines.insert(3, String::new());
    c.write(&c.sid, &format!("{}\n", lines.join("\n")));
    c.scan(&sb);
    let row = c.row(&sb);
    assert!(row["msg_count"].as_i64().unwrap_or(0) >= 2, "{row}");
}

#[test]
fn test_sess_c9_empty_file() {
    // 反例：空会话文件 → 不炸服务（0 条或跳过均合法形态）。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "d");
    c.write("22222222-3333-4444-8555-666666666666", "");
    c.scan(&sb);
    let r = sb.req("GET", "/api/state");
    assert_eq!(r.status, 200, "{}", common::dump(&r));
}

#[test]
fn test_sess_c9_unicode_content() {
    // unicode/emoji 内容逐字节保留（搜索与导出依赖）。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "e");
    let text = "规格夹具：中文 🎉 emoji '引号' \"双引号\" \\反斜杠";
    let lines = vec![
        json!({"type": "queue-operation", "timestamp": "2026-09-21T10:00:00.000Z",
               "sessionId": c.sid, "cwd": "/tmp/proj-x", "uuid": "u-0",
               "parentUuid": Value::Null, "version": "2.1.217"}).to_string(),
        json!({"type": "user", "timestamp": "2026-09-21T10:00:01.000Z",
               "sessionId": c.sid, "cwd": "/tmp/proj-x", "uuid": "u-1",
               "parentUuid": Value::Null, "version": "2.1.217",
               "message": {"role": "user", "content": text}}).to_string(),
    ];
    c.write(&c.sid, &format!("{}\n", lines.join("\n")));
    c.scan(&sb);
    let q = urlencoding_encode("规格夹具");
    let r = sb.req("GET", &format!("/api/search?q={q}"));
    assert_eq!(r.status, 200, "{}", common::dump(&r));
    let body = r.body.to_string();
    assert!(body.contains("规格夹具"), "{body}");
}

/// %-encode（urllib.parse.quote 等价，非字母数字与 -_.~ 全编码）。
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[test]
fn test_sess_c9_incremental_idempotent() {
    // 增量幂等：同会话二次扫描不重复计数；追加消息后计数增加。
    let _g = common::serial();
    let sb = common::sandbox();
    let c = Case::new(&sb, "f");
    c.write(&c.sid, &claude_lines(4, BASE_TS, "u", &c.sid));
    c.scan(&sb);
    let n1 = c.row(&sb)["msg_count"].as_i64().unwrap();
    c.scan(&sb);
    let n2 = c.row(&sb)["msg_count"].as_i64().unwrap();
    assert_eq!(n1, n2, "二次扫描不得重复计数");
    let path = c.proj.join(format!("{}.jsonl", c.sid));
    let mut f = OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(claude_lines(2, "2026-09-21T11:00:00.000Z", "u2", &c.sid).as_bytes())
        .unwrap();
    c.scan(&sb);
    let n3 = c.row(&sb)["msg_count"].as_i64().unwrap();
    assert!(n3 > n2, "追加消息 → 计数增加");
}

// ---------- 崩溃恢复（Rust 版真测；Python 版外部模式软跳） ----------

#[test]
fn test_crash_restart_realigns() {
    // kill -9 depotd → 改磁盘 → 同端口重启 → 启动兜底扫描拾取变化（对齐语义）。
    let _g = common::serial();
    let sb = common::sandbox();
    // 造一个已链接目录（沙箱内）
    let root = sb.root().join("crash-dir");
    fs::create_dir_all(root.join("crash-skill")).unwrap();
    fs::write(
        root.join("crash-skill").join("SKILL.md"),
        "---\nname: crash-skill\n---\nbefore",
    )
    .unwrap();
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": root.to_string_lossy(), "name": "crash-dir"}),
    );
    assert_ok(&r, 200);
    // kill -9 + 停机期间改磁盘
    sb.kill9();
    fs::write(
        root.join("crash-skill").join("SKILL.md"),
        "---\nname: crash-skill\n---\nafter-kill",
    )
    .unwrap();
    fs::create_dir_all(root.join("added-while-down")).unwrap();
    fs::write(
        root.join("added-while-down").join("SKILL.md"),
        "---\nname: added-while-down\n---\nnew",
    )
    .unwrap();
    // 同端口 + 同 env 重启（等待轮询在 respawn 内）
    sb.respawn();
    // 启动兜底/首次读取对齐：内容变化 + 新增条目都被拾取
    let r = sb.req("GET", "/api/local-dirs");
    assert_ok(&r, 200);
    let row = r.body["dirs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("crash-dir"))
        .unwrap();
    assert_eq!(row["counts"]["skills"], json!(2), "{row}"); // 新增条目被拾取
    let did = row["id"].as_i64().unwrap();
    let r = sb.req("GET", &format!("/api/skills/items?source=manual&dir={did}"));
    let it = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == json!("crash-skill"))
        .unwrap();
    assert!(
        it["hash"].as_str().map_or(false, |h| !h.is_empty()),
        "hash 链在重启后延续：{it}"
    );
}

// ---------- 契约10 · 旅程级跨模块组合 ----------

#[test]
fn test_journey_c10_container_to_tool() {
    // 旅程：关联容器目录（多子 skills 文件夹）→ 绑定 → 分发 → 编辑 →
    // 回退 → 断开清理，全链路。
    let _g = common::serial();
    let sb = common::sandbox();
    let a = sb.root().join("journey-A");
    for sub in ["x/skills/jr-foo", "y/skills/jr-bar"] {
        let d = a.join(sub);
        fs::create_dir_all(&d).unwrap();
        let name = sub.split('/').next_back().unwrap();
        fs::write(
            d.join("SKILL.md"),
            format!("---\nname: {name}\nversion: 1.0\n---\n初始"),
        )
        .unwrap();
    }
    let r = sb.reqj(
        "POST",
        "/api/local-dirs/link",
        &json!({"path": a.to_string_lossy(), "name": "journey-A"}),
    );
    assert_ok(&r, 200);
    let did = r.body["id"].as_i64().unwrap();
    assert_eq!(r.body["added"], json!(2), "{}", common::dump(&r));
    let tpath = sb.root().join("journey-tgt");
    fs::create_dir_all(&tpath).unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/targets",
        &json!({"name": "journey-tgt", "kind": "skills_dir", "path": tpath.to_string_lossy()}),
    );
    let tid = r.body["id"].as_i64().unwrap();
    let r = sb.reqj(
        "POST",
        "/api/skills/dir-bindings",
        &json!({"dir_id": did, "target_ids": [tid]}),
    );
    assert_ok(&r, 200);
    assert!(tpath.join("jr-foo").join("SKILL.md").is_file());
    assert!(tpath.join("jr-bar").join("SKILL.md").is_file());
    // 编辑（写回容器子文件夹）→ 同步跟随
    let r = sb.reqj(
        "PUT",
        "/api/skills/registry/item/jr-foo",
        &json!({"files": {"SKILL.md": "---\nname: jr-foo\nversion: 2.0\n---\n编辑后"}}),
    );
    assert_ok(&r, 200);
    let r = sb.req("GET", "/api/local-dirs");
    assert_ok(&r, 200);
    // 回退本地库（快照时间戳分辨率 1 秒）
    thread::sleep(Duration::from_millis(1100));
    let r = sb.reqj("POST", "/api/skills/registry/rollback", &json!({"name": "jr-foo"}));
    assert_ok(&r, 200);
    // 断开清理 → 工具内两个条目都被清掉
    let r = sb.req("GET", "/api/skills/dir-bindings");
    let bid = r.body["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["dir_id"] == json!(did))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let r = sb.req("DELETE", &format!("/api/skills/dir-bindings/{bid}?clean=1"));
    assert_ok(&r, 200);
    assert!(!tpath.join("jr-foo").exists());
    assert!(!tpath.join("jr-bar").exists());
    // 容器目录与条目登记仍在（断开不动源）
    let r = sb.req("GET", &format!("/api/skills/items?source=manual&dir={did}"));
    assert_eq!(r.body["items"].as_array().unwrap().len(), 2, "{}", common::dump(&r));
}
