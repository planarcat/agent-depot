"""契约 · 链接目录扫描与容器发现（Rust 行为真源）。

契约原文（2026-11-14 agent-skills 事故，discover_layout 两守）：
1. 技能原子性：自带 SKILL.md 的目录是单个条目，其内部树（references/、收编的
   上游技能副本）不再下钻找容器——vendored 副本不得被收编为条目；
2. 空壳容器不记录：skills/、mcp/ 里没有有效条目时不算容器，也不把目录抬进
   容器模式（否则根层条目全部落空）；
3. 真容器（有货）仍按容器模式扫子条目；无容器走根层扫描（根层每个带
   SKILL.md 的子目录 = 一个条目）。

断言强度：L2 响应 shape + L3 local_dirs.layout / 条目清单副作用。
"""
import json
import os

from _sandbox import SpecSandbox, req


class DirScanSpec(SpecSandbox):
    """契约 · 目录链接的容器发现与根层扫描。"""

    def _mk_skill(self, root, rel):
        d = os.path.join(root, *rel.split("/"))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w") as f:
            f.write("---\nname: %s\n---\nbody" % rel.split("/")[-1])
        return d

    def _link(self, root, name):
        s, d = req("POST", "/api/local-dirs/link", {"path": root, "name": name},
                   base=self.base)
        self.assertOk(s, d)
        return d["id"]

    def _resync(self):
        s, d = req("GET", "/api/local-dirs", base=self.base)   # 读取触发 scan_sync
        self.assertOk(s, d)
        return d["dirs"]

    def _layout(self, did):
        row = next(x for x in self._resync() if x["id"] == did)
        lay = row.get("layout")            # API 已把 layout 解析成对象或 null
        if isinstance(lay, str):
            lay = json.loads(lay)
        return lay or None

    def _items(self, did):
        s, d = req("GET", "/api/skills/items?source=manual&dir=%d&per_page=100" % did,
                   base=self.base)
        self.assertOk(s, d)
        return sorted(it["name"] for it in d["items"])

    # ---------- 技能原子性（2026-11-14 事故复现夹具） ----------

    def test_scan_atomic_skill_not_descended(self):
        """自带 SKILL.md 的目录内部不下钻：vendored references/skills 不收编。"""
        root = os.path.join(self.tmp, "atomic-dir")
        self._mk_skill(root, "plain-a")
        self._mk_skill(root, "router")                       # 单条目：内部树非容器
        self._mk_skill(root, "router/references/skills/html-a")
        self._mk_skill(root, "router/references/skills/html-b")
        did = self._link(root, "atomic-dir")
        self.assertIsNone(self._layout(did),
                          "技能内部树不得发现容器（否则 vendored 副本被收编）")
        self.assertEqual(self._items(did), ["plain-a", "router"])

    def test_scan_empty_container_not_folder_mode(self):
        """空壳 skills/ 不算容器：目录退回根层扫描，根层条目不落空。"""
        root = os.path.join(self.tmp, "empty-ctr")
        os.makedirs(os.path.join(root, "skills"))            # 空容器
        self._mk_skill(root, "real-a")
        did = self._link(root, "empty-ctr")
        self.assertIsNone(self._layout(did), "空壳容器不得抬进容器模式")
        self.assertEqual(self._items(did), ["real-a"])

    def test_scan_real_container_mode_kept(self):
        """真容器（有货）仍按容器模式：只收容器子条目，layout 记录发现。"""
        root = os.path.join(self.tmp, "real-ctr")
        os.makedirs(os.path.join(root, "skills"))
        self._mk_skill(root, "skills/ta")
        self._mk_skill(root, "skills/tb")
        did = self._link(root, "real-ctr")
        self.assertEqual(self._layout(did), {"skills": ["skills"], "mcp": []})
        self.assertEqual(self._items(did), ["ta", "tb"])

    def test_scan_mcp_container_needs_valid_entry(self):
        """mcp 容器判据与收录一致：无 command/url 的 .json 不算货。"""
        root = os.path.join(self.tmp, "mcp-ctr")
        ctr = os.path.join(root, "mcp")
        os.makedirs(ctr)
        with open(os.path.join(ctr, "broken.json"), "w") as f:
            json.dump({"port": 1}, f)                        # 无 command/url：无效
        did = self._link(root, "mcp-ctr")
        self.assertIsNone(self._layout(did), "空壳 mcp 容器不得记录")
        with open(os.path.join(ctr, "good.json"), "w") as f:
            json.dump({"command": "npx"}, f)                 # 有效条目 → 容器成立
        self.assertEqual(self._layout(did), {"skills": [], "mcp": ["mcp"]})
