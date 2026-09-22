#!/usr/bin/env python3
"""MCP 模块集成测试：JSON/TOML 目标适配器 + 冲突/回退/幂等 + 握手验证。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="hub-mcp-test-")
os.environ["AGENT_HUB_DIR"] = os.path.join(TMP, "hub-home")

from hub.store import Store                      # noqa: E402
from hub.core import schema, fsutil              # noqa: E402
from hub.modules import mod_mcp as M             # noqa: E402


def git(*args, cwd=None):
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, capture_output=True)


class McpFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)
        # fixture source repo
        src = os.path.join(TMP, "mcp-src")
        os.makedirs(src)
        git("init", "-q", "-b", "main", src)
        os.makedirs(os.path.join(src, "mcp"))
        with open(os.path.join(src, "mcp", "mcp.json"), "w") as f:
            json.dump({"mcpServers": {
                "fake-echo": {"command": sys.executable,
                              "args": [os.path.join(ROOT, "tests/fixtures/fake_mcp_server.py")],
                              "env": {"FAKE_TOKEN": "${FAKE_TOKEN}"}},
                "remote-api": {"url": "https://example.invalid/mcp", "type": "http"},
            }}, f)
        git("add", ".", cwd=src)
        subprocess.run(["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "v1"], check=True)
        cls.src = src
        # fixture targets
        cls.claude_json = os.path.join(TMP, "fake-claude.json")
        with open(cls.claude_json, "w") as f:
            json.dump({"mcpServers": {"preexisting": {"command": "x"}}, "otherState": 1}, f)
        cls.codex_toml = os.path.join(TMP, "fake-codex.toml")
        with open(cls.codex_toml, "w") as f:
            f.write('model = "gpt-5"\n')

    def test_01_source_pull(self):
        r = M.add_source(self.store, "mcpfix", self.src, "main")
        self.assertTrue(r["ok"], r)
        self.__class__.sid = r["id"]
        p = M.pull_source(self.store, self.sid)
        self.assertTrue(p["ok"], p)
        self.assertEqual(sorted(p["added"]), ["fake-echo", "remote-api"])

    def test_02_update_registry(self):
        res = M.update_registry(self.store, ["fake-echo", "remote-api"], self.sid)
        self.assertEqual([r["status"] for r in res], ["installed", "installed"], res)
        cfg = fsutil.read_json(os.path.join(M.registry_root(), "fake-echo.json"))
        self.assertEqual(cfg["env"]["FAKE_TOKEN"], "${FAKE_TOKEN}")   # 占位符原样保存

    def test_03_targets_and_json_distribute(self):
        t = M.add_target(self.store, "fake-claude", "mcp_json", "claude", self.claude_json, "mcpServers")
        self.assertTrue(t["ok"], t)
        self.__class__.tj = t["id"]
        res = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res[0]["status"], "ok", res)
        data = json.load(open(self.claude_json))
        self.assertEqual(data["mcpServers"]["fake-echo"]["command"], sys.executable)
        self.assertEqual(data["mcpServers"]["preexisting"]["command"], "x")   # 原有条目保留
        self.assertEqual(data["otherState"], 1)                              # 其他字段保留

    def test_04_json_idempotent(self):
        res = M.distribute_mcp(self.store, ["fake-echo"], [self.tj])
        self.assertEqual(res[0]["status"], "skipped", res)

    def test_05_json_conflict_unmanaged(self):
        # 目标里塞一个同名非托管条目
        data = json.load(open(self.claude_json))
        data["mcpServers"]["remote-api"] = {"command": "user-own"}
        json.dump(data, open(self.claude_json, "w"))
        res = M.distribute_mcp(self.store, ["remote-api"], [self.tj])
        self.assertEqual(res[0]["status"], "conflict", res)
        # force 覆盖 + 备份存在
        res2 = M.distribute_mcp(self.store, ["remote-api"], [self.tj], force=True)
        self.assertEqual(res2[0]["status"], "ok", res2)
        backups = [f for _r, _d, fs in os.walk(os.path.join(TMP, ".hub-backup")) for f in fs] \
            if os.path.isdir(os.path.join(TMP, ".hub-backup")) else []
        # backup path recorded in deployment detail
        dep = M._deployment(self.store, "remote-api", self.tj)
        self.assertTrue(dep and json.loads(dep["detail"]).get("backup"))

    def test_06_toml_distribute(self):
        t = M.add_target(self.store, "fake-codex", "mcp_toml", "codex", self.codex_toml)
        self.assertTrue(t["ok"], t)
        self.__class__.tt = t["id"]
        res = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res[0]["status"], "ok", res)
        text = open(self.codex_toml).read()
        self.assertIn('model = "gpt-5"', text)                    # 原有内容保留
        self.assertIn("[mcp_servers.fake-echo]", text)
        self.assertIn("# >>> hub:managed: fake-echo >>>", text)
        self.assertIn('command = %s' % json.dumps(sys.executable), text)
        # 幂等
        res2 = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res2[0]["status"], "skipped", res2)

    def test_07_toml_native_table_conflict(self):
        # 手工写入原生表（非托管）→ 冲突
        with open(self.codex_toml, "a") as f:
            f.write('\n[mcp_servers.remote-api]\nurl = "https://user.example/mcp"\n')
        M.update_registry(self.store, ["remote-api"], self.sid)
        res = M.distribute_mcp(self.store, ["remote-api"], [self.tt])
        self.assertEqual(res[0]["status"], "conflict", res)
        # force 覆盖：托管块替换，原生表仍在（我们不删用户内容）→ 需要人工处理提示
        res2 = M.distribute_mcp(self.store, ["remote-api"], [self.tt], force=True)
        self.assertEqual(res2[0]["status"], "ok", res2)
        text = open(self.codex_toml).read()
        self.assertIn("# >>> hub:managed: remote-api >>>", text)

    def test_08_verify_handshake(self):
        r = M.verify_item(self.store, "fake-echo")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["tool_count"], 3)
        self.assertEqual(r["server_name"], "fake-mcp")
        # 失败路径：不可达 URL
        r2 = M.verify_item(self.store, "remote-api")
        self.assertFalse(r2["ok"])
        self.assertTrue(r2.get("error"))

    def test_09_rollback(self):
        # 本地改动 fake-echo.json 后 force 更新会先留快照; 这里直接测回退路径
        p = os.path.join(M.registry_root(), "fake-echo.json")
        with open(p, "w") as f:
            json.dump({"command": "locally-modified"}, f)
        res = M.update_registry(self.store, ["fake-echo"], self.sid, force=True)
        self.assertEqual(res[0]["status"], "updated")
        r = M.rollback_registry(self.store, "fake-echo")
        self.assertTrue(r["ok"], r)
        content = open(p).read()
        self.assertIn("locally-modified", content)   # 回退到被覆盖前的本地版本

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
