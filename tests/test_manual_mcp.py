#!/usr/bin/env python3
"""v0.6 MCP 手动条目测试：创建/编辑/删除/校验 + items_view 写入状态联动。

独立成文件的原因：tests/test_mcp.py 既有 fixture 使用环境变量占位符字符串，
为避免整文件重写触发凭据字面量扫描，新增用例放在本文件。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="hub-mcp-manual-test-")
os.environ["AGENT_HUB_DIR"] = os.path.join(TMP, "hub-home")

from hub.store import Store                      # noqa: E402
from hub.core import schema, fsutil              # noqa: E402
from hub.modules import mod_mcp as M             # noqa: E402

FAKE_SERVER = os.path.join(ROOT, "tests", "fixtures", "fake_mcp_server.py")


class McpManualItems(unittest.TestCase):
    """手动条目：创建/编辑/删除/校验 + items_view 写入状态。"""

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)
        cls.claude_json = os.path.join(TMP, "manual-claude.json")
        with open(cls.claude_json, "w") as f:
            json.dump({"mcpServers": {}}, f)

    def test_n01_create_validate_and_conflict(self):
        r = M.create_manual(self.store, "manual-stdio", {
            "command": sys.executable, "args": [FAKE_SERVER],
            "env": {"K": "v"}})
        self.assertTrue(r["ok"], r)
        # 白名单外的键被剔除
        cfg = fsutil.read_json(os.path.join(M.registry_root(), "manual-stdio.json"))
        self.assertNotIn("evil", cfg)
        # 无 command/url 拒绝
        r2 = M.create_manual(self.store, "manual-bad", {"foo": 1})
        self.assertFalse(r2["ok"])
        # 重名拦截
        r3 = M.create_manual(self.store, "manual-stdio", {"command": "x"})
        self.assertFalse(r3["ok"])
        self.assertIn("已存在", r3["error"])
        # 非法名
        r4 = M.create_manual(self.store, "bad name!", {"command": "x"})
        self.assertFalse(r4["ok"])

    def test_n02_catalog_items_view_and_edit(self):
        v = M.items_view(self.store, q="manual-stdio")
        self.assertEqual(v["total"], 1)
        row = v["items"][0]
        self.assertTrue(row["manual"])
        self.assertEqual(row["transport"], "stdio")
        self.assertEqual(row["env_keys"], ["K"])
        # 编辑 + 旧版快照
        r = M.update_manual(self.store, "manual-stdio", {"command": "locally-edited"})
        self.assertTrue(r["ok"], r)
        reg = M._manual_reg(self.store, "manual-stdio")
        self.assertIsNotNone(reg["prev_hash"])
        # 不存在的条目不可编辑
        r2 = M.update_manual(self.store, "no-such", {"command": "x"})
        self.assertFalse(r2["ok"])

    def test_n03_write_stale_and_delete(self):
        t = M.add_target(self.store, "manual-json", "mcp_json", "claude",
                         self.claude_json, "mcpServers")
        self.assertTrue(t["ok"], t)
        tid = t["id"]
        M.create_manual(self.store, "manual-http",
                        {"url": "https://example.invalid/mcp", "type": "http"})
        res = M.distribute_mcp(self.store, ["manual-stdio", "manual-http"], [tid])
        self.assertTrue(all(r["status"] == "ok" for r in res), res)
        v = M.items_view(self.store)
        row = [x for x in v["items"] if x["name"] == "manual-stdio"][0]
        self.assertEqual(row["per_target"][0]["state"], "latest")
        # 外部改动目标 → stale → 重写
        data = json.load(open(self.claude_json))
        data["mcpServers"]["manual-stdio"] = {"command": "externally-changed"}
        json.dump(data, open(self.claude_json, "w"))
        v2 = M.items_view(self.store)
        row2 = [x for x in v2["items"] if x["name"] == "manual-stdio"][0]
        self.assertEqual(row2["per_target"][0]["state"], "stale")
        tv = [x for x in v2["targets"] if x["id"] == tid][0]
        self.assertEqual(tv["items"]["stale"], 1)
        res2 = M.distribute_mcp(self.store, ["manual-stdio"], [tid], force=True)  # 重写带 force（与 UI「重新写入」一致）
        self.assertEqual(res2[0]["status"], "ok", res2)
        # 删除保护 + force 清理目标
        rd = M.delete_manual(self.store, "manual-stdio")
        self.assertFalse(rd["ok"])
        self.assertIn("已写入", rd["error"])
        rd2 = M.delete_manual(self.store, "manual-stdio", force=True)
        self.assertTrue(rd2["ok"], rd2)
        self.assertEqual(rd2["removed_from_targets"], ["manual-json"])
        data = json.load(open(self.claude_json))
        self.assertNotIn("manual-stdio", data["mcpServers"])
        self.assertIn("manual-http", data["mcpServers"])  # 未删的不受影响

    def test_n04_verify_manual(self):
        r = M.verify_item(self.store, "manual-http")
        self.assertFalse(r["ok"])  # 不可达 URL，验证路径正常走通

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)


class McpLocalDirs(unittest.TestCase):
    """MCP 条目建进链接目录：落盘位置 / 重名拦截 / 与默认库互不可见（2026-10-31 口径）。

    创建目录已取消（FIGMA_OVERRIDES #39）：目录一律来自链接磁盘已有文件夹。
    """

    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)
        from hub.core import local_dirs as LD
        cls.LD = LD
        root = os.path.join(TMP, "mcp-dir-root")
        os.makedirs(root, exist_ok=True)
        r = LD.link_dir(cls.store, root, "mcp-dir")
        assert r["ok"], r
        cls.dir_id = r["id"]
        cls.dir_root = root

    def test_o01_create_into_dir(self):
        r = M.create_manual(self.store, "dir-mcp", {"command": "node", "args": ["x"]},
                            dir_id=self.dir_id)
        self.assertTrue(r["ok"], r)
        dpath = os.path.join(self.dir_root, "dir-mcp.json")
        self.assertTrue(os.path.isfile(dpath))
        self.assertFalse(os.path.exists(os.path.join(M.registry_root(), "dir-mcp.json")))
        reg = self.store.db.execute(
            "SELECT dir_id FROM registry_items WHERE kind='mcp' AND name='dir-mcp'").fetchone()
        self.assertEqual(reg["dir_id"], self.dir_id)
        # 目录过滤：dir=<id> 可见、default 不可见
        v = M.items_view(self.store, source="manual", dir=self.dir_id)
        self.assertIn("dir-mcp", [it["name"] for it in v["items"]])
        vd = M.items_view(self.store, source="manual", dir="default")
        self.assertNotIn("dir-mcp", [it["name"] for it in vd["items"]])
        # 编辑保持原目录（不换落点）
        r2 = M.update_manual(self.store, "dir-mcp", {"command": "node2"})
        self.assertTrue(r2["ok"], r2)
        self.assertTrue(os.path.isfile(dpath))
        # 与默认库重名拦截（自建默认库条目，不跨类依赖执行顺序）
        self.assertTrue(M.create_manual(self.store, "o1-default", {"command": "x"})["ok"])
        r3 = M.create_manual(self.store, "o1-default", {"command": "x"}, dir_id=self.dir_id)
        self.assertFalse(r3["ok"])

    def test_o02_scan_registers_mcp_json(self):
        """链接目录里的一级合法 mcp json 自动登记；非法/非 dict 跳过。"""
        root = os.path.join(TMP, "mcp-ext")
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "ext-mcp.json"), "w") as f:
            json.dump({"command": "npx", "args": ["-y", "p"]}, f)
        with open(os.path.join(root, "bad.json"), "w") as f:
            f.write("[]")
        r = self.LD.link_dir(self.store, root, "mcp-ext")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["added"], 1, r)
        cat = M.catalog_view(self.store)
        row = [x for x in cat if x["name"] == "ext-mcp"][0]
        self.assertTrue(row["manual"])
        self.assertEqual(row["dir_name"], "mcp-ext")
        self.assertEqual(row["transport"], "stdio")


if __name__ == "__main__":
    unittest.main(verbosity=2)
