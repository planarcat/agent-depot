#!/usr/bin/env python3
"""hub/watcher.py 边界判据——补 test_watcher.py 的盲区（为变异门禁而写）。

为什么单独成文件：test_watcher.py 正被并行会话改动，这里只钉 hub/watcher.py 的对外行为，
互不干扰。选点原则是「改一个字就静默走错」的地方：

  1. 忽略规则全集（目录名 7 个 / 后缀 8 个）+ 不能误伤同名普通文件
  2. scope 前缀匹配不能漏到兄弟目录（`/x/tool` 与 `/x/tool-2`）
  3. 抖动上限常量 MAX_DIRTY_SCOPES 的边界（正好 N 条不降级，N+1 条降级）
  4. 广播载荷：full 时补 hub scope、rev 只加一次、debounce 生效、force 生效
  5. 订阅队列上限 64、订阅者计数、status 字段
  6. manifest 的深度上限 / 文件数上限 / 忽略规则 / 已删文件归属哪个 scope
  7. _iter_paths 的条数上限与「目录先、文件后」
  8. kqueue 收到 DELETE/RENAME 必须降级 full=true（增量不可信）并计入 resyncs
"""
import os
import select
import shutil
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from hub.watcher import FileWatcher, MAX_DIRTY_SCOPES, _ignored          # noqa: E402

IGNORE_DIR_NAMES = (".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".cache")
IGNORE_SUFFIXES = (".tmp", ".swp", ".swx", "-wal", "-shm", ".lock", ".DS_Store", "~")


class IgnoreRuleTest(unittest.TestCase):
    def test_every_ignored_dir_name(self):
        for name in IGNORE_DIR_NAMES:
            with self.subTest(name=name):
                self.assertTrue(_ignored(os.path.join("proj", name, "x.jsonl")),
                                "目录 %s 下的事件必须忽略" % name)
                # 深层也要忽略（不只顶一层）
                self.assertTrue(_ignored(os.path.join("proj", "a", "b", name, "deep.txt")))

    def test_every_ignored_suffix(self):
        for suf in IGNORE_SUFFIXES:
            with self.subTest(suf=suf):
                self.assertTrue(_ignored("session.jsonl" + suf) if suf != "~"
                                else _ignored("session.jsonl~"))
                self.assertTrue(_ignored("hub.db" + suf) if suf.startswith(("-", ".")) and suf != ".DS_Store"
                                else _ignored("file" + suf))

    def test_ds_store_anywhere(self):
        self.assertTrue(_ignored(".DS_Store"))
        self.assertTrue(_ignored(os.path.join("a", "b", ".DS_Store")))

    def test_legit_names_not_ignored(self):
        for p in ("dist-report.md", "build.log", "cache.md", "node_modules.md",
                  os.path.join("a", "node_modules.md"), "session.jsonl", "release~notes.md",
                  "db-wal.txt", ".gitignore", "master.txt"):
            with self.subTest(p=p):
                self.assertFalse(_ignored(p), "%s 不该被忽略" % p)


class ScopePrefixTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="watch-edge-scope-")
        self.tool = os.path.join(self.tmp, "tool")
        self.sibling = os.path.join(self.tmp, "tool-2")
        os.makedirs(self.tool)
        os.makedirs(self.sibling)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_prefix_does_not_leak_to_sibling(self):
        w = FileWatcher()
        w.set_roots({"tool:demo": [self.tool]})
        self.assertEqual(w.scope_of(os.path.join(self.tool, "a.jsonl")), "tool:demo")
        self.assertEqual(w.scope_of(self.tool), "tool:demo")            # 根目录本身也算
        self.assertIsNone(w.scope_of(os.path.join(self.sibling, "a.jsonl")),
                          "兄弟目录 tool-2 不能被 tool 的前缀吃掉")

    def test_dotdot_is_normalized_before_matching(self):
        w = FileWatcher()
        w.set_roots({"tool:demo": [self.tool]})
        sneaky = os.path.join(self.tool, "..", "tool-2", "a.jsonl")
        self.assertIsNone(w.scope_of(sneaky))

    def test_longest_prefix_wins(self):
        os.makedirs(os.path.join(self.tool, "inner"))
        w = FileWatcher()
        w.set_roots({"tool:outer": [self.tool], "memory:inner": [os.path.join(self.tool, "inner")]})
        self.assertEqual(w.scope_of(os.path.join(self.tool, "inner", "x")), "memory:inner")

    def test_missing_root_mounts_ancestor(self):
        ghost = os.path.join(self.tmp, "not-yet", "deep")
        w = FileWatcher()
        self.assertGreaterEqual(w.set_roots({"tool:ghost": [ghost]}), 1)
        self.assertEqual(w.scope_of(ghost), "tool:ghost")


class DirtyLimitTest(unittest.TestCase):
    """抖动上限常量：正好 MAX_DIRTY_SCOPES 条不降级，多一条才降级。"""

    def test_boundary(self):
        w = FileWatcher()
        for i in range(MAX_DIRTY_SCOPES):
            w._mark("tool:s%d" % i)
        self.assertFalse(w.status()["degraded"], "正好到上限不该降级")
        self.assertEqual(len(w._dirty), MAX_DIRTY_SCOPES)
        w._mark("tool:one-more")
        self.assertTrue(w.status()["degraded"], "超过上限必须降级")
        self.assertEqual(w._dirty, {("hub", True)}, "降级后只留一条全量标记")

    def test_constant_value(self):
        self.assertEqual(MAX_DIRTY_SCOPES, 64)


class FlushPayloadTest(unittest.TestCase):
    def test_debounce_blocks_then_force_flushes(self):
        w = FileWatcher(debounce=10.0)
        q = w.subscribe()
        w._mark("tool:demo")
        w._flush()                                  # 窗口内：不广播
        with self.assertRaises(Exception):
            q.get(timeout=0.2)
        w._flush(force=True)                        # 强制：广播
        ev = q.get(timeout=1)
        self.assertEqual(ev["scopes"], ["tool:demo"])
        self.assertEqual(ev["rev"], 1)
        self.assertFalse(ev["full"])

    def test_full_flush_appends_hub_scope_and_single_rev_bump(self):
        w = FileWatcher(debounce=0.0)
        q = w.subscribe()
        w._mark("tool:demo", full=True)
        w._flush(force=True)
        ev = q.get(timeout=1)
        self.assertTrue(ev["full"])
        self.assertIn("hub", ev["scopes"], "full 时前端要按 hub 全量重取")
        self.assertEqual(ev["rev"], 1)
        self.assertIsInstance(ev["ts"], float)
        w._flush(force=True)                        # 没有脏数据 → 不再广播、rev 不变
        with self.assertRaises(Exception):
            q.get(timeout=0.2)
        self.assertEqual(w.status()["rev"], 1)

    def test_scopes_deduplicated(self):
        w = FileWatcher(debounce=0.0)
        q = w.subscribe()
        w._mark("tool:a")
        w._mark("tool:a")
        w._mark("tool:a", full=False)
        w._flush(force=True)
        ev = q.get(timeout=1)
        self.assertEqual(ev["scopes"], ["tool:a"], "同 scope 只出现一次")


class SubscriptionTest(unittest.TestCase):
    def test_queue_capacity_and_counts(self):
        w = FileWatcher()
        q1 = w.subscribe()
        q2 = w.subscribe()
        self.assertEqual(q1.maxsize, 64, "订阅队列上限 64（满了丢最旧）")
        self.assertEqual(w.subscriber_count(), 2)
        self.assertEqual(w.status()["subs"], 2)
        w.unsubscribe(q1)
        self.assertEqual(w.subscriber_count(), 1)

    def test_status_shape(self):
        w = FileWatcher()
        st = w.status()
        self.assertEqual(set(st), {"backend", "rev", "events", "resyncs", "watched",
                                   "fds", "subs", "degraded"})
        self.assertEqual(st["backend"], "none")
        self.assertEqual(st["rev"], 0)
        self.assertIsInstance(st["fds"], int)
        self.assertFalse(st["degraded"])

    def test_bump_increments_events_and_defaults_scope(self):
        w = FileWatcher(debounce=0.0)
        q = w.subscribe()
        w.bump()
        ev = q.get(timeout=1)
        self.assertEqual(ev["scopes"], ["hub"])
        self.assertEqual(w.status()["events"], 1)

    def test_start_is_idempotent_and_stop_clears(self):
        d = tempfile.mkdtemp(prefix="watch-edge-life-")
        try:
            w = FileWatcher(debounce=0.05, interval=0.2)
            w.set_roots({"tool:demo": [d]})
            w.start()
            n = len(w._threads)
            self.assertGreaterEqual(n, 1)
            self.assertIs(w.start(), w)
            self.assertEqual(len(w._threads), n, "重复 start 不得重复起线程")
            w.stop()
            self.assertEqual(w._threads, [])
        finally:
            shutil.rmtree(d, ignore_errors=True)


class ManifestLimitTest(unittest.TestCase):
    def setUp(self):
        # 用 realpath：set_roots 会 realpath 规范化，manifest 的键也是真实路径
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="watch-edge-man-"))
        self.deep = os.path.join(self.tmp, "a", "b", "c", "d")
        os.makedirs(self.deep)
        os.makedirs(os.path.join(self.tmp, "node_modules"))
        for p in (os.path.join(self.tmp, "top.txt"), self.deep + "/deep.txt",
                  os.path.join(self.tmp, "node_modules", "x.js")):
            with open(p, "w") as f:
                f.write("x")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _manifest(self, max_depth=4):
        w = FileWatcher()
        w.set_roots({"tool:demo": [self.tmp]})
        return w._manifest(max_depth=max_depth)

    def test_depth_limit(self):
        shallow = self._manifest(max_depth=2)
        self.assertIn(os.path.join(self.tmp, "top.txt"), shallow)
        self.assertNotIn(self.deep + "/deep.txt", shallow, "超过 max_depth 的深层文件不 stat")

    def test_ignore_in_walk(self):
        m = self._manifest()
        self.assertFalse(any("node_modules" in p for p in m), "manifest 也要跳过 node_modules")

    def test_max_files_cap(self):
        w = FileWatcher(max_files=2)
        w.set_roots({"tool:demo": [self.tmp]})
        self.assertLessEqual(len(w._manifest()), 2, "max_files 上限必须生效")

    def test_removed_file_only_marks_its_own_scope(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix="watch-edge-other-"))
        try:
            with open(os.path.join(other, "y.txt"), "w") as f:
                f.write("y")
            w = FileWatcher(debounce=0.0)
            w.set_roots({"tool:a": [self.tmp], "tool:b": [other]})
            w._manifest_diff()                     # 建基线
            self.assertFalse(w._manifest_diff(), "无变化时返回 False")
            os.unlink(os.path.join(self.tmp, "top.txt"))
            w._dirty = set()
            w._manifest_diff()
            self.assertEqual({s for s, _ in w._dirty}, {"tool:a"},
                             "删文件只标记它所属的 scope")
        finally:
            shutil.rmtree(other, ignore_errors=True)


class IterPathsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="watch-edge-iter-")
        for d in ("d1", "d2", ".git"):
            os.makedirs(os.path.join(self.tmp, d))
        for f in ("f1.txt", "f2.txt"):
            with open(os.path.join(self.tmp, f), "w") as fh:
                fh.write("x")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dirs_first_then_files_and_ignored_skipped(self):
        w = FileWatcher(max_files=10)
        got = w._iter_paths(self.tmp)
        self.assertTrue(got and got[0] == self.tmp, "根目录在最前")
        dirs = [p for p in got if os.path.isdir(p)]
        files = [p for p in got if not os.path.isdir(p)]
        self.assertEqual(got, dirs + files, "目录先、文件后")
        self.assertFalse(any(".git" in p for p in got), ".git 不参与挂 fd")

    def test_max_files_limit(self):
        w = FileWatcher(max_files=2)
        self.assertLessEqual(len(w._iter_paths(self.tmp)), 2)


@unittest.skipUnless(hasattr(select, "kqueue"), "kqueue 只在 macOS/BSD 上有（spec-guard: allowed 平台特有后端）")
class KqueueResyncTest(unittest.TestCase):
    def test_delete_triggers_full_resync(self):
        tmp = tempfile.mkdtemp(prefix="watch-edge-kq-")
        f = os.path.join(tmp, "victim.txt")
        with open(f, "w") as fh:
            fh.write("x")
        w = FileWatcher(debounce=0.0, interval=0.2)
        try:
            w.set_roots({"tool:demo": [tmp]})
            w.start()
            self.assertEqual(w.backend, "kqueue")
            q = w.subscribe()
            time.sleep(0.3)                       # 等挂 fd
            os.unlink(f)
            got = []
            deadline = time.time() + 3
            while time.time() < deadline:
                try:
                    got.append(q.get(timeout=0.3))
                except Exception:
                    continue
                if any(e["full"] for e in got):
                    break
            self.assertTrue(any(e["full"] for e in got),
                            "路径被删/改名 → 必须广播 full=true（增量不可信）：%s" % got)
            self.assertIn("hub", got[-1]["scopes"])
            self.assertGreaterEqual(w.status()["resyncs"], 1)
        finally:
            w.stop()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
