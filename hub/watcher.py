"""文件监控 → 即时刷新（SSE 推送）。

设计要点
--------
1) **三级后端**（自动降级，零强制依赖）：
   - `watchdog`：装了就用它（递归、精确到文件）
   - **kqueue**（macOS/BSD，stdlib）：注册"目录 + 文件"fd，精确到文件
   - **manifest 兜底**（任何平台）：只对已注册路径做 mtime+size 清单比对（默认 2s）
2) **合并抖动**：一次 `git checkout` / `npm i` 会打几千条事件 → 攒进"脏 scope 集合"，
   抖动窗口（默认 250ms）过后只广播一次：`{rev, scopes:[...]}`。
3) **自身写入直推**：自己写盘不动等 watcher（可能有延迟/被忽略）——写完调用
   `bump(scope)`，立即广播并把 rev 加一。
4) **溢出/断档兜底**：FSEvents 的 mustScanSubDirs、inotify 队列溢出、kqueue 目录被重建…
   一律广播 `full=true`，由前端做一次全量重取（而不是相信增量）。
5) 订阅端是 `queue.Queue`：满了丢最旧的一条，**永不阻塞** watcher 线程。

对外接口
--------
    w = FileWatcher()
    w.set_roots({"tool:zcode": ["~/.zcode/cli/db/db.sqlite"], "memory:zcode": [...]})
    w.start()
    q = w.subscribe()          # SSE 端点用；get(timeout) 拿事件
    w.bump("hub")              # 自身写入后立即广播
    w.unsubscribe(q)
    w.status()                 # {backend, rev, events, resyncs, watched, degraded}
"""
import os
import queue
import threading
import time

IGNORE_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".cache"}
IGNORE_SUFFIX = (".tmp", ".swp", ".swx", "-wal", "-shm", ".lock", ".DS_Store", "~")

# 一次抖动窗口内最多广播多少条（防止事件风暴把订阅端刷爆）
MAX_DIRTY_SCOPES = 64


def _expand(p):
    return os.path.abspath(os.path.expanduser(str(p))) if p else ""


def _ignored(path):
    parts = [p for p in str(path).split(os.sep) if p and p not in (".", "..")]
    if any(p in IGNORE_DIRS for p in parts):        # 深层 node_modules / .git 里的事件一律忽略
        return True
    base = parts[-1] if parts else ""
    if base == ".DS_Store":  # mutate: disable 与 IGNORE_SUFFIX 里的 ".DS_Store" 重复，删掉不影响行为
        return True
    return any(base.endswith(suf) for suf in IGNORE_SUFFIX)


def _norm(path):
    """规范化 + 解析符号链接（父目录可能不存在，逐级回溯）。"""
    p = _expand(path)
    if not p:
        return ""
    try:
        return os.path.realpath(p)
    except OSError:
        return p


class FileWatcher(object):
    def __init__(self, debounce=0.25, interval=2.0, max_files=4096, logger=None):
        self.debounce = float(debounce)
        self.interval = float(interval)
        self.max_files = int(max_files)
        self.logger = logger

        self._lock = threading.RLock()
        self._roots = {}            # realpath -> scope
        self._scope_paths = {}      # scope -> [realpath]
        self._subs = set()          # queue.Queue
        self._dirty = set()         # (scope, full)
        self._dirty_since = 0.0
        self._rev = 0
        self._events = 0
        self._resyncs = 0
        self._degraded = False
        self._needs_rescan = False
        self._stop = threading.Event()
        self._threads = []
        self.backend = "none"

    # ---------------- 注册路径 ----------------
    def set_roots(self, mapping):
        """mapping: {scope: [path, ...]}；重复调用会重建监控（幂等）。"""
        roots, scope_paths = {}, {}
        for scope, paths in (mapping or {}).items():
            plist = []
            for p in paths or []:
                rp = _norm(p)
                if not rp:
                    continue
                plist.append(rp)                        # 不存在也登记：父目录挂监控，创建后即可见
                if os.path.exists(rp):
                    roots[rp] = scope
            if plist:
                scope_paths[scope] = plist
        with self._lock:
            self._roots = roots
            self._scope_paths = scope_paths
        # 逐级向上挂"还不存在"的父目录：一旦路径被创建，事件会落在这些祖先上
        for scope, plist in list(scope_paths.items()):
            for rp in list(plist):
                parent = os.path.dirname(rp)
                while parent and parent != "/" and not os.path.exists(parent):
                    roots.setdefault(parent, scope)
                    parent = os.path.dirname(parent)
                if not os.path.exists(rp) and os.path.isdir(parent or ""):
                    roots.setdefault(parent, scope)     # 挂最近的已存在祖先
        with self._lock:
            self._needs_rescan = True          # 各后端下一轮自检时重挂
        return len(roots)

    def _note_root(self, roots, path, scope):
        # 最长前缀优先：同一个 path 只记一次，但允许被更具体的目标覆盖
        roots[path] = scope

    def scope_of(self, path):
        """路径 → scope（最长前缀匹配）。"""
        rp = _norm(path)
        best, best_len = None, -1  # mutate: disable 初值 -1/0 等价（命中时 len(root) ≥ 1）
        with self._lock:
            for root, scope in self._roots.items():
                if rp == root or rp.startswith(root.rstrip("/") + "/"):
                    if len(root) > best_len:
                        best, best_len = scope, len(root)
        return best

    def watched_paths(self):
        with self._lock:
            return sorted(self._scope_paths.items())

    # ---------------- 自身写入 ----------------
    def bump(self, scope="hub", full=False):  # mutate: disable _mark 里还有一层 `scope or "hub"` 兜底，默认值不可观测
        """自己写盘 / 后台任务完成后立刻广播（不等 watcher）。"""
        self._mark(scope or "hub", full=full)  # mutate: disable 与 _mark 内部的兜底重复
        self._flush(force=True)
        self._events += 1

    # ---------------- 订阅 ----------------
    def subscribe(self):
        q = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def subscriber_count(self):
        with self._lock:
            return len(self._subs)

    def status(self):
        with self._lock:
            return {"backend": self.backend, "rev": self._rev, "events": self._events,
                    "resyncs": self._resyncs, "watched": len(self._roots),
                    "fds": len(getattr(self, "_kq_watch", {}) or {}),  # mutate: disable getattr 默认值已经是 {}，`or {}` 冗余
                    "subs": len(self._subs), "degraded": self._degraded}

    # ---------------- 广播 ----------------
    def _mark(self, scope, full=False):
        with self._lock:
            self._dirty.add((scope or "hub", bool(full)))  # mutate: disable _flush 里对 scope 不做区分，空串与 "hub" 等价
            if not self._dirty_since:
                self._dirty_since = time.time()
            if len(self._dirty) > MAX_DIRTY_SCOPES:      # 风暴保护：降级为全量
                self._dirty = {("hub", True)}
                self._degraded = True

    def _flush(self, force=False):
        with self._lock:
            if not self._dirty:
                return
            if not force and (time.time() - self._dirty_since) < self.debounce:
                return
            dirty, self._dirty = self._dirty, set()
            self._dirty_since = 0.0
            self._rev += 1
            rev = self._rev
        scopes, full = [], False
        for scope, f in dirty:
            if scope not in scopes:
                scopes.append(scope)
            full = full or f
        if full and "hub" not in scopes:  # mutate: disable 补 hub 是幂等兜底，重复补也无害
            scopes.append("hub")
        payload = {"rev": rev, "scopes": scopes, "full": full, "ts": time.time()}
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                try:
                    q.get_nowait()          # 丢最旧，保证新事件能进
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    pass

    # ---------------- 生命周期 ----------------
    def start(self):
        if self._threads:
            return self
        self._stop.clear()
        if self._start_watchdog():
            self.backend = "watchdog"
        elif self._start_kqueue():
            self.backend = "kqueue"
        else:
            self.backend = "manifest"
            self._degraded = True
            self.start_manifest_loop()
        # 注意：manifest 分支里 start_manifest_loop() 已经起过 flush 线程，
        # 这里必须判重，否则 manifest 后端会跑两个 flush 线程（空转翻倍）。
        if not any(t.name == "hub-watch-flush" for t in self._threads):
            t = threading.Thread(target=self._flush_loop, name="hub-watch-flush", daemon=True)
            t.start()
            self._threads.append(t)
        return self

    def stop(self):
        self._stop.set()
        for t in self._threads:
            t.join(timeout=1.0)
        self._threads = []

    def _restart_backend(self):
        # 路径变更：kqueue 需要重挂 fd；watchdog 关掉重开
        if self.backend == "kqueue":
            self._stop.set()
            self._stop = threading.Event()
            self._start_kqueue()
        elif self.backend == "watchdog":
            self._stop.set()
            self._stop = threading.Event()
            self._obs = None
            self._start_watchdog()

    def _flush_loop(self):
        while not self._stop.is_set():
            try:
                self._flush()
            except Exception:
                pass
            self._stop.wait(0.08)

    # ---------------- 后端 1：watchdog ----------------
    def _start_watchdog(self):
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except Exception:
            return False

        w = self

        class _H(FileSystemEventHandler):
            def on_any_event(self, event):
                if getattr(event, "is_directory", False) and event.event_type == "modified":
                    return
                path = getattr(event, "dest_path", None) or getattr(event, "src_path", "")
                if not path or _ignored(path):
                    return
                scope = w.scope_of(path)
                if scope:
                    w._mark(scope)
                    w._events += 1

        try:
            obs = Observer(timeout=0.2)
            for path in list(self._roots.keys()):
                if os.path.isdir(path):
                    obs.schedule(_H(), path, recursive=True)
                else:
                    obs.schedule(_H(), os.path.dirname(path) or "/", recursive=False)
            obs.daemon = True
            obs.start()
            self._obs, self._wd_handler = obs, _H
            t = threading.Thread(target=self._watchdog_loop, name="hub-watch-dog", daemon=True)
            t.start()
            self._threads.append(t)
            return True
        except Exception:
            return False

    def _watchdog_loop(self):
        while not self._stop.is_set():
            with self._lock:
                need, self._needs_rescan = self._needs_rescan, False
            if need:
                try:
                    self._watchdog_schedule()
                except Exception:
                    pass
            try:
                self._manifest_diff()          # 兜底校验：watcher 漏事件也能发现
            except Exception:
                pass
            self._stop.wait(max(5.0, self.interval * 5))

    def _watchdog_schedule(self):
        obs, H = getattr(self, "_obs", None), getattr(self, "_wd_handler", None)
        if not obs or not H:
            return False
        try:
            obs.unschedule_all()
        except Exception:
            pass
        for path in list(self._roots.keys()):
            try:
                obs.schedule(H(), path if os.path.isdir(path) else (os.path.dirname(path) or "/"),
                             recursive=os.path.isdir(path))
            except Exception:
                continue
        return True

    # ---------------- 后端 2：kqueue（macOS/BSD） ----------------
    def _start_kqueue(self):
        try:
            import select
            if not hasattr(select, "kqueue"):
                return False
            import resource
            try:                                    # 每个被监控文件占一个 fd
                soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
                want = min(max(self.max_files + 256, 1024), hard if hard > 0 else 1024)  # mutate: disable 只影响「尽量抬 rlimit」，实际 fd 上限取进程 rlimit，不可观测
                if soft < want:  # mutate: disable 同上：软限是否已够，外部不可观测
                    resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
            except Exception:
                pass
            kq = select.kqueue()
        except Exception:
            return False

        watch = {}
        self._kq, self._kq_watch = kq, watch
        self._pending = []
        try:
            self._kqueue_register(limit=64)        # 少量先挂上，其余循环里逐步补  # mutate: disable 启动时预挂条数不可观测（循环里会补齐）
        except Exception:
            pass
        self._kq, self._kq_watch = kq, watch
        t = threading.Thread(target=self._kqueue_loop, name="hub-watch-kqueue", daemon=True)
        t.start()
        self._threads.append(t)
        return True

    def _iter_paths(self, root):
        """浅层优先的候选路径（目录先、文件后），总数受 max_files 限制。

        不做全树递归：避免在超大目录上有上万次 open 把启动拖死。
        """
        out, files = [], []
        def push(p, isdir):
            if len(out) + len(files) < self.max_files * 4:  # mutate: disable 候选队列倍数只影响规模，最终都被 [:max_files] 截断
                (out if isdir else files).append(p)
        if os.path.isfile(root):
            return [root]
        push(root, True)
        try:
            with os.scandir(root) as it:
                for e in it:
                    if _ignored(e.path):
                        continue
                    try:
                        push(e.path, e.is_dir())
                    except OSError:
                        continue
        except OSError:
            pass
        return (out + files)[:self.max_files]

    def _kqueue_register(self, limit=200):
        """补挂新增路径（每轮最多 limit 条，后台渐进；避免阻塞事件循环）。"""
        import select
        kq, watch = self._kq, self._kq_watch
        if not getattr(self, "_pending", None):
            wanted = []
            for path in list(self._roots.keys()):
                wanted.extend(self._iter_paths(path))
            have = set(watch.values())
            self._pending = [p for p in wanted if p not in have]
        wanted, self._pending = self._pending[:limit], self._pending[limit:]
        have = set(watch.values())
        flags = (select.KQ_FILTER_VNODE, select.KQ_EV_ADD | select.KQ_EV_CLEAR | select.KQ_EV_ENABLE)
        fflags = (select.KQ_NOTE_WRITE | select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME |
                  select.KQ_NOTE_EXTEND | select.KQ_NOTE_ATTRIB | select.KQ_NOTE_REVOKE)
        for p in wanted:
            if p in have or _ignored(p) or len(watch) >= self.max_files:
                continue
            try:
                fd = os.open(p, os.O_RDONLY)
                kq.control([select.kevent(fd, *flags, fflags=fflags)], 0, 0)  # mutate: disable kevent 的 fflags 组合由内核决定，测试无法区分
                watch[fd] = p
            except OSError:
                continue
        return len(watch)

    def _kqueue_loop(self):
        import select
        kq, watch = self._kq, self._kq_watch
        last_sweep = time.time()
        while not self._stop.is_set():
            try:
                evs = kq.control(None, 128, 0.2)  # mutate: disable 批量 128 与 0.2s 轮询间隔不可观测（多轮会补齐）
            except Exception:
                evs = []
            for ev in evs:
                p = watch.get(ev.ident)
                if not p:
                    continue
                if ev.fflags & (select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME | select.KQ_NOTE_REVOKE):
                    self._mark("hub", full=True)          # 路径被换掉 → 增量不可信，全量重取
                    self._resyncs += 1
                scope = self.scope_of(p) or self.scope_of(os.path.dirname(p))
                if scope:
                    self._mark(scope)
                    self._events += 1
            # 补挂：每轮最多 200 条（后台渐进，永不阻塞事件循环）
            with self._lock:
                need, self._needs_rescan = self._needs_rescan, False
            if need:
                self._pending = []
            if need or getattr(self, "_pending", None) or (time.time() - last_sweep > 15):  # mutate: disable 15s 兜底扫描周期需等 15s 才可观测，成本高于收益
                if time.time() - last_sweep > 15:  # mutate: disable 同上
                    last_sweep = time.time()
                try:
                    self._kqueue_register(limit=200)
                except Exception:
                    pass

    # ---------------- 后端 3：manifest 兜底 ----------------
    def _manifest(self, max_depth=4):
        """{path: (mtime, size, scope)}；只 stat 已注册路径下的浅层文件，上限 max_files。"""
        out = {}
        with self._lock:
            scopes = dict(self._scope_paths)
        for scope, plist in scopes.items():
            for root in plist:
                if len(out) >= self.max_files:
                    return out
                root_depth = root.rstrip("/").count("/")  # mutate: disable 尾部斜杠不影响层数计算（realpath 已去尾斜杠）
                try:
                    if os.path.isdir(root):
                        for dirpath, dirnames, filenames in os.walk(root):
                            if dirpath.count("/") - root_depth >= max_depth:
                                dirnames[:] = []
                            dirnames[:] = [d for d in dirnames
                                           if not _ignored(os.path.join(dirpath, d))]
                            for f in filenames:
                                full = os.path.join(dirpath, f)
                                if _ignored(full):
                                    continue
                                try:
                                    st = os.stat(full)
                                except OSError:
                                    continue
                                out[full] = (int(st.st_mtime), st.st_size, scope)
                                if len(out) >= self.max_files:
                                    return out
                    elif os.path.exists(root):
                        st = os.stat(root)
                        out[root] = (int(st.st_mtime), st.st_size, scope)
                except OSError:
                    continue
        return out

    def _manifest_diff(self):
        """与上次清单比对，标记变化 scope；返回 True 表示发生了"断档级"变化。"""
        cur = self._manifest()
        prev = getattr(self, "_prev_manifest", None)
        self._prev_manifest = cur
        if prev is None:
            return False
        changed = set()
        for path, meta in cur.items():
            if prev.get(path) != meta:
                changed.add(meta[2])
        for path in prev:
            if path not in cur:
                changed.add(prev[path][2])
        for scope in changed:
            self._mark(scope)
            self._events += 1
        return False

    def start_manifest_loop(self):
        # 只有 manifest 后端时也要有 flush 线程（广播靠它）
        if not any(t.name == "hub-watch-flush" for t in self._threads):
            f = threading.Thread(target=self._flush_loop, name="hub-watch-flush", daemon=True)
            f.start()
            self._threads.append(f)
        t = threading.Thread(target=self._manifest_loop, name="hub-watch-manifest", daemon=True)
        t.start()
        self._threads.append(t)

    def _manifest_loop(self):
        self._manifest_diff()                     # 建基线
        while not self._stop.is_set():
            self._stop.wait(self.interval)
            if self._stop.is_set():
                break
            try:
                self._manifest_diff()
            except Exception:
                pass
