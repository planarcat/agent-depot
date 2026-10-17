#!/usr/bin/env python3
"""lint 基线（scripts/lint_baseline.py）判据：多分支 / 合并 / rebase 场景下只拦「本次新增」。

每个用例都在临时目录里建真实的 git 环境：bare 远程 + 工作克隆（+ 第二个克隆模拟同事），
把被测脚本与规则文件复制进去跑，不碰本仓 git 状态。

初始 main：
  web/hub-ui.css 有 2 条存量告警，基线登记 {"web/hub-ui.css": 2}
  web/app.css / web/index.html 干净；other.txt 为普通文件
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "lint_baseline.py")
RULES = os.path.join(ROOT, "tests", "lint_styles.py")

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@localhost",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@localhost",
    "GIT_CONFIG_NOSYSTEM": "1",
}


class Repo:
    def __init__(self, path, home):
        self.path = path
        self.env = dict(os.environ, HOME=home, **GIT_ENV)
        self.env.pop("LINT_BASE", None)

    def git(self, *args, check=True):
        r = subprocess.run(["git", *args], cwd=self.path, env=self.env, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise AssertionError("git %s 失败：%s%s" % (" ".join(args), r.stdout, r.stderr))
        return r

    def write(self, rel, text, append=False):
        p = os.path.join(self.path, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a" if append else "w", encoding="utf-8") as fh:
            fh.write(text)

    def commit(self, msg, *paths):
        self.git("add", *(paths or ["-A"]))
        self.git("commit", "-q", "-m", msg)

    def lint(self, *args, env=None):
        e = dict(self.env, **(env or {}))
        r = subprocess.run([sys.executable, "scripts/lint_baseline.py", *args], cwd=self.path, env=e,
                           capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def full_lint(self):
        r = subprocess.run([sys.executable, "tests/lint_styles.py"], cwd=self.path, env=self.env,
                           capture_output=True, text=True)
        return r.returncode

    def baseline(self):
        with open(os.path.join(self.path, "scripts", "lint-baseline.json"), encoding="utf-8") as fh:
            return json.load(fh)["files"]


class LintBaselineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lint-baseline-")
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.origin = os.path.join(self.tmp, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True)
        self.me = self._clone("me")
        r = self.me
        os.makedirs(os.path.join(r.path, "scripts"), exist_ok=True)
        os.makedirs(os.path.join(r.path, "tests"), exist_ok=True)
        shutil.copyfile(SCRIPT, os.path.join(r.path, "scripts", "lint_baseline.py"))
        shutil.copyfile(RULES, os.path.join(r.path, "tests", "lint_styles.py"))
        r.write("web/index.html", "<html><body>ok</body></html>\n")
        r.write("web/app.css", ".a { color: var(--c-text); }\n")
        r.write("web/hub-ui.css", ".legacy1 { color: #111; }\n.legacy2 { color: #222; }\n")
        r.write("other.txt", "base\n")
        r.write("scripts/lint-baseline.json", json.dumps({"rule_source": "tests/lint_styles.py",
                                                           "files": {"web/hub-ui.css": 2}}) + "\n")
        r.commit("init")
        r.git("push", "-q", "-u", "origin", "main")
        r.git("remote", "set-head", "origin", "-a")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _clone(self, name):
        path = os.path.join(self.tmp, name)
        subprocess.run(["git", "clone", "-q", self.origin, path], check=True, capture_output=True,
                       env=dict(os.environ, HOME=self.home, **GIT_ENV))
        return Repo(path, self.home)

    def _feature(self, name="feat"):
        self.me.git("checkout", "-q", "-b", name)
        self.me.git("push", "-q", "-u", "origin", name)

    def _colleague_pushes_violation_to_main(self, also_other=True):
        """同事绕过检查往 main 推了一条 index.html 告警（基线没跟着改）。"""
        mate = self._clone("mate")
        mate.write("web/index.html", "<html><body style=\"color:#f00\">x</body></html>\n")
        if also_other:
            mate.write("other.txt", "theirs\n")
        mate.commit("mate: index 告警")
        mate.git("push", "-q", "origin", "main")
        self.me.git("fetch", "-q", "origin")

    def _diverge_on_other_txt(self):
        """feat 改 other.txt 并推送；同事在 main 上改 other.txt + 塞 index 告警 → 合并必冲突。"""
        self._feature()
        self.me.write("other.txt", "mine\n")
        self.me.commit("feat: 改 other")
        self.me.git("push", "-q")
        self._colleague_pushes_violation_to_main()

    # ---------------------------------------------------------------- 基本面
    def test_01_clean_main_passes(self):
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertIn("增量", out)
        self.assertIn("命中 lint 范围 0/3", out)

    def test_02_feature_new_violation_fails(self):
        self._feature()
        self.me.write("web/app.css", ".b { color: #fff; }\n", append=True)
        self.me.commit("feat: 新增告警")
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("web/app.css 告警 1 > 基线 0", out)
        self.assertIn("web/app.css:2 hex color #fff", out)

    def test_03_uncommitted_violation_fails(self):
        self._feature()
        self.me.write("web/app.css", ".b { color: #abcdef; }\n", append=True)
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("hex color #abcdef", out)

    def test_04_legacy_debt_does_not_block_unrelated_work(self):
        """存量告警不拦与之无关的改动——而全量零容忍会把所有人一起拦住（这正是要基线的原因）。"""
        self._feature()
        self.me.write("other.txt", "mine\n")
        self.me.commit("feat: 无关改动")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.me.full_lint(), 1, "前提：全量 lint 在存量下本应是红的")

    def test_05_legacy_file_touched_only_new_counts(self):
        self._feature()
        self.me.write("web/hub-ui.css", ".clean { color: var(--c-ok); }\n", append=True)
        self.me.commit("feat: 碰存量文件但不新增")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertIn("web/hub-ui.css 告警 2 ≤ 基线 2", out)
        self.me.write("web/hub-ui.css", ".bad { color: #333; }\n", append=True)
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("web/hub-ui.css 告警 3 > 基线 2（新增 1）", out)

    # ---------------------------------------------------------------- 合并 / rebase
    def test_06_merge_in_progress_excludes_their_files(self):
        """合并进行中：对方带入的文件不算你的（§九 合并期误报）。"""
        self._diverge_on_other_txt()
        r = self.me.git("merge", "origin/main", check=False)
        self.assertNotEqual(r.returncode, 0, "前提：other.txt 应冲突，合并停在进行中")
        naive = self.me.git("diff", "--name-only", "@{u}").stdout
        self.assertIn("web/index.html", naive, "前提：朴素 diff 会把对方文件算进来")
        self.me.write("other.txt", "mine+theirs\n")
        self.me.git("add", "other.txt")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertIn("合并带入、不计：web/index.html", out)

    def test_07_after_merge_commit_still_excludes_their_files(self):
        """合并已提交但未推送：first-parent + combined diff，对方文件仍不算。"""
        self._diverge_on_other_txt()
        self.me.git("merge", "origin/main", check=False)
        self.me.write("other.txt", "mine+theirs\n")
        self.me.git("add", "other.txt")
        self.me.git("commit", "-q", "--no-edit")
        naive = self.me.git("diff", "--name-only", "@{u}..HEAD").stdout
        self.assertIn("web/index.html", naive, "前提：朴素区间 diff 会误报")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)

    def test_08_evil_merge_is_caught(self):
        """解冲突时顺手塞进新告警（与两个父提交都不同）→ 必须拦。合并中、合并后都拦。"""
        self._diverge_on_other_txt()
        self.me.git("merge", "origin/main", check=False)
        self.me.write("other.txt", "mine+theirs\n")
        self.me.write("web/app.css", ".evil { color: #0f0; }\n", append=True)
        self.me.git("add", "other.txt", "web/app.css")
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("web/app.css 告警 1 > 基线 0", out)
        self.me.git("commit", "-q", "--no-edit")
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("web/app.css 告警 1 > 基线 0", out)
        self.assertNotIn("web/index.html 告警", out)

    def test_09_rebase_onto_new_main_passes(self):
        """rebase 到新 main 后：基点取离 HEAD 最近的 merge-base，main 上别人的提交不算。"""
        self._feature()
        self.me.write("web/app.css", ".mine { color: var(--c-ok); }\n", append=True)
        self.me.commit("feat: 干净改动")
        self.me.git("push", "-q")
        self._colleague_pushes_violation_to_main(also_other=False)
        self.me.git("rebase", "-q", "origin/main")
        naive = self.me.git("diff", "--name-only", "@{u}..HEAD").stdout
        self.assertIn("web/index.html", naive, "前提：只按上游算会误报")
        rc, out = self.me.lint("--explain")
        self.assertEqual(rc, 0, out)
        self.assertIn("origin", out)

    def test_10_pre_push_base_env_is_honored(self):
        """pre-push 传入的远端 sha（LINT_BASE）参与选基点；本地没有的 sha 被忽略而不是报错。"""
        self._feature()
        self.me.write("web/app.css", ".b { color: #abc; }\n", append=True)
        self.me.commit("feat: 告警")
        rc, out = self.me.lint(env={"LINT_BASE": "0" * 40})
        self.assertEqual(rc, 1, out)
        sha = self.me.git("rev-parse", "HEAD").stdout.strip()
        rc, out = self.me.lint(env={"LINT_BASE": sha})
        self.assertEqual(rc, 0, out)   # 远端已是这个提交 → 没有本次变更
        self.assertIn("$LINT_BASE", out)

    # ---------------------------------------------------------------- 模式切换
    def test_11_rule_change_switches_to_full(self):
        self._feature()
        self.me.write("tests/lint_styles.py", "\n# rule tweak\n", append=True)
        self.me.commit("feat: 改规则")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertIn("全量（规则或基线被改", out)
        self.assertIn("命中 lint 范围 3/3", out)

    def test_12_no_remote_falls_back_to_full_not_worktree_only(self):
        """单机仓（无远程）：不能退化成只看未提交——否则提交到 main 的告警永远查不到。"""
        solo = os.path.join(self.tmp, "solo")
        shutil.copytree(self.me.path, solo, ignore=shutil.ignore_patterns(".git"))
        r = Repo(solo, self.home)
        r.git("init", "-q", "-b", "main")
        r.commit("init")
        r.write("web/app.css", ".x { color: #123; }\n", append=True)
        r.commit("main: 直接提交告警")
        rc, out = r.lint()
        self.assertEqual(rc, 1, out)
        self.assertIn("全量", out)
        self.assertIn("web/app.css 告警 1 > 基线 0", out)

    # ---------------------------------------------------------------- 基线维护
    def test_13_ratchet_only_lowers(self):
        self._feature()
        self.me.write("web/hub-ui.css", ".legacy1 { color: var(--c-a); }\n.legacy2 { color: #222; }\n")
        rc, out = self.me.lint()
        self.assertEqual(rc, 0, out)
        self.assertIn("已改善", out)
        rc, out = self.me.lint("--ratchet")
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.me.baseline(), {"web/hub-ui.css": 1})
        self.me.write("web/hub-ui.css", ".n1 { color: #111; }\n.n2 { color: #222; }\n", append=True)
        rc, out = self.me.lint("--ratchet")
        self.assertIn("不上调", out)
        self.assertEqual(self.me.baseline(), {"web/hub-ui.css": 1}, "ratchet 永不上调")
        rc, out = self.me.lint()
        self.assertEqual(rc, 1, out)

    def test_14_init_refuses_overwrite_and_missing_baseline_errors(self):
        rc, out = self.me.lint("--init")
        self.assertEqual(rc, 2, out)
        self.assertIn("拒绝覆盖", out)
        os.remove(os.path.join(self.me.path, "scripts", "lint-baseline.json"))
        rc, out = self.me.lint()
        self.assertEqual(rc, 2, out)
        self.assertIn("--init", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
