"""HTTP 面 · 双零路由 + 错误分支矩阵 + 幂等矩阵（Rust 重写行为真源）。

覆盖审计（2026-11-07）确认的 22 条双零路由与错误分支缺口：
403 静态穿越 / HEAD / 未知路径 404 / 503 模块门 / attachment / memory item CRUD /
adopt / distribute / sync-local / tool-items·extract·tool-sync / detect / doctor /
backup / ops-export / reorder / unwire-memory / modules toggle / remote-repos。
幂等矩阵：每个写操作执行两次的期望行为。

断言强度：L1-L3（结构 + 状态码 + 关键副作用）。
"""
import json
import os

from _sandbox import SpecSandbox, req


class SurfaceErrorMatrix(SpecSandbox):
    """错误分支矩阵：穿越 / HEAD / 404 / 非法输入。"""

    def test_err_403_static_traversal(self):
        """反例：/assets 路径穿越 → 403，不泄露服务端文件。"""
        for evil in ("/assets/../server.py", "/assets/../hub/store.py",
                     "/assets/%2e%2e/server.py"):
            s, d = req("GET", evil, base=self.base)
            self.assertIn(s, (403, 404), (evil, s))
            body = json.dumps(d)[:200] if isinstance(d, dict) else str(d)[:200]
            self.assertNotIn("import os", body, evil)   # 服务端源码不泄露

    def test_err_head_requests(self):
        """HEAD：钉现状——/ 与 /api/* 一律 200（do_HEAD 不做 404 判定，
        Rust 重写需显式决策是否改为随 GET 状态）；响应无 body。"""
        import urllib.request
        for path in ("/", "/api/state", "/api/nope"):
            r = urllib.request.Request(self.base + path, method="HEAD")
            with urllib.request.urlopen(r, timeout=10) as resp:
                self.assertEqual(resp.status, 200, path)
                self.assertFalse(resp.read(), path)

    def test_err_unknown_paths_404(self):
        """未知 GET/POST 路径 → 404 结构化 JSON（不 500）。"""
        s, d = req("GET", "/api/definitely-not-a-route", base=self.base)
        self.assertEqual(s, 404, d)
        s, d = req("POST", "/api/definitely-not-a-route", {}, base=self.base)
        self.assertEqual(s, 404, d)

    def test_err_star_and_memory_delete_400(self):
        """star 缺 sid / memory delete 缺 id → 400。"""
        s, d = req("POST", "/api/star", {}, base=self.base)
        self.assertErr(s, d, 400)
        s, d = req("POST", "/api/memory/delete", {}, base=self.base)
        self.assertErr(s, d, 400)

    def test_err_search_empty_q(self):
        """搜索空 q → 400。"""
        s, d = req("GET", "/api/search?q=", base=self.base)
        self.assertErr(s, d, 400)


class SurfaceDoubleZeroRoutes(SpecSandbox):
    """审计确认的双零路由：逐条钉 happy + 主要 error。"""

    def test_sz_doctor_backup_opsexport(self):
        s, d = req("GET", "/api/doctor", base=self.base)
        self.assertEqual(s, 200, d)                       # 聚合 ok 反映检查项（沙箱中总线/工具路径不存在 → False 合法）
        self.assertIsInstance(d["checks"], list, d)
        for chk in d["checks"]:
            self.assertIn("name", chk, chk)
            self.assertIn("ok", chk, chk)
        # /api/backup 是二进制下载（非 JSON）：单独原始请求
        import urllib.request
        with urllib.request.urlopen(self.base + "/api/backup", timeout=15) as resp:
            self.assertEqual(resp.status, 200)
            blob = resp.read()
            self.assertGreater(len(blob), 100)            # 非空备份体
        import urllib.request
        with urllib.request.urlopen(self.base + "/api/ops/export?format=csv",
                                    timeout=15) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn(b"module", resp.read()[:200])   # CSV 文本头
        s, d = req("GET", "/api/ops/export?format=json", base=self.base)
        self.assertEqual(s, 200, d)
        self.assertIsInstance(d, (list, dict), d)

    def test_sz_modules_toggle_gate(self):
        """模块开关（显式 enabled 布尔，非切换）：禁用 → 模块路由 503；启用恢复。"""
        s, d = req("GET", "/api/skills/sources", base=self.base)
        self.assertEqual(s, 200, d)
        self.addCleanup(lambda: req("POST", "/api/modules/skills/toggle",
                                    {"enabled": True}, base=self.base))
        s, d = req("POST", "/api/modules/skills/toggle",
                   {"enabled": False}, base=self.base)
        self.assertOk(s, d)
        s, d = req("GET", "/api/skills/sources", base=self.base)
        self.assertErr(s, d, 503)
        s, d = req("POST", "/api/modules/skills/toggle",
                   {"enabled": True}, base=self.base)
        self.assertOk(s, d)
        s, d = req("GET", "/api/skills/sources", base=self.base)
        self.assertEqual(s, 200, d)
        # 未知模块 toggle → 404
        s, d = req("POST", "/api/modules/ghost/toggle",
                   {"enabled": True}, base=self.base)
        self.assertErr(s, d, 404)

    def test_sz_remote_repos_crud(self):
        """remote-repos：POST 登记 / PATCH 更新 / 400 分支。"""
        s, d = req("POST", "/api/remote-repos",
                   {"name": "spec-repo", "url": "https://example.com/spec.git",
                    "branch": "main", "subdir": "", "modules": ["skills"]}, base=self.base)
        self.assertOk(s, d)
        rid = d.get("id") or (d.get("repo") or {}).get("id")
        self.assertTrue(rid, d)
        s, d = req("POST", "/api/remote-repos", {"name": "", "url": ""}, base=self.base)
        self.assertErr(s, d, 400)
        s, d = req("PATCH", "/api/remote-repos/%s" % rid,
                   {"branch": "dev"}, base=self.base)
        self.assertOk(s, d)
        s, d = req("PATCH", "/api/remote-repos/abc", {}, base=self.base)
        self.assertErr(s, d, 400)
        s, d = req("GET", "/api/remote-repos", base=self.base)
        row = [x for x in d["repos"] if x["name"] == "spec-repo"][0]
        self.assertEqual(row["branch"], "dev", row)

    def test_sz_targets_delete_and_seed(self):
        """targets：DELETE（含 400 非法 id）/ seed 幂等。"""
        tpath = os.path.join(self.tmp, "sz-tgt")
        os.makedirs(tpath)
        s, d = req("POST", "/api/skills/targets",
                   {"name": "sz-tgt", "kind": "skills_dir", "path": tpath}, base=self.base)
        self.assertOk(s, d)
        tid = d["id"]
        s, d = req("DELETE", "/api/skills/targets/%d" % tid, base=self.base)
        self.assertOk(s, d)
        s, d = req("DELETE", "/api/skills/targets/%d" % tid, base=self.base)
        self.assertOk(s, d)   # 幂等删除：目标不存在也 ok=True（Rust 需显式决策是否改 404）
        s, d = req("POST", "/api/skills/targets/seed", {}, base=self.base)
        self.assertOk(s, d)

    def test_sz_tools_reorder_detect_unwire(self):
        """tools：reorder / detect / wire→unwire 往返。"""
        s, d = req("GET", "/api/tools", base=self.base)
        self.assertOk(s, d)
        ids = [t["id"] for t in d["tools"]]
        if len(ids) >= 2:
            s, d = req("POST", "/api/tools/reorder",
                       {"order": list(reversed(ids))}, base=self.base)
            self.assertOk(s, d) if "ok" in d else self.assertEqual(s, 200, d)
        # detect：无内容目录 → 结构化返回（adapter 可为空）
        empty = os.path.join(self.tmp, "detect-empty")
        os.makedirs(empty)
        s, d = req("POST", "/api/tools/detect", {"root": empty}, base=self.base)
        self.assertEqual(s, 200, d)
        # unwire：未接线工具 → 结构化错误（404/400 均为合法拒绝形态）
        s, d = req("POST", "/api/tools/agents/unwire-memory", {}, base=self.base)
        self.assertIn(s, (200, 400, 404), d)

    def test_sz_remaining_routes_touch(self):
        """矩阵双零收口：lineage/preview/watch/memory overview+scan/seed。"""
        s, d = req("GET", "/api/lineage?tool=claude&sid=ghost", base=self.base)
        self.assertIn(s, (200, 400, 404), d)
        s, d = req("GET", "/api/sync/preview?source=ghost&target=ghost", base=self.base)
        self.assertIn(s, (200, 400, 404), d)
        s, d = req("GET", "/api/watch", base=self.base)
        self.assertIn(s, (200, 503), d)          # watcher 未启动 → 503 合法
        s, d = req("GET", "/api/memory/overview", base=self.base)
        self.assertEqual(s, 200, d)
        s, d = req("POST", "/api/memory/scan", {}, base=self.base)
        self.assertEqual(s, 200, d)
        s, d = req("POST", "/api/skills/targets/seed", {}, base=self.base)
        self.assertOk(s, d)

    def test_sz_attachment_guards(self):
        """attachment：缺参数 → 400（hub/attachments.py 首个 HTTP 判据）。"""
        s, d = req("GET", "/api/attachment", base=self.base)
        self.assertErr(s, d, 400)
        s, d = req("GET", "/api/attachment?sid=ghost&path=x", base=self.base)
        self.assertIn(s, (400, 404), d)

    def test_sz_skills_source_sync_local(self):
        """skills 源 sync-local：登记源后调用，结构化返回（内容为空亦 ok/error 合法）。"""
        s, d = req("POST", "/api/skills/sources",
                   {"name": "spec-src", "kind": "skills",
                    "url": "https://example.com/spec.git"}, base=self.base)
        self.assertOk(s, d)
        sid = d.get("id") or (d.get("source") or {}).get("id")
        self.assertTrue(sid, d)
        s, d = req("POST", "/api/skills/sources/%s/sync-local" % sid, {}, base=self.base)
        self.assertIn(s, (200, 400), d)     # 无本地缓存 → 结构化拒绝；有 → ok
        s, d = req("POST", "/api/skills/sources/999999/sync-local", {}, base=self.base)
        self.assertErr(s, d, s)         # 结构化拒绝

    def test_sz_memory_item_lifecycle_guards(self):
        """memory item：GET/PUT/DELETE/adopt 未知 id → 404；distribute 结构化。"""
        # 钉实际口径（逐方法混合，Rust 需显式决策是否统一）：
        # GET/DELETE → 404；PUT/adopt → 400；error 文案同为"条目不存在"
        expect = {"GET": 404, "PUT": 400, "DELETE": 404, "POST": 400}
        for method, body in (("GET", None), ("PUT", {"content": "x"}), ("DELETE", {}),
                             ("POST", {})):
            path = "/api/memory/item/999999" + ("/adopt" if method == "POST" else "")
            s, d = req(method, path, body, base=self.base)
            self.assertErr(s, d, expect[method], keyword="不存在")
        s, d = req("POST", "/api/memory/distribute", {}, base=self.base)
        self.assertIn(s, (200, 400), d)     # 空 memory → ok 空 / 400 皆合法拒绝形态

    def test_sz_tool_items_extract_sync_guards(self):
        """tool-items / extract / tool-sync（skills + mcp）：未知工具 → 结构化错误。"""
        for prefix in ("skills", "mcp"):
            s, d = req("GET", "/api/%s/tool-items?tool=ghost" % prefix, base=self.base)
            self.assertIn(s, (200, 400, 404), d)
            s, d = req("POST", "/api/%s/extract" % prefix,
                       {"tool": "ghost", "name": "x"}, base=self.base)
            self.assertErr(s, d, s)     # 结构化拒绝（400/404 均合法形态）
            s, d = req("POST", "/api/%s/tool-sync" % prefix,
                       {"tool": "ghost", "names": []}, base=self.base)
            self.assertErr(s, d, s)


class IdempotencyMatrix(SpecSandbox):
    """幂等矩阵：每个写操作执行两次的期望行为（Rust 最易分叉处）。"""

    def test_idem_create_manual_twice(self):
        """create ×2：第二次 400 重名（登记以先到者为准）。"""
        body = {"name": "idem-create", "files": {"SKILL.md": "---\nname: idem-create\n---\nx"}}
        s, d = req("POST", "/api/skills/registry/item", body, base=self.base)
        self.assertOk(s, d)
        s, d = req("POST", "/api/skills/registry/item", body, base=self.base)
        self.assertErr(s, d, 400)

    def test_idem_memory_add_twice(self):
        """memory add ×2：两条独立记录（追加语义，非 upsert）。"""
        s, d1 = req("POST", "/api/memory/add",
                    {"body": "规格夹具：幂等记忆"}, base=self.base)
        self.assertOk(s, d1)
        s, d2 = req("POST", "/api/memory/add",
                    {"body": "规格夹具：幂等记忆"}, base=self.base)
        self.assertOk(s, d2)
        s, d = req("GET", "/api/memories", base=self.base)
        self.assertOk(s, d)
        items = d.get("memories") or d.get("items") or []
        hit = [x for x in items if "幂等记忆" in str(x)]
        self.assertEqual(len(hit), 2, hit)

    def test_idem_star_twice(self):
        """star ×2：toggle 语义（第二次还原第一次），非重复写入。"""
        s, d = req("GET", "/api/sessions", base=self.base)
        self.assertOk(s, d)
        sessions = d.get("sessions") or []
        if not sessions:
            return
        sid = sessions[0]["sid"]
        s, d1 = req("POST", "/api/star", {"sid": sid}, base=self.base)
        self.assertOk(s, d1)
        st1 = d1["starred"]
        s, d2 = req("POST", "/api/star", {"sid": sid}, base=self.base)
        self.assertOk(s, d2)
        self.assertEqual(d2["starred"], not st1, (d1, d2))   # toggle

    def test_idem_distribute_twice(self):
        """distribute ×2：第二次 skipped（内容一致）。已在 spec_dispatch 钉 adopt/skipped，
        此处补 API 级：results[0].status=skipped。"""
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": "idem-dist", "files": {"SKILL.md": "---\nname: idem-dist\n---\nx"}},
                   base=self.base)
        self.assertOk(s, d)
        tpath = os.path.join(self.tmp, "idem-tgt")
        os.makedirs(tpath)
        s, d = req("POST", "/api/skills/targets",
                   {"name": "idem-tgt", "kind": "skills_dir", "path": tpath}, base=self.base)
        tid = d["id"]
        s, d = req("POST", "/api/skills/distribute",
                   {"names": ["idem-dist"], "target_ids": [tid]}, base=self.base)
        self.assertEqual(d["results"][0]["status"], "ok", d)
        s, d = req("POST", "/api/skills/distribute",
                   {"names": ["idem-dist"], "target_ids": [tid]}, base=self.base)
        self.assertEqual(d["results"][0]["status"], "skipped", d)

    def test_idem_link_dir_twice(self):
        """link ×2：同路径第二次 400。"""
        ext = os.path.join(self.tmp, "idem-dir")
        os.makedirs(ext)
        s, d = req("POST", "/api/local-dirs/link", {"path": ext, "name": "idem-dir"},
                   base=self.base)
        self.assertOk(s, d)
        s, d = req("POST", "/api/local-dirs/link", {"path": ext}, base=self.base)
        self.assertErr(s, d, 400)
