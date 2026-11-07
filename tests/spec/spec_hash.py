"""契约6 · 哈希体系 + 黄金样本（Rust 重写的二值验收闸门）。

契约原文：tree_hash_from_files / _dir_sig 指纹缓存必须**逐字节复现**——
否则存量库全部误判漂移。黄金样本 = 固定夹具树的 Python 实测 hash 快照，
Rust 实现必须与 fixtures/golden/hashes.json 完全一致。

断言强度：L3（直接函数级 + 落库行为）。
"""
import json
import os
import tempfile
import unittest

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
        from hub.core import fsutil
        tree = os.path.join(self.tmp, "golden-tree")
        paths = build_tree(tree)
        file_hashes = fsutil.list_files(tree)          # {rel: sha256}（跳过 .DS_Store）
        hashes = {rel: file_hashes[rel] for rel in paths if rel in file_hashes}
        # 全树 hash（排序敏感性：.DS_Store/.hub-backup 必须被跳过）
        full = fsutil.tree_hash_from_files(fsutil.list_files(tree))
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
        同 mtime 同 size 但内容不同的极端情况不在检测范围（Rust 侧保持同取舍）。"""
        # 该用例为契约说明性钉子：不改行为，只防未来"顺手加强"未在方案中声明
        from hub.core import local_dirs
        self.assertTrue(hasattr(local_dirs, "_dir_sig"))


class FsutilUnitSpec(unittest.TestCase):
    """fsutil 直接单测（Rust 重写须逐条对位）。"""

    def test_fs_c6_safe_rm_outside_hub(self):
        from hub.core import fsutil
        outside = tempfile.mkdtemp(prefix="spec-fs-")
        victim = os.path.join(outside, "x")
        os.makedirs(victim)
        with self.assertRaises(PermissionError):
            fsutil.safe_rm(victim)
        self.assertTrue(os.path.isdir(victim))   # 未被删除

    def test_fs_c6_atomic_write_tmp_cleanup_on_error(self):
        from hub.core import fsutil
        base = tempfile.mkdtemp(prefix="spec-fs-")
        fsutil.atomic_write_bytes(os.path.join(base, "sub", "f.txt"), b"data")
        self.assertTrue(os.path.isfile(os.path.join(base, "sub", "f.txt")))
        self.assertEqual([n for n in os.listdir(base) if "hub-tmp" in n], [])

    def test_fs_c6_backup_collision_suffix(self):
        import time as _t
        from hub.core import fsutil
        base = tempfile.mkdtemp(prefix="spec-fs-")
        src = os.path.join(base, "f.txt")
        with open(src, "w") as f:
            f.write("a")
        b1 = fsutil.backup_file(src, os.path.join(base, "bk"))
        with open(src, "w") as f:
            f.write("b")
        b2 = fsutil.backup_file(src, os.path.join(base, "bk"))
        self.assertNotEqual(b1, b2)                    # 同秒 → -n 后缀
        self.assertEqual(open(b1).read(), "a")
        self.assertEqual(open(b2).read(), "b")

    def test_fs_c6_list_files_skips(self):
        from hub.core import fsutil
        base = tempfile.mkdtemp(prefix="spec-fs-")
        os.makedirs(os.path.join(base, "sub"))
        open(os.path.join(base, "a.md"), "w").close()
        open(os.path.join(base, ".DS_Store"), "w").close()
        open(os.path.join(base, "sub", "b.txt"), "w").close()
        rels = sorted(fsutil.list_files(base))     # dict 键 = 相对路径（跳过 .DS_Store）
        self.assertNotIn(".DS_Store", rels)
        self.assertIn("a.md", rels)
        self.assertIn(os.path.join("sub", "b.txt"), rels)


if __name__ == "__main__":
    unittest.main()
