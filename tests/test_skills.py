#!/usr/bin/env python3
"""Skills 模块集成测试：本地 git 夹具当远程源，全链路 + 边界/失败场景。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="hub-skills-test-")
os.environ["AGENT_HUB_DIR"] = os.path.join(TMP, "hub-home")

from hub.store import Store                      # noqa: E402
from hub.core import schema                     # noqa: E402
from hub.modules import mod_skills as S          # noqa: E402


def git(*args, cwd=None):
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, capture_output=True)


def make_source_repo(base):
    """构建夹具源仓库：2 个 skill + 1 个 mcp 文件。"""
    work = os.path.join(base, "src-repo")
    os.makedirs(work)
    git("init", "-q", "-b", "main", work)

    def w(path, content):
        full = os.path.join(work, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(content)

    w("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: \"Alpha skill\"\nversion: 1.0.0\n---\n\n# Alpha\nbody v1\n")
    w("skills/alpha/helper.py", "print('alpha helper v1')\n")
    w("skills/beta/SKILL.md", "---\nname: beta\ndescription: \"Beta skill\"\n---\n\n# Beta\n")
    git("add", ".", cwd=work)
    subprocess.run(["git", "-C", work, "-c", "user.name=t", "-c", "user.email=t@t",
                    "commit", "-qm", "v1"], check=True)
    return work


def bump_source(work, version, body):
    with open(os.path.join(work, "skills/alpha/SKILL.md"), "w") as f:
        f.write("---\nname: alpha\ndescription: \"Alpha skill\"\nversion: %s\n---\n\n# Alpha\n%s\n" % (version, body))
    git("add", ".", cwd=work)
    subprocess.run(["git", "-C", work, "-c", "user.name=t", "-c", "user.email=t@t",
                    "commit", "-qm", version], check=True)


class SkillsFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_repo = make_source_repo(TMP)
        cls.t1 = os.path.join(TMP, "target-a")   # 空目标
        cls.t2 = os.path.join(TMP, "target-b")   # 第二个目标
        os.makedirs(cls.t1); os.makedirs(cls.t2)
        cls.store = Store()
        schema.ensure(cls.store)

    def test_01_add_source_and_pull(self):
        r = S.add_source(self.store, "fixture", self.source_repo, "main")
        self.assertTrue(r["ok"], r)
        self.__class__.sid = r["id"]
        p = S.pull_source(self.store, self.sid)
        self.assertTrue(p["ok"], p)
        self.assertEqual(sorted(p["added"]), ["alpha", "beta"])
        self.__class__.first_commit = p["commit"]
        srcs = S.list_sources(self.store)
        self.assertEqual(srcs[0]["item_count"], 2)

    def test_02_pull_incremental(self):
        bump_source(self.source_repo, "1.1.0", "body v1.1")
        p = S.pull_source(self.store, self.sid)
        self.assertTrue(p["ok"])
        self.assertEqual(p["changed"], ["alpha"])
        self.assertEqual(p["added"], [])
        self.assertNotEqual(p["commit"], self.first_commit)

    def test_03_update_registry(self):
        res = S.update_registry(self.store, ["alpha", "gamma"], self.sid)
        by = {r["item"]: r for r in res}
        self.assertEqual(by["alpha"]["status"], "installed")
        self.assertEqual(by["alpha"]["version"], "1.1.0")
        self.assertEqual(by["gamma"]["status"], "failed")   # 源中不存在
        # 幂等：再次更新 → unchanged
        res2 = S.update_registry(self.store, ["alpha"], self.sid)
        self.assertEqual(res2[0]["status"], "unchanged")

    def test_04_registry_local_modified_conflict(self):
        p = os.path.join(S.registry_root(), "alpha", "SKILL.md")
        with open(p, "a") as f:
            f.write("LOCAL EDIT\n")
        # 源再次更新（新版本），本地被改 → 冲突
        bump_source(self.source_repo, "1.2.0", "body v1.2")
        S.pull_source(self.store, self.sid)
        res = S.update_registry(self.store, ["alpha"], self.sid)
        self.assertEqual(res[0]["status"], "conflict-local-modified", res)
        # force 覆盖
        res2 = S.update_registry(self.store, ["alpha"], self.sid, force=True)
        self.assertEqual(res2[0]["status"], "updated", res2)
        content = open(p).read()
        self.assertNotIn("LOCAL EDIT", content)
        self.assertIn("1.2.0", content)

    def test_05_rollback(self):
        # 上一步 force 更新时已留旧版快照；回退应恢复 "LOCAL EDIT" 版本
        r = S.rollback_registry(self.store, "alpha")
        self.assertTrue(r["ok"], r)
        content = open(os.path.join(S.registry_root(), "alpha", "SKILL.md")).read()
        self.assertIn("LOCAL EDIT", content)
        # 版本号随内容回退（force 更新前为 1.1.0）
        self.assertEqual(r.get("version"), "1.1.0", r)
        row = [x for x in S.registry_view(self.store) if x["name"] == "alpha"][0]
        self.assertEqual(row["version"], "1.1.0")

    def test_06_distribute_two_targets(self):
        # 用 beta 做干净分发（alpha 处于回退后的本地修改态）
        S.update_registry(self.store, ["beta"], self.sid)
        ta = S.add_target(self.store, "fixture-a", "skills_dir", "plain", self.t1)
        tb = S.add_target(self.store, "fixture-b", "skills_dir", "plain", self.t2)
        self.assertTrue(ta["ok"] and tb["ok"], (ta, tb))
        res = S.distribute_skills(self.store, ["beta"], [ta["id"], tb["id"]])
        self.assertEqual([r["status"] for r in res], ["ok", "ok"], res)
        for t in (self.t1, self.t2):
            self.assertTrue(os.path.exists(os.path.join(t, "beta", "SKILL.md")))
        self.__class__.ta, self.__class__.tb = ta["id"], tb["id"]

    def test_07_distribute_idempotent(self):
        res = S.distribute_skills(self.store, ["beta"], [self.ta, self.tb])
        self.assertEqual([r["status"] for r in res], ["skipped", "skipped"], res)

    def test_08_distribute_conflict_on_manual_edit(self):
        # 手改目标文件 → 再分发应冲突
        p = os.path.join(self.t1, "beta", "SKILL.md")
        with open(p, "a") as f:
            f.write("MANUAL EDIT\n")
        res = S.distribute_skills(self.store, ["beta"], [self.ta])
        self.assertEqual(res[0]["status"], "conflict", res)
        self.assertIn("手动修改", res[0]["reason"])
        # force 覆盖 + 备份存在
        res2 = S.distribute_skills(self.store, ["beta"], [self.ta], force=True)
        self.assertEqual(res2[0]["status"], "ok", res2)
        content = open(p).read()
        self.assertNotIn("MANUAL EDIT", content)
        backups = os.path.join(self.t1, "beta", ".hub-backup")
        found = [f for _r, _d, fs in os.walk(backups) for f in fs if "SKILL.md" in f]
        self.assertTrue(os.path.isdir(backups) and found, "backup missing under %s" % backups)

    def test_09_unmanaged_preexisting_conflict(self):
        # 目标已有未托管的同名目录 → 冲突，不覆盖
        pre = os.path.join(self.t2, "gamma")
        os.makedirs(pre)
        open(os.path.join(pre, "SKILL.md"), "w").write("user's own gamma\n")
        # 先在源中注册 gamma
        w = os.path.join(self.source_repo, "skills/gamma")
        os.makedirs(w)
        open(os.path.join(w, "SKILL.md"), "w").write("---\nname: gamma\ndescription: g\n---\n")
        git("add", ".", cwd=self.source_repo)
        subprocess.run(["git", "-C", self.source_repo, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "gamma"], check=True)
        S.pull_source(self.store, self.sid)
        S.update_registry(self.store, ["gamma"], self.sid)
        res = S.distribute_skills(self.store, ["gamma"], [self.tb])
        self.assertEqual(res[0]["status"], "conflict", res)
        self.assertIn("未托管", res[0]["reason"])
        # 用户文件纹丝不动
        self.assertEqual(open(os.path.join(pre, "SKILL.md")).read(), "user's own gamma\n")

    def test_10_dry_run_no_write(self):
        os.makedirs(os.path.join(self.t2, "delta"), exist_ok=True)
        w = os.path.join(self.source_repo, "skills/delta")
        os.makedirs(w)
        open(os.path.join(w, "SKILL.md"), "w").write("---\nname: delta\ndescription: d\n---\n")
        git("add", ".", cwd=self.source_repo)
        subprocess.run(["git", "-C", self.source_repo, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "delta"], check=True)
        S.pull_source(self.store, self.sid)
        S.update_registry(self.store, ["delta"], self.sid)
        res = S.distribute_skills(self.store, ["delta"], [self.tb], dry_run=True)
        self.assertEqual(res[0]["status"], "ok", res)
        self.assertTrue(res[0]["dry_run"])
        self.assertFalse(os.path.exists(os.path.join(self.t2, "delta", "SKILL.md")))

    def test_11_readonly_target_fails_cleanly(self):
        ro = os.path.join(TMP, "target-ro")
        os.makedirs(ro)
        os.chmod(ro, 0o555)
        try:
            tr = S.add_target(self.store, "readonly", "skills_dir", "plain", ro)
            res = S.distribute_skills(self.store, ["delta"], [tr["id"]])
            self.assertEqual(res[0]["status"], "failed", res)
            self.assertTrue(res[0]["reason"])
        finally:
            os.chmod(ro, 0o755)

    def test_12_bad_source_errors_cleanly(self):
        r = S.add_source(self.store, "bad", os.path.join(TMP, "no-such-dir"), "main")
        p = S.pull_source(self.store, r["id"])
        self.assertFalse(p["ok"])
        srcs = {s["name"]: s for s in S.list_sources(self.store)}
        self.assertIsNotNone(srcs["bad"]["last_error"])

    def test_13_diff_view(self):
        d = S.diff_registry_vs_source(self.store, "alpha")
        self.assertTrue(d["ok"])
        self.assertIn("+++", d["diff"])  # 本地回退过 → 与源有差异

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
