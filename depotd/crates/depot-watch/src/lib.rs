//! 文件监控 → SSE 即时刷新（对位 hub/watcher.py，Tier 2 内部自由）。
//!
//! 设计要点（沿用 Python 版语义）：
//! - notify（macOS FSEvents/kqueue）递归监控已存在的根；不存在的路径挂最近已存在祖先，
//!   创建后即可见；另有一层 manifest 兜底轮询（2s）防漏事件。
//! - 合并抖动 250ms：风暴攒「脏 scope 集合」，窗口过后只广播一次 `{rev, scopes, full}`。
//! - 自身写入直推：`bump(scope)` 立即广播（POST/PATCH 后端不等 watcher）。
//! - 订阅端 `broadcast` 通道：满了丢最旧，永不阻塞 watcher。
//! - status() 的 `backend` 恒为 "notify"（≠ "off" 即可，前端只判非 off）。

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use tokio::sync::broadcast;

const IGNORE_DIRS: [&str; 7] = [".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".cache"];
const IGNORE_SUFFIX: [&str; 8] = [".tmp", ".swp", ".swx", "-wal", "-shm", ".lock", ".DS_Store", "~"];
const DEBOUNCE: Duration = Duration::from_millis(250);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_DIRTY: usize = 64;

fn ignored(path: &Path) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return true;
    };
    if name == ".DS_Store" || IGNORE_SUFFIX.iter().any(|s| name.ends_with(s)) {
        return true;
    }
    path.ancestors()
        .filter_map(|a| a.file_name())
        .any(|n| IGNORE_DIRS.contains(&n.to_string_lossy().as_ref()))
}

fn stat_of(p: &Path) -> Option<(u128, u64)> {
    let md = std::fs::metadata(p).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime, md.len()))
}

struct Inner {
    /// (根路径, scope)；scope_of 做最长前缀匹配。
    roots: Vec<(PathBuf, String)>,
    /// manifest 兜底快照：root → (mtime_nanos, size)。
    manifest: HashMap<PathBuf, (u128, u64)>,
    dirty: BTreeSet<(String, bool)>,
}

impl Inner {
    fn mark(&mut self, scope: String, full: bool) {
        self.dirty.insert((if scope.is_empty() { "hub".into() } else { scope }, full));
        if self.dirty.len() > MAX_DIRTY {
            // 风暴保护：降级为全量
            self.dirty.clear();
            self.dirty.insert(("hub".into(), true));
        }
    }
}

pub struct Watcher {
    inner: Arc<Mutex<Inner>>,
    tx: broadcast::Sender<String>,
    rev: AtomicU64,
    events: AtomicU64,
    resyncs: AtomicU64,
    failed_watches: AtomicU64,
    backend: &'static str,
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher, RecommendedCache>>>,
}

impl Watcher {
    pub fn new() -> Arc<Watcher> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Watcher {
            inner: Arc::new(Mutex::new(Inner {
                roots: Vec::new(),
                manifest: HashMap::new(),
                dirty: Default::default(),
            })),
            tx,
            rev: AtomicU64::new(0),
            events: AtomicU64::new(0),
            resyncs: AtomicU64::new(0),
            failed_watches: AtomicU64::new(0),
            backend: "notify",
            debouncer: Mutex::new(None),
        })
    }

    /// mapping: {scope: [path, ...]}；重复调用重建监控（幂等）。
    pub fn set_roots(self: &Arc<Self>, mapping: &HashMap<String, Vec<PathBuf>>) {
        let mut roots: Vec<(PathBuf, String)> = Vec::new();
        for (scope, paths) in mapping {
            for p in paths {
                if p.as_os_str().is_empty() {
                    continue;
                }
                roots.push((p.clone(), scope.clone()));
                // 不存在的路径：挂最近已存在祖先（创建后事件落在祖先上）
                let mut anc = p.parent().map(|p| p.to_path_buf());
                while let Some(a) = anc {
                    if a == *p {
                        break;
                    }
                    if a.exists() {
                        roots.push((a.clone(), scope.clone()));
                        break;
                    }
                    anc = a.parent().map(|p| p.to_path_buf());
                }
            }
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.roots = roots;
            inner.manifest.clear();
        }
        self.restart_debouncer();
        self.resyncs.fetch_add(1, Ordering::Relaxed);
        self.manifest_snapshot(); // 建基线（不触发广播）
    }

    fn restart_debouncer(self: &Arc<Self>) {
        let paths: Vec<PathBuf> = {
            let inner = self.inner.lock().unwrap();
            let mut seen = Vec::new();
            for (p, _) in &inner.roots {
                if !seen.contains(p) {
                    seen.push(p.clone());
                }
            }
            seen
        };
        let me = Arc::clone(self);
        let failed_counter = Arc::clone(&me);
        let mut guard = self.debouncer.lock().unwrap();
        match new_debouncer(DEBOUNCE, None, move |events| me.on_events(events)) {
            Ok(mut d) => {
                let mut failed = 0usize;
                for p in &paths {
                    let mode = if p.is_dir() {
                        RecursiveMode::Recursive
                    } else {
                        // 文件根：监控父目录（非递归）
                        match p.parent() {
                            Some(parent) => {
                                if d.watch(parent, RecursiveMode::NonRecursive).is_err() {
                                    failed += 1;
                                }
                                continue;
                            }
                            None => continue,
                        }
                    };
                    if d.watch(p, mode).is_err() {
                        failed += 1; // watch 描述符耗尽等：该根从此无事件
                    }
                }
                if failed > 0 {
                    tracing::error!("watcher 注册失败 {} 个根（将仅靠 manifest 兜底轮询）", failed);
                    failed_counter.failed_watches.store(failed as u64, Ordering::Relaxed);
                }
                *guard = Some(d);
            }
            Err(e) => tracing::warn!("notify 初始化失败，退化为 manifest 轮询: {e}"),
        }
    }

    fn on_events(self: &Arc<Self>, events: DebounceEventResult) {
        let Ok(evs) = events else { return };
        let mut scopes: Vec<String> = Vec::new();
        for ev in &evs {
            for path in &ev.paths {
                if ignored(path) {
                    continue;
                }
                if let Some(scope) = self.scope_of(path) {
                    if !scopes.contains(&scope) {
                        scopes.push(scope);
                    }
                }
            }
        }
        if scopes.is_empty() {
            return;
        }
        self.events.fetch_add(scopes.len() as u64, Ordering::Relaxed);
        {
            let mut inner = self.inner.lock().unwrap();
            for s in scopes {
                inner.mark(s, false);
            }
        }
        self.flush();
    }

    /// 路径 → scope（最长前缀匹配）。
    pub fn scope_of(&self, path: &Path) -> Option<String> {
        let p = path.to_string_lossy();
        let inner = self.inner.lock().unwrap();
        let mut best: Option<(String, usize)> = None;
        for (root, scope) in &inner.roots {
            let rs = root.to_string_lossy();
            let rs = rs.trim_end_matches('/');
            if p.starts_with(rs)
                && (p.len() == rs.len() || p.as_bytes().get(rs.len()) == Some(&b'/'))
                && best.as_ref().map(|(_, l)| rs.len() > *l).unwrap_or(true)
            {
                best = Some((scope.clone(), rs.len()));
            }
        }
        best.map(|(s, _)| s)
    }

    /// 自身写入 / 后台任务后立即广播。
    pub fn bump(&self, scope: &str, full: bool) {
        self.events.fetch_add(1, Ordering::Relaxed);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.mark(scope.to_string(), full);
        }
        self.flush();
    }

    /// 合并脏集合并广播（rev 单调递增）。
    fn flush(&self) {
        let dirty: Vec<(String, bool)> = {
            let mut inner = self.inner.lock().unwrap();
            if inner.dirty.is_empty() {
                return;
            }
            std::mem::take(&mut inner.dirty).into_iter().collect()
        };
        let rev = self.rev.fetch_add(1, Ordering::Relaxed) + 1;
        let mut scopes: Vec<String> = Vec::new();
        let mut full = false;
        for (s, f) in dirty {
            if !scopes.contains(&s) {
                scopes.push(s);
            }
            full = full || f;
        }
        if full && !scopes.iter().any(|s| s == "hub") {
            scopes.push("hub".into());
        }
        let payload = serde_json::json!({
            "rev": rev, "scopes": scopes, "full": full,
            "ts": SystemTime::now().duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64()).unwrap_or(0.0),
        })
        .to_string();
        let _ = self.tx.send(payload); // 无订阅者时可忽略
    }

    /// manifest 兜底：对所有已登记根做 mtime+size 清单比对（漏事件也能发现）。
    /// 首次调用只建基线不广播。
    pub fn manifest_snapshot(&self) {
        // 先取 roots 快照，锁内只做比对与写快照（避免借用冲突）
        let roots: Vec<PathBuf> = {
            let inner = self.inner.lock().unwrap();
            inner.roots.iter().map(|(p, _)| p.clone()).collect()
        };
        let mut dirty_scopes: Vec<String> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            for p in &roots {
                let cur = stat_of(p);
                let changed = match (inner.manifest.get(p), cur.as_ref()) {
                    (Some(prev), Some(c)) => prev != c && !ignored(p),
                    _ => false,
                };
                if changed {
                    dirty_scopes.push(p.to_string_lossy().to_string());
                }
                if let Some(c) = cur {
                    inner.manifest.insert(p.clone(), c);
                }
            }
        }
        if dirty_scopes.is_empty() {
            return;
        }
        let mut scopes: Vec<String> = Vec::new();
        for raw in dirty_scopes {
            if let Some(s) = self.scope_of(Path::new(&raw)) {
                if !scopes.contains(&s) {
                    scopes.push(s);
                }
            }
        }
        if scopes.is_empty() {
            return;
        }
        self.events.fetch_add(scopes.len() as u64, Ordering::Relaxed);
        {
            let mut inner = self.inner.lock().unwrap();
            for s in scopes {
                inner.mark(s, false);
            }
        }
        self.flush();
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    pub fn rev(&self) -> u64 {
        self.rev.load(Ordering::Relaxed)
    }

    pub fn status(&self) -> serde_json::Value {
        let watched = self.inner.lock().unwrap().roots.len();
        serde_json::json!({
            "backend": self.backend,
            "rev": self.rev(),
            "events": self.events.load(Ordering::Relaxed),
            "resyncs": self.resyncs.load(Ordering::Relaxed),
            "watched": watched,
            "fds": 0,
            "subs": self.subscriber_count(),
            "degraded": self.failed_watches.load(Ordering::Relaxed) > 0,
            "failed_watches": self.failed_watches.load(Ordering::Relaxed),
        })
    }

    /// 启动 manifest 兜底轮询（tokio 后台任务）。
    pub fn start_polling(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(POLL_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                me.manifest_snapshot();
            }
        })
    }
}
