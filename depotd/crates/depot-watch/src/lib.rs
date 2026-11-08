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
use notify_debouncer_full::{
    DebounceEventResult, Debouncer, NoCache, new_debouncer_opt,
};
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
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher, NoCache>>>,
    /// 已注册过 watch 的路径（增量注册：避免每次 set_roots 全量重建）
    watched: Mutex<std::collections::HashSet<PathBuf>>,
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
            watched: Mutex::new(Default::default()),
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
        self.ensure_debouncer();
        self.resyncs.fetch_add(1, Ordering::Relaxed);
        self.manifest_snapshot(); // 建基线（不触发广播）
    }

    /// 确保 debouncer 存在且覆盖全部 roots。
    ///
    /// 两个关键设计（2026-11-08 内存事故修复）：
    /// 1. **NoCache 替代 FileIdMap**：默认的 RecommendedCache 会在 watch() 时
    ///    walkdir 递归遍历整棵被监控树并给每个文件缓存 file-id——真实机器上
    ///    ~/.claude/projects 等根有海量文件，内存无界增长（用户观测到 30G）、
    ///    启动阶段卡死数分钟（端口都无法绑定）。NoCache 零缓存；代价是
    ///    rename 事件会拆成 create+remove 两条——本实现的消费端只做
    ///    「路径→scope」映射，两种形态效果相同，无行为差异。
    /// 2. **debouncer 只创建一次，watch 增量注册**：旧实现每次 set_roots
    ///    全量重建 debouncer + 重新 watch 所有根（roots 集合在 /api/tools、
    ///    /api/local-dirs 写操作后刷新）→ 每次都全树重走。现在只 watch 新增路径。
    fn ensure_debouncer(self: &Arc<Self>) {
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
        let mut guard = self.debouncer.lock().unwrap();
        if guard.is_none() {
            let me = Arc::clone(self);
            match new_debouncer_opt(
                DEBOUNCE,
                None,
                move |events| me.on_events(events),
                NoCache,
                notify::Config::default(),
            ) {
                Ok(d) => *guard = Some(d),
                Err(e) => {
                    tracing::warn!("notify 初始化失败，退化为 manifest 轮询: {e}");
                    return;
                }
            }
        }
        let d = guard.as_mut().unwrap();
        let mut watched = self.watched.lock().unwrap();
        let mut failed = 0usize;
        for p in &paths {
            if watched.contains(p) {
                continue; // 已注册：增量跳过
            }
            let mode = if p.is_dir() {
                RecursiveMode::Recursive
            } else {
                // 文件根：监控父目录（非递归）
                match p.parent() {
                    Some(parent) => {
                        if d.watch(parent, RecursiveMode::NonRecursive).is_err() {
                            failed += 1;
                            continue;
                        }
                        watched.insert(p.clone());
                        continue;
                    }
                    None => continue,
                }
            };
            if d.watch(p, mode).is_err() {
                failed += 1; // watch 描述符耗尽等：该根从此无事件
            } else {
                watched.insert(p.clone());
            }
        }
        if failed > 0 {
            tracing::error!("watcher 注册失败 {} 个根（将仅靠 manifest 兜底轮询）", failed);
            self.failed_watches
                .fetch_add(failed as u64, Ordering::Relaxed);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归钉（2026-11-08 FileIdMap 内存事故）：set_roots 必须不做全树遍历。
    /// 造一棵 1 万文件树，注册须在 1s 内完成——FileIdMap 回归时 walkdir+stat
    /// 1 万文件（暖缓存也要秒级）+ 缓存分配会让此测试显著变慢并红。
    #[test]
    fn set_roots_does_not_walk_watched_tree() {
        let w = Watcher::new();
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("big-tree");
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..10_000u32 {
            std::fs::write(root.join(format!("f{i:05}.txt")), "x").unwrap();
        }
        let mut mapping = HashMap::new();
        mapping.insert("test:big".to_string(), vec![root.clone()]);
        let start = std::time::Instant::now();
        w.set_roots(&mapping);
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "set_roots 耗时 {elapsed:?}——疑似回归到全树遍历缓存（FileIdMap）"
        );
        // 状态自洽：已注册、无失败
        assert!(w.status()["failed_watches"].as_u64() == Some(0));
        assert!(w.rev() >= 0);
    }

    /// 文件根（非目录）挂父目录非递归：不 panic、注册成功。
    #[test]
    fn file_root_watches_parent() {
        let w = Watcher::new();
        let base = tempfile::tempdir().unwrap();
        let f = base.path().join("db.sqlite");
        std::fs::write(&f, "x").unwrap();
        let mut mapping = HashMap::new();
        mapping.insert("tool:x".to_string(), vec![f.clone()]);
        w.set_roots(&mapping);
        assert!(w.scope_of(&f).as_deref() == Some("tool:x"));
    }

    /// 事件→scope 最长前缀匹配。
    #[test]
    fn scope_longest_prefix() {
        let w = Watcher::new();
        let base = tempfile::tempdir().unwrap();
        let a = base.path().join("a");
        let ab = a.join("sub");
        std::fs::create_dir_all(&ab).unwrap();
        let mut mapping = HashMap::new();
        mapping.insert("tool:a".to_string(), vec![a.clone()]);
        mapping.insert("tool:ab".to_string(), vec![ab.clone()]);
        w.set_roots(&mapping);
        assert_eq!(w.scope_of(&ab.join("x.txt")).as_deref(), Some("tool:ab"));
        assert_eq!(w.scope_of(&a.join("y.txt")).as_deref(), Some("tool:a"));
    }
}
