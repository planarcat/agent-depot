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
from hub.core import local_dirs as LD           # noqa: E402
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
        # 按目标 id 取（2026-10-31 起 DirBindings 判据会先建其它目标，per_target[0] 不再是本测试的目标）
        pt = [x for x in row["per_target"] if x["target_id"] == tid][0]
        self.assertEqual(pt["state"], "latest")
        # 编辑 → stale
        S.update_manual(self.store, "manual-a", {
            "SKILL.md": "---\nname: manual-a\ndescription: 测试技能\nversion: 0.3.0\n---\n# a3\n"})
        row2 = [x for x in S.items_view(self.store)["items"] if x["name"] == "manual-a"][0]
        self.assertEqual([x for x in row2["per_target"] if x["target_id"] == tid][0]["state"], "stale")
        tv = [x for x in S.items_view(self.store)["targets"] if x["id"] == tid][0]
        self.assertEqual(tv["items"]["stale"], 1)
        self.assertIn("manual-a", tv["stale_names"])
        # 重写 → latest
        S.distribute_skills(self.store, ["manual-a"], [tid])
        row3 = [x for x in S.items_view(self.store)["items"] if x["name"] == "manual-a"][0]
        pt3 = [x for x in row3["per_target"] if x["target_id"] == tid][0]
        self.assertEqual(pt3["state"], "latest")
        self.assertEqual(pt3["deployed_version"], "0.3.0")
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


class LocalDirs(unittest.TestCase):
    """本地目录：选择链接 / 扫描同步 / 目标目录落盘 / 移除保留磁盘（2026-10-31 口径）。

    口径出处：共享目录池（Skills/MCP 共用）、外部变化自动登记进本地库（与新建/导入同权）、
    「取消创建，提供【选择目录】功能」（2026-10-31 用户口径——hub 不再代建目录，
    链接一律来自磁盘已有文件夹；FIGMA_OVERRIDES #39）。原生文件夹选择器
    （pick_native → osascript 弹系统窗口）依赖人工交互，不进自动化判据；
    其登记路径与 link_dir 完全同一条管线，登记口径由本类覆盖。
    """

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)

    def _mk_ext(self, tag, skills=(("ext-skill", "1.0"),), mcp=True, junk=False, empty=False):
        root = os.path.join(TMP, "ext-%s" % tag)
        os.makedirs(root, exist_ok=True)
        if empty:
            return root
        for name, ver in skills:
            d = os.path.join(root, name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "SKILL.md"), "w") as f:
                f.write("---\nname: %s\ndescription: ext\nversion: %s\n---\nbody %s\n" % (name, ver, ver))
        if mcp:
            with open(os.path.join(root, "ext-server.json"), "w") as f:
                json.dump({"command": "npx", "args": ["-y", "srv"]}, f)
        if junk:
            with open(os.path.join(root, "junk.json"), "w") as f:
                f.write("not a mcp entry")
        return root

    def test_d01_link_and_register(self):
        root = self._mk_ext("a", skills=(("ext-skill", "1.0"),), mcp=True, junk=True)
        r = LD.link_dir(self.store, root, "dir-ext")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["origin"], "linked")
        self.__class__.dir_ext_id = r["id"]
        self.__class__.dir_ext_root = root
        # skill + 合法 mcp json 登记；非法 json（junk.json）不计
        self.assertEqual(r["added"], 2, r)
        self.assertEqual(r["skipped"], [])
        cat = S.catalog_view(self.store)
        row = [x for x in cat if x["name"] == "ext-skill"][0]
        self.assertTrue(row["manual"])
        self.assertEqual(row["dir_name"], "dir-ext")
        self.assertEqual(row["version"], "1.0")
        # 校验路径：不存在 / hub 自身 / 与已链接目录重叠 / 缺省名取目录名
        self.assertFalse(LD.link_dir(self.store, os.path.join(TMP, "nope"))["ok"])
        self.assertFalse(LD.link_dir(self.store, os.path.join(TMP, "hub-home"))["ok"])
        self.assertFalse(LD.link_dir(self.store, os.path.join(root, "ext-skill"))["ok"])
        r2 = LD.link_dir(self.store, self._mk_ext("b", skills=(("b-skill", "1"),), mcp=False))
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["name"], os.path.basename(r2["path"]))

    def test_d02_create_and_import_into_dir(self):
        # 目标目录同样来自链接（创建已取消）：先链接一个空目录
        root_a = self._mk_ext("a2", empty=True)
        linked = LD.link_dir(self.store, root_a, "dir-a")
        self.assertTrue(linked["ok"], linked)
        self.assertEqual(linked["added"], 0, linked)
        did = linked["id"]
        self.__class__.dir_a_id = did
        r = S.create_manual(self.store, "in-dir", "d",
                            {"SKILL.md": "---\nname: in-dir\nversion: 0.2.0\n---\nb"}, dir_id=did)
        self.assertTrue(r["ok"], r)
        # 落盘在链接的目录里（不是 registry/skills）
        self.assertTrue(os.path.isdir(os.path.join(root_a, "in-dir")))
        self.assertFalse(os.path.isdir(os.path.join(S.registry_root(), "in-dir")))
        reg = self.store.db.execute(
            "SELECT dir_id FROM registry_items WHERE kind='skills' AND name='in-dir'").fetchone()
        self.assertEqual(reg["dir_id"], did)
        # 默认库对照条目（dir_id 为空 = 默认目录）
        r0 = S.create_manual(self.store, "in-default", "d", {"SKILL.md": "---\nname: in-default\n---\nb"})
        self.assertTrue(r0["ok"], r0)
        # 从磁盘目录导入到链接目录
        src = os.path.join(TMP, "import-src-in")
        os.makedirs(src)
        with open(os.path.join(src, "SKILL.md"), "w") as f:
            f.write("---\nname: imported\n---\nhi")
        r2 = S.import_local(self.store, src, "imported", dir_id=did)
        self.assertTrue(r2["ok"], r2)
        self.assertTrue(os.path.isfile(os.path.join(root_a, "imported", "SKILL.md")))
        # 跨目录重名拦截（ext-skill 已登记在 dir-ext）
        r3 = S.create_manual(self.store, "ext-skill", "d", {"SKILL.md": "x"}, dir_id=did)
        self.assertFalse(r3["ok"])
        self.assertIn("已存在", r3["error"])
        # 非法目录 id
        r4 = S.create_manual(self.store, "no-dir", "d", {"SKILL.md": "x"}, dir_id=999)
        self.assertFalse(r4["ok"])

    def test_d03_scan_follows_disk(self):
        """外部增/改/删 → scan_sync 跟随登记（自动登记口径）。"""
        root = self.__class__.dir_ext_root
        # 改：外部追加文件（mtime/size 变）→ hash 更新 + prev_hash 留链
        with open(os.path.join(root, "ext-skill", "EXTRA.md"), "w") as f:
            f.write("more")
        before = self.store.db.execute(
            "SELECT hash, prev_hash FROM registry_items WHERE kind='skills' AND name='ext-skill'").fetchone()
        out = LD.sync_all(self.store)
        self.assertEqual(out["dir-ext"], {"added": 0, "updated": 1, "removed": 0, "skipped": []}, out)
        after = self.store.db.execute(
            "SELECT hash, prev_hash FROM registry_items WHERE kind='skills' AND name='ext-skill'").fetchone()
        self.assertNotEqual(before["hash"], after["hash"])
        self.assertEqual(after["prev_hash"], before["hash"])
        # 增：外部投放新条目
        os.makedirs(os.path.join(root, "brand-new"))
        with open(os.path.join(root, "brand-new", "SKILL.md"), "w") as f:
            f.write("---\nname: brand-new\n---\nnew")
        out = LD.sync_all(self.store)
        self.assertEqual(out["dir-ext"]["added"], 1, out)
        # 重名条目投放到另一目录 → 跳过
        dup_root = self._mk_ext("c", skills=(("brand-new", "9"),), mcp=False)
        rid = LD.link_dir(self.store, dup_root, "dir-dup")
        self.assertTrue(rid["ok"], rid)
        self.assertEqual(rid["skipped"], [{"kind": "skills", "name": "brand-new", "reason": "重名"}], rid)
        # 删：磁盘移除 → 注销登记
        shutil.rmtree(os.path.join(root, "brand-new"))
        out = LD.sync_all(self.store)
        self.assertEqual(out["dir-ext"]["removed"], 1, out)
        row = self.store.db.execute(
            "SELECT 1 FROM registry_items WHERE kind='skills' AND name='brand-new' AND dir_id=?",
            (self.__class__.dir_ext_id,)).fetchone()
        self.assertIsNone(row)

    def test_d04_items_view_dir_filter(self):
        did_a = self.__class__.dir_a_id
        did_ext = self.__class__.dir_ext_id
        v = S.items_view(self.store, source="manual", dir=did_a)
        names = [it["name"] for it in v["items"]]
        self.assertIn("in-dir", names)
        self.assertIn("imported", names)
        self.assertNotIn("ext-skill", names)
        ve = S.items_view(self.store, source="manual", dir=did_ext)
        self.assertIn("ext-skill", [it["name"] for it in ve["items"]])
        vd = S.items_view(self.store, source="manual", dir="default")
        self.assertNotIn("in-dir", [it["name"] for it in vd["items"]])
        # 默认库条目（d02 建的 in-default）仍在 default
        self.assertIn("in-default", [it["name"] for it in vd["items"]])

    def test_d05_remove_dir_keeps_disk(self):
        root = self.__class__.dir_ext_root
        did = self.__class__.dir_ext_id
        r = LD.remove_dir(self.store, did)        # dir-ext
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["items_unregistered"], 2, r)
        # 磁盘文件一律不动（非破坏性）
        self.assertTrue(os.path.isdir(os.path.join(root, "ext-skill")))
        self.assertTrue(os.path.isfile(os.path.join(root, "ext-server.json")))
        # 登记已下架
        row = self.store.db.execute(
            "SELECT COUNT(*) c FROM registry_items WHERE dir_id=?", (did,)).fetchone()
        self.assertEqual(row["c"], 0)
        self.assertFalse(LD.remove_dir(self.store, did)["ok"])


class DirBindings(unittest.TestCase):
    """目录 ↔ 工具 绑定同步（2026-10-31 拆解 M1）：

    建连即全量同步 / 变化三态跟随（改·增·删）/ 未托管内容停手 /
    暂停跳过 / 断开保留与清理。口径出处：Plans/目录连接工具/需求拆解.md。
    watcher worker 只是 sync_all_bindings 的定时触发，登记与分发口径由本类覆盖。
    """

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)

    def _mk_dir(self, tag, skills):
        root = os.path.join(TMP, "bind-dir-%s" % tag)
        os.makedirs(root, exist_ok=True)
        for name in skills:
            d = os.path.join(root, name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "SKILL.md"), "w") as f:
                f.write("---\nname: %s\nversion: 1.0\n---\nbody %s\n" % (name, tag))
        r = LD.link_dir(self.store, root, "bind-%s" % tag)
        self.assertTrue(r["ok"], r)
        setattr(self.__class__, "dir_%s_id" % tag, r["id"])
        setattr(self.__class__, "dir_%s_root" % tag, root)
        return r["id"], root

    def _mk_target(self, tag):
        path = os.path.join(TMP, "bind-tgt-%s" % tag)
        os.makedirs(path, exist_ok=True)
        r = S.add_target(self.store, "bind-tgt-%s" % tag, "skills_dir", None, path)
        self.assertTrue(r["ok"], r)
        return r["id"], path

    def test_b01_bind_full_sync(self):
        did, _root = self._mk_dir("a", ("bskill-a", "bskill-b"))
        tid, tpath = self._mk_target("a")
        self.__class__.tgt_a_id = tid
        r = S.bind_dirs(self.store, did, [tid])
        self.assertTrue(r["ok"], r)
        res = r["results"][0]
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["added"], 2, res)
        # 全部落进工具目录
        for name in ("bskill-a", "bskill-b"):
            self.assertTrue(os.path.isfile(os.path.join(tpath, name, "SKILL.md")))
        # 部署记录打上绑定标记 + 绑定行有同步结果
        bl = S.list_dir_bindings(self.store, dir_id=did)
        self.assertEqual(len(bl), 1)
        self.assertIsNotNone(bl[0]["last_sync_at"])
        self.assertEqual(bl[0]["last_result"]["added"], 2, bl[0])
        # 重复绑定同一目标 → 拒绝
        r2 = S.bind_dirs(self.store, did, [tid])
        self.assertFalse(r2["results"][0]["ok"])

    def test_b02_change_follows(self):
        did = self.__class__.dir_a_id
        root = self.__class__.dir_a_root
        tpath = os.path.join(TMP, "bind-tgt-a")
        # 改：目录内 SKILL.md 外部修改 → 扫描 + 绑定同步 → 目标内容更新
        with open(os.path.join(root, "bskill-a", "SKILL.md"), "w") as f:
            f.write("---\nname: bskill-a\nversion: 2.0\n---\nchanged")
        LD.scan_sync(self.store, LD.get_dir(self.store, did))
        out = S.sync_dir_bindings(self.store, did)
        self.assertEqual(out[0]["updated"], 1, out)
        with open(os.path.join(tpath, "bskill-a", "SKILL.md")) as f:
            self.assertIn("changed", f.read())
        # 增：外部投放新 skill → 同步出现
        os.makedirs(os.path.join(root, "bskill-c"))
        with open(os.path.join(root, "bskill-c", "SKILL.md"), "w") as f:
            f.write("---\nname: bskill-c\n---\nnew")
        LD.scan_sync(self.store, LD.get_dir(self.store, did))
        out = S.sync_dir_bindings(self.store, did)
        self.assertEqual(out[0]["added"], 1, out)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "bskill-c", "SKILL.md")))
        # 幂等：再同步一次 → 全部跳过
        out = S.sync_dir_bindings(self.store, did)
        self.assertEqual(out[0]["skipped"], 3, out)

    def test_b03_conflict_stops(self):
        """目标里已有、但不是 hub 落的同名内容 → 停手跳过且不碰原文件。"""
        tid = self.__class__.tgt_a_id
        tpath = os.path.join(TMP, "bind-tgt-a")
        # 未托管内容先放进目标
        unmanaged = os.path.join(tpath, "bskill-unmanaged")
        os.makedirs(unmanaged)
        with open(os.path.join(unmanaged, "SKILL.md"), "w") as f:
            f.write("手写的，别动我")
        # 同名条目进入链接目录
        root = self.__class__.dir_a_root
        os.makedirs(os.path.join(root, "bskill-unmanaged"))
        with open(os.path.join(root, "bskill-unmanaged", "SKILL.md"), "w") as f:
            f.write("---\nname: bskill-unmanaged\n---\nhub 版本")
        LD.scan_sync(self.store, LD.get_dir(self.store, self.__class__.dir_a_id))
        out = S.sync_dir_bindings(self.store, self.__class__.dir_a_id)
        self.assertEqual(out[0]["conflicts"], 1, out)
        with open(os.path.join(unmanaged, "SKILL.md")) as f:
            self.assertIn("手写的", f.read())          # 原文件未被触碰
        # force 才覆盖
        out = S.sync_dir_bindings(self.store, self.__class__.dir_a_id, force=True)
        with open(os.path.join(unmanaged, "SKILL.md")) as f:
            self.assertIn("hub 版本", f.read())

    def test_b04_removed_propagates_managed_only(self):
        did = self.__class__.dir_a_id
        root = self.__class__.dir_a_root
        tpath = os.path.join(TMP, "bind-tgt-a")
        # 目标里放一个非托管文件（别人落的），删 skill 时不能碰
        keeper = os.path.join(tpath, "bskill-a", "manual-note.txt")
        with open(keeper, "w") as f:
            f.write("不是 hub 的")
        shutil.rmtree(os.path.join(root, "bskill-a"))
        LD.scan_sync(self.store, LD.get_dir(self.store, did))
        out = S.sync_dir_bindings(self.store, did)
        self.assertEqual(out[0]["removed"], 1, out)
        # 托管文件（SKILL.md）已清；非托管文件仍在；目录因非托管文件残留而保留
        self.assertFalse(os.path.exists(os.path.join(tpath, "bskill-a", "SKILL.md")))
        self.assertTrue(os.path.isfile(keeper))
        with store_lock_row(self.store, "bskill-a") as st:
            self.assertEqual(st, "removed")

    def test_b05_pause_skips(self):
        bl = S.list_dir_bindings(self.store)
        bid = bl[0]["id"]
        self.assertTrue(S.set_binding_enabled(self.store, bid, False)["ok"])
        root = self.__class__.dir_a_root
        with open(os.path.join(root, "bskill-b", "SKILL.md"), "w") as f:
            f.write("---\nname: bskill-b\nversion: 9.9\n---\npaused-change")
        LD.scan_sync(self.store, LD.get_dir(self.store, self.__class__.dir_a_id))
        out = S.sync_dir_bindings(self.store, self.__class__.dir_a_id)
        self.assertEqual(out, [], out)                # 暂停 → 完全跳过
        tpath = os.path.join(TMP, "bind-tgt-a")
        with open(os.path.join(tpath, "bskill-b", "SKILL.md")) as f:
            self.assertNotIn("paused-change", f.read())
        # 恢复 → 跟上
        self.assertTrue(S.set_binding_enabled(self.store, bid, True)["ok"])
        S.sync_dir_bindings(self.store, self.__class__.dir_a_id)
        with open(os.path.join(tpath, "bskill-b", "SKILL.md")) as f:
            self.assertIn("paused-change", f.read())

    def _mk_mcp_dir(self, tag, servers):
        """目录里放 mcp json（scan_sync 会登记为 mcp 条目）。"""
        root = os.path.join(TMP, "bind-mcpdir-%s" % tag)
        os.makedirs(root, exist_ok=True)
        for name, cfg in servers.items():
            with open(os.path.join(root, name + ".json"), "w") as f:
                json.dump(cfg, f)
        r = LD.link_dir(self.store, root, "bind-mcp-%s" % tag)
        self.assertTrue(r["ok"], r)
        return r["id"]

    def test_b07_bind_mcp_channel(self):
        # MCP 通道：目录里的 mcp 条目写进目标配置；channels 标 mcp
        did = self._mk_mcp_dir("a", {"bind-mcp-a": {"command": "echo", "args": ["hi"]}})
        tpath = os.path.join(TMP, "bind-mcp-tgt-a.json")
        with open(tpath, "w") as f:
            json.dump({"mcpServers": {}}, f)
        tid = S.add_target(self.store, "bind-mcp-tgt", "mcp_json", None, tpath,
                           "mcpServers")["id"]
        r = S.bind_dirs(self.store, did, [tid])
        self.assertTrue(r["ok"], r)
        with open(tpath) as f:
            data = json.load(f)
        self.assertIn("bind-mcp-a", data["mcpServers"])
        bl = [b for b in S.list_dir_bindings(self.store, dir_id=did) if b["target_id"] == tid]
        self.assertEqual(bl[0]["channels"], ["mcp"], bl[0])
        self.assertEqual(bl[0]["target_kind"], "mcp_json")
        # 断开并清理：配置里的条目摘掉
        self.assertTrue(S.unbind(self.store, bl[0]["id"], clean=True)["ok"])
        with open(tpath) as f:
            self.assertNotIn("bind-mcp-a", json.load(f)["mcpServers"])

    def test_b09_excluded_stops_following(self):
        # 排除条目：不再分发（工具内已装文件保留）
        did, root = self._mk_dir("exc", ("exskill-a", "exskill-b"))
        tid, tpath = self._mk_target("exc")
        self.assertTrue(S.bind_dirs(self.store, did, [tid])["ok"])
        bl = [b for b in S.list_dir_bindings(self.store, dir_id=did) if b["target_id"] == tid]
        bid = bl[0]["id"]
        self.assertEqual(bl[0]["excluded"], [])
        r = S.set_binding_excluded(self.store, bid, ["exskill-a"])
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["excluded"], ["exskill-a"])
        # 手动删掉 a 的部署，再强制同步：被排除的不会回来，b 仍在
        shutil.rmtree(os.path.join(tpath, "exskill-a"), ignore_errors=True)
        S.sync_dir_bindings(self.store, did, force=True)
        self.assertFalse(os.path.exists(os.path.join(tpath, "exskill-a")))
        self.assertTrue(os.path.isfile(os.path.join(tpath, "exskill-b", "SKILL.md")))
        # 恢复跟随 → 再次同步会把 a 补回来
        S.set_binding_excluded(self.store, bid, [])
        S.sync_dir_bindings(self.store, did, force=True)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "exskill-a", "SKILL.md")))

    def test_b10_clean_only_touches_channels(self):
        # clean 删除：只清本绑定落过的内容，目录与其余条目不受影响
        did, root = self._mk_dir("cln", ("clskill-a",))
        tid, tpath = self._mk_target("cln")
        self.assertTrue(S.bind_dirs(self.store, did, [tid])["ok"])
        bl = [b for b in S.list_dir_bindings(self.store, dir_id=did) if b["target_id"] == tid]
        r = S.unbind(self.store, bl[0]["id"], clean=True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["cleaned"], 1, r)
        self.assertFalse(os.path.exists(os.path.join(tpath, "clskill-a")))
        self.assertTrue(os.path.isfile(os.path.join(root, "clskill-a", "SKILL.md")))

    def test_b08_channels_guard(self):
        # skills 目标只能走 skills 通道；只留 mcp 要被拒绝
        did, _root = self._mk_dir("chg", ("cskill-a",))
        tid, _p = self._mk_target("chg")
        self.assertTrue(S.bind_dirs(self.store, did, [tid])["ok"])
        bl = [b for b in S.list_dir_bindings(self.store, dir_id=did) if b["target_id"] == tid]
        self.assertTrue(bl)
        bad = S.set_binding_channels(self.store, bl[0]["id"], ["mcp"])
        self.assertFalse(bad["ok"], bad)
        ok = S.set_binding_channels(self.store, bl[0]["id"], ["skills"])
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["channels"], ["skills"])

    def test_b06_unbind_keep_and_clean(self):
        did = self.__class__.dir_a_id
        tid = self.__class__.tgt_a_id
        bl = S.list_dir_bindings(self.store, dir_id=did)
        bid = bl[0]["id"]
        # 默认断开：文件保留
        r = S.unbind(self.store, bid, clean=False)
        self.assertTrue(r["ok"] and r["files_kept"], r)
        self.assertTrue(os.path.isfile(os.path.join(TMP, "bind-tgt-a", "bskill-b", "SKILL.md")))
        self.assertFalse(S.list_dir_bindings(self.store, dir_id=did))
        # 重新绑定 + 清理断开：托管内容移除，非托管文件保留
        S.bind_dirs(self.store, did, [tid], force=True)
        bl = S.list_dir_bindings(self.store, dir_id=did)
        r = S.unbind(self.store, bl[0]["id"], clean=True)
        self.assertTrue(r["ok"] and not r["files_kept"], r)
        self.assertFalse(os.path.exists(os.path.join(TMP, "bind-tgt-a", "bskill-b")))
        self.assertTrue(os.path.isfile(os.path.join(TMP, "bind-tgt-a", "bskill-a", "manual-note.txt")))


def store_lock_row(store, name):
    """读 deployment 状态的小工具（上下文管理器形式供 with 使用）。"""
    class _Ctx:
        def __enter__(self):
            with store.lock:
                row = store.db.execute(
                    "SELECT status FROM deployments WHERE item_kind='skill' AND item_name=? "
                    "ORDER BY id DESC LIMIT 1", (name,)).fetchone()
            return dict(row)["status"] if row else None

        def __exit__(self, *a):
            return False
    return _Ctx()


if __name__ == "__main__":
    unittest.main(verbosity=2)
