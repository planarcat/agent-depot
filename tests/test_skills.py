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
        # 口径（2026-10 起）：拉取即落库——changed 条目自动物化进本地库
        self.assertEqual([m["status"] for m in p["materialized"]], ["updated"], p["materialized"])

    def test_03_update_registry(self):
        # 口径（2026-10 起）：pull_source 把 added/changed 自动落库，
        # 显式 update_registry 只对「库中已有」的条目做幂等 / 冲突处理，不再负责首次安装。
        self.assertTrue(os.path.isfile(os.path.join(S.registry_root(), "alpha", "SKILL.md")),
                        "拉取应已自动落库")
        res = S.update_registry(self.store, ["alpha", "gamma"], self.sid)
        by = {r["item"]: r for r in res}
        self.assertEqual(by["alpha"]["status"], "unchanged")   # 已落库 → 幂等
        self.assertEqual(by["alpha"]["version"], "1.1.0")
        self.assertEqual(by["gamma"]["status"], "failed")      # 源中不存在
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

class ManualItems(unittest.TestCase):
    """v0.6 手动条目：新建/重名/编辑/导入/删除 + items_view 状态联动。"""

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)
        cls.t1 = os.path.join(TMP, "manual-target")
        os.makedirs(cls.t1)

    def test_m01_create_and_conflict(self):
        r = S.create_manual(self.store, "manual-a", "测试技能", {
            "SKILL.md": "---\nname: manual-a\ndescription: 测试技能\nversion: 0.1.0\n---\n# a\n",
            "helper.txt": "hi",
        })
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["files"], 2)
        # 重名拦截
        r2 = S.create_manual(self.store, "manual-a", "dup", {"SKILL.md": "x"})
        self.assertFalse(r2["ok"])
        self.assertIn("已存在", r2["error"])
        # 非法名拦截
        r3 = S.create_manual(self.store, "../evil", "x", {"SKILL.md": "x"})
        self.assertFalse(r3["ok"])
        # 路径穿越拦截
        r4 = S.create_manual(self.store, "ok-name", "", {"../x.txt": "x", "SKILL.md": "y"})
        self.assertFalse(r4["ok"])

    def test_m02_catalog_and_items_view(self):
        cat = S.catalog_view(self.store)
        row = [x for x in cat if x["name"] == "manual-a"][0]
        self.assertTrue(row["manual"])
        self.assertEqual(row["source_name"], "本地")
        self.assertEqual(row["status"], "installed")
        v = S.items_view(self.store, q="manual-a")
        self.assertEqual(v["total"], 1)
        self.assertTrue(v["items"][0]["manual"])
        self.assertEqual(v["items"][0]["version"], "0.1.0")

    def test_m02b_items_view_source_filter(self):
        """来源过滤口径：数字 = 远程源 id，"manual" = 本地手动条目。

        回归：source=manual 曾被后端当成"没有过滤"（路由里非数字就置 None），
        于是 UI 上选中「本地·手动」卡片时列表依旧是全部条目。
        """
        cat = S.catalog_view(self.store)
        manual_n = len([x for x in cat if x["manual"]])
        m = S.items_view(self.store, source="manual")
        self.assertEqual(m["total"], manual_n)
        self.assertTrue(all(x["manual"] for x in m["items"]))
        # 不传 source = 全部（不要因为 "None" 字符串被误判成 manual）
        self.assertEqual(S.items_view(self.store)["total"], len(cat))

    def test_m03_edit_updates_version_and_hash(self):
        r = S.update_manual(self.store, "manual-a", {
            "SKILL.md": "---\nname: manual-a\ndescription: 测试技能\nversion: 0.2.0\n---\n# a2\n"})
        self.assertTrue(r["ok"], r)
        reg = S._manual_reg(self.store, "manual-a")
        self.assertEqual(reg["version"], "0.2.0")
        self.assertEqual(reg["prev_version"], "0.1.0")  # 可回退
        # 远程条目不可编辑
        r2 = S.update_manual(self.store, "no-such", {"SKILL.md": "x"})
        self.assertFalse(r2["ok"])

    def test_m04_import_local_dir(self):
        src = os.path.join(TMP, "import-src")
        os.makedirs(os.path.join(src, "sub"), exist_ok=True)
        with open(os.path.join(src, "SKILL.md"), "w") as f:
            f.write("---\nname: imported\ndescription: 导入技能\n---\n# i\n")
        with open(os.path.join(src, "sub", "data.txt"), "w") as f:
            f.write("d")
        r = S.import_local(self.store, src)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["files"], 2)
        self.assertEqual(r["name"], "import-src")
        # 缺 SKILL.md 拒绝
        src2 = os.path.join(TMP, "import-bad")
        os.makedirs(src2, exist_ok=True)
        with open(os.path.join(src2, "x.txt"), "w") as f:
            f.write("x")
        r2 = S.import_local(self.store, src2, "import-bad")
        self.assertFalse(r2["ok"])
        self.assertIn("SKILL.md", r2["error"])
        # 覆盖导入（先拒绝，overwrite=True 成功且留快照）
        with open(os.path.join(src, "SKILL.md"), "w") as f:
            f.write("---\nname: imported\ndescription: v2\n---\n# i2\n")
        r3 = S.import_local(self.store, src, "import-src")
        self.assertFalse(r3["ok"])
        r4 = S.import_local(self.store, src, "import-src", overwrite=True)
        self.assertTrue(r4["ok"], r4)
        self.assertTrue(r4["overwritten"])
        snaps = os.listdir(os.path.join(S.versions_root("import-src")))
        self.assertTrue(snaps)

    def test_m05_distribute_and_stale_and_delete(self):
        t = S.add_target(self.store, "manual-t1", "skills_dir", "plain", self.t1)
        self.assertTrue(t["ok"], t)
        tid = t["id"]
        res = S.distribute_skills(self.store, ["manual-a"], [tid])
        self.assertEqual(res[0]["status"], "ok", res)
        dep = S._deployment(self.store, "manual-a", tid)
        self.assertEqual(dep["item_version"], "0.2.0")  # 部署版本号记录
        # 最新态
        row = [x for x in S.items_view(self.store)["items"] if x["name"] == "manual-a"][0]
        pt = row["per_target"][0]
        self.assertEqual(pt["state"], "latest")
        # 编辑 → stale
        S.update_manual(self.store, "manual-a", {
            "SKILL.md": "---\nname: manual-a\ndescription: 测试技能\nversion: 0.3.0\n---\n# a3\n"})
        row2 = [x for x in S.items_view(self.store)["items"] if x["name"] == "manual-a"][0]
        self.assertEqual(row2["per_target"][0]["state"], "stale")
        tv = [x for x in S.items_view(self.store)["targets"] if x["id"] == tid][0]
        self.assertEqual(tv["items"]["stale"], 1)
        self.assertIn("manual-a", tv["stale_names"])
        # 重写 → latest
        S.distribute_skills(self.store, ["manual-a"], [tid])
        row3 = [x for x in S.items_view(self.store)["items"] if x["name"] == "manual-a"][0]
        self.assertEqual(row3["per_target"][0]["state"], "latest")
        self.assertEqual(row3["per_target"][0]["deployed_version"], "0.3.0")
        # 删除保护：有部署先拒绝
        rd = S.delete_manual(self.store, "manual-a")
        self.assertFalse(rd["ok"])
        self.assertIn("已部署", rd["error"])
        rd2 = S.delete_manual(self.store, "manual-a", force=True)
        self.assertTrue(rd2["ok"], rd2)
        self.assertEqual(rd2["removed_from_targets"], ["manual-t1"])
        self.assertFalse(os.path.isdir(os.path.join(self.t1, "manual-a")))

    def test_m06_delete_nonexistent_and_remote(self):
        r = S.delete_manual(self.store, "no-such-manual")
        self.assertFalse(r["ok"])


    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)



class RemovedItemsFlow(unittest.TestCase):
    """v0.6.1 远程删除条目三选：needs_action 不应用 / localize 转本地 / delete 同步删除。"""

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)

    def _make(self, tag):
        """源仓库两个 skill + 拉取 + 更新到本地 + 部署，然后远程删一个。返回 (sid, tid)。"""
        store = self.store
        src = os.path.join(TMP, "rm-src-" + tag)
        os.makedirs(src)
        for n in ("rm-keep-" + tag, "rm-doomed-" + tag):
            d = os.path.join(src, n)
            os.makedirs(d)
            with open(os.path.join(d, "SKILL.md"), "w") as f:
                f.write("---\nname: %s\ndescription: d\nversion: 1.0.0\n---\n# %s\n" % (n, n))
        git("init", "-q", "-b", "main", src)
        git("add", ".", cwd=src)
        subprocess.run(["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "v1"], check=True)
        sid = S.add_source(store, "rm-" + tag, src, "main")["id"]
        p = S.pull_source(store, sid)
        self.assertTrue(p["ok"], p)
        doomed = "rm-doomed-" + tag
        # 口径（2026-10 起）：拉取即落库——add_source + pull_source 已把条目物化进本地库，
        # 不需要（也不再适用）先调 update_registry 拿 "installed"。
        self.assertTrue(os.path.isfile(os.path.join(S.registry_root(), doomed, "SKILL.md")),
                        "拉取应已自动落库")
        u = S.update_registry(store, [doomed])
        self.assertEqual(u[0]["status"], "unchanged", u)
        tdir = os.path.join(TMP, "rm-tgt-" + tag)
        os.makedirs(tdir)
        tid = S.add_target(store, "rm-t-" + tag, "skills_dir", "plain", tdir)["id"]
        S.distribute_skills(store, [doomed], [tid])
        shutil.rmtree(os.path.join(src, doomed))
        git("add", "-A", cwd=src)
        subprocess.run(["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "v2"], check=True)
        return sid, tid, doomed, tdir

    def test_r01_pull_needs_action_not_applied(self):
        sid, tid, doomed, tdir = self._make("a")
        p = S.pull_source(self.store, sid)
        self.assertTrue(p.get("needs_action"), p)
        self.assertEqual(p["removed"], [doomed])
        det = p["removed_detail"][0]
        self.assertTrue(det["in_registry"])
        self.assertEqual(det["deployed_count"], 1)
        # 未应用：再次拉取仍是 needs_action，last_commit 不前进
        row = self.store.db.execute("SELECT last_commit FROM sources WHERE id=?", (sid,)).fetchone()
        self.assertNotEqual(row["last_commit"], p["commit"])
        p2 = S.pull_source(self.store, sid)
        self.assertTrue(p2.get("needs_action"), p2)

    def test_r02_localize(self):
        sid, tid, doomed, tdir = self._make("b")
        p = S.pull_source(self.store, sid, removed_action="localize")
        self.assertFalse(p.get("needs_action"), p)
        self.assertEqual(p["removed_action"], "localize")
        reg = self.store.db.execute(
            "SELECT source_id, version FROM registry_items WHERE kind='skills' AND name=?",
            (doomed,)).fetchone()
        self.assertIsNone(reg["source_id"])
        self.assertEqual(reg["version"], "1.0.0")
        # 已分发文件保留 + 手动条目可再分发
        self.assertTrue(os.path.isdir(os.path.join(tdir, doomed)))
        res = S.distribute_skills(self.store, [doomed], [tid])
        self.assertIn(res[0]["status"], ("ok", "skipped"), res)

    def test_r03_delete_action(self):
        sid, tid, doomed, tdir = self._make("c")
        p = S.pull_source(self.store, sid, removed_action="delete")
        self.assertFalse(p.get("needs_action"), p)
        self.assertEqual(p["removed_action"], "delete")
        row = self.store.db.execute(
            "SELECT 1 FROM registry_items WHERE kind='skills' AND name=?", (doomed,)).fetchone()
        self.assertIsNone(row)
        self.assertFalse(os.path.isdir(os.path.join(S.registry_root(), doomed)))
        # 已分发文件保留（删除保护语义：只清本地库，不动工具）
        self.assertTrue(os.path.isdir(os.path.join(tdir, doomed)))

    def test_r04_delete_source_localize_default(self):
        sid, tid, doomed, tdir = self._make("d")
        r = S.delete_source(self.store, sid)
        self.assertTrue(r["ok"], r)
        # 口径（2026-10 起）：拉取即落库 → 源内**所有**已落库条目都转手动（不只被删除的那一条）
        self.assertEqual(sorted(r["localized"]), sorted([doomed, "rm-keep-d"]), r)
        reg = self.store.db.execute(
            "SELECT source_id FROM registry_items WHERE kind='skills' AND name=?",
            (doomed,)).fetchone()
        self.assertIsNone(reg["source_id"])  # 转手动，不丢

    def test_r05_delete_source_purge(self):
        sid, tid, doomed, tdir = self._make("e")
        r = S.delete_source(self.store, sid, removed_action="delete")
        self.assertTrue(r["ok"], r)
        self.assertEqual(sorted(r["purged"]), sorted([doomed, "rm-keep-e"]), r)
        row = self.store.db.execute(
            "SELECT 1 FROM registry_items WHERE kind='skills' AND name=?", (doomed,)).fetchone()
        self.assertIsNone(row)
        # git 缓存目录已清
        self.assertFalse(os.path.isdir(os.path.join(S.sources_root(), "skills-%d" % sid)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
