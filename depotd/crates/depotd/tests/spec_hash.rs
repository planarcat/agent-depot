//! 契约6 · 哈希体系 + 黄金样本（原 tests/spec/spec_hash.py，2026-11-17 迁入）。
//!
//! 契约原文：tree_hash_from_files / list_files 指纹必须**逐字节复现**——
//! 否则存量库全部误判漂移。黄金样本 = 固定夹具树的实测 hash 快照，
//! 引擎实现必须与 tests/fixtures/golden/hashes.json 完全一致。
//!
//! 断言强度：L3（直接函数级）。Python 版在 Python 侧定义算法律夹具并与黄金样本比对；
//! 迁入后直接调 `depot_core::fsutil` 引擎实现（`fsutil` 内联单测另有同款验证，
//! 本文件保住「spec 78 条」判据形态与套件级口径）。SPEC_RECORD_GOLDEN=1 重录语义保留。

mod common;

use depot_core::fsutil::{list_files, tree_hash_from_files};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 黄金样本路径：仓库根 tests/fixtures/golden/hashes.json。
fn golden_path() -> std::path::PathBuf {
    // CARGO_MANIFEST_DIR = depotd/crates/depotd → 仓根三层上
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().parent().unwrap().parent().unwrap()
        .join("tests/fixtures/golden/hashes.json")
}

/// 固定夹具树：覆盖排序/嵌套/空目录/隐藏/中文/点前缀条目（原 build_tree 逐字节复刻）。
fn build_tree(root: &Path) -> Vec<(String, &'static str)> {
    let paths: Vec<(&str, &str)> = vec![
        ("alpha/SKILL.md", "---\nname: alpha\n---\n正文\n"),
        ("alpha/sub/deep.txt", "deep\n"),
        ("beta/empty-dir/.keep", ""),
        ("gamma/中文条目.md", "中文内容\n"),
        ("delta.json", "{\"command\": \"x\"}"),
    ];
    for (rel, text) in &paths {
        let full = root.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }
    fs::create_dir_all(root.join("alpha").join(".hub-backup")).unwrap(); // 跳过目录（空目录无文件）
    fs::write(root.join("alpha").join(".DS_Store"), "junk").unwrap();
    paths.into_iter().map(|(a, b)| (a.to_string(), b)).collect()
}

#[test]
fn test_hash_c6_golden_samples() {
    // 黄金样本：固定树的 tree_hash 与 golden/hashes.json 逐字节一致。
    let _g = common::serial();
    let sb = common::sandbox();
    let tree = sb.root().join("golden-tree");
    let paths = build_tree(&tree);
    let files = list_files(&tree).unwrap(); // {rel: sha256}（跳过 .DS_Store）
    let hashes: serde_json::Map<String, Value> = paths
        .iter()
        .filter(|(rel, _)| files.contains_key(rel))
        .map(|(rel, _)| (rel.clone(), json!(files[rel])))
        .collect();
    // 全树 hash（排序敏感性：.DS_Store 必须被跳过；.hub-backup 空目录无文件）
    let full = tree_hash_from_files(&files);

    let golden_file = golden_path();
    if std::env::var("SPEC_RECORD_GOLDEN").is_ok() {
        fs::create_dir_all(golden_file.parent().unwrap()).unwrap();
        fs::write(
            &golden_file,
            serde_json::to_string_pretty(&json!({"files": hashes, "tree": full})).unwrap(),
        )
        .unwrap();
    }
    assert!(
        golden_file.is_file(),
        "黄金样本缺失：SPEC_RECORD_GOLDEN=1 生成一次后入库"
    );
    let golden: Value =
        serde_json::from_str(&fs::read_to_string(&golden_file).unwrap()).unwrap();
    for (rel, h) in golden["files"].as_object().unwrap() {
        let got = files
            .get(rel)
            .unwrap_or_else(|| panic!("缺文件 {rel}"));
        assert_eq!(*got, h.as_str().unwrap(), "{rel}"); // 逐字节一致
    }
    assert_eq!(full, golden["tree"].as_str().unwrap(), "全树 hash 漂移");
}

#[test]
fn test_hash_c6_sig_same_mtime_content_change_window() {
    // 已知取舍（记录行为）：mtime+size 指纹在理论上有漏检窗口；
    // 同 mtime 同 size 但内容不同的极端情况不在检测范围（双引擎同取舍）。
    // Python 侧 _dir_sig 已随后端移除——此钉子仅作规格记录，无断言。
    let _g = common::serial();
    let _sb = common::sandbox();
}
