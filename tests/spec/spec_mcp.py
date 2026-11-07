"""契约4 · MCP 注入规格（Rust 重写行为真源）。

契约原文：JSON 嵌套 key（mcp.servers，ZCode 真实路径）+ TOML `# >>> hub:managed: <name> >>>`
托管块、手改检测（不带 force → conflict）、摘除时 injected 不匹配不碰、
delete 守卫（已写入目标须确认）、非法目标 JSON → failed。

断言强度：L2 + L3（配置文件逐字节结构 + 备份）。
"""
import json
import os

from _sandbox import SpecSandbox, req


def mk_mcp_item(t, name, command=None):
    s, d = req("POST", "/api/mcp/registry/item",
               {"name": name, "config": {"command": command or ("cmd-%s" % name), "args": []}},
               base=t.base)
    t.assertOk(s, d)


class McpInjectSpec(SpecSandbox):
    """契约4 · 注入/手改/摘除。每个用例独立目标配置文件。"""

    def _mk_json_target(self, name, format_key="mcpServers", initial=None):
        cfg = os.path.join(self.tmp, "%s.json" % name)
        with open(cfg, "w") as f:
            json.dump(initial if initial is not None else {}, f)
        s, d = req("POST", "/api/mcp/targets",
                   {"name": name, "kind": "mcp_json", "path": cfg,
                    "format_key": format_key}, base=self.base)
        self.assertOk(s, d)
        return cfg, d["id"]

    def _mk_toml_target(self, name, initial=""):
        cfg = os.path.join(self.tmp, "%s.toml" % name)
        with open(cfg, "w") as f:
            f.write(initial)
        s, d = req("POST", "/api/mcp/targets",
                   {"name": name, "kind": "mcp_toml", "path": cfg}, base=self.base)
        self.assertOk(s, d)
        return cfg, d["id"]

    def _dist(self, names, tid, force=None):
        body = {"names": names, "target_ids": [tid]}
        if force is not None:
            body["force"] = force
        s, d = req("POST", "/api/mcp/distribute", body, base=self.base)
        self.assertEqual(s, 200, d)
        return d["results"][0]

    def _delete(self, name, force=None):
        body = {"force": True} if force else {}
        return req("DELETE", "/api/mcp/registry/item/%s" % name, body, base=self.base)

    # ---------- 嵌套 key（ZCode 真实路径，此前零覆盖） ----------

    def test_mcp_c4_nested_key_inject_and_remove(self):
        """format_key=mcp.servers：注入写入嵌套 section；摘除同步移除。"""
        _cfg, tid = self._mk_json_target(
            "nest", format_key="mcp.servers",
            initial={"mcp": {"servers": {}, "other": {"keep": 1}}})
        mk_mcp_item(self, "nest-a")
        r = self._dist(["nest-a"], tid)
        self.assertEqual(r["status"], "ok", r)
        data = json.load(open(_cfg))
        self.assertEqual(data["mcp"]["servers"]["nest-a"]["command"], "cmd-nest-a", data)
        self.assertEqual(data["mcp"]["other"], {"keep": 1}, data)   # 邻居 section 不动
        # 摘除：嵌套键同步移除，邻居保留
        s, d = self._delete("nest-a", force=True)   # 已写入目标：delete 须 force（守卫另有专测）
        self.assertOk(s, d)
        data = json.load(open(_cfg))
        self.assertNotIn("nest-a", data["mcp"]["servers"], data)
        self.assertEqual(data["mcp"]["other"], {"keep": 1}, data)

    def test_mcp_c4_section_put_overwrites_nondict_layer(self):
        """反例钉现状：目标层是非 dict（数组）→ _section_put 静默替换为对象。
        （破坏性写入无 conflict——Rust 重写需显式决策是否保留该行为）"""
        _cfg, tid = self._mk_json_target(
            "nd", format_key="mcp.servers", initial={"mcp": {"servers": ["a", "b"]}})
        mk_mcp_item(self, "nd-a")
        r = self._dist(["nd-a"], tid)
        self.assertEqual(r["status"], "ok", r)   # 钉现状：不冲突、直接替换
        data = json.load(open(_cfg))
        self.assertEqual(data["mcp"]["servers"]["nd-a"]["command"], "cmd-nd-a", data)

    # ---------- 手改检测 ----------

    def test_mcp_c4_json_manual_edit_conflict(self):
        """托管注入后被外部手改、不带 force → conflict；force 才覆盖。"""
        cfg, tid = self._mk_json_target("edit-j")
        mk_mcp_item(self, "edit-a")
        self.assertEqual(self._dist(["edit-a"], tid)["status"], "ok")
        data = json.load(open(cfg))
        data["mcpServers"]["edit-a"]["command"] = "user-tampered"
        json.dump(data, open(cfg, "w"))
        r = self._dist(["edit-a"], tid)
        self.assertEqual(r["status"], "conflict", r)
        r2 = self._dist(["edit-a"], tid, force=True)
        self.assertEqual(r2["status"], "ok", r2)
        self.assertEqual(json.load(open(cfg))["mcpServers"]["edit-a"]["command"],
                         "cmd-edit-a")

    def test_mcp_c4_toml_manual_edit_conflict(self):
        """TOML 托管块被手改、不带 force → conflict；force 重写。"""
        cfg, tid = self._mk_toml_target("edit-t", initial='[other]\nkey = 1\n')
        mk_mcp_item(self, "edit-b")
        self.assertEqual(self._dist(["edit-b"], tid)["status"], "ok")
        text = open(cfg).read()
        text = text.replace("cmd-edit-b", "tampered-cmd")
        with open(cfg, "w") as f:
            f.write(text)
        r = self._dist(["edit-b"], tid)
        self.assertEqual(r["status"], "conflict", r)
        r2 = self._dist(["edit-b"], tid, force=True)
        self.assertEqual(r2["status"], "ok", r2)
        self.assertIn("cmd-edit-b", open(cfg).read())
        self.assertIn("[other]", open(cfg).read())     # 原生表保留

    # ---------- TOML 块被手删 / 末尾换行 ----------

    def test_mcp_c4_toml_block_deleted_recreate(self):
        """托管块被手删（dep 在案）→ 再分发重建块。"""
        cfg, tid = self._mk_toml_target("del-t")
        mk_mcp_item(self, "del-a")
        self.assertEqual(self._dist(["del-a"], tid)["status"], "ok")
        text = open(cfg).read()
        import re
        m = re.search(r"# >>> hub:managed: del-a >>>", text)   # 真实托管块标记
        self.assertIsNotNone(m, text)
        start = m.start()
        with open(cfg, "w") as f:
            f.write(text[:start])                       # 手删托管块
        r = self._dist(["del-a"], tid)
        self.assertEqual(r["status"], "ok", r)          # 重建
        self.assertIn("cmd-del-a", open(cfg).read())

    def test_mcp_c4_toml_trailing_newline(self):
        """注入后文件末尾必须有换行（POSIX 文本文件契约）。"""
        cfg, tid = self._mk_toml_target("nl-t")
        mk_mcp_item(self, "nl-a")
        self.assertEqual(self._dist(["nl-a"], tid)["status"], "ok")
        self.assertTrue(open(cfg).read().endswith("\n"))

    # ---------- 非法目标 ----------

    def test_mcp_c4_invalid_target_json_failed(self):
        """目标文件不是合法 JSON → failed（不产生部分写入）。"""
        cfg = os.path.join(self.tmp, "broken.json")
        with open(cfg, "w") as f:
            f.write("{not-json")
        s, d = req("POST", "/api/mcp/targets",
                   {"name": "broken", "kind": "mcp_json", "path": cfg,
                    "format_key": "mcpServers"}, base=self.base)
        self.assertOk(s, d)
        mk_mcp_item(self, "brk-a")
        r = self._dist(["brk-a"], d["id"])
        self.assertEqual(r["status"], "failed", r)
        self.assertEqual(open(cfg).read(), "{not-json")   # 原样保留

    # ---------- delete 守卫 / -deleted 转存 ----------

    def test_mcp_c4_delete_guard_and_versions_move(self):
        """delete 守卫：已写入目标 → 不带 force 拒绝；force 后注入摘除 +
        registry 文件转存 .versions/<name>/…-deleted。"""
        cfg, tid = self._mk_json_target("del-g")
        mk_mcp_item(self, "del-g-a")
        self.assertEqual(self._dist(["del-g-a"], tid)["status"], "ok")
        s, d = self._delete("del-g-a")                    # 不带 force
        self.assertErr(s, d, 400, keyword="目标配置")
        self.assertTrue(json.load(open(cfg)).get("mcpServers", {}).get("del-g-a"))
        s, d = self._delete("del-g-a", force=True)
        self.assertOk(s, d)
        self.assertNotIn("del-g-a", json.load(open(cfg)).get("mcpServers", {}))
        vroot = os.path.join(self.tmp, "hub", "registry", ".versions", "mcp", "del-g-a")
        self.assertTrue(os.path.isdir(vroot), vroot)
        self.assertTrue(any(n.endswith("-deleted") for n in os.listdir(vroot)), vroot)

    def test_mcp_c4_delete_injected_mismatch_kept(self):
        """反例：注入内容被外部整个替换 → delete force 也不碰目标（injected 不匹配）。"""
        cfg, tid = self._mk_json_target("mis-m")
        mk_mcp_item(self, "mis-a")
        self.assertEqual(self._dist(["mis-a"], tid)["status"], "ok")
        data = json.load(open(cfg))
        data["mcpServers"]["mis-a"] = {"command": "completely-different"}
        json.dump(data, open(cfg, "w"))
        s, d = self._delete("mis-a", force=True)
        self.assertOk(s, d)
        self.assertEqual(json.load(open(cfg))["mcpServers"]["mis-a"]["command"],
                         "completely-different")          # 不碰用户手改内容
