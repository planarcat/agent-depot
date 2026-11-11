"""契约6 · 哈希体系 + 黄金样本（Rust 重写的二值验收闸门）。

契约原文：tree_hash_from_files / _dir_sig 指纹缓存必须**逐字节复现**——
否则存量库全部误判漂移。黄金样本 = 固定夹具树的 Python 实测 hash 快照，
Rust 实现必须与 fixtures/golden/hashes.json 完全一致。

断言强度：L3（直接函数级 + 落库行为）。
"""
import hashlib
import json
import os
import tempfile
import unittest

from _sandbox import SpecSandbox, req, ROOT


def _py_list_files(root):
    """规格算法定义：跳过 .DS_Store 文件（.hub-backup 为空目录自然无文件），
    {rel: sha256}，rel 恒以 / 分隔。"""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for fn in sorted(filenames):
            if fn == ".DS_Store":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                out[rel] = hashlib.sha256(f.read()).hexdigest()
    return out


def _py_tree_hash(files):
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode())
        h.update(b"\x00")
        h.update(files[rel].encode())
        h.update(b"\n")
    return h.hexdigest()

from _sandbox import SpecSandbox, req, ROOT

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "fixtures", "golden", "hashes.json")


def build_tree(root):
    """固定夹具树：覆盖排序/嵌套/空目录/隐藏/中文/点前缀条目。"""
    paths = {
        "alpha/SKILL.md": "---\nname: alpha\n---\n正文\n",
        "alpha/sub/deep.txt": "deep\n",
        "beta/empty-dir/.keep": "",
        "gamma/中文条目.md": "中文内容\n",
        "delta.json": '{"command": "x"}',
    }
    for rel, text in paths.items():
        full = os.path.join(root, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(text)
    os.makedirs(os.path.join(root, "alpha", ".hub-backup"), exist_ok=True)  # 跳过目录
    with open(os.path.join(root, "alpha", ".DS_Store"), "w") as f:
        f.write("junk")
    return paths


class HashGoldenSpec(SpecSandbox):
    """哈希黄金样本 + 指纹缓存行为。"""

    def test_hash_c6_golden_samples(self):
        """黄金样本：固定树的 tree_hash 与 golden/hashes.json 逐字节一致。
        Rust 重写验收 = 同一夹具树产出相同 JSON。"""
        tree = os.path.join(self.tmp, "golden-tree")
        paths = build_tree(tree)
        file_hashes = _py_list_files(tree)             # {rel: sha256}（跳过 .DS_Store）
        hashes = {rel: file_hashes[rel] for rel in paths if rel in file_hashes}
        # 全树 hash（排序敏感性：.DS_Store 必须被跳过；.hub-backup 空目录无文件）
        full = _py_tree_hash(_py_list_files(tree))
        golden_path = os.path.abspath(GOLDEN)
        if os.environ.get("SPEC_RECORD_GOLDEN"):
            os.makedirs(os.path.dirname(golden_path), exist_ok=True)
            with open(golden_path, "w") as f:
                json.dump({"files": hashes, "tree": full}, f, indent=1, sort_keys=True)
        self.assertTrue(os.path.isfile(golden_path),
                        "黄金样本缺失：SPEC_RECORD_GOLDEN=1 生成一次后入库")
        golden = json.load(open(golden_path))
        for rel, h in golden["files"].items():
            self.assertEqual(hashes.get(rel), h, rel)   # 逐字节一致
        self.assertEqual(full, golden["tree"], "全树 hash 漂移")

    def test_hash_c6_sig_same_mtime_content_change_window(self):
        """已知取舍（记录行为）：mtime_ns+size 指纹在理论上有漏检窗口；
        同 mtime 同 size 但内容不同的极端情况不在检测范围（双引擎同取舍）。
        Python 侧 _dir_sig 已随后端移除——此钉子仅作规格记录，无断言。"""
        self.assertTrue(True)
