//! 行为规格套件 · 共享基座（原 tests/spec/_sandbox.py，2026-11-17 随「去 Python 化」迁入）。
//!
//! 定位（Plans/行为规格测试套件-固化计划.md）：
//! - 全部用例走 HTTP 黑盒：每个测试二进制（tests/spec_*.rs）起一个**专属 depotd 实例 +
//!   独立沙箱根**（对齐原 runner「每文件一个全新 depotd 实例」的隔离语义）；
//! - 二进制内全部用例经 [`serial`] 串行执行（对齐 unittest 文件内串行）；
//! - 每条用例精确断言（状态码 + 响应 shape + 磁盘副作用 + DB 状态 + 台账字段），
//!   按 L0-L4 标注强度；禁止只断 ok=True；
//! - 错误响应钉结构不钉文案：`{ok: False, error 存在 + 类型关键词}` 是契约，
//!   中文逐字文案豁免（变异门禁的 String 存活变异不虚高）；
//! - [`kill9`] + [`Sandbox::respawn`] 让崩溃恢复契约成为**真测**
//!   （Python 版在外部模式下只能软跳）。
//!
//! 断言强度分级：L0 状态码 / L1 ok / L2 响应 shape / L3 磁盘+DB 副作用 / L4 台账 detail 字段。

use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

pub struct Sandbox {
    root: PathBuf,
    pub base: String,
    port: u16,
    child: Mutex<Option<Child>>,
    log: PathBuf,
}

static SANDBOX: OnceLock<Sandbox> = OnceLock::new();
static SERIAL: Mutex<()> = Mutex::new(());
static PID: AtomicU32 = AtomicU32::new(0);
static EXIT_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 二进制内全用例串行（文件级单实例 + 共享沙箱，防夹具互踩）。
pub fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// 取（或在首次调用时 spawn）本测试二进制的专属 depotd 实例。
pub fn sandbox() -> &'static Sandbox {
    SANDBOX.get_or_init(|| {
        let tmp = tempfile::tempdir().expect("建沙箱临时目录失败");
        let root = tmp.path().to_path_buf();
        std::mem::forget(tmp); // 沙箱存活到进程退出，由 atexit 统一 kill + 回收
        fs::create_dir_all(root.join("home")).unwrap();
        fs::create_dir_all(root.join("hub")).unwrap();
        fs::write(
            root.join("mem-src.json"),
            r#"{"mcpServers":{"agentmemory":{"command":"agentmemory-mcp","args":["serve"]}}}"#,
        )
        .unwrap();
        let port = free_port();
        let sb = Sandbox {
            root,
            base: format!("http://127.0.0.1:{port}"),
            port,
            child: Mutex::new(None),
            log: PathBuf::new(),
        };
        let log = sb.root.join("depotd.err");
        let sb = Sandbox { log, ..sb };
        let child = spawn_depotd(&sb);
        PID.store(child.id(), Ordering::SeqCst);
        let _ = EXIT_ROOT.set(sb.root.clone());
        unsafe { libc::atexit(cleanup) };
        *sb.child.lock().unwrap() = Some(child);
        wait_ready(&sb.base);
        sb
    })
}

impl Sandbox {
    /// 沙箱根（原 self.tmp；= runner 的 DEPOT_SANDBOX，与服务端落盘对齐）。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// hub 存储根（AGENT_HUB_DIR）。
    pub fn hub(&self) -> PathBuf {
        self.root.join("hub")
    }

    /// HTTP 黑盒请求，无 body。
    pub fn req(&self, method: &str, path: &str) -> Resp {
        self.req_opt(method, path, None)
    }

    /// HTTP 黑盒请求，body 按 JSON 序列化。
    pub fn reqj(&self, method: &str, path: &str, body: &Value) -> Resp {
        self.req_opt(method, path, Some(body))
    }

    /// 原版 req(method, path, body=None)：错误响应也解析 body（HTTPError → (code, parsed)）。
    pub fn req_opt(&self, method: &str, path: &str, body: Option<&Value>) -> Resp {
        let url = format!("{}{}", self.base, path);
        let mut rq = agent()
            .request(method, &url)
            .set("Content-Type", "application/json");
        let out = match body {
            Some(v) => rq.send_string(&v.to_string()),
            None => rq.call(),
        };
        match out {
            Ok(r) => {
                let status = r.status();
                Resp { status, body: parse_body(r) }
            }
            Err(ureq::Error::Status(code, r)) => Resp { status: code, body: parse_body(r) },
            Err(e) => panic!("req {method} {path} 传输失败：{e}"),
        }
    }

    /// 原始字节请求（/api/backup 二进制下载、/api/ops/export CSV 等非 JSON 端点）。
    pub fn bytes(&self, path: &str) -> (u16, Vec<u8>) {
        match agent().get(&format!("{}{}", self.base, path)).call() {
            Ok(r) => {
                let status = r.status();
                (status, r.into_string().unwrap_or_default().into_bytes())
            }
            Err(ureq::Error::Status(code, r)) => (
                code,
                r.into_string().unwrap_or_default().into_bytes(),
            ),
            Err(e) => panic!("GET {path} 传输失败：{e}"),
        }
    }

    /// kill -9 当前 depotd（崩溃恢复契约用）。测试进程握有生命周期 → 真测可行。
    pub fn kill9(&self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill(); // std::process::Child::kill = SIGKILL
            let _ = child.wait();
        }
        *guard = None;
    }

    /// 同端口 + 同 env 重启（崩溃恢复契约用）。
    pub fn respawn(&self) {
        self.kill9();
        let child = spawn_depotd(self);
        PID.store(child.id(), Ordering::SeqCst);
        *self.child.lock().unwrap() = Some(child);
        wait_ready(&self.base);
    }
}

extern "C" fn cleanup() {
    let pid = PID.load(Ordering::SeqCst);
    if pid != 0 {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
    if let Some(root) = EXIT_ROOT.get() {
        let _ = std::fs::remove_dir_all(root);
    }
}

fn depotd_bin() -> String {
    std::env::var("CARGO_BIN_EXE_depotd").expect("cargo 未注入 CARGO_BIN_EXE_depotd")
}

/// 仓根（静态服务以 cwd 相对解析 web/dist——旧 runner 即从仓根起 depotd）。
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf()
}

/// 每个内置工具的默认根都改道沙箱（原 _sandbox_env；兜底手段是改 HOME）。
fn spawn_depotd(sb: &Sandbox) -> Child {
    let root = &sb.root;
    Command::new(depotd_bin())
        .current_dir(repo_root())
        .arg("--port")
        .arg(sb.port.to_string())
        .arg("serve")
        .env("HOME", root.join("home"))
        .env("AGENT_HUB_DIR", root.join("hub"))
        .env("HUB_CLAUDE_PROJECTS", root.join("claude"))
        .env("CODEX_HOME", root.join("codex"))
        .env("HUB_OPENCODE_DB", root.join("opencode.db"))
        .env("HUB_WORKBUDDY_PROJECTS", root.join("workbuddy"))
        .env("HUB_ZCODE_DB", root.join("zcode.db"))
        .env("HUB_AUTOCLAW_DIR", root.join("autoclaw"))
        .env("HUB_AGENTMEMORY_SRC", root.join("mem-src.json"))
        .env("HUB_PORT", sb.port.to_string())
        .env("DEPOT_SANDBOX", root)
        .stdout(Stdio::null())
        .stderr(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&sb.log)
                .expect("打开 depotd.err 失败"),
        )
        .spawn()
        .expect("spawn depotd 失败（cargo test 应先构建 bin）")
}

fn free_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0 失败");
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

/// 轮询就绪（最多 60×0.2s），替代固定 sleep（原 setUpClass 尾部循环）。
fn wait_ready(base: &str) {
    for _ in 0..60 {
        if let Ok(r) = agent().get(&format!("{base}/api/state")).call() {
            if r.status() == 200 {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("spec depotd 启动失败（{base}），日志见沙箱根 depotd.err");
}

// ------------------------------------------------------------------ HTTP 黑盒

fn agent() -> &'static ureq::Agent {
    static A: OnceLock<ureq::Agent> = OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(15))
            .timeout_write(Duration::from_secs(15))
            .build()
    })
}

fn parse_body(r: ureq::Response) -> Value {
    let text = r.into_string().unwrap_or_default();
    if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }
}

/// 黑盒响应：状态码 + 已解析 JSON（错误响应也解析；空 body → null）。
#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub body: Value,
}

impl Resp {
    /// 台账 detail 等行级字段解析（原版 `json.loads(row["detail"]) if str else row["detail"]`）。
    pub fn parse_detail(row: &Value) -> Value {
        match row.get("detail") {
            Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        }
    }
}

pub fn dump(r: &Resp) -> String {
    format!("status={} body={}", r.status, r.body)
}

/// L1 断言：状态码 + ok 布尔（响应含 ok 字段时才查布尔）。
pub fn assert_ok(r: &Resp, code: u16) {
    assert_eq!(r.status, code, "{}", dump(r));
    if let Some(ok) = r.body.get("ok") {
        assert!(ok.as_bool().unwrap_or(false), "ok 应为 true：{}", dump(r));
    }
}

/// 错误结构契约：状态码 + {ok: False, error 非空}；不钉中文文案。
pub fn assert_err(r: &Resp, code: u16) {
    assert_err_kw(r, code, None);
}

/// 同上，keyword 为类型关键词（不钉文案，对齐原 assertErr(keyword=...)）。
pub fn assert_err_kw(r: &Resp, code: u16, keyword: Option<&str>) {
    assert_eq!(r.status, code, "{}", dump(r));
    let obj = r
        .body
        .as_object()
        .unwrap_or_else(|| panic!("错误响应应为对象：{}", dump(r)));
    if let Some(ok) = obj.get("ok") {
        assert_eq!(ok, &Value::Bool(false), "{}", dump(r));
    }
    let err = obj
        .get("error")
        .unwrap_or_else(|| panic!("缺 error 字段：{}", dump(r)));
    let err_s = match err {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    assert!(!err_s.is_empty(), "{}", dump(r));
    if let Some(kw) = keyword {
        assert!(err_s.contains(kw), "error 应含「{kw}」：{}", dump(r));
    }
}

// ------------------------------------------------------------------ SSE（契约7）

#[derive(Debug)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: Option<String>,
}

/// 打开 /api/events 流（读超时 = read_timeout，超时/断流即 EOF 收尾）。
/// 供后台线程订阅 change 事件（原 _read_sse / listen 线程）。
pub fn open_events(sb: &Sandbox, read_timeout: Duration) -> BufReader<Box<dyn Read + Send>> {
    open_events_from(&sb.base, read_timeout)
}

/// 同上，直接吃 base URL（后台线程不便传 &Sandbox 时用）。
pub fn open_events_from(base: &str, read_timeout: Duration) -> BufReader<Box<dyn Read + Send>> {
    let a = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(read_timeout)
        .build();
    let r = a
        .get(&format!("{base}/api/events"))
        .set("Accept", "text/event-stream")
        .call()
        .unwrap_or_else(|e| panic!("SSE 连接失败：{e}"));
    BufReader::new(r.into_reader())
}

/// 读 SSE 流至超时（秒），返回 (status, events)。超时/断流即收尾（原 _read_sse）。
pub fn read_sse(sb: &Sandbox, seconds: f64) -> (u16, Vec<SseEvent>) {
    let a = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_millis((seconds * 1000.0) as u64))
        .build();
    match a
        .get(&format!("{}/api/events", sb.base))
        .set("Accept", "text/event-stream")
        .call()
    {
        Ok(r) => {
            let status = r.status();
            (status, drain_events(BufReader::new(r.into_reader())))
        }
        Err(ureq::Error::Status(code, _)) => (code, vec![]),
        Err(e) => panic!("SSE 连接失败：{e}"),
    }
}

/// 逐行解析 SSE 帧（event: / data: / 空行成帧），超时或断流即收尾。
pub fn drain_events<R: BufRead>(mut reader: R) -> Vec<SseEvent> {
    let mut events = vec![];
    let mut ev: Option<String> = None;
    let mut data: Option<String> = None;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim();
        if let Some(v) = line.strip_prefix("event: ") {
            ev = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("data: ") {
            data = Some(v.to_string());
        } else if line.is_empty() && (ev.is_some() || data.is_some()) {
            events.push(SseEvent { event: ev.take(), data: data.take() });
        }
    }
    events
}
