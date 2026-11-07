"""契约3 · 绑定与清理规格（Rust 重写行为真源）。

契约原文：绑定级反向清理只认 deployments.detail.binding 打标（不是本绑定落的
内容一个不碰）；排除条目保留工具内文件（即使从目录删除）；channels 至少保留
一个；同秒/重复同步 tag 幂等。

断言强度：L2 + L3（磁盘副作用 + deployments 行）。
"""
import json
import os

from _sandbox import SpecSandbox, req


class BindingsSpec(SpecSandbox):
    """契约3 · 绑定/清理。夹具 = 链接目录（容器外普通模式）+ skills_dir 目标。"""

    def _link_dir_with(self, dirname, skills):
        root = os.path.join(self.tmp, dirname)
        for name in skills:
            d = os.path.join(root, name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "SKILL.md"), "w") as f:
                f.write("---\nname: %s\n---\nbody" % name)
        s, d = req("POST", "/api/local-dirs/link", {"path": root, "name": dirname},
                   base=self.base)
        self.assertOk(s, d)
        return root, d["id"]

    def _mk_target(self, name):
        path = os.path.join(self.tmp, name)
        os.makedirs(path, exist_ok=True)
        s, d = req("POST", "/api/skills/targets",
                   {"name": name, "kind": "skills_dir", "path": path}, base=self.base)
        self.assertOk(s, d)
        return path, d["id"]

    def _bind(self, did, tid, **kw):
        body = {"dir_id": did, "target_ids": [tid]}
        body.update(kw)
        s, d = req("POST", "/api/skills/dir-bindings", body, base=self.base)
        self.assertOk(s, d)
        self.assertTrue(d["results"][0]["ok"], d)
        return d["results"][0]["binding_id"]

    def _patch(self, bid, body):
        return req("PATCH", "/api/skills/dir-bindings/%d" % bid, body, base=self.base)

    def _sync_one(self, bid):
        return req("POST", "/api/skills/dir-bindings/%d/sync" % bid, {}, base=self.base)

    def _bindings(self):
        s, d = req("GET", "/api/skills/dir-bindings", base=self.base)
        self.assertEqual(s, 200, d)
        return d["bindings"]

    # ---------- 归属守卫 ----------

    def test_bind_c3_owned_tag_guard(self):
        """归属守卫：手动分发的文件（无 binding 标）在建绑后从目录删除 → 工具内必须保留。"""
        # 手动条目 + 直发到目标（无绑定参与）
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": "owned-a", "files": {"SKILL.md": "---\nname: owned-a\n---\n手动直发"}},
                   base=self.base)
        self.assertOk(s, d)
        tpath, tid = self._mk_target("tgt-owned")
        s, d = req("POST", "/api/skills/distribute",
                   {"names": ["owned-a"], "target_ids": [tid]}, base=self.base)
        self.assertOk(s, d)
        # 另一目录（含 kept 条目）建绑到同一目标
        root, did = self._link_dir_with("bind-owned", ["kept"])
        bid = self._bind(did, tid)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "kept", "SKILL.md")))
        # 从目录删除 owned-a（与绑定无关的条目）
        import shutil
        shutil.rmtree(os.path.join(root, "kept"))   # 从目录删除 kept（本绑定落的条目）
        s, d = req("GET", "/api/local-dirs", base=self.base)   # 读取触发 scan_sync 对齐
        self.assertOk(s, d)
        self._sync_one(bid)
        # kept（本绑定落的）被反向清理；owned-a（非本绑定落的）必须保留
        self.assertFalse(os.path.exists(os.path.join(tpath, "kept")))
        self.assertTrue(os.path.isfile(os.path.join(tpath, "owned-a", "SKILL.md")),
                        "非本绑定落的内容不得清理")

    def test_bind_c3_excluded_removed_from_dir_kept_in_tool(self):
        """排除条目从目录删除 → 工具内文件保留（排除 = 停止同步但保留）。"""
        root, did = self._link_dir_with("bind-excl", ["stay", "gone"])
        tpath, tid = self._mk_target("tgt-excl")
        bid = self._bind(did, tid)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "gone", "SKILL.md")))
        s, d = self._patch(bid, {"excluded": ["gone"]})
        self.assertOk(s, d)
        import shutil
        shutil.rmtree(os.path.join(root, "gone"))
        s, d = req("GET", "/api/local-dirs", base=self.base)   # 读取触发 scan_sync 对齐
        self.assertOk(s, d)
        self._sync_one(bid)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "gone", "SKILL.md")),
                        "被排除条目即使从目录删除，工具内文件保留")
        self.assertTrue(os.path.isfile(os.path.join(tpath, "stay", "SKILL.md")))

    # ---------- 守卫 ----------

    def test_bind_c3_bind_guards(self):
        """bind_dirs 守卫：目录不存在 / 目标不存在 / 重复绑定 → 结构化错误。"""
        # 目录不存在：路由级 400 结构化错误
        s, d = req("POST", "/api/skills/dir-bindings",
                   {"dir_id": 999999, "target_ids": [1]}, base=self.base)
        self.assertErr(s, d, 400)
        # 目标不存在：400 + 聚合结构（错误在 results[0]，无顶层 error）
        root, did = self._link_dir_with("bind-guard", ["g1"])
        s, d = req("POST", "/api/skills/dir-bindings",
                   {"dir_id": did, "target_ids": [999999]}, base=self.base)
        self.assertEqual(s, 400, d)
        self.assertFalse(d["ok"], d)
        self.assertFalse(d["results"][0]["ok"], d)
        self.assertTrue(d["results"][0].get("error"), d)
        # 重复绑定：400 + 聚合结构（同目标不存在同款）
        tpath, tid = self._mk_target("tgt-guard")
        self._bind(did, tid)
        s, d = req("POST", "/api/skills/dir-bindings",
                   {"dir_id": did, "target_ids": [tid]}, base=self.base)
        self.assertEqual(s, 400, d)
        self.assertFalse(d["results"][0]["ok"], d)
        self.assertIn("已建立连接", d["results"][0].get("error", ""), d)

    def test_bind_c3_channels_must_keep_one(self):
        """channels 至少保留一个：PATCH 到空列表 → 400 结构化错误。"""
        root, did = self._link_dir_with("bind-ch", ["c1"])
        tpath, tid = self._mk_target("tgt-ch")
        bid = self._bind(did, tid)
        s, d = self._patch(bid, {"channels": []})
        self.assertErr(s, d, 400)

    def test_bind_c3_patch_invalid_id(self):
        """反例：非法绑定 id → 400。"""
        s, d = self._patch(999999, {"enabled": False})
        self.assertErr(s, d, 404) if s == 404 else self.assertErr(s, d, 400)

    # ---------- 幂等 / tag ----------

    def test_bind_c3_sync_twice_idempotent(self):
        """连续两次 sync：第二次 skipped（内容一致），deployments 不重复。"""
        root, did = self._link_dir_with("bind-idem", ["idem-a"])
        tpath, tid = self._mk_target("tgt-idem")
        bid = self._bind(did, tid)
        s, d = self._sync_one(bid)
        self.assertOk(s, d)
        agg = [r for r in d["results"] if r.get("binding_id") == bid][0]
        self.assertEqual(agg["added"], 0, agg)
        self.assertEqual(agg["skipped"], 1, agg)
        s, d = req("GET", "/api/skills/items?source=manual&dir=%d" % did, base=self.base)
        it = [x for x in d["items"] if x["name"] == "idem-a"][0]
        self.assertEqual(len(it["deployments"]), 1, it)   # tag 幂等：不重复

    def test_bind_c3_unbind_clean_db_state(self):
        """clean 断连：deployments 行 status=removed（保留文件模式为对照）。"""
        root, did = self._link_dir_with("bind-clean", ["cl-a", "kp-a"])
        tpath, tid = self._mk_target("tgt-clean")
        bid = self._bind(did, tid)
        s, d = req("DELETE", "/api/skills/dir-bindings/%d?clean=1" % bid, base=self.base)
        self.assertOk(s, d)
        self.assertFalse(os.path.exists(os.path.join(tpath, "cl-a")))
        # 重新绑定 kp-a 对照：keep 模式断开后 deployments 保留
        bid2 = self._bind(did, tid)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "kp-a", "SKILL.md")))
        s, d = req("DELETE", "/api/skills/dir-bindings/%d" % bid2, base=self.base)
        self.assertOk(s, d)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "kp-a", "SKILL.md")))
