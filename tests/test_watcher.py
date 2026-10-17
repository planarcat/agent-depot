#!/usr/bin/env python3
"""hub/watcher.py 单测：文件监控 → SSE 即时刷新的核心语义。

覆盖：
  1. path → scope 映射（最长前缀）
  2. 抖动合并：一次事件风暴只广播一次，scope 去重
  3. 自身写入 bump() 立即广播（不等 watcher），rev 递增
  4. 溢出/断档 → full=true（前端据此全量重取）
  5. manifest 后端（无 kqueue/watchdog 的平台的兜底）：能发现新增/修改/删除
  6. 订阅端慢/满时丢最旧，永不阻塞 watcher
"""
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from hub.watcher import FileWatcher, _ignored                      # noqa: E402


class WatcherScopeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="watch-scope-")
        self.tool = os.path.join(self.dir, "tool-root")
        self.mem = os.path.join(self.dir, "memory-root")
        os.makedirs(os.path.join(self.tool, "sessions"))
        os.makedirs(self.mem)
        with open(os.path.join(self.tool, "sessions", "a.jsonl"), "w") as f:
            f.write("{}\n")
        with open(os.path.join(self.mem, "user.md"), "w") as f:
            f.write("hi\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_scope_of_longest_prefix(self):
        w = FileWatcher()
        w.set_roots({"tool:demo": [self.tool], "memory:demo": [self.mem]})
        self.assertEqual(w.scope_of(os.path.join(self.tool, "sessions", "a.jsonl")), "tool:demo")
        self.assertEqual(w.scope_of(os.path.join(self.mem, "user.md")), "memory:demo")
        self.assertIsNone(w.scope_of(os.path.join(self.dir, "elsewhere.txt")))

    def test_missing_root_is_watched_via_ancestor(self):
        """根目录还不存在（工具刚登记）时，挂父目录，创建后仍能发现。"""
        w = FileWatcher()
        ghost = os.path.join(self.dir, "not-yet")
        n = w.set_roots({"tool:ghost": [ghost]})
        self.assertGreaterEqual(n, 1)
        self.assertEqual(w.scope_of(ghost), "tool:ghost")

    def test_ignore_rules(self):
        self.assertTrue(_ignored(os.path.join("x", "node_modules", "pkg", "index.js")))
        self.assertTrue(_ignored("hub.db-wal"))
        self.assertTrue(_ignored("notes.md.tmp"))
        self.assertFalse(_ignored("code-review.md"))


class WatcherBroadcastTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="watch-ev-")
        with open(os.path.join(self.dir, "a.txt"), "w") as f:
            f.write("a")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _watcher(self, **kw):
        w = FileWatcher(debounce=0.1, interval=0.2, **kw)
        w.set_roots({"tool:demo": [self.dir]})
        w.start()
        return w

    def test_bump_is_immediate_and_bumps_rev(self):
        w = self._watcher()
        try:
            q = w.subscribe()
            w.bump("tool:demo")
            ev = q.get(timeout=2)
            self.assertEqual(ev["scopes"], ["tool:demo"])
            self.assertFalse(ev["full"])
            self.assertEqual(ev["rev"], 1)
        finally:
            w.stop()

    def test_debounce_coalesces_burst(self):
        """风暴：40 次标记 → 只广播一次，且 scope 去重。"""
        w = self._watcher()
        try:
            q = w.subscribe()
            for _ in range(40):
                w._mark("tool:demo")
            time.sleep(0.35)
            first = q.get(timeout=2)
            self.assertEqual(first["scopes"], ["tool:demo"])
            self.assertEqual(first["rev"], 1)
            with self.assertRaises(Exception):
                q.get(timeout=0.4)          # 不应有第二条
        finally:
            w.stop()

    def test_overflow_degrades_to_full(self):
        """标记数量超过上限 → 降级 full=true（增量不可信，改全量重取）。"""
        w = self._watcher()
        try:
            q = w.subscribe()
            for i in range(200):
                w._mark("tool:s%d" % i)
            got = []
            deadline = time.time() + 2
            while time.time() < deadline:
                try:
                    got.append(q.get(timeout=0.4))
                except Exception:
                    break
            self.assertTrue(got, "应有广播")
            self.assertTrue(any(e["full"] for e in got), "溢出必须降级为 full=true")
            self.assertIn("hub", got[-1]["scopes"])
            self.assertTrue(w.status()["degraded"])
        finally:
            w.stop()

    def test_slow_subscriber_never_blocks(self):
        """订阅端不取数据：队列满了丢最旧，watcher 不阻塞。"""
        w = self._watcher()
        try:
            q = w.subscribe()
            for i in range(200):
                w.bump("tool:demo")
                if i % 20 == 0:
                    time.sleep(0.02)
            self.assertLessEqual(q.qsize(), 64)
            self.assertGreater(w.status()["rev"], 100)
        finally:
            w.stop()


class WatcherManifestTest(unittest.TestCase):
    """manifest 后端 = 没有 kqueue/watchdog 的平台上的兜底（只 stat 已注册路径）。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="watch-man-")
        self.sub = os.path.join(self.dir, "sub")
        os.makedirs(self.sub)
        self.f1 = os.path.join(self.dir, "a.txt")
        self.f2 = os.path.join(self.sub, "b.txt")
        with open(self.f1, "w") as f:
            f.write("a")
        with open(self.f2, "w") as f:
            f.write("b")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _watcher(self):
        w = FileWatcher(debounce=0.05, interval=0.15)
        w.set_roots({"tool:demo": [self.dir]})
        w.start_manifest_loop()
        w._manifest_diff()                    # 建基线
        return w

    def test_manifest_detects_change_and_delete(self):
        w = self._watcher()
        try:
            q = w.subscribe()
            time.sleep(0.1)
            with open(self.f2, "a") as f:
                f.write("more")               # 修改
            ev = q.get(timeout=3)
            self.assertIn("tool:demo", ev["scopes"])

            q2 = w.subscribe()
            os.unlink(self.f1)                # 删除
            ev2 = q2.get(timeout=3)
            self.assertIn("tool:demo", ev2["scopes"])
        finally:
            w.stop()

    def test_manifest_ignores_noise(self):
        w = self._watcher()
        try:
            q = w.subscribe()
            time.sleep(0.1)
            with open(os.path.join(self.dir, "x.tmp"), "w") as f:
                f.write("noise")
            with self.assertRaises(Exception):
                q.get(timeout=0.6)
        finally:
            w.stop()


class WatcherServerRootsTest(unittest.TestCase):
    def test_watch_roots_shape(self):
        """监控范围必须给出 tool:<id> / memory:<id> 这样的 scope（前端据此选块刷新）。"""
        import server as hub_server
        os.environ["AGENT_HUB_DIR"] = tempfile.mkdtemp(prefix="watch-hub-")
        store = hub_server.ensure_store()
        try:
            roots = hub_server.watch_roots(store)
            self.assertTrue(any(k.startswith("tool:") for k in roots))
            self.assertIn("memory:hub", roots)
            for scope, paths in roots.items():
                self.assertTrue(scope.startswith(("tool:", "memory:")), scope)
                self.assertTrue(paths)
        finally:
            hub_server.WATCHER and hub_server.WATCHER.stop()
            hub_server.WATCHER = None


if __name__ == "__main__":
    unittest.main(verbosity=2)
