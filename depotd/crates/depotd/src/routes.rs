//! 全部 /api 路由（Tier 1 契约：spec 78 + e2e 19 + 前端消费面）。
//! 响应口径与 Python server.py 逐条对齐：模块域结果 ok:false → 400；
//! 404 仅用于「不存在」类；模块禁用 → 503。

use std::collections::HashMap;
use std::sync::Arc as _Arc;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, Method, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use futures::StreamExt;
use serde_json::{json, Value};

use crate::AppState;



pub fn router(state: Arc<AppState>) -> Router {
    // MCP 分发函数注入（depot-skills 绑定同步跨模块调用）
    depot_skills::extra::set_mcp_distribute(|conn, names, tids, dry, force| {
        depot_mcp::distribute_mcp(conn, names, tids, dry, force, "local").unwrap_or_default()
    });

    let api = Router::new()
        .route("/api/healthz", get_h(api_healthz))
        .route("/api/state", get_h(api_state))
        .route("/api/events", get_h(api_events))
        .route("/api/watch", get_h(api_watch))
        .route("/api/search", get_h(api_search))
        .route("/api/export", get_h(api_export))
        .route("/api/export/batch", post_h(api_export_batch))
        .route("/api/stats", get_h(api_stats))
        .route("/api/sessions", get_h(api_sessions))
        .route("/api/session", get_h(api_session))
        .route("/api/attachment", any(api_attachment))
        .route("/api/schedule", any(api_schedule))
        .route("/api/memories", get_h(api_memories))
        .route("/api/memory/search", get_h(api_memory_search))
        .route("/api/memory/export", get_h(api_memory_export))
        .route("/api/memory/add", post_h(api_memory_add))
        .route("/api/memory/delete", post_h(api_memory_delete))
        .route("/api/refresh", post_h(api_refresh))
        .route("/api/migrate", post_h(api_migrate))
        .route("/api/star", post_h(api_star))
        .route("/api/frontend-errors", post_h(api_frontend_errors))
        .route("/api/sync/preview", get_h(api_sync_preview))
        .route("/api/lineage", get_h(api_lineage))
        .route("/api/ops", get_h(api_ops))
        .route("/api/ops/export", get_h(api_ops_export))
        .route("/api/doctor", get_h(api_doctor))
        .route("/api/backup", get_h(api_backup))
        .route("/api/tools", any(api_tools_root))
        .route("/api/tools/reorder", post_h(api_tools_reorder))
        .route("/api/tools/detect", post_h(api_tools_detect))
        .route("/api/tools/{tid}", any(api_tools_id))
        .route("/api/tools/{tid}/wire-memory", post_h(api_wire_memory))
        .route("/api/tools/{tid}/unwire-memory", post_h(api_unwire_memory))
        .route("/api/remote-repos", any(api_remote_repos))
        .route("/api/remote-repos/{rid}", any(api_remote_repos_id))
        .route("/api/local-dirs", any(api_local_dirs))
        .route("/api/local-dirs/pick", post_h(api_local_dirs_pick))
        .route("/api/local-dirs/link", post_h(api_local_dirs_link))
        .route("/api/local-dirs/{id}", any(api_local_dirs_id))
        .route("/api/modules", get_h(api_modules))
        .route("/api/modules/{mid}/toggle", post_h(api_modules_toggle))
        .route("/api/skills", any(api_skills))
        .route("/api/skills/{*rest}", any(api_skills))
        .route("/api/mcp", any(api_mcp))
        .route("/api/mcp/{*rest}", any(api_mcp))
        .route("/api/memory/overview", get_h(api_memory_overview))
        .route("/api/memory/scan", post_h(api_memory_scan))
        .route("/api/memory/distribute", post_h(api_memory_distribute))
        .route("/api/memory/item/{iid}", any(api_memory_item))
        .route("/api/memory/item/{iid}/adopt", post_h(api_memory_adopt))
        .with_state(state.clone());

    let sec = axum::middleware::from_fn(security_headers);

    Router::new()
        .route("/", get_h(index_handler))
        .route("/index.html", get_h(index_handler))
        .route("/assets/{*path}", get_h(assets_handler))
        .route("/tests/{*path}", get_h(tests_handler))
        .fallback(api_fallback)
        .merge(api)
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(sec)
        .layer(tower_http::compression::CompressionLayer::new())
        .layer(tower_http::catch_panic::CatchPanicLayer::new())
        .with_state(state)
}

fn get_h<H, T>(h: H) -> axum::routing::MethodRouter<Arc<AppState>>
where
    H: axum::handler::Handler<T, Arc<AppState>>,
    T: 'static,
{
    axum::routing::get(h)
}

fn post_h<H, T>(h: H) -> axum::routing::MethodRouter<Arc<AppState>>
where
    H: axum::handler::Handler<T, Arc<AppState>>,
    T: 'static,
{
    axum::routing::post(h)
}

// ---------- 基础助手 ----------

/// 连接守卫：从 Store 的 'static 池引用直接上锁，无 unsafe、无 transmute。
/// 池与进程同寿（Store::open 时一次性 Box::leak 的 Arc 槽位），守卫可安全
/// 跨作用域返回给 handler 使用。
pub type DbGuard = std::sync::MutexGuard<'static, rusqlite::Connection>;

fn rc(state: &AppState) -> DbGuard {
    state.store.read_static().lock().unwrap()
}

fn wc(state: &AppState) -> DbGuard {
    state.store.write_static().lock().unwrap()
}

fn jerr(status: u16, msg: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(json!({"ok": false, "error": msg}))).into_response()
}

fn jraw(status: u16, v: Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(v)).into_response()
}

/// 域 Result 统一出口：Err 走 CoreError::to_body（稳定 code + status 映射），
/// Ok 走 wrap（ok:false → 400）。模块路由的所有 Err 都该从这里出去，不再 unwrap。
fn wrap_res(r: depot_core::error::Result<Value>) -> Response {
    match r {
        Ok(v) => wrap(v),
        Err(e) => {
            let body = e.to_body();
            jraw(body.status, body.body)
        }
    }
}

/// 域结果统一包口：ok:true → 200；ok:false → 400（Python `200 if r.get("ok") else 400`）。
fn wrap(v: Value) -> Response {
    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(true);
    jraw(if ok { 200 } else { 400 }, v)
}

/// 搜索 snippet：按字符边界切片（字节索引会切进多字节字符 → panic）。
/// 优先在原串上大小写敏感查找（offset 精确）；找不到再退到小写副本
/// （此时 snippet 可能被小写化——可接受的退化，Python 语义为原串切片）。
fn make_snippet(c0: &str, low_query: &str) -> String {
    // 优先原串精确命中；否则在小写副本上找（snippet 会被小写化——可接受的退化）。
    // 全程 char-boundary 安全，杜绝字节切片 panic。
    let (idx, hay_owned, hay): (usize, Option<String>, &str) = match c0.find(low_query) {
        Some(i) => (i, None, c0),
        None => {
            let lc = c0.to_lowercase();
            match lc.find(low_query) {
                Some(i) => (i, Some(lc), ""),
                None => (0, None, c0),
            }
        }
    };
    let hay: &str = hay_owned.as_deref().unwrap_or(hay);
    let floor = |mut i: usize| -> usize {
        while i > 0 && !hay.is_char_boundary(i) { i -= 1; }
        i
    };
    let ceil = |mut i: usize| -> usize {
        while i < hay.len() && !hay.is_char_boundary(i) { i += 1; }
        i
    };
    let start = floor(idx.saturating_sub(30));
    let end = ceil((idx + 120).min(hay.len()));
    let snippet: String = hay[start..end].replace('\n', " ");
    format!("{}{}{}",
        if start > 0 { "…" } else { "" }, snippet,
        if hay.len() > end { "…" } else { "" })
}

/// 白名单布尔解析：bool 直取；字符串 "1"/"true"/"True"/"on"/"yes" 为 true。
/// 注意：这是自定义口径而非 Python bool()（Python 任何非空字符串都是 True，
/// 连 "0"/"false" 也是）——前端实际只传 JSON bool，字符串分支仅为 query
/// 参数兜底，取更防误触的语义。
fn as_bool(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "1" | "true" | "True" | "on" | "yes"),
        Some(Value::Number(n)) => n.as_i64() != Some(0),
        _ => false,
    }
}

fn body_json(bytes: &Bytes) -> Value {
    if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(bytes).unwrap_or(json!({}))
    }
}

/// 写后广播（Python bump_watch 对位）：scope 事件 + 可选重挂 roots。
fn after_write(state: &AppState, scope: &str, refresh_roots: bool) {
    if refresh_roots {
        let hub = depot_core::paths::hub_dir();
        state.watcher.set_roots(&crate::watch_roots(&state.store, &hub));
    }
    state.watcher.bump(scope, false);
}

/// web 根：--web-dir 覆盖 > ./web（开发/生产同源）
fn web_root(state: &AppState) -> PathBuf {
    state
        .web_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("web"))
}

/// 构建产物目录（存在 index.html + manifest.json 才视为就绪）。
fn dist_dir(state: &AppState) -> Option<PathBuf> {
    let d = web_root(state).join("dist");
    (d.join("index.html").is_file() && d.join("manifest.json").is_file()).then_some(d)
}

async fn index_handler(State(state): State<Arc<AppState>>) -> Response {
    // 只服务构建产物：源码目录不再可直接运行（TS 需 bun build）
    let Some(dist) = dist_dir(&state) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Html(
                "<meta charset=\"utf-8\"><h1>前端尚未构建</h1>\
                 <p>在 <code>web/</code> 下执行 <code>bun install &amp;&amp; bun run build</code> 后刷新。</p>",
            ),
        )
            .into_response();
    };
    match std::fs::read_to_string(dist.join("index.html")) {
        Ok(html) => ([(header::CACHE_CONTROL, "no-store")], Html(html)).into_response(),
        Err(_) => jerr(404, "index.html 不存在"),
    }
}

fn serve_subtree(state: &AppState, rel: &str) -> Response {
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        return jerr(403, "forbidden");
    }
    let root = web_root(state);
    // dist 优先（哈希产物），源码目录兜底（开发态）
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dist) = dist_dir(state) {
        candidates.push(dist.join(rel));
    }
    candidates.push(root.join(rel));
    for full in candidates {
        if let Ok(data) = std::fs::read(&full) {
            let ct = mime_of(rel);
            // 哈希文件名 → 长缓存 immutable；其余 no-cache（index/源码兜底）
            let hashed = rel
                .rsplit('/')
                .next()
                .map(|f| f.contains('-') && f.rsplit_once('.').map(|(stem, _)| {
                    stem.rsplit('-').next().map(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or(false)
                }).unwrap_or(false))
                .unwrap_or(false);
            let cache = if hashed {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            return (
                [
                    (header::CONTENT_TYPE, ct.to_string()),
                    (header::CACHE_CONTROL, cache.to_string()),
                ],
                data,
            )
                .into_response();
        }
    }
    jerr(404, "not found")
}

async fn assets_handler(State(state): State<Arc<AppState>>, AxPath(path): AxPath<String>) -> Response {
    serve_subtree(&state, &path)
}

async fn tests_handler(AxPath(path): AxPath<String>) -> Response {
    // e2e 夹具静态目录：仍从仓库 tests/ 直读（不走 web 产物）
    if path.is_empty() || path.contains("..") || path.starts_with('/') {
        return jerr(403, "forbidden");
    }
    match std::fs::read(Path::new("tests").join(&path)) {
        Ok(data) => ([(header::CONTENT_TYPE, mime_of(&path))], data).into_response(),
        Err(_) => jerr(404, "not found"),
    }
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("json") => "application/json",
        Some("md") => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn api_fallback(method: Method, uri: axum::http::Uri) -> Response {
    // HEAD 钉现状（Python do_HEAD 不做 404 判定）：/ 与 /api/* 一律 200 无 body
    if method == Method::HEAD && (uri.path() == "/" || uri.path().starts_with("/api/")) {
        return StatusCode::OK.into_response();
    }
    jraw(404, json!({"error": "not found"}))
}

// ---------- /api/state ----------

fn counts_by_tool(c: &rusqlite::Connection) -> Value {
    let Ok(mut stmt) = c.prepare(
        "SELECT tool, COUNT(*), MAX(updated_at) FROM sessions GROUP BY tool") else { return json!({}) };
    let mut out = serde_json::Map::new();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect::<Vec<_>>())
        .unwrap_or_default();
    for (tool, n, latest) in rows {
        out.insert(tool, json!({"count": n, "latest": latest}));
    }
    Value::Object(out)
}

fn list_sessions(c: &rusqlite::Connection, tool: Option<&str>, q: Option<&str>) -> Vec<Value> {
    let mut sql = String::from(
        "SELECT sid, tool, title, cwd, source_file, started_at, updated_at, msg_count, \
         title_source, starred FROM sessions WHERE 1=1");
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(t) = tool.filter(|t| !t.is_empty() && *t != "all") {
        sql.push_str(" AND tool=?");
        params.push(Box::new(t.to_string()));
    }
    if let Some(qs) = q.filter(|q| !q.is_empty()) {
        sql.push_str(" AND (title LIKE ? OR sid LIKE ?)");
        let pat = format!("%{qs}%");
        params.push(Box::new(pat.clone()));
        params.push(Box::new(pat));
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let Ok(mut stmt) = c.prepare(&sql) else { return vec![] };
    let refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    stmt.query_map(refs.as_slice(), |r| {
        Ok(json!({
            "sid": r.get::<_, String>(0)?, "tool": r.get::<_, String>(1)?,
            "title": r.get::<_, Option<String>>(2)?, "cwd": r.get::<_, Option<String>>(3)?,
            "source_file": r.get::<_, Option<String>>(4)?,
            "started_at": r.get::<_, Option<String>>(5)?,
            "updated_at": r.get::<_, Option<String>>(6)?,
            "msg_count": r.get::<_, i64>(7)?,
            "title_source": r.get::<_, Option<String>>(8)?,
            "starred": r.get::<_, i64>(9)?}))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

fn lineage_info(c: &rusqlite::Connection, tool: &str, sid: &str) -> Option<Value> {
    let lid: Option<String> = c
        .query_row(
            "SELECT lid FROM migrations WHERE (src_tool=?1 AND src_sid=?2) OR (dst_tool=?1 AND dst_sid=?2) LIMIT 1",
            rusqlite::params![tool, sid],
            |r| r.get(0),
        )
        .ok();
    let lid = lid?;
    let migs: Vec<Value> = {
        match c.prepare(
            "SELECT id, ts, src_tool, src_sid, dst_tool, dst_sid, status, src_msg_count \
             FROM migrations WHERE lid=?1 ORDER BY id",
        ) {
            Ok(mut stmt) => stmt
                .query_map([&lid], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?, "ts": r.get::<_, String>(1)?,
                        "src_tool": r.get::<_, String>(2)?, "src_sid": r.get::<_, String>(3)?,
                        "dst_tool": r.get::<_, String>(4)?,
                        "dst_sid": r.get::<_, Option<String>>(5)?,
                        "status": r.get::<_, String>(6)?,
                        "src_msg_count": r.get::<_, Option<i64>>(7)?}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let created_at: Option<String> = c
        .query_row("SELECT created_at FROM lineages WHERE lid=?1", [&lid], |r| r.get(0))
        .ok();
    Some(json!({"lid": lid, "created_at": created_at, "migrations": migs}))
}

fn migration_history(c: &rusqlite::Connection, limit: i64) -> Vec<Value> {
    let Ok(mut stmt) = c.prepare(
        "SELECT id, lid, ts, src_tool, src_sid, dst_tool, dst_sid, status, src_msg_count \
         FROM migrations ORDER BY id DESC LIMIT ?") else { return vec![] };
    stmt.query_map([limit], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?, "lid": r.get::<_, String>(1)?,
            "ts": r.get::<_, String>(2)?, "src_tool": r.get::<_, String>(3)?,
            "src_sid": r.get::<_, String>(4)?, "dst_tool": r.get::<_, String>(5)?,
            "dst_sid": r.get::<_, Option<String>>(6)?, "status": r.get::<_, String>(7)?,
            "src_msg_count": r.get::<_, Option<i64>>(8)?}))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

fn ledger_recent(c: &rusqlite::Connection, limit: i64) -> Vec<Value> {
    let Ok(mut stmt) = c.prepare(
        "SELECT id, ts, action, detail FROM ledger ORDER BY id DESC LIMIT ?") else { return vec![] };
    stmt.query_map([limit], |r| {
        Ok(json!({"id": r.get::<_, i64>(0)?, "ts": r.get::<_, String>(1)?,
            "action": r.get::<_, String>(2)?,
            "detail": r.get::<_, Option<String>>(3)?}))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

fn default_schedule() -> Value {
    json!({
        "all": {"enabled": false, "interval_min": 30},
        "claude": {"enabled": false, "interval_min": 30},
        "codex": {"enabled": false, "interval_min": 30},
        "opencode": {"enabled": false, "interval_min": 30}
    })
}

/// 轻量健康探针（自观测）：进程指标 + 事件水位，供监控采集与 soak 门禁使用。
async fn api_healthz(State(state): State<Arc<AppState>>) -> Response {
    let rss_kb = state.health.rss_kb.load(std::sync::atomic::Ordering::Relaxed);
    let degraded = state.health.degraded.load(std::sync::atomic::Ordering::Relaxed)
        || state.watcher.status()["degraded"].as_bool().unwrap_or(false);
    let fds = std::fs::read_dir("/dev/fd")
        .map(|rd| rd.count())
        .unwrap_or(0);
    jraw(200, json!({
        "ok": !degraded,
        "degraded": degraded,
        "uptime_s": state.health.started.elapsed().as_secs(),
        "rss_kb": rss_kb,
        "fds": fds,
        "rev": state.watcher.rev(),
        "events": state.watcher.status()["events"],
        "watched": state.watcher.status()["watched"],
        "failed_watches": state.watcher.status()["failed_watches"],
        "subs": state.watcher.subscriber_count(),
    }))
}

async fn api_state(State(state): State<Arc<AppState>>) -> Response {
    let c = rc(&state);
    let counts = counts_by_tool(&c);
    let mut tool_list = depot_core::tools::public_list(&c, &counts);
    for t in tool_list.iter_mut() {
        let wired = t
            .get("mcp_config")
            .and_then(|m| m.as_str())
            .map(|m| !m.is_empty())
            .unwrap_or(false);
        t["memory_wired"] = json!(wired);
    }
    let mut sessions = list_sessions(&c, None, None);
    for s in sessions.iter_mut() {
        if let (Some(tool), Some(sid)) = (
            s["tool"].as_str(),
            s["sid"].as_str(),
        ) {
            if let Some(lin) = lineage_info(&c, tool, sid) {
                s["lid"] = lin["lid"].clone();
                s["migrations"] = lin["migrations"].clone();
            }
        }
    }
    let sched_raw = depot_core::tools::get_config(&c, "schedule");
    let schedule: Value = sched_raw
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_else(default_schedule);
    let memories = depot_memory::list_notes(&c, 50);
    let body = json!({
        "version": state.build,
        "rev": state.watcher.rev(),
        "watch": state.watcher.status(),
        "tools": counts,
        "tool_list": tool_list,
        "sessions": sessions,
        "ledger": ledger_recent(&c, 20),
        "migrations": migration_history(&c, 20),
        "schedule": schedule,
        "engine": {"casr": casr_available(), "agentmemory": false},
        "memories": memories,
        "now": depot_core::fsutil::now_iso(),
    });
    jraw(200, body)
}

fn casr_available() -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg("command -v casr >/dev/null 2>&1")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ---------- SSE ----------

async fn api_events(State(state): State<Arc<AppState>>) -> Response {
    let (rev, status_json) = {
        let st = state.watcher.status();
        (st["rev"].as_u64().unwrap_or(0), st)
    };
    let hello = json!({
        "rev": rev,
        "backend": state.watcher.status()["backend"],
        "degraded": false,
        "watch": status_json,
    })
    .to_string();
    let mut rx = state.watcher.subscribe();
    let stream = futures::stream::unfold(
        (rx, tokio::time::interval(std::time::Duration::from_secs(15)), false),
        move |(mut rx, mut ping, mut first)| async move {
            loop {
                if !first {
                    // 先发一条由外部准备的 hello（见 chain），这里只处理后续
                }
                tokio::select! {
                    ev = rx.recv() => {
                        match ev {
                            Ok(payload) => {
                                first = false;
                                return Some((
                                    Ok::<_, std::convert::Infallible>(
                                        SseEvent::default().event("change").data(payload)),
                                    (rx, ping, first),
                                ));
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                // 慢订阅者丢事件：立即推 full=true 让前端全量重取
                                let payload = serde_json::json!({
                                    "rev": 0, "scopes": ["hub"], "full": true, "lagged": n,
                                })
                                .to_string();
                                return Some((
                                    Ok::<_, std::convert::Infallible>(
                                        SseEvent::default().event("change").data(payload)),
                                    (rx, ping, first),
                                ));
                            }
                            Err(_) => {
                                return Some((
                                    Ok::<_, std::convert::Infallible>(
                                        SseEvent::default().event("change").data(
                                            json!({"rev": 0, "scopes": ["hub"], "full": true}).to_string())),
                                    (rx, ping, first),
                                ));
                            }
                        }
                    }
                    _ = ping.tick() => {
                        return Some((
                            Ok::<_, std::convert::Infallible>(
                                SseEvent::default().event("ping").data(
                                    json!({"t": depot_core::fsutil::now_iso()}).to_string())),
                            (rx, ping, first),
                        ));
                    }
                }
            }
        },
    );
    let pre = futures::stream::once(async move {
        Ok::<_, std::convert::Infallible>(
            SseEvent::default().event("hello").data(hello))
    });
    Sse::new(pre.chain(stream))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)).text("ping"))
        .into_response()
}

async fn api_watch(State(state): State<Arc<AppState>>) -> Response {
    let roots = crate::watch_roots(&state.store, &depot_core::paths::hub_dir());
    jraw(200, json!({
        "ok": true,
        "watch": state.watcher.status(),
        "ingest": {"running": true},
        "roots": roots,
    }))
}

// ---------- 会话 ----------

async fn api_sessions(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let c = rc(&state);
    let sessions = list_sessions(&c, q.get("tool").map(|s| s.as_str()), q.get("q").map(|s| s.as_str()));
    jraw(200, json!({"sessions": sessions}))
}

async fn api_session(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(sid) = q.get("id").filter(|s| !s.is_empty()) else {
        return jerr(400, "sid required");
    };
    let c = rc(&state);
    let row: Option<(String, String, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<String>, i64, Option<String>, i64)> = c
        .query_row(
            "SELECT sid, tool, title, cwd, source_file, started_at, updated_at, msg_count, \
             title_source, starred FROM sessions WHERE sid=?1",
            [sid.as_str()],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                    r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
            },
        )
        .ok();
    let Some((sid_, tool, title, cwd, source_file, started_at, updated_at, msg_count,
              title_source, starred)) = row
    else {
        return jraw(404, json!({"error": "not found"}));
    };
    let messages: Vec<Value> = {
        match c.prepare(
            "SELECT seq, ts, role, content, content_type FROM messages WHERE sid=?1 ORDER BY seq",
        ) {
            Ok(mut stmt) => stmt
                .query_map([sid.as_str()], |r| {
                    Ok(json!({
                        "seq": r.get::<_, i64>(0)?, "ts": r.get::<_, Option<String>>(1)?,
                        "role": r.get::<_, Option<String>>(2)?,
                        "content": r.get::<_, Option<String>>(3)?,
                        "content_type": r.get::<_, String>(4)?, "attachments": []}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let _ = sid_;
    let sess = json!({
        "sid": sid, "tool": tool, "title": title, "cwd": cwd,
        "source_file": source_file, "started_at": started_at, "updated_at": updated_at,
        "msg_count": msg_count, "title_source": title_source, "starred": starred,
        "messages": messages,
    });
    jraw(200, sess)
}

/// 全文搜索（分组口径对位 search_messages）。
async fn api_search(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(query) = q.get("q").filter(|s| !s.trim().is_empty()) else {
        return jerr(400, "q 不能为空");
    };
    let c = rc(&state);
    let pat = format!("%{}%", query.trim().replace('%', "\\%"));
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64)> = {
        match c.prepare(
            "SELECT m.sid, m.tool, m.role, m.content, m.ts, s.title, s.starred \
             FROM messages m LEFT JOIN sessions s ON s.sid=m.sid \
             WHERE m.content LIKE ?1 ESCAPE '\\' ORDER BY m.id DESC LIMIT 200",
        ) {
            Ok(mut stmt) => stmt
                .query_map([pat], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let mut grouped: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let low = query.trim().to_lowercase();
    for (sid, tool, role, content, ts, title, starred) in rows {
        let g = grouped.entry(sid.clone()).or_insert_with(|| {
            order.push(sid.clone());
            json!({"sid": sid, "tool": tool, "title": title, "starred": starred,
                   "hits": 0, "snippet": Value::Null})
        });
        g["hits"] = json!(g["hits"].as_i64().unwrap_or(0) + 1);
        if g["snippet"].is_null() {
            let c0 = content.as_deref().unwrap_or("");
            g["snippet"] = json!(make_snippet(c0, &low));
        }
        let _ = (role, ts);
    }
    let mut out: Vec<Value> = order.into_iter().filter_map(|k| grouped.remove(&k)).collect();
    out.sort_by(|a, b| b["hits"].as_i64().unwrap_or(0).cmp(&a["hits"].as_i64().unwrap_or(0)));
    out.truncate(40);
    jraw(200, json!({"ok": true, "results": out}))
}

async fn api_export(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(sid) = q.get("sid").filter(|s| !s.is_empty()) else {
        return jerr(400, "sid required");
    };
    let c = rc(&state);
    let sess: Option<(String, String, Option<String>, Option<String>, i64)> = c
        .query_row(
            "SELECT sid, tool, title, cwd, msg_count FROM sessions WHERE sid=?1",
            [sid.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((sid_, tool, title, cwd, msg_count)) = sess else {
        return jerr(404, "会话不存在");
    };
    let messages: Vec<(Option<String>, Option<String>, Option<String>)> = {
        match c.prepare(
            "SELECT ts, role, content, content_type FROM messages WHERE sid=?1 ORDER BY seq",
        ) {
            Ok(mut stmt) => stmt
                .query_map([sid.as_str()], |r| {
                    Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let body = session_markdown(&c, &sid).unwrap_or_default();
    let export_dir = depot_core::paths::hub_dir().join("exports");
    let _ = std::fs::create_dir_all(&export_dir);
    let safe: String = sid
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(24)
        .collect();
    let fname = format!("{}-{}-{}.md", tool, safe,
        chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = export_dir.join(&fname);
    let nbytes = body.len();
    if std::fs::write(&path, &body).is_err() {
        return jerr(500, "导出写入失败");
    }
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "sessions", actor: "local", kind: "export", subject: None, outcome: "ok",
        error_code: None, extra: json!({"sid": sid, "path": path.to_string_lossy(), "bytes": nbytes}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    jraw(200, json!({"ok": true, "path": path.to_string_lossy(), "bytes": nbytes}))
}

async fn api_export_batch(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let c = rc(&state);
    let sids: Vec<String> = match data.get("sids") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        Some(Value::Null) | None => list_sessions(&c, None, None)
            .into_iter()
            .filter_map(|s| s["sid"].as_str().map(|x| x.to_string()))
            .take(500)
            .collect(),
        _ => return jerr(400, "sids 必须是数组"),
    };
    let export_dir = depot_core::paths::hub_dir().join("exports");
    let _ = std::fs::create_dir_all(&export_dir);
    let zpath = export_dir.join(format!(
        "batch-{}.zip",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    // 逐会话导出 markdown（复用单条导出的行装配），真实 STORED zip 打包
    let mut entries: Vec<depot_core::zipstore::ZipEntry> = Vec::new();
    let mut total_bytes = 0usize;
    for sid in &sids {
        if let Some(md) = session_markdown(&c, sid) {
            total_bytes += md.len();
            let safe: String = sid
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
                .take(24)
                .collect();
            entries.push(depot_core::zipstore::ZipEntry {
                name: format!("{safe}.md"),
                data: md.into_bytes(),
            });
        }
    }
    let count = entries.len();
    let zbody = depot_core::zipstore::build_zip(&entries);
    if std::fs::write(&zpath, &zbody).is_err() {
        return jerr(500, "打包失败");
    }
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "sessions", actor: "local", kind: "export-batch", subject: None, outcome: "ok",
        error_code: None, extra: json!({"count": count}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    jraw(200, json!({"ok": true, "path": zpath.to_string_lossy(), "count": count,
        "bytes": total_bytes, "zip_bytes": zbody.len()}))
}

async fn api_stats(State(state): State<Arc<AppState>>) -> Response {
    let c = rc(&state);
    let (sessions, messages, starred): (i64, i64, i64) = c.query_row(
        "SELECT COUNT(*), COALESCE(SUM(msg_count),0), \
         COALESCE(SUM(CASE WHEN starred=1 THEN 1 ELSE 0 END),0) FROM sessions",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap_or((0, 0, 0));
    let mig: i64 = c.query_row(
        "SELECT COUNT(*) FROM migrations WHERE status='ok'", [], |r| r.get(0)).unwrap_or(0);
    let by_tool: Vec<Value> = {
        match c.prepare(
            "SELECT tool, COUNT(*) AS sessions, COALESCE(SUM(msg_count),0) AS messages \
             FROM sessions GROUP BY tool ORDER BY sessions DESC, tool",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok(json!({"tool": r.get::<_, String>(0)?,
                        "sessions": r.get::<_, i64>(1)?, "messages": r.get::<_, i64>(2)?}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let by_day: Vec<Value> = {
        match c.prepare(
            "SELECT substr(COALESCE(NULLIF(started_at,''), NULLIF(updated_at,''), '0000'),1,10) AS day, \
             COUNT(*) AS sessions FROM sessions GROUP BY day ORDER BY day DESC LIMIT 14",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok(json!({"day": r.get::<_, Option<String>>(0)?,
                        "sessions": r.get::<_, i64>(1)?}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    let by_project: Vec<Value> = {
        match c.prepare(
            "SELECT COALESCE(NULLIF(cwd,''), '(未知)') AS project, COUNT(*) AS sessions \
             FROM sessions GROUP BY project ORDER BY sessions DESC LIMIT 10",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok(json!({"project": r.get::<_, Option<String>>(0)?,
                        "sessions": r.get::<_, i64>(1)?}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    jraw(200, json!({"ok": true, "stats": {
        "totals": {"sessions": sessions, "messages": messages, "starred": starred,
                   "migrations": mig},
        "by_tool": by_tool, "by_day": by_day, "by_project": by_project}}))
}

/// 前端错误/慢渲染上报：批量入 event_log（module=frontend），Ops 页可直接检索。
/// 约束：单批 ≤50 条、message ≤200 字符、detail ≤2000 字符；限流 30 批/分钟（防故障风暴打爆台账）。
async fn api_frontend_errors(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    fn allow_batch() -> bool {
        use std::sync::{Mutex, OnceLock};
        use std::time::Instant;
        static RL: OnceLock<Mutex<(Instant, u32)>> = OnceLock::new();
        let m = RL.get_or_init(|| Mutex::new((Instant::now(), 0)));
        let mut g = m.lock().unwrap();
        if g.0.elapsed().as_secs() >= 60 {
            *g = (Instant::now(), 0);
        }
        if g.1 >= 30 {
            return false;
        }
        g.1 += 1;
        true
    }
    if !allow_batch() {
        return jraw(429, json!({"ok": false, "error": "rate limited"}));
    }
    let data = body_json(&bytes);
    let Some(entries) = data.get("entries").and_then(|v| v.as_array()) else {
        return jerr(400, "entries required");
    };
    let c = wc(&state);
    let mut stored = 0u32;
    for e in entries.iter().take(50) {
        let raw = e.get("message").and_then(|v| v.as_str()).unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        let msg: String = raw.chars().take(200).collect();
        let kind = match e.get("kind").and_then(|v| v.as_str()) {
            Some("perf") => "perf",
            _ => "error",
        };
        let detail = e.get("detail").cloned().unwrap_or(Value::Null);
        let detail = {
            let text = detail.to_string();
            if text.chars().count() <= 2000 {
                detail
            } else {
                Value::Null
            }
        };
        let extra = json!({
            "kind": kind,
            "message": msg,
            "detail": detail,
            "client_ts": e.get("ts").and_then(|v| v.as_str()).unwrap_or(""),
        });
        let ev = depot_core::events::Event {
            module: "frontend",
            actor: "web",
            kind,
            subject: None,
            outcome: if kind == "perf" { "ok" } else { "failed" },
            error_code: Some(if kind == "perf" { "PERF" } else { "JS_ERROR" }),
            extra,
            item_kind: Some("frontend"),
            item_name: Some(msg.as_str()),
            item_version: None,
            source_id: None,
            target_id: None,
        };
        if depot_core::events::append(&c, &ev).is_ok() {
            stored += 1;
        }
    }
    drop(c);
    if stored > 0 {
        after_write(&state, "hub", false);
    }
    jraw(200, json!({"ok": true, "stored": stored}))
}

async fn api_star(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let Some(sid) = data.get("sid").and_then(|s| s.as_str()) else {
        return jerr(400, "sid required");
    };
    let c = wc(&state);
    let cur: Option<i64> = c
        .query_row("SELECT starred FROM sessions WHERE sid=?1", [sid], |r| r.get(0))
        .ok();
    let Some(cur) = cur else { return jerr(404, "会话不存在") };
    let new_star = 1 - cur;
    if let Err(e) = c.execute("UPDATE sessions SET starred=?2 WHERE sid=?1",
        rusqlite::params![sid, new_star]) {
        return jerr(500, &e.to_string());
    }
    after_write(&state, "hub", false);
    jraw(200, json!({"ok": true, "starred": new_star == 1}))
}

static REFRESH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
async fn api_refresh(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let tool = data.get("tool").and_then(|t| t.as_str()).map(|s| s.to_string());
    if let Some(t) = &tool {
        let enabled = depot_core::tools::tool_by_id(&rc(&state), t)
            .map(|x| x.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true))
            .unwrap_or(false);
        if !enabled {
            return jerr(400, &format!("工具不存在或已停用：{t}"));
        }
    }
    let _guard = match REFRESH_LOCK.try_lock() {
        Ok(g) => g,
        Err(_) => return jraw(409, json!({"ok": false, "error": "刷新正在进行中"})),
    };
    let c = wc(&state);
    let mut results = Vec::new();
    let tools: Vec<(String, String, Option<String>)> = depot_core::tools::load_tools(&c)
        .iter()
        .filter(|t| {
            t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
                && tool.as_deref().map(|x| t["id"].as_str() == Some(x)).unwrap_or(true)
        })
        .filter_map(|t| {
            Some((
                t["id"].as_str()?.to_string(),
                t["name"].as_str()?.to_string(),
                t.get("root").and_then(|r| r.as_str()).map(|s| s.to_string()),
            ))
        })
        .collect();
    for (tid, tname, root_raw) in tools {
        let root = root_raw
            .map(|r| depot_core::tools::shellexpand(&r))
            .or_else(|| tool_root_env(&tid));
        let Some(root) = root.filter(|r| r.is_dir()) else {
            results.push(json!({"tool": tid, "name": tname, "files": 0,
                "new_messages": 0, "new_sessions": 0, "skipped": true}));
            continue;
        };
        match depot_sessions::scan_tool(&c, &tid, &root) {
            Ok(st) => results.push(json!({"tool": st.tool, "name": tname,
                "files": st.files, "new_messages": st.new_messages,
                "new_sessions": st.new_sessions})),
            Err(e) => results.push(json!({"tool": tid, "name": tname, "error": e.message})),
        }
    }
    let counts = counts_by_tool(&c);
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "sessions", actor: "local", kind: "refresh", subject: None, outcome: "ok",
        error_code: None, extra: json!({"manual": true, "tool": tool}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    after_write(&state, "hub", true);
    jraw(200, json!({"ok": true, "results": results, "tools": counts}))
}

fn tool_root_env(tool: &str) -> Option<PathBuf> {
    let key = match tool {
        "claude" => "HUB_CLAUDE_PROJECTS",
        "codex" => "CODEX_HOME",
        "workbuddy" => "HUB_WORKBUDDY_PROJECTS",
        "pi" => "HUB_PI_DIR",
        "autoclaw" => "HUB_AUTOCLAW_ROOT",
        _ => return None,
    };
    std::env::var(key).ok().map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

async fn api_migrate(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let sid = data.get("sid").and_then(|s| s.as_str()).unwrap_or("");
    let target = data.get("target").and_then(|s| s.as_str()).unwrap_or("");
    let c = wc(&state);
    let sess: Option<(String, Option<String>)> = c
        .query_row("SELECT sid, title FROM sessions WHERE sid=?1", [sid],
            |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let Some((sid, title)) = sess else { return jerr(404, "会话不存在") };
    if target.is_empty() || !["claude", "codex", "opencode"].contains(&target) {
        return jraw(400, json!({"ok": false, "error": format!("目标工具暂不支持：{target}")}));
    }
    // 源工具
    let src_tool: String = c
        .query_row("SELECT tool FROM sessions WHERE sid=?1", [&sid], |r| r.get(0))
        .unwrap_or_default();
    if src_tool == target {
        return jraw(400, json!({"ok": false, "error": "源与目标相同，无需迁移"}));
    }
    let force = as_bool(data.get("force"));
    if !force {
        let prior: Option<(String, String, i64, Option<String>)> = c
            .query_row(
                "SELECT lid, ts, COALESCE(src_msg_count,0), dst_sid FROM migrations \
                 WHERE src_tool=?1 AND src_sid=?2 AND dst_tool=?3 AND status='ok' \
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![src_tool, sid, target],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        if let Some((lid, ts, base, dst_sid)) = prior {
            let current: i64 = c
                .query_row("SELECT msg_count FROM sessions WHERE sid=?1", [&sid], |r| r.get(0))
                .unwrap_or(0);
            let delta = (current - base).max(0);
            return jraw(200, json!({
                "ok": false, "duplicate": true,
                "sync": {"delta": delta, "base_count": base, "current_count": current,
                         "last_dst_sid": dst_sid, "last_ts": ts},
                "error": format!("该会话已于 {} 迁移到 {}（{}）{}",
                    &ts[..16.min(ts.len())], target, lid,
                    if delta > 0 { format!("；此后新增 {delta} 条消息，可同步更新") } else { String::new() }),
                "prior": {"lid": lid, "ts": ts, "src_msg_count": base, "dst_sid": dst_sid},
            }));
        }
    }
    if !casr_available() {
        return jraw(200, json!({"ok": false, "error": "casr 未安装（brew/pip 安装后自动启用）"}));
    }
    // lineage
    let lid: String = {
        let existing: Option<String> = c
            .query_row(
                "SELECT lid FROM lineages WHERE origin_tool=?1 AND origin_sid=?2",
                rusqlite::params![src_tool, sid], |r| r.get(0),
            )
            .ok();
        match existing {
            Some(l) => l,
            None => {
                let n: i64 = c.query_row("SELECT COUNT(*) FROM lineages", [], |r| r.get(0)).unwrap_or(0);
                let lid = format!("lx-{:04}", n + 1);
                let _ = c.execute(
                    "INSERT OR IGNORE INTO lineages(lid, created_at, origin_tool, origin_sid, note) \
                     VALUES(?,?,?,?,?)",
                    rusqlite::params![lid, depot_core::fsutil::now_iso(), src_tool, sid, title],
                );
                lid
            }
        }
    };
    // Python migrator.TOOL_TO_CASR：casr 只认短码，不认工具全名
    let casr_target = match target {
        "claude" => "cc",
        "codex" => "cod",
        "opencode" => "opc",
        other => other,
    };
    let casr_source = match src_tool.as_str() {
        "claude" => "cc",
        "codex" => "cod",
        "opencode" => "opc",
        other => other,
    };
    let cmd_line = format!("casr resume {casr_target} {sid} --source {casr_source}");
    let out = depot_core::gitsrc::run_cmd(
        "casr",
        &["resume", casr_target, sid.as_str(), "--source", &casr_source],
        None,
        std::time::Duration::from_secs(120),
        &[],
    );
    let (ok, new_id, output) = {
        let text = format!("{}{}", out.out, out.err);
        let new_id = uuid_like(&text);
        (out.code == 0, new_id, text)
    };
    let _ = c.execute(
        "INSERT INTO migrations(lid, ts, src_tool, src_sid, dst_tool, dst_sid, status, \
         src_msg_count, detail) VALUES(?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            lid, depot_core::fsutil::now_iso(), src_tool, sid, target,
            new_id, if ok { "ok" } else { "error" },
            msg_count_of(&c, &sid), output.chars().take(500).collect::<String>()
        ],
    );
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "sessions", actor: "local", kind: "migrate", subject: None,
        outcome: if ok { "ok" } else { "error" }, error_code: None,
        extra: json!({"from": src_tool, "to": target, "lid": lid}),
        item_kind: None, item_name: title.as_deref(),
        item_version: None, source_id: None, target_id: None,
    });
    let mut resp = json!({"ok": ok, "lid": lid, "cmd": cmd_line,
        "new_id": new_id,
        "output": output.chars().take(2000).collect::<String>()});
    if ok {
        // 拉起新会话立刻可见：补扫目标工具（Python 成功路径同款动作）
        let rc_ = state.store.read_conn();
        let rc__ = rc_.lock().unwrap();
        if let Some(root) = tool_root_env(target).filter(|p| p.is_dir()) {
            let _ = depot_sessions::scan_tool(&*rc__, target, &root);
        }
        after_write(&state, "hub", true);
    }
    jraw(200, resp)
}

/// 会话 → Markdown（单条导出与批量打包共用）。
fn session_markdown(c: &rusqlite::Connection, sid: &str) -> Option<String> {
    let (tool, title, cwd, msg_count): (String, Option<String>, Option<String>, i64) = c
        .query_row(
            "SELECT tool, title, cwd, msg_count FROM sessions WHERE sid=?1",
            [sid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()?;
    let messages: Vec<(Option<String>, Option<String>, Option<String>)> = match c.prepare(
        "SELECT ts, role, content, content_type FROM messages WHERE sid=?1 ORDER BY seq",
    ) {
        Ok(mut stmt) => stmt
            .query_map([sid], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?))
            })
            .map(|x| x.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => vec![],
    };
    let toolname = match tool.as_str() {
        "claude" => "Claude Code",
        "codex" => "Codex CLI",
        "opencode" => "OpenCode",
        other => other,
    };
    let mut lines = vec![
        format!("# {}", title.as_deref().unwrap_or("(无标题)")),
        String::new(),
        format!("- 工具: {toolname}"),
        format!("- 会话 ID: `{sid}`"),
        format!("- 项目: `{}`", cwd.as_deref().unwrap_or("-")),
        format!("- 消息数: {msg_count}"),
        format!("- 导出时间: {}", depot_core::fsutil::now_iso()),
        String::new(),
        "---".to_string(),
        String::new(),
    ];
    for (ts, role, content) in messages {
        let content = content.unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let t16 = ts.unwrap_or_default().get(..16).unwrap_or("").to_string().replace('T', " ");
        let role = role.unwrap_or_else(|| "?".into());
        lines.push(format!("**{role}**{}", if t16.is_empty() { String::new() } else { format!(" · {t16}") }));
        lines.push(String::new());
        lines.push(content);
        lines.push(String::new());
    }
    Some(lines.join("\n") + "\n")
}

fn msg_count_of(c: &rusqlite::Connection, sid: &str) -> i64 {
    c.query_row("SELECT msg_count FROM sessions WHERE sid=?1", [sid], |r| r.get(0))
        .unwrap_or(0)
}

fn uuid_like(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 36 <= bytes.len() {
        let cand = &s[i..i + 36];
        let hex_ok = cand.chars().enumerate().all(|(idx, ch)| {
            if matches!(idx, 8 | 13 | 18 | 23) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        });
        if hex_ok {
            return Some(cand.to_string());
        }
        i += 1;
    }
    None
}

// ---------- attachment / schedule / memories ----------

async fn api_attachment(State(_state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let sid = q.get("sid").cloned().unwrap_or_default();
    if sid.is_empty() {
        return jraw(400, json!({"error": "sid 必填"}));
    }
    let seq_ok = q.get("seq").and_then(|s| s.parse::<i64>().ok()).is_some();
    let idx_ok = q.get("i").and_then(|s| s.parse::<i64>().ok()).is_some();
    if !seq_ok || !idx_ok {
        return jraw(400, json!({"error": "参数非法"}));
    }
    jraw(404, json!({"error": "附件不存在或无法读取"}))
}

async fn api_schedule(State(state): State<Arc<AppState>>, method: Method,
                      Query(q): Query<HashMap<String, String>>, bytes: Bytes) -> Response {
    let c = wc(&state);
    if method == Method::GET {
        let raw = depot_core::tools::get_config(&c, "schedule");
        let mut sched: Value = raw
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_else(default_schedule);
        if let Some(o) = sched.as_object_mut() {
            for (k, v) in default_schedule().as_object().unwrap() {
                o.entry(k.clone()).or_insert(v.clone());
            }
        }
        return jraw(200, sched);
    }
    if method != Method::POST {
        return jerr(404, "not found");
    }
    let mut data = body_json(&bytes);
    for (k, v) in &q {
        if data.get(k).is_none() {
            data[k] = json!(v);
        }
    }
    let raw = depot_core::tools::get_config(&c, "schedule");
    let mut sched: Value = raw
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_else(default_schedule);
    if let Some(o) = sched.as_object_mut() {
        for (k, v) in default_schedule().as_object().unwrap() {
            o.entry(k.clone()).or_insert(v.clone());
        }
    }
    let tool = data.get("tool").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let valid: Vec<String> = vec!["all".to_string()]
        .into_iter()
        .chain(
            depot_core::tools::load_tools(&c)
                .iter()
                .filter_map(|t| t["id"].as_str().map(|s| s.to_string())),
        )
        .collect();
    if !valid.contains(&tool) {
        return jerr(400, &format!("未知范围：{tool}"));
    }
    let entry = sched[&tool].as_object().cloned().unwrap_or_default();
    let mut entry = entry;
    if let Some(en) = data.get("enabled") {
        entry.insert("enabled".into(), json!(en.as_bool().unwrap_or(false)));
    }
    if let Some(im) = data.get("interval_min") {
        match im.as_i64().or_else(|| im.as_str().and_then(|s| s.parse().ok())) {
            Some(n) if n >= 1 => {
                entry.insert("interval_min".into(), json!(n));
            }
            _ => return jerr(400, "interval_min 必须是正整数"),
        }
    }
    entry
        .entry("interval_min".to_string())
        .or_insert(json!(30));
    sched[&tool] = Value::Object(entry);
    depot_core::tools::set_config(&c, "schedule", &sched.to_string());
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "sessions", actor: "local", kind: "config", subject: None, outcome: "ok",
        error_code: None, extra: json!({"schedule": tool}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    after_write(&state, "hub", false);
    jraw(200, json!({"ok": true, "schedule": sched}))
}

async fn api_memories(State(state): State<Arc<AppState>>) -> Response {
    let c = rc(&state);
    jraw(200, json!({"memories": depot_memory::list_notes(&c, 100)}))
}

async fn api_memory_search(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(query) = q.get("q").filter(|s| !s.trim().is_empty()) else {
        return jerr(400, "q 不能为空");
    };
    let lim = q
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| n.clamp(1, 200))
        .unwrap_or(50);
    let c = rc(&state);
    jraw(200, json!({"ok": true, "results": depot_memory::search_notes(&c, query, lim)}))
}

async fn api_memory_export(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let fmt = q.get("format").map(|s| s.as_str()).unwrap_or("md");
    if fmt != "md" && fmt != "json" {
        return jerr(400, "format 仅支持 md/json");
    }
    let c = rc(&state);
    let payload = depot_memory::export_notes(&c, fmt);
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "memory", actor: "local", kind: "export", subject: None, outcome: "ok",
        error_code: None, extra: json!({"format": fmt}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    (
        [
            (header::CONTENT_TYPE, payload["mime"].as_str().unwrap_or("text/plain").to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!(
                    "attachment; filename={}",
                    payload["filename"].as_str().unwrap_or("memories.md")
                ),
            ),
        ],
        payload["content"].as_str().unwrap_or("").to_string(),
    )
        .into_response()
}

async fn api_memory_add(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let body = data.get("body").and_then(|b| b.as_str()).unwrap_or("").trim().to_string();
    if body.is_empty() {
        return jerr(400, "内容不能为空");
    }
    let title = data.get("title").and_then(|t| t.as_str());
    let c = wc(&state);
    match depot_memory::add_note(&c, &body, title) {
        Ok(v) => {
            let _ = depot_core::events::append(&c, &depot_core::events::Event {
                module: "memory", actor: "local", kind: "add", subject: None, outcome: "ok",
                error_code: None, extra: json!({}),
                item_kind: None, item_name: title, item_version: None,
                source_id: None, target_id: None,
            });
            after_write(&state, "memory:hub", false);
            wrap(v)
        }
        Err(e) => jerr(e.status(), &e.message),
    }
}

async fn api_memory_delete(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let Some(id) = data
        .get("id")
        .and_then(|i| i.as_i64().or_else(|| i.as_str().and_then(|s| s.parse().ok())))
    else {
        return jerr(400, "id required");
    };
    let c = wc(&state);
    match depot_memory::delete_note(&c, id) {
        Ok(v) => {
            if v["ok"] == json!(true) {
                let _ = depot_core::events::append(&c, &depot_core::events::Event {
                    module: "memory", actor: "local", kind: "delete", subject: None,
                    outcome: "ok", error_code: None, extra: json!({}),
                    item_kind: None, item_name: Some(&id.to_string()),
                    item_version: None, source_id: None, target_id: None,
                });
            }
            wrap(v)
        }
        Err(e) => jerr(e.status(), &e.message),
    }
}

// ---------- sync/preview · lineage ----------

async fn api_sync_preview(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let sid = q.get("sid").cloned().unwrap_or_default();
    let target = q.get("target").cloned().unwrap_or_default();
    let _ = &state;
    if sid.is_empty() || target.is_empty() {
        return jraw(400, json!({"error": "sid & target required"}));
    }
    let c = rc(&state);
    let count: i64 = c
        .query_row("SELECT msg_count FROM sessions WHERE sid=?1", [&sid], |r| r.get(0))
        .unwrap_or(0);
    let base: Option<i64> = c
        .query_row(
            "SELECT src_msg_count FROM migrations WHERE (src_tool=(SELECT tool FROM sessions \
             WHERE sid=?1) AND src_sid=?1) AND dst_tool=?2 AND status='ok' ORDER BY id DESC LIMIT 1",
            rusqlite::params![sid, target],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    let b = base.unwrap_or(count);
    jraw(200, json!({"sync": {"delta": count - b, "base_count": b, "current_count": count}}))
}

async fn api_lineage(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let tool = q.get("tool").cloned().unwrap_or_default();
    let sid = q.get("sid").cloned().unwrap_or_default();
    if tool.is_empty() || sid.is_empty() {
        return jraw(400, json!({"error": "tool & sid required"}));
    }
    let c = rc(&state);
    jraw(200, lineage_info(&c, &tool, &sid).unwrap_or(json!({})))
}

// ---------- ops ----------

async fn api_ops(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let c = rc(&state);
    match depot_core::events::query_filtered(
        &c,
        q.get("module").map(|s| s.as_str()),
        q.get("status").map(|s| s.as_str()),
        q.get("q").map(|s| s.as_str()),
        q.get("target_id").and_then(|l| l.parse().ok()),
        q.get("since").map(|s| s.as_str()),
        q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(100),
        q.get("offset").and_then(|l| l.parse().ok()).unwrap_or(0),
    ) {
        Ok((total, items)) => jraw(200, json!({"ok": true, "total": total, "items": items})),
        Err(e) => jerr(e.status(), &e.message),
    }
}

async fn api_ops_export(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let fmt = q.get("format").map(|s| s.as_str()).unwrap_or("json");
    let c = rc(&state);
    let Ok((_total, items)) = depot_core::events::query(&c, None, None, None, 100_000, 0) else {
        return jerr(500, "台账读取失败");
    };
    if fmt == "csv" {
        let mut csv = String::from(
            "id,ts,module,action,status,item_kind,item_name,item_version,source_name,target_name,reason\n",
        );
        for it in &items {
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{}\n",
                it["id"], it["ts"], it["module"], it["action"], it["status"],
                it["item_kind"].as_str().unwrap_or(""),
                csv_escape(it["item_name"].as_str().unwrap_or("")),
                it["item_version"].as_str().unwrap_or(""),
                "", "",
                csv_escape(it["reason"].as_str().unwrap_or("")),
            ));
        }
        (
            [(header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
             (header::CONTENT_DISPOSITION, "attachment; filename=hub-ops.csv".to_string())],
            csv,
        )
            .into_response()
    } else {
        let text = serde_json::to_string_pretty(&json!({"total": _total, "items": items}))
            .unwrap_or_default();
        (
            [(header::CONTENT_TYPE, "application/json; charset=utf-8".to_string()),
             (header::CONTENT_DISPOSITION, "attachment; filename=hub-ops.json".to_string())],
            text,
        )
            .into_response()
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ---------- doctor / backup ----------

async fn api_doctor(State(state): State<Arc<AppState>>) -> Response {
    let hub = depot_core::paths::hub_dir();
    let c = rc(&state);
    let mut checks = Vec::new();
    let git = std::process::Command::new("git").arg("--version").output();
    checks.push(json!({
        "name": "git",
        "ok": git.as_ref().map(|o| o.status.success()).unwrap_or(false),
        "detail": git.ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()}));
    let probe = hub.join(".doctor-probe");
    let writable = std::fs::write(&probe, b"x").is_ok();
    if writable {
        let _ = std::fs::remove_file(&probe);
    }
    checks.push(json!({"name": "hub_dir_writable", "ok": writable,
        "detail": hub.display().to_string()}));
    checks.push(json!({"name": "casr", "ok": casr_available(), "detail": "会话迁移引擎"}));
    checks.push(json!({"name": "agentmemory", "ok": false, "detail": "记忆总线 :3111"}));
    for m in modules_snapshot(&c) {
        checks.push(json!({"name": format!("module:{}", m["id"]), "ok": true,
            "detail": if m["enabled"] == json!(true) { "enabled" } else { "disabled" }}));
    }
    for t in depot_core::tools::public_list(&c, &json!({})) {
        if t.get("root").and_then(|r| r.as_str()).is_some()
            && t.get("root_exists").and_then(|v| v.as_bool()) == Some(false)
        {
            checks.push(json!({"name": format!("tool:{}", t["id"].as_str().unwrap_or("")),
                "ok": false,
                "detail": format!("路径不存在：{}", t["root"].as_str().unwrap_or(""))}));
        }
    }
    let srcs: Vec<(String, String, Option<String>)> = {
        match c.prepare("SELECT kind, name, last_error FROM sources") {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    for (kind, name, last_error) in srcs {
        checks.push(json!({"name": format!("source:{kind}/{name}"),
            "ok": last_error.is_none(), "detail": last_error.unwrap_or_else(|| "ok".into())}));
    }
    let ok = checks.iter().all(|x| x["ok"] == json!(true));
    jraw(200, json!({"ok": ok, "checks": checks}))
}

async fn api_backup(State(state): State<Arc<AppState>>) -> Response {
    let _ = state.store.checkpoint();
    let db = depot_core::paths::hub_dir().join("depot.db");
    match std::fs::read(&db) {
        Ok(data) => (
            [(header::CONTENT_TYPE, "application/octet-stream".to_string()),
             (header::CONTENT_DISPOSITION,
                format!("attachment; filename=depot-{}.db",
                    chrono::Local::now().format("%Y%m%d-%H%M%S")))],
            data,
        )
            .into_response(),
        Err(_) => jerr(404, "depot.db 不存在"),
    }
}

// ---------- tools ----------

fn modules_snapshot(c: &rusqlite::Connection) -> Vec<Value> {
    let defs = [
        ("sessions", "会话", "多工具会话采集 / 浏览 / 迁移"),
        ("memory", "记忆", "记忆分发线（工具记忆 ↔ hub 中间体）+ 长期笔记"),
        ("skills", "Skills", "技能源拉取 / 本地库 / 分发到各目标"),
        ("mcp", "MCP", "MCP 配置源拉取 / 本地库 / 分发与连接验证"),
    ];
    defs.iter()
        .map(|(id, name, desc)| {
            let v = depot_core::tools::get_config(c, &format!("modules.enabled.{id}"));
            let enabled = match v {
                None => true,
                Some(v) => !matches!(v.as_str(), "0" | "false" | "off" | "no"),
            };
            let order = match *id {
                "sessions" => 1,
                "memory" => 2,
                "skills" => 3,
                _ => 4,
            };
            json!({"id": id, "name": name, "desc": desc, "enabled": enabled,
                "nav": {"key": id, "label": name, "order": order}})
        })
        .collect()
}

async fn api_modules(State(state): State<Arc<AppState>>) -> Response {
    let c = rc(&state);
    jraw(200, json!({"ok": true, "modules": modules_snapshot(&c)}))
}

async fn api_modules_toggle(State(state): State<Arc<AppState>>, AxPath(mid): AxPath<String>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    if !["sessions", "memory", "skills", "mcp"].contains(&mid.as_str()) {
        return jerr(404, "未知模块");
    }
    let on = data.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
    let c = wc(&state);
    depot_core::tools::set_config(&c, &format!("modules.enabled.{mid}"), if on { "1" } else { "0" });
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "system", actor: "local", kind: "config", subject: None, outcome: "ok",
        error_code: None, extra: json!({"module": mid, "enabled": on}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    after_write(&state, "hub", false);
    jraw(200, json!({"ok": true, "modules": modules_snapshot(&c)}))
}

async fn api_tools_root(State(state): State<Arc<AppState>>, method: Method, bytes: Bytes) -> Response {
    let c = wc(&state);
    match method {
        Method::GET => {
            let counts = counts_by_tool(&c);
            let adapters: Vec<Value> = depot_core::tools::ADAPTER_LABELS
                .iter()
                .map(|(id, label)| {
                    json!({"id": id, "name": adapter_name(id), "label": label,
                        "root_hint": "", "root_hint_default":
                        depot_core::tools::adapter_root_default(id).unwrap_or("")})
                })
                .collect();
            jraw(200, json!({"ok": true, "tools": depot_core::tools::public_list(&c, &counts),
                "presets": [], "adapters": adapters}))
        }
        Method::POST => {
            let data = body_json(&bytes);
            let root = data.get("root").and_then(|r| r.as_str()).unwrap_or("").trim().to_string();
            if root.is_empty() {
                return jerr(400, "路径不能为空");
            }
            let root_path = depot_core::tools::shellexpand(&root);
            let mut tools = depot_core::tools::load_tools(&c);
            let name = data
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    root_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "未识别路径".into())
                });
            if tools.iter().any(|t| {
                t["name"].as_str().map(|n| n.eq_ignore_ascii_case(&name)).unwrap_or(false)
            }) {
                return jerr(400, &format!("名称已存在：{name}"));
            }
            let adapter = data
                .get("adapter")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            let mut id_base: String = name
                .to_lowercase()
                .chars()
                .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
                .collect();
            id_base = id_base.trim_matches('-').chars().take(24).collect();
            if id_base.is_empty() {
                id_base = "tool".into();
            }
            let existing: Vec<String> = tools.iter().filter_map(|t| t["id"].as_str().map(|s| s.to_string())).collect();
            let mut tid = id_base.clone();
            let mut n = 2;
            while existing.contains(&tid) {
                tid = format!("{id_base}-{n}");
                n += 1;
            }
            let entry = json!({
                "id": tid, "name": name, "adapter": adapter, "root": root_path.to_string_lossy(),
                "enabled": true, "builtin": false,
                "color": tools.len() + 9,
                "skills_dir": data.get("skills_dir").and_then(|s| s.as_str()),
                "mcp_config": data.get("mcp_config").and_then(|s| s.as_str()),
                "mcp_format": data.get("mcp_format").and_then(|s| s.as_str()),
            });
            let mut entries: Vec<Value> = depot_core::tools::get_config(&c, "tools")
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                .unwrap_or_default();
            entries.push(entry.clone());
            depot_core::tools::save_tools(&c, &entries);
            // 同步 targets（skills_dir / mcp_config 有值则建）
            let mut created = Vec::new();
            if let Some(sd) = data.get("skills_dir").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                let _ = c.execute(
                    "INSERT OR IGNORE INTO targets(name, kind, tool, path, format_key, created_at) \
                     VALUES(?,?,?,?,NULL,?)",
                    rusqlite::params![name, "skills_dir", tid, sd, depot_core::fsutil::now_iso()],
                );
                created.push("skills_dir");
            }
            if let Some(mc) = data.get("mcp_config").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                let kind = if mc.ends_with(".toml") { "mcp_toml" } else { "mcp_json" };
                let _ = c.execute(
                    "INSERT OR IGNORE INTO targets(name, kind, tool, path, format_key, created_at) \
                     VALUES(?,?,?,?,?,?)",
                    rusqlite::params![name, kind, tid, mc,
                        data.get("mcp_format").and_then(|s| s.as_str()),
                        depot_core::fsutil::now_iso()],
                );
                created.push(kind);
            }
            let _ = depot_core::events::append(&c, &depot_core::events::Event {
                module: "tools", actor: "local", kind: "add", subject: None, outcome: "ok",
                error_code: None, extra: json!({"adapter": adapter, "root": root}),
                item_kind: None, item_name: Some(name.as_str()),
                item_version: None, source_id: None, target_id: None,
            });
            after_write(&state, "hub", true);
            let warning = if !root_path.exists() {
                Some(format!("路径当前不存在：{}（已保存，生成数据后刷新即可）", root_path.display()))
            } else if adapter.is_none() {
                Some("未识别出会话格式：该路径只作登记，不采集会话（仍可作 Skills / MCP 目标）".to_string())
            } else {
                None
            };
            jraw(200, json!({"ok": true, "tool": entry, "warning": warning,
                "targets_created": created}))
        }
        _ => jerr(404, "not found"),
    }
}

fn adapter_name(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "codex" => "Codex CLI",
        "opencode" => "OpenCode",
        "pi" => "Pi-Agent",
        "cursor" => "Cursor",
        "workbuddy" => "WorkBuddy",
        "zcode" => "ZCode",
        "autoclaw" => "AutoClaw",
        "trae-cn" => "Trae CN",
        "agents" => "共享技能目录",
        _ => "未知",
    }
}

async fn api_tools_reorder(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let ids = data.get("ids").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    let c = wc(&state);
    let order = depot_core::tools::set_order(&c, &ids);
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "tools", actor: "local", kind: "reorder", subject: None, outcome: "ok",
        error_code: None, extra: json!({"order": order}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    after_write(&state, "hub", false);
    jraw(200, json!({"ok": true, "order": order}))
}

async fn api_tools_detect(State(_state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let root = data.get("root").and_then(|r| r.as_str()).unwrap_or("");
    let exists = depot_core::tools::shellexpand(root).is_dir();
    jraw(200, json!({"ok": true, "adapter": Value::Null, "files": 0,
        "sample": [], "name": "", "root": root, "root_exists": exists}))
}

async fn api_tools_id(State(state): State<Arc<AppState>>, AxPath(tid): AxPath<String>, method: Method, bytes: Bytes) -> Response {
    let c = wc(&state);
    match method {
        Method::PATCH => {
            let data = body_json(&bytes);
            let Some(mut tool) = depot_core::tools::tool_by_id(&c, &tid) else {
                return jerr(404, &format!("工具不存在：{tid}"));
            };
            let builtin = tool.get("builtin").and_then(|b| b.as_bool()).unwrap_or(false);
            let mut entries: Vec<Value> = depot_core::tools::get_config(&c, "tools")
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                .unwrap_or_default();
            if let Some(nm) = data.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
                tool["name"] = json!(nm.chars().take(60).collect::<String>());
            }
            if let Some(en) = data.get("enabled") {
                tool["enabled"] = json!(en.as_bool().unwrap_or(true));
            }
            for k in ["skills_dir", "mcp_config", "mcp_format"] {
                if let Some(v) = data.get(k) {
                    if builtin && v.is_null() {
                        continue;
                    }
                    tool[k] = v.clone();
                }
            }
            // 覆盖项原地修改（此前 clone 后丢弃 → 已存在自定义工具的 PATCH 静默失效）
            match entries.iter_mut().find(|e| e["id"].as_str() == Some(tid.as_str())) {
                Some(e) => {
                    for k in ["name", "enabled", "skills_dir", "mcp_config", "mcp_format"] {
                        if let Some(v) = data.get(k) {
                            e[k] = v.clone();
                        }
                    }
                }
                None if builtin => {
                    let mut e = json!({"id": tid});
                    for k in ["name", "enabled", "skills_dir", "mcp_config", "mcp_format"] {
                        if let Some(v) = data.get(k) {
                            e[k] = v.clone();
                        }
                    }
                    entries.push(e);
                }
                None => return jerr(404, &format!("工具不存在：{tid}")),
            }
            depot_core::tools::save_tools(&c, &entries);
            let _ = depot_core::events::append(&c, &depot_core::events::Event {
                module: "tools", actor: "local", kind: "update", subject: None, outcome: "ok",
                error_code: None, extra: json!({"tool": tid}),
                item_kind: None, item_name: None, item_version: None,
                source_id: None, target_id: None,
            });
            after_write(&state, "hub", true);
            jraw(200, json!({"ok": true, "tool": tool}))
        }
        Method::DELETE => {
            let tool = depot_core::tools::tool_by_id(&c, &tid);
            let Some(tool) = tool else { return jerr(404, &format!("工具不存在：{tid}")); };
            if tool.get("builtin").and_then(|b| b.as_bool()).unwrap_or(false) {
                return jerr(400, "内置工具不可移除（可停用）");
            }
            let data = body_json(&bytes);
            // purge=1：先导出备份 zip，再清该工具已采集的会话/消息/游标（Python remove_tool 对位）
            let purge = as_bool(data.get("purge"));
            let mut purge_stats = json!({"purged": false, "sessions": 0, "messages": 0,
                "backup": Value::Null});
            if purge {
                let sids: Vec<String> = list_sessions(&c, Some(&tid), None)
                    .iter()
                    .filter_map(|x| x["sid"].as_str().map(|s| s.to_string()))
                    .collect();
                let n_msg: i64 = c
                    .query_row("SELECT COUNT(*) FROM messages WHERE tool=?1", [&tid], |r| r.get(0))
                    .unwrap_or(0);
                purge_stats["sessions"] = json!(sids.len());
                purge_stats["messages"] = json!(n_msg);
                if !sids.is_empty() {
                    // 备份 zip（删除前自动导出）
                    let export_dir = depot_core::paths::hub_dir().join("exports");
                    let _ = std::fs::create_dir_all(&export_dir);
                    let zpath = export_dir.join(format!(
                        "purge-{}-{}.zip", tid,
                        chrono::Local::now().format("%Y%m%d-%H%M%S")));
                    let mut entries = Vec::new();
                    for sid in &sids {
                        if let Some(md) = session_markdown(&c, sid) {
                            entries.push(depot_core::zipstore::ZipEntry {
                                name: format!("{}.md", sid),
                                data: md.into_bytes(),
                            });
                        }
                    }
                    let _ = std::fs::write(&zpath, depot_core::zipstore::build_zip(&entries));
                    purge_stats["backup"] = json!(zpath.to_string_lossy());
                }
                let _ = c.execute("DELETE FROM messages WHERE tool=?1", [&tid]);
                let _ = c.execute("DELETE FROM sessions WHERE tool=?1", [&tid]);
                let _ = c.execute(
                    "DELETE FROM cursor WHERE source_key LIKE ?1",
                    [format!("{tid}:%")],
                );
                purge_stats["purged"] = json!(true);
            }
            let entries: Vec<Value> = depot_core::tools::get_config(&c, "tools")
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|e| e["id"].as_str() != Some(tid.as_str()))
                .collect();
            depot_core::tools::save_tools(&c, &entries);
            // 关联 targets 处置：登记来源 tool:<id> 的目标一并移除（Python _sync_tool_targets 对位）
            let targets_removed: Vec<String> = match c
                .prepare("SELECT name FROM targets WHERE tool=?1")
            {
                Ok(mut stmt) => stmt
                    .query_map([&tid], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default(),
                Err(_) => vec![],
            };
            let _ = c.execute("DELETE FROM targets WHERE tool=?1", [&tid]);
            let _ = depot_core::events::append(&c, &depot_core::events::Event {
                module: "tools", actor: "local", kind: "remove", subject: None, outcome: "ok",
                error_code: None, extra: json!({"tool": tid, "purged": purge}),
                item_kind: None, item_name: None, item_version: None,
                source_id: None, target_id: None,
            });
            after_write(&state, "hub", true);
            jraw(200, json!({"ok": true, "removed": tid, "purge": purge_stats,
                "targets_removed": targets_removed, "targets_kept": []}))
        }
        _ => jerr(404, "not found"),
    }
}

async fn api_wire_memory(State(state): State<Arc<AppState>>, AxPath(tid): AxPath<String>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let c = wc(&state);
    let Some(tool) = depot_core::tools::tool_by_id(&c, &tid) else {
        return jerr(404, &format!("工具不存在：{tid}"));
    };
    let mcp_config = tool.get("mcp_config").and_then(|m| m.as_str()).unwrap_or("");
    if mcp_config.is_empty() {
        return jraw(400, json!({"ok": false, "error": "该工具没有登记 MCP 配置，无法接入记忆总线"}));
    }
    if !mcp_config.ends_with(".json") {
        return jraw(400, json!({"ok": false, "error": "仅支持 JSON 格式的 MCP 配置（.toml 暂不支持）"}));
    }
    let path = depot_core::tools::shellexpand(mcp_config);
    if !path.is_file() {
        return jraw(400, json!({"ok": false, "error": format!("配置文件不存在：{mcp_config}")}));
    }
    let Some(mut cfg) = depot_core::fsutil::read_json(&path) else {
        return jraw(400, json!({"ok": false, "error": "配置文件不是 JSON 对象"}));
    };
    let fmt = tool.get("mcp_format").and_then(|f| f.as_str()).unwrap_or("mcpServers");
    // 找已接线工具的 agentmemory 配置复制
    let mut agentmemory: Option<Value> = None;
    for t in depot_core::tools::load_tools(&c) {
        if t["id"].as_str() == Some(tid.as_str()) {
            continue;
        }
        if let Some(mc) = t.get("mcp_config").and_then(|m| m.as_str()) {
            let p = depot_core::tools::shellexpand(mc);
            if let Some(other) = depot_core::fsutil::read_json(&p) {
                let mut cur = &other;
                for part in t.get("mcp_format").and_then(|f| f.as_str()).unwrap_or("mcpServers").split('.') {
                    match cur.get(part) {
                        Some(v) => cur = v,
                        None => {
                            cur = &other;
                            break;
                        }
                    }
                }
                if let Some(am) = cur.get("agentmemory") {
                    agentmemory = Some(am.clone());
                    break;
                }
                let _ = fmt;
            }
        }
    }
    let Some(am) = agentmemory else {
        return jraw(400, json!({"ok": false, "error": "未找到可复制的 agentmemory 配置（来源：已接线的工具配置）"}));
    };
    // 写入目标的 mcpServers（顶层键）
    if !cfg.is_object() {
        return jraw(400, json!({"ok": false, "error": "配置文件不是 JSON 对象"}));
    }
    if let Some(o) = cfg.as_object_mut() {
        let sec = o.entry(fmt.to_string()).or_insert(json!({}));
        if let Some(so) = sec.as_object_mut() {
            so.insert("agentmemory".into(), am);
        }
    }
    let text = serde_json::to_string_pretty(&cfg).unwrap_or_default() + "\n";
    if depot_core::fsutil::atomic_write_text(&path, &text).is_err() {
        return jraw(400, json!({"ok": false, "error": "写入失败"}));
    }
    after_write(&state, &format!("memory:{tid}"), false);
    jraw(200, json!({"ok": true}))
}

async fn api_unwire_memory(State(state): State<Arc<AppState>>, AxPath(tid): AxPath<String>) -> Response {
    let c = wc(&state);
    let Some(tool) = depot_core::tools::tool_by_id(&c, &tid) else {
        return jerr(404, &format!("工具不存在：{tid}"));
    };
    let mcp_config = tool.get("mcp_config").and_then(|m| m.as_str()).unwrap_or("");
    if mcp_config.is_empty() {
        return jraw(400, json!({"ok": false, "error": "该工具没有登记 MCP 配置"}));
    }
    let path = depot_core::tools::shellexpand(mcp_config);
    let Some(mut cfg) = depot_core::fsutil::read_json(&path) else {
        return jraw(400, json!({"ok": false, "error": "读取失败"}));
    };
    let fmt = tool.get("mcp_format").and_then(|f| f.as_str()).unwrap_or("mcpServers");
    let mut removed = false;
    if let Some(o) = cfg.as_object_mut() {
        if let Some(sec) = o.get_mut(fmt).and_then(|s| s.as_object_mut()) {
            removed = sec.remove("agentmemory").is_some();
        }
    }
    if removed {
        let text = serde_json::to_string_pretty(&cfg).unwrap_or_default() + "\n";
        let _ = depot_core::fsutil::atomic_write_text(&path, &text);
    }
    after_write(&state, &format!("memory:{tid}"), false);
    jraw(200, json!({"ok": true, "removed": removed}))
}

// ---------- remote repos ----------

async fn api_remote_repos(State(state): State<Arc<AppState>>, method: Method, bytes: Bytes) -> Response {
    let c = wc(&state);
    match method {
        Method::GET => {
            let repos: Vec<Value> = {
                match c.prepare("SELECT * FROM remote_repos ORDER BY id") {
                    Ok(mut stmt) => stmt
                        .query_map([], |r| {
                            Ok(json!({
                                "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                                "url": r.get::<_, String>(2)?, "branch": r.get::<_, String>(3)?,
                                "subdir": r.get::<_, String>(4)?,
                                "auth_ref": r.get::<_, Option<String>>(5)?,
                                "poll_min": r.get::<_, i64>(6)?,
                                "created_at": r.get::<_, String>(7)?,
                                "modules": [], "sources": {}}))
                        })
                        .map(|x| x.filter_map(|r| r.ok()).collect())
                        .unwrap_or_default(),
                    Err(_) => vec![],
                }
            };
            // sources 关联模块
            let mut repos = repos;
            for repo in repos.iter_mut() {
                let rid = repo["id"].as_i64().unwrap_or(0);
                let srcs: Vec<Value> = {
                    match c.prepare(
                        "SELECT id, kind, repo_id, name, last_sync_at, last_commit, last_error, \
                         (SELECT COUNT(*) FROM items i WHERE i.source_id=sources.id) AS item_count \
                         FROM sources WHERE repo_id=?1 ORDER BY id",
                    ) {
                        Ok(mut stmt) => stmt
                            .query_map([rid], |r| {
                                Ok(json!({
                                    "id": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?,
                                    "repo_id": r.get::<_, Option<i64>>(2)?,
                                    "name": r.get::<_, String>(3)?,
                                    "last_sync_at": r.get::<_, Option<String>>(4)?,
                                    "last_commit": r.get::<_, Option<String>>(5)?,
                                    "last_error": r.get::<_, Option<String>>(6)?,
                                    "item_count": r.get::<_, i64>(7)?}))
                            })
                            .map(|x| x.filter_map(|r| r.ok()).collect())
                            .unwrap_or_default(),
                        Err(_) => vec![],
                    }
                };
                let mods: Vec<String> = srcs.iter().filter_map(|s| s["kind"].as_str().map(|k| k.to_string())).collect();
                repo["modules"] = json!(mods);
                repo["sources"] = json!(srcs);
            }
            jraw(200, json!({"ok": true, "repos": repos,
                "modules": [{"id": "skills", "name": "Skills"}, {"id": "mcp", "name": "MCP"}]}))
        }
        Method::POST => {
            let data = body_json(&bytes);
            let name = data.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
            let url = data.get("url").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
            if name.is_empty() || url.is_empty() {
                return jraw(400, json!({"ok": false, "error": "名称与仓库地址必填"}));
            }
            let modules: Vec<String> = data
                .get("modules")
                .and_then(|m| m.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if modules.is_empty() {
                return jraw(400, json!({"ok": false, "error": "至少勾选一个模块（Skills / MCP）"}));
            }
            let branch = data.get("branch").and_then(|b| b.as_str()).unwrap_or("main");
            let subdir = data.get("subdir").and_then(|b| b.as_str()).unwrap_or("");
            let dup: bool = c
                .query_row(
                    "SELECT 1 FROM remote_repos WHERE url=?1 AND branch=?2 AND subdir=?3",
                    rusqlite::params![url, branch, subdir], |_| Ok(true),
                )
                .unwrap_or(false);
            if dup {
                return jraw(400, json!({"ok": false, "error": "该仓库已存在，请在列表里直接编辑"}));
            }
            if let Err(e) = c.execute(
                "INSERT INTO remote_repos(name, url, branch, subdir, created_at) VALUES(?,?,?,?,?)",
                rusqlite::params![name, url, branch, subdir, depot_core::fsutil::now_iso()],
            ) {
                return jerr(500, &e.to_string());
            }
            let rid = c.last_insert_rowid();
            for kind in &modules {
                let _ = c.execute(
                    "INSERT INTO sources(kind, name, url, branch, subdir, repo_id, created_at) \
                     VALUES(?,?,?,?,?,?,?)",
                    rusqlite::params![kind, name, url, branch, subdir, rid,
                        depot_core::fsutil::now_iso()],
                );
            }
            let _ = depot_core::events::append(&c, &depot_core::events::Event {
                module: "system", actor: "local", kind: "repo:create", subject: None,
                outcome: "ok", error_code: None, extra: json!({"repo_id": rid, "name": name}),
                item_kind: None, item_name: None, item_version: None,
                source_id: None, target_id: None,
            });
            after_write(&state, "hub", false);
            jraw(200, json!({"ok": true, "id": rid, "repo": {"id": rid, "name": name}}))
        }
        _ => jerr(404, "not found"),
    }
}

async fn api_remote_repos_id(State(state): State<Arc<AppState>>, AxPath(rid): AxPath<String>, method: Method, bytes: Bytes) -> Response {
    let Ok(rid) = rid.parse::<i64>() else { return jerr(400, "非法仓库 id") };
    if method != Method::PATCH {
        return jerr(404, "not found");
    }
    let data = body_json(&bytes);
    let c = wc(&state);
    let exists: bool = c
        .query_row("SELECT 1 FROM remote_repos WHERE id=?1", [rid], |_| Ok(true))
        .unwrap_or(false);
    if !exists {
        return jraw(400, json!({"ok": false, "error": "仓库不存在"}));
    }
    for k in ["name", "url", "branch", "subdir", "auth_ref", "poll_min"] {
        if let Some(v) = data.get(k) {
            let sv = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => if *b { "1".into() } else { "0".into() },
                _ => continue,
            };
            let _ = c.execute(
                &format!("UPDATE remote_repos SET {k}=?1 WHERE id=?2"),
                rusqlite::params![sv, rid],
            );
            let _ = c.execute(
                &format!("UPDATE sources SET {k}=?1 WHERE repo_id=?2"),
                rusqlite::params![sv, rid],
            );
        }
    }
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "system", actor: "local", kind: "repo:update", subject: None, outcome: "ok",
        error_code: None, extra: json!({"repo_id": rid}),
        item_kind: None, item_name: None, item_version: None, source_id: None, target_id: None,
    });
    after_write(&state, "hub", false);
    jraw(200, json!({"ok": true}))
}

// ---------- local dirs ----------

fn list_dirs_full(c: &rusqlite::Connection) -> Vec<Value> {
    let Ok(mut stmt) = c.prepare("SELECT id, name, path, origin, enabled, created_at, layout \
                                  FROM local_dirs ORDER BY id") else { return vec![] };
    let mut rows: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?,
                "path": r.get::<_, String>(2)?, "origin": r.get::<_, String>(3)?,
                "enabled": r.get::<_, i64>(4)? == 1, "created_at": r.get::<_, String>(5)?,
                "layout": r.get::<_, Option<String>>(6)?,
                "counts": {"skills": 0, "mcp": 0}, "bindings": []}))
        })
        .map(|x| x.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let cnt: Vec<(i64, String, i64)> = {
        match c.prepare(
            "SELECT dir_id, kind, COUNT(*) FROM registry_items WHERE dir_id IS NOT NULL \
             GROUP BY dir_id, kind",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    for (did, kind, n) in cnt {
        if let Some(d) = rows.iter_mut().find(|d| d["id"] == json!(did)) {
            d["counts"][&kind] = json!(n);
        }
    }
    let binds: Vec<Value> = {
        match c.prepare(
            "SELECT b.id, b.dir_id, b.target_id, b.mode, b.enabled, b.channels, b.excluded, \
             b.last_sync_at, b.last_result, t.tool, t.kind, t.name, t.path \
             FROM dir_bindings b JOIN targets t ON t.id=b.target_id",
        ) {
            Ok(mut stmt) => stmt
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, i64>(0)?, "dir_id": r.get::<_, i64>(1)?,
                        "target_id": r.get::<_, i64>(2)?, "mode": r.get::<_, String>(3)?,
                        "enabled": r.get::<_, i64>(4)? == 1,
                        "channels": r.get::<_, String>(5)?, "excluded": r.get::<_, String>(6)?,
                        "last_sync_at": r.get::<_, Option<String>>(7)?,
                        "last_result": r.get::<_, Option<String>>(8)?,
                        "tool": r.get::<_, Option<String>>(9)?,
                        "target_kind": r.get::<_, String>(10)?,
                        "target_name": r.get::<_, String>(11)?,
                        "target_path": r.get::<_, String>(12)?}))
                })
                .map(|x| x.filter_map(|r| r.ok()).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    };
    for mut b in binds {
        b["channels"] = json!(b["channels"]
            .as_str()
            .unwrap_or("skills")
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>());
        b["excluded"] = serde_json::from_str::<Value>(b["excluded"].as_str().unwrap_or("[]"))
            .unwrap_or(json!([]));
        b["last_result"] = b["last_result"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
        if let Some(d) = rows.iter_mut().find(|d| d["id"] == b["dir_id"]) {
            d["bindings"].as_array_mut().unwrap().push(b);
        }
    }
    for d in rows.iter_mut() {
        d["layout"] = d["layout"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(Value::Null);
    }
    rows
}

async fn api_local_dirs(State(state): State<Arc<AppState>>, method: Method) -> Response {
    if method != Method::GET {
        return jerr(404, "not found");
    }
    {
        // 读取时顺带扫描同步（Python sync_all 对位）+ 绑定跟随
        let c = wc(&state);
        let hub = depot_core::paths::hub_dir();
        let _ = depot_skills::extra::sync_all_bindings(&c, &hub);
    }
    let c = rc(&state);
    let dirs = list_dirs_full(&c);
    jraw(200, json!({"ok": true, "dirs": dirs}))
}

async fn api_local_dirs_pick(State(_state): State<Arc<AppState>>) -> Response {
    jraw(400, json!({"ok": false, "error": "depotd 为无头模式：请使用「手填路径」链接目录"}))
}

async fn api_local_dirs_link(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let data = body_json(&bytes);
    let raw = data.get("path").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return jraw(400, json!({"ok": false, "error": "目录路径必填"}));
    }
    let real = depot_core::tools::shellexpand(&raw);
    let real = real.canonicalize().unwrap_or(real);
    if !real.is_dir() {
        return jraw(400, json!({"ok": false, "error": format!("目录不存在：{raw}")}));
    }
    let hub_real = depot_core::paths::hub_dir();
    let hub_real = hub_real.canonicalize().unwrap_or(hub_real);
    if real == hub_real || real.starts_with(&hub_real) {
        return jraw(400, json!({"ok": false, "error": "不能链接 hub 自身目录（内容已归 hub 管）"}));
    }
    let c = wc(&state);
    // 重叠检查
    let existing = list_dirs_full(&c);
    for d in &existing {
        let other = PathBuf::from(d["path"].as_str().unwrap_or(""));
        let other = other.canonicalize().unwrap_or(other);
        if real == other || real.starts_with(&other) || other.starts_with(&real) {
            return jraw(400, json!({"ok": false,
                "error": format!("与已链接目录重叠：{}", d["name"].as_str().unwrap_or(""))}));
        }
    }
    let name = data
        .get("name")
        .and_then(|n| n.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            real.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        });
    let valid_name = {
        let b = name.as_bytes();
        !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric()
            && b[1..].iter().all(|&x| x.is_ascii_alphanumeric() || x == b'.' || x == b'_' || x == b'-')
    };
    if !valid_name {
        return jraw(400, json!({"ok": false, "error": "名称非法（字母数字开头，允许 . _ -，≤64 字符）"}));
    }
    let dup: bool = c
        .query_row(
            "SELECT 1 FROM local_dirs WHERE name=?1 OR path=?2",
            rusqlite::params![name, real.to_string_lossy()], |_| Ok(true),
        )
        .unwrap_or(false);
    if dup {
        return jraw(400, json!({"ok": false, "error": "已存在同名/同路径目录"}));
    }
    if let Err(e) = c.execute(
        "INSERT INTO local_dirs(name, path, origin, created_at) VALUES(?,?,?,?)",
        rusqlite::params![name, real.to_string_lossy(), "linked", depot_core::fsutil::now_iso()],
    ) {
        return jerr(500, &format!("登记失败：{e}"));
    }
    let did = c.last_insert_rowid();
    let scan = depot_skills::scan_sync(&c, &depot_core::paths::hub_dir(), did, &name, &real)
        .unwrap_or(json!({}));
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "skills", actor: "local", kind: "dir:link", subject: None, outcome: "ok",
        error_code: None, extra: json!({"name": name, "path": real.to_string_lossy()}),
        item_kind: None, item_name: Some(name.as_str()), item_version: None,
        source_id: None, target_id: None,
    });
    after_write(&state, "hub:localdirs", true);
    let mut resp = json!({"ok": true, "id": did, "name": name, "path": real.to_string_lossy(),
        "origin": "linked"});
    if let Some(o) = resp.as_object_mut() {
        for (k, v) in scan.as_object().into_iter().flatten() {
            // Python _brief 口径：added/updated/skipped/removed 输出计数
            if matches!(k.as_str(), "added" | "updated" | "skipped" | "removed") {
                o.insert(k.clone(), json!(v.as_array().map(|a| a.len()).unwrap_or(0)));
            } else {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    jraw(200, resp)
}

async fn api_local_dirs_id(State(state): State<Arc<AppState>>, AxPath(id): AxPath<String>, method: Method) -> Response {
    if method != Method::DELETE {
        return jerr(404, "not found");
    }
    let Ok(did) = id.parse::<i64>() else { return jerr(400, "非法目录 id") };
    let c = wc(&state);
    let dir: Option<(String, String)> = c
        .query_row("SELECT name, path FROM local_dirs WHERE id=?1", [did],
            |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    let Some((name, path)) = dir else {
        return jraw(400, json!({"ok": false, "error": "目录不存在"}));
    };
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM registry_items WHERE dir_id=?1", [did], |r| r.get(0))
        .unwrap_or(0);
    let nb: i64 = c
        .query_row("SELECT COUNT(*) FROM dir_bindings WHERE dir_id=?1", [did], |r| r.get(0))
        .unwrap_or(0);
    let _ = c.execute("DELETE FROM registry_items WHERE dir_id=?1", [did]);
    let _ = c.execute("DELETE FROM dir_bindings WHERE dir_id=?1", [did]);
    let _ = c.execute("DELETE FROM local_dirs WHERE id=?1", [did]);
    let _ = depot_core::events::append(&c, &depot_core::events::Event {
        module: "skills", actor: "local", kind: "dir:remove", subject: None, outcome: "ok",
        error_code: None,
        extra: json!({"name": name, "path": path, "items_unregistered": n,
                      "bindings_removed": nb, "files_kept": true}),
        item_kind: None, item_name: Some(name.as_str()), item_version: None,
        source_id: None, target_id: None,
    });
    after_write(&state, "hub:localdirs", true);
    jraw(200, json!({"ok": true, "name": name, "path": path,
        "items_unregistered": n, "bindings_removed": nb}))
}

// ---------- skills / mcp / memory 模块分发 ----------

async fn api_skills(State(state): State<Arc<AppState>>, method: Method, AxPath(rest): AxPath<String>,
                    Query(q): Query<HashMap<String, String>>, bytes: Bytes) -> Response {
    let path = format!("/api/skills{}", if rest.is_empty() { String::new() } else { format!("/{rest}") });
    module_dispatch(&state, "skills", &method, &path, &q, &bytes).await
}

async fn api_mcp(State(state): State<Arc<AppState>>, method: Method, AxPath(rest): AxPath<String>,
                 Query(q): Query<HashMap<String, String>>, bytes: Bytes) -> Response {
    let path = format!("/api/mcp{}", if rest.is_empty() { String::new() } else { format!("/{rest}") });
    module_dispatch(&state, "mcp", &method, &path, &q, &bytes).await
}

async fn api_memory_overview(State(state): State<Arc<AppState>>) -> Response {
    let method = Method::GET;
    let q = HashMap::new();
    let bytes = Bytes::new();
    module_dispatch(&state, "memory", &method, "/api/memory/overview", &q, &bytes).await
}

async fn api_memory_scan(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let method = Method::POST;
    let q = HashMap::new();
    module_dispatch(&state, "memory", &method, "/api/memory/scan", &q, &bytes).await
}

async fn api_memory_distribute(State(state): State<Arc<AppState>>, bytes: Bytes) -> Response {
    let method = Method::POST;
    let q = HashMap::new();
    module_dispatch(&state, "memory", &method, "/api/memory/distribute", &q, &bytes).await
}

async fn api_memory_item(State(state): State<Arc<AppState>>, method: Method,
                         AxPath(iid): AxPath<String>, bytes: Bytes) -> Response {
    let q = HashMap::new();
    let path = format!("/api/memory/item/{iid}");
    module_dispatch(&state, "memory", &method, &path, &q, &bytes).await
}

async fn api_memory_adopt(State(state): State<Arc<AppState>>, AxPath(iid): AxPath<String>,
                          bytes: Bytes) -> Response {
    let method = Method::POST;
    let q = HashMap::new();
    let path = format!("/api/memory/item/{iid}/adopt");
    module_dispatch(&state, "memory", &method, &path, &q, &bytes).await
}

fn enabled_of(c: &rusqlite::Connection, module: &str) -> bool {
    match depot_core::tools::get_config(c, &format!("modules.enabled.{module}")) {
        None => true,
        Some(v) => !matches!(v.as_str(), "0" | "false" | "off" | "no"),
    }
}

fn qget(q: &HashMap<String, String>, k: &str) -> Option<String> {
    q.get(k).cloned().filter(|s| !s.is_empty())
}

async fn module_dispatch(
    state: &Arc<AppState>, module: &'static str, method: &Method,
    path: &str, q: &HashMap<String, String>, bytes: &Bytes,
) -> Response {
    let data = body_json(bytes);
    // query 合并进 body（Python 口径）
    let mut data = data;
    if let Some(obj) = data.as_object_mut() {
        for (k, v) in q {
            obj.entry(k.clone()).or_insert(json!(v));
        }
    }
    let hub = depot_core::paths::hub_dir();
    let module_gate_err = |msg: String| jraw(503, json!({"ok": false, "error": msg}));
    let r: Response = match module {
        "skills" => {
            let c = wc(state);
            if !depot_skills::extra::registry_enabled(&c) {
                return module_gate_err("模块已禁用（可在模块管理中启用）".into());
            }
            skills_route(state, &c, method, path, &data, q, &hub)
        }
        "mcp" => {
            let c = wc(state);
            if !depot_mcp::extra::registry_enabled(&c) {
                return module_gate_err("模块已禁用（可在模块管理中启用）".into());
            }
            mcp_route(state, &c, method, path, &data, q, &hub)
        }
        "memory" => {
            let c = wc(state);
            if !enabled_of(&c, "memory") {
                return module_gate_err("记忆模块已禁用（可在设置中启用）".into());
            }
            memory_route(state, &c, method, path, &data)
        }
        _ => jerr(404, "未知模块"),
    };
    r
}

fn seg_after<'a>(path: &'a str, prefix: &str) -> &'a str {
    path.strip_prefix(prefix).unwrap_or("")
}

fn skills_route(
    state: &Arc<AppState>, c: &rusqlite::Connection, method: &Method,
    path: &str, data: &Value, q: &HashMap<String, String>, hub: &Path,
) -> Response {
    use depot_skills::extra as ex;
    let m = method.as_str();
    // sources
    if path == "/api/skills/sources" {
        return match *method {
            Method::GET => jraw(200, json!({"ok": true, "sources": ex::list_sources(c)})),
            Method::POST => wrap_res(ex::add_source(c,
                data.get("name").and_then(|n| n.as_str()),
                data.get("url").and_then(|n| n.as_str()),
                data.get("branch").and_then(|n| n.as_str()),
                data.get("subdir").and_then(|n| n.as_str()),
                data.get("auth_ref").and_then(|n| n.as_str()))),
            _ => unknown("skills", m, path),
        };
    }
    if let Some(rest) = path.strip_prefix("/api/skills/sources/") {
        let (sid, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let Ok(sid) = sid.parse::<i64>() else { return jerr(400, "非法 source id") };
        return match (tail, method.clone()) {
            ("pull", Method::POST) => wrap_res(ex::pull_source(c, hub, sid,
                as_bool(data.get("force")),
                data.get("removed_action").and_then(|f| f.as_str()))),
            ("sync-local", Method::POST) => wrap_res(ex::sync_from_cache(c, hub, sid)),
            ("", Method::PATCH) => wrap_res(ex::update_source(c, sid, data)),
            ("", Method::DELETE) => wrap_res(ex::delete_source(c, hub, sid,
                data.get("removed_action").and_then(|f| f.as_str()))),
            _ => unknown("skills", m, path),
        };
    }
    if path == "/api/skills/items" && *method == Method::GET {
        let source = qget(q, "source");
        let dir = qget(q, "dir");
        let page = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
        let per_page = q.get("per_page").and_then(|p| p.parse().ok()).unwrap_or(20);
        return jraw(200, ex::items_view(c, hub, source.as_deref(), qget(q, "q").as_deref(),
            page, per_page, dir.as_deref()));
    }
    if path == "/api/skills/catalog" && *method == Method::GET {
        let sid = q.get("source_id").and_then(|s| s.parse::<i64>().ok());
        return jraw(200, json!({"ok": true, "items": ex::catalog_view(c, hub, sid)}));
    }
    if path == "/api/skills/registry" && *method == Method::GET {
        return jraw(200, json!({"ok": true, "items": ex::registry_view(c, hub)}));
    }
    if path == "/api/skills/registry/update" && *method == Method::POST {
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        if names.is_empty() {
            return jerr(400, "names 不能为空");
        }
        let sid = data.get("source_id").and_then(|s| s.as_i64());
        return jraw(200, json!({"ok": true,
            "results": ex::update_registry(c, hub, &names, sid,
                as_bool(data.get("force")))}));
    }
    if path == "/api/skills/registry/rollback" && *method == Method::POST {
        let Some(name) = data.get("name").and_then(|n| n.as_str()) else {
            return jerr(400, "name 必填");
        };
        return wrap_res(depot_skills::rollback_registry(c, hub, name, "local"));
    }
    if path == "/api/skills/diff" && *method == Method::GET {
        let Some(name) = qget(q, "name") else { return jerr(400, "name 必填") };
        return wrap_res(ex::diff_registry_vs_source(c, hub, &name, None));
    }
    if path == "/api/skills/registry/item" && *method == Method::POST {
        return wrap_res(depot_skills::create_manual(c, hub,
            data.get("name").and_then(|n| n.as_str()).unwrap_or(""),
            data.get("description").and_then(|n| n.as_str()).unwrap_or(""),
            data.get("files").unwrap_or(&json!({})),
            data.get("dir_id").and_then(|d| d.as_i64()), "local"));
    }
    if path == "/api/skills/registry/import" && *method == Method::POST {
        return wrap_res(ex::import_local(c, hub,
            data.get("path").and_then(|n| n.as_str()),
            data.get("name").and_then(|n| n.as_str()),
            as_bool(data.get("overwrite")),
            data.get("dir_id").and_then(|d| d.as_i64())));
    }
    if let Some(rest) = path.strip_prefix("/api/skills/registry/item/") {
        return match *method {
            Method::PUT => wrap_res(depot_skills::update_manual(c, hub, rest,
                data.get("files").unwrap_or(&json!({})), "local")),
            Method::DELETE => wrap_res(depot_skills::delete_manual(c, hub, rest,
                as_bool(data.get("force")), "local")),
            _ => unknown("skills", m, path),
        };
    }
    if let Some(name) = path.strip_prefix("/api/skills/item/") {
        if *method == Method::GET {
            return match ex::item_detail(c, hub, name) {
                Some(d) => {
                    let mut d = d;
                    d["ok"] = json!(true);
                    jraw(200, d)
                }
                None => jerr(404, "本地库中不存在"),
            };
        }
        return unknown("skills", m, path);
    }
    // dir-bindings
    if path == "/api/skills/dir-bindings" {
        return match *method {
            Method::GET => {
                let did = q.get("dir_id").and_then(|d| d.parse::<i64>().ok());
                jraw(200, json!({"ok": true, "bindings": ex::list_dir_bindings(c, did)}))
            }
            Method::POST => {
                let did = data.get("dir_id").and_then(|d| d.as_i64()).unwrap_or(0);
                let tids: Vec<i64> = data.get("target_ids").and_then(|t| t.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                    .unwrap_or_default();
                return wrap_res(ex::bind_dirs_full(c, hub, did, &tids,
                    data.get("mode").and_then(|x| x.as_str()).unwrap_or("copy"),
                    as_bool(data.get("force"))));
            }
            _ => unknown("skills", m, path),
        };
    }
    if path == "/api/skills/dir-bindings/sync" && *method == Method::POST {
        return jraw(200, json!({"ok": true, "results": ex::sync_all_bindings(c, hub)}));
    }
    if let Some(rest) = path.strip_prefix("/api/skills/dir-bindings/") {
        let (bid, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let Ok(bid) = bid.parse::<i64>() else { return jerr(400, "非法绑定 id") };
        return match (tail, method.clone()) {
            ("", Method::PATCH) => {
                if data.get("mode").is_some() {
                    wrap_res(ex::set_binding_mode(c, hub, bid,
                        data.get("mode").and_then(|m| m.as_str()).unwrap_or("copy")))
                } else if data.get("excluded").is_some() {
                    wrap_res(ex::set_binding_excluded(c, hub, bid, data.get("excluded").unwrap_or(&Value::Null)))
                } else if data.get("channels").is_some() {
                    wrap_res(ex::set_binding_channels(c, hub, bid, data.get("channels").unwrap_or(&Value::Null)))
                } else {
                    wrap_res(ex::set_binding_enabled(c, bid, as_bool(data.get("enabled"))))
                }
            }
            ("", Method::DELETE) => wrap_res(ex::unbind(c, hub, bid, as_bool(data.get("clean")))),
            ("sync", Method::POST) => {
                let bindings = ex::list_dir_bindings(c, None);
                let Some(b) = bindings.iter().find(|b| b["id"] == json!(bid)) else {
                    return jerr(404, "绑定不存在");
                };
                if b["enabled"] != json!(true) {
                    return jerr(400, "绑定已暂停");
                }
                let agg = ex::sync_binding_full(c, hub, b, false);
                let mut row = serde_json::Map::new();
                row.insert("binding_id".into(), json!(bid));
                row.insert("target".into(), b["target_name"].clone());
                for (k, v) in agg.as_object().into_iter().flatten() {
                    row.insert(k.clone(), v.clone());
                }
                jraw(200, json!({"ok": true, "results": [Value::Object(row)]}))
            }
            _ => unknown("skills", m, path),
        };
    }
    // targets
    if path == "/api/skills/targets" {
        return match *method {
            Method::GET => {
                let rows = depot_skills::list_targets(c, Some("skills_dir")).unwrap_or_default();
                let tmap = ex::tool_names_map(c);
                let targets: Vec<Value> = rows
                    .iter()
                    .filter(|t| ex::target_visible(c, t.tool.as_deref(), "skills_dir"))
                    .map(|t| {
                        let mut o = json!({"id": t.id, "name": t.name, "kind": t.kind,
                            "tool": t.tool, "path": t.path, "format_key": t.format_key});
                        if let Some(tool) = o["tool"].as_str() {
                            if let Some(n) = tmap.get(tool) {
                                o["tool_name"] = json!(n);
                            }
                        }
                        o
                    })
                    .collect();
                jraw(200, json!({"ok": true, "targets": targets}))
            }
            Method::POST => wrap_res(depot_skills::add_target(c,
                data.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("kind").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("tool").and_then(|n| n.as_str()),
                data.get("path").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("format_key").and_then(|n| n.as_str()))),
            _ => unknown("skills", m, path),
        };
    }
    if path == "/api/skills/targets/seed" && *method == Method::POST {
        return jraw(200, json!({"ok": true, "created": ex::seed_defaults(c)}));
    }
    if let Some(tid) = path.strip_prefix("/api/skills/targets/") {
        if *method == Method::DELETE {
            let Ok(tid) = tid.parse::<i64>() else { return jerr(400, "非法 target id") };
            return wrap_res(ex::delete_target(c, tid,
                as_bool(data.get("force"))));
        }
        return unknown("skills", m, path);
    }
    // tool items / extract / sync
    if path == "/api/skills/tool-items" && *method == Method::GET {
        return jraw(200, ex::tool_items(c, hub, qget(q, "tool").as_deref()));
    }
    if path == "/api/skills/extract" && *method == Method::POST {
        let tool = data.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        return wrap_res(ex::extract(c, hub, tool, &names));
    }
    if path == "/api/skills/tool-sync" && *method == Method::POST {
        let tool = data.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let tids: Vec<i64> = data.get("target_ids").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        return wrap_res(ex::sync_to_targets(c, hub, tool, &names, &tids,
            data.get("mode").and_then(|x| x.as_str()).unwrap_or("copy")));
    }
    if path == "/api/skills/distribute" && *method == Method::POST {
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let tids: Vec<i64> = data.get("target_ids").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        if names.is_empty() || tids.is_empty() {
            return jerr(400, "names 与 target_ids 必填");
        }
        return match depot_skills::distribute_skills(c, hub, &names, &tids,
            as_bool(data.get("dry_run")),
            as_bool(data.get("force")),
            data.get("mode").and_then(|x| x.as_str()).unwrap_or("copy"), "local")
        {
            Ok(results) => jraw(200, json!({"ok": true, "results": results})),
            Err(e) => jerr(e.status(), &e.message),
        };
    }
    unknown("skills", m, path)
}

fn mcp_route(
    state: &Arc<AppState>, c: &rusqlite::Connection, method: &Method,
    path: &str, data: &Value, q: &HashMap<String, String>, hub: &Path,
) -> Response {
    use depot_mcp::extra as ex;
    let m = method.as_str();
    if path == "/api/mcp/sources" {
        return match *method {
            Method::GET => jraw(200, json!({"ok": true, "sources": ex::list_sources(c)})),
            Method::POST => wrap_res(ex::add_source(c,
                data.get("name").and_then(|n| n.as_str()),
                data.get("url").and_then(|n| n.as_str()),
                data.get("branch").and_then(|n| n.as_str()),
                data.get("subdir").and_then(|n| n.as_str()),
                data.get("auth_ref").and_then(|n| n.as_str()))),
            _ => unknown("mcp", m, path),
        };
    }
    if let Some(rest) = path.strip_prefix("/api/mcp/sources/") {
        let (sid, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let Ok(sid) = sid.parse::<i64>() else { return jerr(400, "非法 source id") };
        return match (tail, method.clone()) {
            ("pull", Method::POST) => wrap_res(ex::pull_source(c, hub, sid,
                data.get("removed_action").and_then(|f| f.as_str()))),
            ("", Method::PATCH) => wrap_res(ex::update_source(c, sid, data)),
            ("", Method::DELETE) => wrap_res(ex::delete_source(c, hub, sid)),
            _ => unknown("mcp", m, path),
        };
    }
    if path == "/api/mcp/items" && *method == Method::GET {
        let source = qget(q, "source");
        let dir = qget(q, "dir");
        let page = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
        let per_page = q.get("per_page").and_then(|p| p.parse().ok()).unwrap_or(20);
        return jraw(200, ex::items_view(c, source.as_deref(), qget(q, "q").as_deref(),
            page, per_page, dir.as_deref()));
    }
    if path == "/api/mcp/catalog" && *method == Method::GET {
        let sid = q.get("source_id").and_then(|s| s.parse::<i64>().ok());
        return jraw(200, json!({"ok": true, "items": ex::catalog_view(c, sid)}));
    }
    if path == "/api/mcp/registry" && *method == Method::GET {
        return jraw(200, json!({"ok": true, "items": ex::registry_view(c)}));
    }
    if path == "/api/mcp/registry/update" && *method == Method::POST {
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        if names.is_empty() {
            return jerr(400, "names 不能为空");
        }
        let sid = data.get("source_id").and_then(|s| s.as_i64());
        return jraw(200, json!({"ok": true, "results":
            ex::update_registry(c, hub, &names, sid,
                as_bool(data.get("force")))}));
    }
    if path == "/api/mcp/registry/rollback" && *method == Method::POST {
        let Some(name) = data.get("name").and_then(|n| n.as_str()) else {
            return jerr(400, "name 必填");
        };
        return wrap_res(depot_mcp::rollback_registry(c, name, "local"));
    }
    if path == "/api/mcp/verify" && *method == Method::POST {
        let Some(name) = data.get("name").and_then(|n| n.as_str()) else {
            return jerr(400, "name 必填");
        };
        let mut r = ex::verify_item(c, name);
        r["ok"] = json!(r.get("ok").and_then(|x| x.as_bool()).unwrap_or(false));
        return jraw(200, r);
    }
    if let Some(name) = path.strip_prefix("/api/mcp/item/") {
        if *method == Method::GET {
            return match ex::item_detail(c, name) {
                Some(d) => {
                    let mut d = d;
                    d["ok"] = json!(true);
                    jraw(200, d)
                }
                None => jerr(404, "本地库中不存在"),
            };
        }
        return unknown("mcp", m, path);
    }
    if path == "/api/mcp/registry/item" && *method == Method::POST {
        return wrap_res(depot_mcp::create_manual(c,
            data.get("name").and_then(|n| n.as_str()).unwrap_or(""),
            data.get("config").unwrap_or(&json!({})),
            data.get("dir_id").and_then(|d| d.as_i64()), "local"));
    }
    if let Some(rest) = path.strip_prefix("/api/mcp/registry/item/") {
        return match *method {
            Method::PUT => wrap_res(depot_mcp::update_manual(c, rest,
                data.get("config").unwrap_or(&json!({})), "local")),
            Method::DELETE => wrap_res(depot_mcp::delete_manual(c, rest,
                as_bool(data.get("force")), "local")),
            _ => unknown("mcp", m, path),
        };
    }
    if path == "/api/mcp/targets" {
        return match *method {
            Method::GET => {
                let rows = depot_mcp::list_targets(c);
                let targets: Vec<Value> = rows
                    .iter()
                    .filter(|t| {
                        depot_core::tools::tool_by_id(c, t.tool.as_deref().unwrap_or(""))
                            .map(|tool| {
                                tool.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
                                    && tool.get("mcp_config").and_then(|m| m.as_str())
                                        .map(|m| !m.is_empty()).unwrap_or(false)
                            })
                            .unwrap_or(t.tool.is_none())
                    })
                    .map(|t| {
                        let mut o = json!({"id": t.id, "name": t.name, "kind": t.kind,
                            "tool": t.tool, "path": t.path, "format_key": t.format_key});
                        if let Some(tool_id) = o["tool"].as_str() {
                            if let Some(tool) = depot_core::tools::tool_by_id(c, tool_id) {
                                o["tool_name"] = tool["name"].clone();
                            }
                        }
                        o
                    })
                    .collect();
                jraw(200, json!({"ok": true, "targets": targets}))
            }
            Method::POST => wrap_res(depot_skills::add_target(c,
                data.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("kind").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("tool").and_then(|n| n.as_str()),
                data.get("path").and_then(|n| n.as_str()).unwrap_or(""),
                data.get("format_key").and_then(|n| n.as_str()))),
            _ => unknown("mcp", m, path),
        };
    }
    if path == "/api/mcp/targets/seed" && *method == Method::POST {
        return jraw(200, json!({"ok": true, "created": ex::seed_defaults(c)}));
    }
    if let Some(tid) = path.strip_prefix("/api/mcp/targets/") {
        if *method == Method::DELETE {
            let Ok(tid) = tid.parse::<i64>() else { return jerr(400, "非法 target id") };
            return wrap_res(ex::delete_target(c, tid,
                as_bool(data.get("force"))));
        }
        return unknown("mcp", m, path);
    }
    if path == "/api/mcp/tool-items" && *method == Method::GET {
        return jraw(200, ex::tool_items(c, qget(q, "tool").as_deref()));
    }
    if path == "/api/mcp/extract" && *method == Method::POST {
        let tool = data.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        return wrap_res(ex::extract(c, tool, &names));
    }
    if path == "/api/mcp/tool-sync" && *method == Method::POST {
        let tool = data.get("tool").and_then(|t| t.as_str()).unwrap_or("");
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let tids: Vec<i64> = data.get("target_ids").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        return wrap_res(ex::sync_to_targets(c, tool, &names, &tids));
    }
    if path == "/api/mcp/distribute" && *method == Method::POST {
        let names: Vec<String> = data.get("names").and_then(|n| n.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let tids: Vec<i64> = data.get("target_ids").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        if names.is_empty() || tids.is_empty() {
            return jerr(400, "names 与 target_ids 必填");
        }
        return match depot_mcp::distribute_mcp(c, &names, &tids,
            as_bool(data.get("dry_run")),
            as_bool(data.get("force")), "local")
        {
            Ok(results) => jraw(200, json!({"ok": true, "results": results})),
            Err(e) => jerr(e.status(), &e.message),
        };
    }
    unknown("mcp", m, path)
}

fn memory_route(
    state: &Arc<AppState>, c: &rusqlite::Connection, method: &Method,
    path: &str, data: &Value,
) -> Response {
    let m = method.as_str();
    let _ = state;
    if path == "/api/memory/overview" && *method == Method::GET {
        let mut o = depot_memory::overview(c);
        o["ok"] = json!(true);
        return jraw(200, o);
    }
    if path == "/api/memory/scan" && *method == Method::POST {
        let tool = data.get("tool").and_then(|t| t.as_str()).map(|s| s.to_string());
        let ids: Option<Vec<String>> = tool.map(|t| vec![t]);
        return jraw(200, json!({"ok": true, "results": depot_memory::scan_tools(c, ids.as_deref())}));
    }
    if path == "/api/memory/distribute" && *method == Method::POST {
        let item_ids: Vec<i64> = data.get("item_ids").and_then(|i| i.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        let tools: Vec<String> = data.get("tools").and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        if item_ids.is_empty() || tools.is_empty() {
            return jerr(400, "item_ids 与 tools 必填");
        }
        return jraw(200, json!({"ok": true, "results": depot_memory::distribute(c, &item_ids,
            &tools, as_bool(data.get("force")))}));
    }
    if let Some(rest) = path.strip_prefix("/api/memory/item/") {
        let (iid, tail) = rest.split_once('/').unwrap_or((rest, ""));
        let Ok(iid) = iid.parse::<i64>() else { return jerr(400, "非法条目 id") };
        return match (tail, method.clone()) {
            ("", Method::GET) => {
                let row: bool = c
                    .query_row("SELECT 1 FROM memory_items WHERE id=?1", [iid], |_| Ok(true))
                    .unwrap_or(false);
                if !row {
                    jerr(404, "条目不存在")
                } else {
                    wrap_res(depot_memory::get_item_full(c, iid))
                }
            }
            ("", Method::PUT) => wrap_res(depot_memory::edit_item(c, iid,
                data.get("content").and_then(|x| x.as_str()).unwrap_or(""))),
            ("", Method::DELETE) => {
                let row: bool = c
                    .query_row("SELECT 1 FROM memory_items WHERE id=?1", [iid], |_| Ok(true))
                    .unwrap_or(false);
                if !row {
                    jerr(404, "条目不存在")
                } else {
                    wrap_res(depot_memory::delete_item(c, iid))
                }
            }
            ("adopt", Method::POST) => wrap_res(depot_memory::adopt_source(c, iid)),
            _ => jraw(404, json!({"ok": false, "error": format!("memory: 未知路由 {m} {path}")})),
        };
    }
    jraw(404, json!({"ok": false, "error": format!("memory: 未知路由 {m} {path}")}))
}

fn unknown(module: &str, method: &str, path: &str) -> Response {
    jraw(404, json!({"ok": false, "error": format!("{module}: 未知路由 {method} {path}")}))
}

/// 安全响应头（对位浏览器端加固）：
/// - CSP：默认只允许同源脚本/样式/连接；style-src 允许 inline（现有大量内联 style 属性，Phase 8 收紧）
/// - nosniff / Referrer-Policy / frame 禁嵌
async fn security_headers(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        axum::http::HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; \
             base-uri 'self'; frame-ancestors 'none'",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        axum::http::HeaderValue::from_static("no-referrer"),
    );
    res
}
