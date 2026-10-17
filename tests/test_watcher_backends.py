#!/usr/bin/env python3
"""hub/watcher.py 后端层判据：watchdog 分支（用假模块注入）+ 归一化/清单细节。

为什么需要它：本机没装 watchdog，`_start_watchdog` 那批变异点原本「本环境不可达」，
再怎么写测试也杀不掉。做法是把一个极小的假 watchdog 注入 sys.modules，
让真实代码走 watchdog 分支，再直接驱动它的事件处理函数 —— 不需要任何新依赖。

第二组用例补 _expand/_norm 的空串哨兵、watched_paths、默认参数、
manifest「根本身是文件」「深度从根目录算」等细节。
"""
import os
import shutil
import sys
import tempfile
import time
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from hub.watcher import FileWatcher, _expand, _ignored, _norm    # noqa: E402


class _FakeObserver(object):
    def __init__(self, timeout=None):
        self.timeout = timeout
        self.scheduled = []          # [(path, recursive)]
        self.daemon = False
        self.started = False
        self.unscheduled = 0

    def schedule(self, handler, path, recursive=False):
        self.scheduled.append((path, recursive))

    def unschedule_all(self):
        self.unscheduled += 1
        self.scheduled = []

    def start(self):
        self.started = True

    def stop(self):
        self.started = False


class _FakeFileSystemEventHandler(object):
    def on_any_event(self, event):
        raise NotImplementedError


def _install_fake_watchdog():
    obs_mod = types.ModuleType("watchdog.observers")
    ev_mod = types.ModuleType("watchdog.events")
    obs_mod.Observer = _FakeObserver
    ev_mod.FileSystemEventHandler = _FakeFileSystemEventHandler
    pkg = types.ModuleType("watchdog")
    pkg.observers, pkg.events = obs_mod, ev_mod
    keys = ("watchdog", "watchdog.observers", "watchdog.events")
    saved = {k: sys.modules.get(k) for k in keys}
    sys.modules.update({"watchdog": pkg, "watchdog.observers": obs_mod,
                        "watchdog.events": ev_mod})
    return saved


def _restore(saved):
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


class _Ev(object):
    def __init__(self, src_path="", dest_path="", is_directory=False, event_type="modified"):
        self.src_path = src_path
        self.dest_path = dest_path
        self.is_directory = is_directory
        self.event_type = event_type


class WatchdogBackendTest(unittest.TestCase):
    def setUp(self):
        self.saved = _install_fake_watchdog()
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="watch-wd-"))
        self.root = os.path.join(self.tmp, "tool")
        os.makedirs(os.path.join(self.root, "sessions"))
        self.file = os.path.join(self.root, "sessions", "a.jsonl")
        with open(self.file, "w") as f:
            f.write("{}\n")

    def tearDown(self):
        _restore(self.saved)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _watcher(self):
        w = FileWatcher(debounce=0.05, interval=0.2)
        w.set_roots({"tool:demo": [self.root]})
        w.start()
        return w

    def test_watchdog_is_preferred_when_available(self):
        w = self._watcher()
        try:
            self.assertEqual(w.backend, "watchdog", "装了 watchdog 就该优先用它")
            self.assertFalse(w.status()["degraded"])
            obs = w._obs
            self.assertTrue(obs.started)
            # 首次挂载由 _watchdog_loop 异步完成（会先 unschedule_all 再 schedule），
            # 直接断言可能落在空窗里 → 轮询等它稳定
            deadline = time.time() + 3
            while time.time() < deadline:
                if any(p == self.root and rec for p, rec in obs.scheduled):
                    break
                time.sleep(0.02)
            self.assertTrue(any(p == self.root and rec for p, rec in obs.scheduled),
                            "目录根必须递归挂监控：%s" % (obs.scheduled,))
        finally:
            w.stop()

    def test_handler_marks_scope_and_skips_noise(self):
        w = self._watcher()
        try:
            h = w._wd_handler()
            w._dirty = set()
            h.on_any_event(_Ev(src_path=self.file))               # 正常文件事件
            self.assertEqual({s for s, _ in w._dirty}, {"tool:demo"})
            self.assertEqual(w.status()["events"], 1)

            w._dirty = set()
            h.on_any_event(_Ev(src_path=self.root, is_directory=True, event_type="modified"))
            self.assertEqual(w._dirty, set(), "目录 modified 是噪音（每个子文件都会触发）")

            h.on_any_event(_Ev(src_path=os.path.join(self.root, "node_modules", "x.js")))
            self.assertEqual(w._dirty, set(), "忽略规则要作用在 watchdog 事件上")

            h.on_any_event(_Ev(src_path=os.path.join(self.tmp, "outside.txt")))
            self.assertEqual(w._dirty, set(), "不在任何 scope 里的路径不标记")

            h.on_any_event(_Ev(src_path=""))                      # 空路径不能崩
            self.assertEqual(w._dirty, set())
        finally:
            w.stop()

    def test_handler_prefers_dest_path_on_rename(self):
        w = self._watcher()
        try:
            h = w._wd_handler()
            w._dirty = set()
            moved = os.path.join(self.root, "sessions", "b.jsonl")
            h.on_any_event(_Ev(src_path=os.path.join(self.tmp, "outside.txt"), dest_path=moved,
                               event_type="moved"))
            self.assertEqual({s for s, _ in w._dirty}, {"tool:demo"},
                             "改名要用 dest_path（src 可能已经不在 scope 内）")
        finally:
            w.stop()

    def test_rescan_reschedules(self):
        w = self._watcher()
        try:
            obs = w._obs
            before = list(obs.scheduled)
            new_root = os.path.join(self.tmp, "tool2")
            os.makedirs(new_root)
            w.set_roots({"tool:demo": [self.root], "tool:two": [new_root]})
            self.assertTrue(w._watchdog_schedule())
            self.assertGreaterEqual(len(obs.scheduled), len(before))
            self.assertTrue(any(p == new_root for p, _ in obs.scheduled), "新根必须被重挂")
        finally:
            w.stop()

    def test_schedule_without_observer_returns_false(self):
        w = FileWatcher()
        self.assertFalse(w._watchdog_schedule(), "没有 observer 时返回 False 而不是抛错")

    def test_restart_backend_both_branches(self):
        """路径变更后 _restart_backend 要真重启对应后端（kqueue / watchdog 各一个分支）。"""
        w = self._watcher()
        try:
            old_stop = w._stop
            w._restart_backend()
            self.assertEqual(w.backend, "watchdog")
            self.assertIsNot(w._stop, old_stop, "重启必须换一个新的 stop 事件")
            self.assertFalse(w._stop.is_set())
        finally:
            w.stop()

    def test_manifest_fallback_when_no_backend(self):
        """watchdog 与 kqueue 都不可用时必须退化为 manifest 后端并标记 degraded。"""
        import unittest.mock as mock
        _restore(self.saved)
        w = FileWatcher(debounce=0.05, interval=0.2)
        try:
            w.set_roots({"tool:demo": [self.root]})
            with mock.patch.object(FileWatcher, "_start_kqueue", return_value=False):
                w.start()
            self.assertEqual(w.backend, "manifest")
            self.assertTrue(w.status()["degraded"], "退化到 manifest 必须标记 degraded")
            names = [t.name for t in w._threads]
            self.assertIn("hub-watch-manifest", names, "必须起 manifest 轮询线程")
            self.assertEqual(names.count("hub-watch-flush"), 1, "flush 线程只能有一个")
        finally:
            w.stop()
            self.saved = _install_fake_watchdog()

    def test_start_without_watchdog_falls_back(self):
        _restore(self.saved)                     # 摘掉假模块 → 退回 kqueue/manifest
        w = FileWatcher(debounce=0.05, interval=0.2)
        try:
            w.set_roots({"tool:demo": [self.root]})
            w.start()
            self.assertIn(w.backend, ("kqueue", "manifest"))
            self.assertNotEqual(w.backend, "watchdog")
        finally:
            w.stop()
            self.saved = _install_fake_watchdog()      # 供 tearDown 正常恢复


class NormalizeEdgeTest(unittest.TestCase):
    def test_expand_and_norm_empty_sentinels(self):
        self.assertEqual(_expand(""), "")
        self.assertEqual(_expand(None), "")
        self.assertEqual(_norm(""), "")
        self.assertEqual(_norm(None), "")
        home = _expand("~")
        self.assertTrue(os.path.isabs(home) and home != "~")

    def test_norm_is_absolute_and_resolves_symlink(self):
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="watch-norm-"))
        try:
            link = os.path.join(tmp, "link")
            os.symlink(tmp, link)
            self.assertEqual(_norm(os.path.join(link, "x")), os.path.join(tmp, "x"))
            self.assertEqual(_norm(os.path.join(tmp, "a", "..", "b")), os.path.join(tmp, "b"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_ignored_trailing_slash_and_dotdot(self):
        self.assertTrue(_ignored("x/dist/"), "尾部斜杠不能让规则失效")
        self.assertTrue(_ignored("a/../node_modules/"))
        self.assertTrue(_ignored("./build/y.js"))

    def test_initial_status_is_zero(self):
        w = FileWatcher()
        st = w.status()
        self.assertEqual((st["rev"], st["events"], st["resyncs"]), (0, 0, 0))
        self.assertFalse(w._needs_rescan, "新建实例不需要立刻 rescan（set_roots 才置位）")
        self.assertEqual(st["fds"], 0)

    def test_defaults(self):
        w = FileWatcher()
        self.assertEqual(w.debounce, 0.25)
        self.assertEqual(w.interval, 2.0)
        self.assertEqual(w.max_files, 4096)

    def test_watched_paths_sorted_pairs(self):
        tmp = os.path.realpath(tempfile.mkdtemp(prefix="watch-paths-"))
        try:
            a, b = os.path.join(tmp, "a"), os.path.join(tmp, "b")
            os.makedirs(a)
            os.makedirs(b)
            w = FileWatcher()
            w.set_roots({"tool:b": [b], "tool:a": [a]})
            got = w.watched_paths()
            self.assertEqual(got, sorted(got), "返回必须按 scope 排序")
            self.assertEqual([s for s, _ in got], ["tool:a", "tool:b"])
            self.assertEqual(got[0][1], [a])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ManifestEdgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="watch-man-edge-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_root_that_is_a_file_is_listed(self):
        f = os.path.join(self.tmp, "hub.db")
        with open(f, "w") as fh:
            fh.write("db")
        w = FileWatcher()
        w.set_roots({"tool:db": [f]})
        self.assertIn(f, w._manifest(), "根本身是文件（如 sqlite）也要进清单")

    def test_depth_counted_from_root_not_absolute(self):
        """max_depth 是「相对根目录的层数」，不能被绝对路径的斜杠数量带偏。"""
        inner = os.path.join(self.tmp, "l1", "l2")
        os.makedirs(inner)
        f = os.path.join(inner, "deep.txt")
        with open(f, "w") as fh:
            fh.write("x")
        w = FileWatcher()
        w.set_roots({"tool:demo": [self.tmp]})
        self.assertIn(f, w._manifest(max_depth=4), "相对深度 2 层，不该被砍")
        self.assertNotIn(f, w._manifest(max_depth=1), "相对深度 2 层 > 1，必须被砍")

    def test_iter_paths_file_root(self):
        f = os.path.join(self.tmp, "one.txt")
        with open(f, "w") as fh:
            fh.write("x")
        w = FileWatcher()
        self.assertEqual(w._iter_paths(f), [f], "根是文件时直接返回它")

    def test_kqueue_register_respects_max_files(self):
        import select
        if not hasattr(select, "kqueue"):
            self.skipTest("kqueue 不可用（spec-guard: allowed 平台特有后端）")
        for i in range(8):
            with open(os.path.join(self.tmp, "f%d.txt" % i), "w") as fh:
                fh.write("x")
        w = FileWatcher(max_files=3)
        w.set_roots({"tool:demo": [self.tmp]})
        if not w._start_kqueue():
            self.skipTest("kqueue 启动失败（spec-guard: allowed 环境限制）")
        try:
            for _ in range(5):
                w._kqueue_register(limit=50)
            self.assertLessEqual(len(w._kq_watch), 3, "挂载 fd 数不得超过 max_files")
            self.assertTrue(all(isinstance(p, str) for p in w._kq_watch.values()))
        finally:
            w.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
