"""契约1 · 分发语义规格（Rust 重写行为真源）。

契约原文（Plans/Rust化-全盘复盘与迁移方案.md §1.3）：
1. 分发四态：conflict / adopt / skipped / drift 判定、逐文件原子写、
   `.hub-backup` 备份、托管清单 {rel: sha256}；
   copy 与 link 两种表示互斥，切换时清除另一种表示。
2. 防穿越：distribute 的 name 直接参与 dest 拼接，非法名必须拒绝（2026-11-07 修复后钉住）。

断言强度：L2（响应 shape）+ L3（磁盘副作用：文件内容逐字节/软链接指向/备份）
+ L4（ops 台账 detail 字段）。错误响应钉结构不钉文案（_sandbox.assertErr）。
"""
import json
import os

from _sandbox import SpecSandbox, req


def skill_files(text="v1", extra=None):
    files = {"SKILL.md": "---\nname: x\nversion: 1.0\n---\n%s" % text,
             "helper.py": "VALUE = '%s'\n" % text}
    if extra:
        files.update(extra)
    return files


class DispatchSpec(SpecSandbox):
    """契约1 · 分发四态与表示互斥。夹具 = HTTP 创建的手动条目 + skills_dir 目标。"""

    def _mk_skill(self, name, files):
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": name, "files": files}, base=self.base)
        self.assertOk(s, d)
        return d

    def _mk_target(self, name):
        path = os.path.join(self.tmp, name)
        os.makedirs(path, exist_ok=True)
        s, d = req("POST", "/api/skills/targets",
                   {"name": name, "kind": "skills_dir", "path": path}, base=self.base)
        self.assertOk(s, d)
        return path, d["id"]

    def _distribute(self, names, tid, **kw):
        body = {"names": names, "target_ids": [tid]}
        body.update(kw)
        return req("POST", "/api/skills/distribute", body, base=self.base)

    def _one(self, s, d):
        self.assertEqual(s, 200, d)
        self.assertEqual(len(d["results"]), 1, d)
        return d["results"][0]

    def _dep_of(self, item, tid):
        s, d = req("GET", "/api/skills/items?source=manual", base=self.base)
        self.assertEqual(s, 200, d)
        it = [x for x in d["items"] if x["name"] == item][0]
        deps = [x for x in it.get("deployments", []) if x["target_id"] == tid]
        self.assertEqual(len(deps), 1, it)
        return deps[0]

    # ---------- adopt ----------

    def test_disp_c1_adopt_identical_preexisting(self):
        """首次分发且目标已有内容与新内容完全一致 → action=adopt（不覆盖不改写）。"""
        files = skill_files("adopt-body")
        self._mk_skill("adopt-a", files)
        tpath, tid = self._mk_target("tgt-adopt")
        # 目标预置完全一致内容（用户自己装过同样文件）
        for rel, text in files.items():
            full = os.path.join(tpath, "adopt-a", rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(text)
        r = self._one(*self._distribute(["adopt-a"], tid))
        self.assertEqual(r["status"], "ok", r)
        self.assertEqual(r["action"], "adopt", r)
        self.assertEqual(r["files_changed"], 0, r)   # 一致 → 零文件变更

    # ---------- 目录缺失 / recreate ----------

    def test_disp_c1_dest_missing_conflict_then_recreate(self):
        """已分发 → 手删目标条目目录 → 再分发 conflict；force → recreate 恢复全部文件。"""
        self._mk_skill("recreate-a", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-recreate")
        self._one(*self._distribute(["recreate-a"], tid))
        import shutil
        shutil.rmtree(os.path.join(tpath, "recreate-a"))
        r = self._one(*self._distribute(["recreate-a"], tid))
        self.assertEqual(r["status"], "conflict", r)   # 记录存在但目标没了：需 force
        r2 = self._one(*self._distribute(["recreate-a"], tid, force=True))
        self.assertEqual(r2["status"], "ok", r2)
        self.assertEqual(r2["action"], "recreate", r2)
        self.assertTrue(os.path.isfile(os.path.join(tpath, "recreate-a", "SKILL.md")))

    # ---------- 未托管软链接 ----------

    def test_disp_c1_unmanaged_symlink_conflict(self):
        """copy 分发遇目标处未托管软链接 → conflict；force 替换链接为托管副本。"""
        self._mk_skill("sym-a", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-sym")
        other = os.path.join(self.tmp, "sym-other")
        os.makedirs(other)
        os.symlink(other, os.path.join(tpath, "sym-a"))
        r = self._one(*self._distribute(["sym-a"], tid))
        self.assertEqual(r["status"], "conflict", r)
        r2 = self._one(*self._distribute(["sym-a"], tid, force=True))
        self.assertEqual(r2["status"], "ok", r2)
        self.assertFalse(os.path.islink(os.path.join(tpath, "sym-a")))
        self.assertTrue(os.path.isfile(os.path.join(tpath, "sym-a", "SKILL.md")))

    # ---------- reg_dir 缺失 / dest 是文件 ----------

    def test_disp_c1_reg_dir_missing_failed(self):
        """分发未登记条目 → failed（本地库不存在），不产生副作用。"""
        tpath, tid = self._mk_target("tgt-missing")
        r = self._one(*self._distribute(["no-such-skill"], tid))
        self.assertEqual(r["status"], "failed", r)
        self.assertFalse(os.path.exists(os.path.join(tpath, "no-such-skill")))

    def test_disp_c1_dest_is_file_failed(self):
        """目标处同名位置是普通文件（非目录）→ failed，不破坏该文件。"""
        self._mk_skill("filed-a", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-filed")
        blocker = os.path.join(tpath, "filed-a")
        with open(blocker, "w") as f:
            f.write("user-file")
        r = self._one(*self._distribute(["filed-a"], tid))
        self.assertEqual(r["status"], "failed", r)
        with open(blocker) as f:
            self.assertEqual(f.read(), "user-file")   # 用户文件原样保留

    # ---------- drift + 新版本叠加 ----------

    def test_disp_c1_drift_with_new_version_conflict(self):
        """分发后：本地升级到 v2 + 目标被手改 → 双重冲突 → conflict；force restore。"""
        files = skill_files("v1")
        self._mk_skill("drift-a", files)
        tpath, tid = self._mk_target("tgt-drift")
        self._one(*self._distribute(["drift-a"], tid))
        # 本地升级 v2
        s, d = req("PUT", "/api/skills/registry/item/drift-a",
                   {"files": skill_files("v2")}, base=self.base)
        self.assertOk(s, d)
        # 目标被手改（drift）
        with open(os.path.join(tpath, "drift-a", "SKILL.md"), "a") as f:
            f.write("manual-edit")
        r = self._one(*self._distribute(["drift-a"], tid))
        self.assertEqual(r["status"], "conflict", r)
        r2 = self._one(*self._distribute(["drift-a"], tid, force=True))
        self.assertEqual(r2["status"], "ok", r2)
        with open(os.path.join(tpath, "drift-a", "SKILL.md")) as f:
            self.assertIn("v2", f.read())            # restore 到本地库 v2
        with open(os.path.join(tpath, "drift-a", "helper.py")) as f:
            self.assertIn("v2", f.read())

    # ---------- link 模式（5 分支） ----------

    def test_disp_c2_link_first_and_follows(self):
        """首次 link 分发 → 软链接指向本地库条目；本地改内容，工具端免分发跟随。"""
        self._mk_skill("link-a", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-link")
        r = self._one(*self._distribute(["link-a"], tid, mode="link"))
        self.assertEqual(r["status"], "ok", r)
        dest = os.path.join(tpath, "link-a")
        self.assertTrue(os.path.islink(dest), r)
        self.assertTrue(os.path.isfile(os.path.join(dest, "SKILL.md")))
        # 本地库改内容 → 软链接免分发跟随
        req("PUT", "/api/skills/registry/item/link-a",
            {"files": skill_files("v2")}, base=self.base)
        with open(os.path.join(dest, "helper.py")) as f:
            self.assertIn("v2", f.read())

    def test_disp_c2_link_twice_skipped(self):
        """已是本托管软链接 → 再 link 分发 skipped（幂等）。"""
        self._mk_skill("link-b", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-link-b")
        self._one(*self._distribute(["link-b"], tid, mode="link"))
        r = self._one(*self._distribute(["link-b"], tid, mode="link"))
        self.assertEqual(r["status"], "skipped", r)

    def test_disp_c2_link_elsewhere_conflict(self):
        """目标软链接指向别处（未托管）→ link 分发 conflict；force 接管。"""
        self._mk_skill("link-c", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-link-c")
        other = os.path.join(self.tmp, "link-other")
        os.makedirs(other)
        os.symlink(other, os.path.join(tpath, "link-c"))
        r = self._one(*self._distribute(["link-c"], tid, mode="link"))
        self.assertEqual(r["status"], "conflict", r)
        r2 = self._one(*self._distribute(["link-c"], tid, mode="link", force=True))
        self.assertEqual(r2["status"], "ok", r2)
        self.assertTrue(os.path.islink(os.path.join(tpath, "link-c")))

    def test_disp_c2_copy_then_link_switch(self):
        """copy → link 互斥切换：旧托管副本整体备份进 .hub-backup，dest 变软链接。"""
        self._mk_skill("sw-a", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-sw")
        self._one(*self._distribute(["sw-a"], tid))                 # copy
        r = self._one(*self._distribute(["sw-a"], tid, mode="link"))
        self.assertEqual(r["status"], "ok", r)
        dest = os.path.join(tpath, "sw-a")
        self.assertTrue(os.path.islink(dest))
        backups = os.path.join(tpath, ".hub-backup")
        self.assertTrue(os.path.isdir(backups))
        backed = [d for d in os.listdir(backups) if d.startswith("sw-a.")]
        self.assertTrue(backed, os.listdir(backups))                # 旧副本备份在案
        self.assertTrue(os.path.isfile(
            os.path.join(backups, backed[0], "SKILL.md")))          # <name>.<ts>/ 平铺
        with open(os.path.join(backups, backed[0], "SKILL.md")) as f:
            self.assertIn("v1", f.read())

    def test_disp_c2_link_then_copy_switch(self):
        """link → copy 互斥切换：dest 变回实体目录且内容等值。"""
        self._mk_skill("sw-b", skill_files("v1"))
        tpath, tid = self._mk_target("tgt-sw-b")
        self._one(*self._distribute(["sw-b"], tid, mode="link"))
        r = self._one(*self._distribute(["sw-b"], tid, mode="copy"))
        self.assertEqual(r["status"], "ok", r)
        dest = os.path.join(tpath, "sw-b")
        self.assertFalse(os.path.islink(dest))
        with open(os.path.join(dest, "SKILL.md")) as f:
            self.assertIn("v1", f.read())

    # ---------- 内容等值 + 托管清单 ----------

    def test_disp_c3_content_equality_and_managed_list(self):
        """多文件条目分发：目标逐文件内容字节等值（含嵌套目录）；
        部署行 hash 与本地库 hash 一致（items_view.deployments）。"""
        extra = {"nested/deep.txt": "深层内容\n", "notes.md": "中文注释"}
        files = skill_files("eq", extra=extra)
        self._mk_skill("eq-a", files)
        tpath, tid = self._mk_target("tgt-eq")
        r = self._one(*self._distribute(["eq-a"], tid))
        self.assertEqual(r["status"], "ok", r)
        for rel, text in files.items():
            p = os.path.join(tpath, "eq-a", rel)
            self.assertTrue(os.path.isfile(p), rel)
            with open(p, encoding="utf-8") as f:
                self.assertEqual(f.read(), text, rel)   # 字节等值
        # 部署行：deployed_hash 与本地库 hash 一致
        s, d = req("GET", "/api/skills/registry", base=self.base)
        reg = [x for x in d["items"] if x["name"] == "eq-a"][0]
        dep = self._dep_of("eq-a", tid)
        # registry 视图给 12 位截断 hash；部署行存完整 64 位 → 前缀一致即同内容
        self.assertTrue(dep["hash"].startswith(reg["hash"]),
                        (reg["hash"], dep["hash"]))
        # 空目录结构也被复制（nested 目录存在）
        self.assertTrue(os.path.isdir(os.path.join(tpath, "eq-a", "nested")))

    # ---------- 防穿越（2026-11-07 修复后钉住） ----------

    def test_disp_c4_traversal_name_rejected(self):
        """反例：name=../evil 直接拒绝（非法条目名），目标目录外无任何写入。"""
        tpath, tid = self._mk_target("tgt-trav")
        r = self._one(*self._distribute(["../evil"], tid))
        self.assertEqual(r["status"], "failed", r)
        self.assertFalse(os.path.exists(os.path.join(tpath, "..", "evil")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil")))

    def test_disp_c4_traversal_name_mcp_rejected(self):
        """反例（mcp）：name=../evil 拒绝，不写目标配置目录之外。"""
        cfg = os.path.join(self.tmp, "mcp.json")
        with open(cfg, "w") as f:
            f.write("{}")
        s, d = req("POST", "/api/mcp/targets",
                   {"name": "trav-m", "kind": "mcp_json", "path": cfg,
                    "format_key": "mcpServers"}, base=self.base)
        self.assertOk(s, d)
        tid = d["id"]
        s, d = req("POST", "/api/mcp/distribute",
                   {"names": ["../evil"], "target_ids": [tid]}, base=self.base)
        self.assertEqual(s, 200, d)
        self.assertEqual(d["results"][0]["status"], "failed", d)
        self.assertEqual(d["results"][0]["reason"], "非法条目名", d)
        self.assertEqual(json.load(open(cfg)), {})   # 配置未被写坏

    # ---------- 台账（L4） ----------

    def test_disp_c4_ops_detail_contract(self):
        """L4：分发台账 detail 契约字段 {files: {rel: sha}, removed, mode}；
        冲突记录 reason 在案。"""
        files = skill_files("v1")
        self._mk_skill("ops-a", files)
        tpath, tid = self._mk_target("tgt-ops")
        self._one(*self._distribute(["ops-a"], tid))
        s, d = req("GET", "/api/ops?module=skills&q=ops-a", base=self.base)
        self.assertEqual(s, 200, d)
        rows = [r for r in d["items"]
                if r["action"] == "distribute" and r["item_name"] == "ops-a"]
        self.assertTrue(rows, d)
        det = json.loads(rows[0]["detail"]) if isinstance(rows[0]["detail"], str) \
            else rows[0]["detail"]
        self.assertEqual(det.get("actor"), "local", det)          # 包裹结构
        extra = det["extra"]
        self.assertEqual(extra["mode"], "copy", extra)
        self.assertEqual(extra["files"], 2, extra)                # 文件计数
        self.assertEqual(extra["removed"], [], extra)
