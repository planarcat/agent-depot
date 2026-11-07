"""契约2 · 版本链与回退规格（Rust 重写行为真源）。

契约原文：prev_hash/prev_version 链、versions 快照、回退前后互转存（可再切回）；
rollback 只作用于本地库，**不自动重新分发**；无快照/空快照 → 守卫拒绝；
同秒多次写 → 快照 `-n` 后缀去碰撞。

断言强度：L2 + L3（磁盘快照/内容）+ L4（ops detail.restored_from）。
"""
import json
import os
import time

from _sandbox import SpecSandbox, req


def skill_files(text):
    return {"SKILL.md": "---\nname: x\nversion: 1.0\n---\n%s" % text,
            "helper.py": "VALUE = '%s'\n" % text}


class VersioningSpec(SpecSandbox):
    """契约2 · 版本链。夹具 = HTTP 手动条目（默认库），编辑走 PUT。"""

    def _mk(self, name, text="v1"):
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": name, "files": skill_files(text)}, base=self.base)
        self.assertOk(s, d)

    def _edit(self, name, text):
        s, d = req("PUT", "/api/skills/registry/item/%s" % name,
                   {"files": skill_files(text)}, base=self.base)
        self.assertOk(s, d)

    def _rollback(self, name, base="skills"):
        return req("POST", "/api/%s/registry/rollback" % base,
                   {"name": name}, base=self.base)

    def _content(self, name):
        s, d = req("GET", "/api/skills/item/%s" % name, base=self.base)
        self.assertEqual(s, 200, d)
        return d

    def _read_local(self, name, rel="SKILL.md"):
        """默认库条目落盘内容（hub/registry/skills/<name>/<rel>）。"""
        import glob
        cands = glob.glob(os.path.join(self.tmp, "hub", "registry", "skills", name, rel))
        self.assertTrue(cands, (name, rel))
        with open(cands[0], encoding="utf-8") as f:
            return f.read()

    def _versions_dir(self, name):
        return os.path.join(self.tmp, "hub", "registry", ".versions", "skills", name)

    # ---------- 守卫 ----------

    def test_ver_c2_rollback_guard_no_snapshot(self):
        """反例：从未编辑过（无快照）→ rollback 400 + 结构化错误。"""
        self._mk("rb-guard")
        s, d = self._rollback("rb-guard")
        self.assertErr(s, d, 400, keyword="快照")

    def test_ver_c2_rollback_guard_unknown_item(self):
        """反例：不存在的条目 → 400（无快照路径），不 500。"""
        s, d = self._rollback("rb-ghost")
        self.assertErr(s, d, 400, keyword="快照")

    # ---------- 回退与互转存 ----------

    def test_ver_c2_rollback_roundtrip_swap(self):
        """v1 → 编辑 v2 → 回退(内容/版本回 v1) → 再回退(互转存：回到 v2)。"""
        self._mk("rb-a", "v1")
        self._edit("rb-a", "v2")
        s, d = self._rollback("rb-a")
        self.assertOk(s, d)
        self.assertIn("v1", self._read_local("rb-a"))
        self.assertTrue(d.get("restored_from"), d)          # 快照名在响应里
        # 再回退：互转存（当前 v2 已在首次回退时转存）→ 回到 v2
        # 快照时间戳分辨率为 1 秒：间隔 1.1s 保证互转存快照按时间排序（同秒歧义见碰撞用例）
        time.sleep(1.1)
        s2, d2 = self._rollback("rb-a")
        self.assertOk(s2, d2)
        self.assertIn("v2", self._read_local("rb-a"))

    def test_ver_c2_rollback_does_not_redeploy(self):
        """回退只作用于本地库：已分发到工具的文件保持原版本（不自动重发）。"""
        self._mk("rb-dep", "v1")
        tpath = os.path.join(self.tmp, "tgt-rb-dep")
        os.makedirs(tpath)
        s, d = req("POST", "/api/skills/targets",
                   {"name": "tgt-rb-dep", "kind": "skills_dir", "path": tpath}, base=self.base)
        self.assertOk(s, d)
        tid = d["id"]
        s, d = req("POST", "/api/skills/distribute",
                   {"names": ["rb-dep"], "target_ids": [tid]}, base=self.base)
        self.assertOk(s, d)
        self._edit("rb-dep", "v2")
        s, d = self._rollback("rb-dep")
        self.assertOk(s, d)
        # 回退不触发重分发：目标保持分发时内容（v1）；本地库已回 v1
        with open(os.path.join(tpath, "rb-dep", "SKILL.md")) as f:
            self.assertIn("v1", f.read())
        self.assertIn("v1", self._read_local("rb-dep"))
        # 部署行保留（未被回退清除）
        s, d = req("GET", "/api/skills/items?source=manual", base=self.base)
        it = [x for x in d["items"] if x["name"] == "rb-dep"][0]
        self.assertTrue(it.get("deployments"), it)

    # ---------- 快照碰撞 ----------

    def test_ver_c2_snapshot_same_second_collision(self):
        """同秒连续两次编辑 → 两个快照（-n 后缀去碰撞），都能回退到达。"""
        self._mk("snap-a", "v1")
        self._edit("snap-a", "v2")
        self._edit("snap-a", "v3")     # 同秒内 → 第二个快照 -1 后缀
        vroot = self._versions_dir("snap-a")
        snaps = [d for d in os.listdir(vroot) if not d.startswith(".")]
        self.assertGreaterEqual(len(snaps), 2, snaps)
        # 逐级回退：v3 → v2 → v1（快照内容互不覆盖）
        s, d = self._rollback("snap-a")
        self.assertOk(s, d)
        self.assertIn("v2", self._read_local("snap-a"))
        time.sleep(1.1)
        s, d = self._rollback("snap-a")
        self.assertOk(s, d)
        # 互转存语义（prev_* 交换 = undo/redo 切换）：再回退回到「上次回退前的版本」
        self.assertIn("v3", self._read_local("snap-a"))
        time.sleep(1.1)
        s, d = self._rollback("snap-a")
        self.assertOk(s, d)
        self.assertIn("v2", self._read_local("snap-a"))   # 再切回
        # 同秒碰撞：连续两次回退（同秒）→ 不 500（-n 后缀去碰撞），
        # 内容 ∈ 有效历史版本，快照目录无丢失
        body = self._read_local("snap-a")
        s, d = self._rollback("snap-a")
        self.assertOk(s, d)
        s, d = self._rollback("snap-a")
        self.assertOk(s, d)   # 修复前此处 500：File exists
        body2 = self._read_local("snap-a")
        self.assertTrue(any(m in body2 for m in ("v1", "v2", "v3")), body2)

    # ---------- 台账（L4） ----------

    def test_ver_c2_rollback_ops_detail(self):
        """L4：rollback 台账 detail.restored_from + item_version 契约。"""
        self._mk("rb-ops", "v1")
        self._edit("rb-ops", "v2")
        s, d = self._rollback("rb-ops")
        self.assertOk(s, d)
        restored = d["restored_from"]
        s, d = req("GET", "/api/ops?module=skills&q=rb-ops", base=self.base)
        self.assertEqual(s, 200, d)
        rows = [r for r in d["items"] if r["action"] == "rollback"
                and r["item_name"] == "rb-ops"]
        self.assertTrue(rows, d)
        row = rows[0]
        self.assertEqual(row["item_version"], "1.0", row)
        det = json.loads(row["detail"]) if isinstance(row["detail"], str) else row["detail"]
        self.assertEqual(det["extra"]["restored_from"], restored, det)

    # ---------- prev_hash 链 ----------

    def test_ver_c2_hash_chain_observable(self):
        """编辑留链的 HTTP 可观测口径：hash 变化；分发后编辑 → modified 标记。"""
        self._mk("chain-a", "v1")
        s, d = req("GET", "/api/skills/registry", base=self.base)
        h1 = [x for x in d["items"] if x["name"] == "chain-a"][0]["hash"]
        self._edit("chain-a", "v2")
        s, d = req("GET", "/api/skills/registry", base=self.base)
        row = [x for x in d["items"] if x["name"] == "chain-a"][0]
        self.assertNotEqual(row["hash"], h1, row)           # hash 前移
        self.assertFalse(row["modified"], row)              # 未分发 → 无漂移
        # 绕过 API 直接改盘（默认库不被 scan_sync 扫描）→ modified 漂移标记
        p = os.path.join(self.tmp, "hub", "registry", "skills", "chain-a", "SKILL.md")
        with open(p, "a") as f:
            f.write("out-of-band-edit")
        s, d = req("GET", "/api/skills/registry", base=self.base)
        row = [x for x in d["items"] if x["name"] == "chain-a"][0]
        self.assertTrue(row["modified"], row)


class McpVersioningSpec(SpecSandbox):
    """契约2（mcp 侧）：rollback 守卫与互转存走同一套磁盘语义。"""

    def _mk(self, name):
        s, d = req("POST", "/api/mcp/registry/item",
                   {"name": name, "config": {"command": "demo-%s" % name, "args": []}},
                   base=self.base)
        self.assertOk(s, d)

    def _edit(self, name, cmd):
        s, d = req("PUT", "/api/mcp/registry/item/%s" % name,
                   {"config": {"command": cmd}}, base=self.base)
        self.assertOk(s, d)

    def test_mver_c2_rollback_guard(self):
        self._mk("m-rb-guard")
        s, d = req("POST", "/api/mcp/registry/rollback",
                   {"name": "m-rb-guard"}, base=self.base)
        self.assertErr(s, d, 400, keyword="快照")

    def test_mver_c2_rollback_roundtrip(self):
        self._mk("m-rb-a")
        self._edit("m-rb-a", "edited-cmd")
        s, d = req("POST", "/api/mcp/registry/rollback",
                   {"name": "m-rb-a"}, base=self.base)
        self.assertOk(s, d)
        # 回退后本地库内容回到初版 command
        s, d = req("GET", "/api/mcp/item/m-rb-a", base=self.base)
        self.assertEqual(s, 200, d)
        body = json.dumps(d)
        self.assertIn("demo-m-rb-a", body, d)
        self.assertNotIn("edited-cmd", body, d)
