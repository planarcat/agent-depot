#!/usr/bin/env python3
"""v0.4 extras unit tests (S1/S2/S3 on a real temp store):
- session_stats / search_memories / export_memories / export_batch
- registry_autopull (poll_min due logic, module-disable gate, tick integration)
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="hub-extras-test-")
os.environ["AGENT_HUB_DIR"] = os.path.join(TMP, "hub-home")

from hub.store import (Store, ensure_lineage_schema, ensure_memory_schema,   # noqa: E402
                       add_memory, set_star, session_stats, search_memories,
                       export_memories, export_batch)
from hub.core import schema as core_schema                                   # noqa: E402
from hub.core import registry as mod_registry                                # noqa: E402
from hub.modules import mod_skills as S                                      # noqa: E402
import server as hub_server                                                  # noqa: E402


def git(*args, cwd=None):
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, capture_output=True)


def make_repo(base, name="src"):
    work = os.path.join(base, name)
    os.makedirs(work)
    git("init", "-q", "-b", "main", work)
    skill = os.path.join(work, "skills", "alpha")
    os.makedirs(skill)
    with open(os.path.join(skill, "SKILL.md"), "w") as f:
        f.write('---\nname: alpha\ndescription: "Alpha"\nversion: 1.0.0\n---\n\n# Alpha\n')
    git("add", ".", cwd=work)
    subprocess.run(["git", "-C", work, "-c", "user.name=t", "-c", "user.email=t@t",
                    "commit", "-qm", "v1"], check=True)
    return work


class ExtrasBase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="ex-", dir=TMP)
        self.st = Store(os.path.join(self.home, "hub.db"))
        ensure_lineage_schema(self.st)
        ensure_memory_schema(self.st)
        core_schema.ensure(self.st)
        # two sessions with messages
        self.st.upsert_session("sid-a", "claude", "会话 A", "/tmp/proj-a", "f1",
                               "2026-09-20T10:00:00", "2026-09-20T11:00:00")
        self.st.add_message("sid-a", "claude", 1, "2026-09-20T10:01:00", "user", "你好")
        self.st.add_message("sid-a", "claude", 2, "2026-09-20T10:02:00", "assistant", "你好，需要什么帮助")
        self.st.bump_msg_count("sid-a")
        self.st.upsert_session("sid-b", "codex", "会话 B", "/tmp/proj-b", "f2",
                               "2026-09-21T09:00:00", "2026-09-21T09:30:00")
        self.st.add_message("sid-b", "codex", 1, "2026-09-21T09:01:00", "user", "跑测试")
        self.st.bump_msg_count("sid-b")
        self.st.commit()


class StatsAndMemory(ExtrasBase):
    def test_stats_counts(self):
        st = session_stats(self.st)
        self.assertEqual(st["totals"]["sessions"], 2)
        self.assertEqual(st["totals"]["messages"], 3)
        tools = {t["tool"]: t["sessions"] for t in st["by_tool"]}
        self.assertEqual(tools, {"claude": 1, "codex": 1})
        days = {d["day"]: d["sessions"] for d in st["by_day"]}
        self.assertEqual(days.get("2026-09-20"), 1)
        self.assertEqual(days.get("2026-09-21"), 1)
        proj = {p["project"]: p["sessions"] for p in st["by_project"]}
        self.assertEqual(proj.get("/tmp/proj-a"), 1)
        # star reflects in stats
        set_star(self.st, "sid-a")
        self.assertEqual(session_stats(self.st)["totals"]["starred"], 1)

    def test_memory_search(self):
        add_memory(self.st, "内容包含 marker-abc 的偏好", title="偏好")
        add_memory(self.st, "另一条无关内容", title="无关")
        hits = search_memories(self.st, "marker-abc")
        self.assertEqual(len(hits), 1)
        self.assertIn("marker-abc", hits[0]["snippet"])
        # empty q -> []
        self.assertEqual(search_memories(self.st, "  "), [])
        # wildcard escaped: "%" must not match everything
        add_memory(self.st, "含百分号 50% 的记录", title="百分号")
        hits2 = search_memories(self.st, "%")
        self.assertEqual(len(hits2), 1)  # only the literal-% row
        # "_" escaped too
        add_memory(self.st, "下划线 a_b 记录", title="下划线")
        self.assertEqual(len(search_memories(self.st, "a_b")), 1)

    def test_memory_export(self):
        add_memory(self.st, "导出体内容 XYZ", title="导出标题")
        md = export_memories(self.st, "md")
        self.assertTrue(md["filename"].endswith(".md"))
        self.assertIn("导出标题", md["content"])
        self.assertIn("导出体内容 XYZ", md["content"])
        js = export_memories(self.st, "json")
        arr = json.loads(js["content"])
        self.assertTrue(any(m.get("title") == "导出标题" for m in arr))

    def test_export_batch_zip(self):
        res = export_batch(self.st, ["sid-a", "sid-b"])
        self.assertEqual(res["count"], 2)
        self.assertTrue(os.path.exists(res["path"]))
        with zipfile.ZipFile(res["path"]) as zf:
            names = zf.namelist()
        self.assertEqual(len(names), 2)
        # content of one session inside zip
        with zipfile.ZipFile(res["path"]) as zf:
            blob = zf.read(names[0]).decode()
        self.assertIn("# ", blob)
        # all-mode (no sids) packs both
        res2 = export_batch(self.st)
        self.assertEqual(res2["count"], 2)


class AutoPull(ExtrasBase):
    def _mk_source(self, poll_min=0):
        repo = make_repo(self.home)
        r = S.add_source(self.st, "auto-src", repo)
        self.assertTrue(r["ok"])
        sid = r["id"]
        pulled = S.pull_source(self.st, sid)
        self.assertTrue(pulled["ok"], pulled)
        if poll_min:
            S.update_source(self.st, sid, {"poll_min": poll_min})
        return sid

    def test_due_logic_and_execution(self):
        sid = self._mk_source(poll_min=30)
        lr = {}
        ran1 = hub_server.registry_autopull(self.st, lr, now=1_000_000.0)
        self.assertEqual(ran1, ["auto:skills:%d" % sid])
        # within interval -> skip
        ran2 = hub_server.registry_autopull(self.st, lr, now=1_000_000.0 + 29 * 60)
        self.assertEqual(ran2, [])
        # past interval -> run again
        ran3 = hub_server.registry_autopull(self.st, lr, now=1_000_000.0 + 31 * 60)
        self.assertEqual(ran3, ["auto:skills:%d" % sid])
        # ledger recorded auto-pull
        n = self.st.db.execute(
            "SELECT COUNT(*) AS n FROM ops WHERE module='skills' AND action='auto-pull'"
        ).fetchone()["n"]
        self.assertGreaterEqual(n, 2)

    def test_poll_min_zero_never_runs(self):
        self._mk_source(poll_min=0)
        ran = hub_server.registry_autopull(self.st, {}, now=9_999_999.0)
        self.assertEqual(ran, [])

    def test_module_disabled_skips(self):
        self._mk_source(poll_min=10)
        mod_registry.set_enabled(self.st, "skills", False)
        ran = hub_server.registry_autopull(self.st, {}, now=9_999_999.0)
        self.assertEqual(ran, [])
        mod_registry.set_enabled(self.st, "skills", True)
        ran2 = hub_server.registry_autopull(self.st, {}, now=9_999_999.0)
        self.assertEqual(len(ran2), 1)

    def test_scheduler_tick_integration(self):
        sid = self._mk_source(poll_min=30)
        lr = {}
        ran = hub_server.scheduler_tick(self.st, lr)
        self.assertIn("auto:skills:%d" % sid, ran)


if __name__ == "__main__":
    unittest.main(verbosity=2)
