//! 文件原语：树哈希（黄金样本逐字节规格）、list_files、原子写、备份（同秒碰撞
//! `-n` 后缀）、safe_rm（hub 边界守卫）。
//!
//! tree hash 算法定义（升格为规格，spec_hash 黄金样本逐字节钉住）：
//! `sha256( for rel in sorted(files): rel + "\0" + files[rel] + "\n" )`，
//! 其中 files = list_files(root) 的 {相对路径: 文件 sha256}（跳过 .DS_Store）。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};

pub fn sha256_bytes(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    hex::encode(h.finalize())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let data = std::fs::read(path)
        .map_err(|e| CoreError::io(format!("读取失败 {}", path.display()), e))?;
    Ok(sha256_bytes(&data))
}

/// {相对路径(始终 / 分隔): 文件 sha256}；跳过 `.DS_Store`。
/// 目录名排序保证遍历稳定；不跳过任何其他隐藏文件（与 Python 口径一致）。
pub fn list_files(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    Ok(out)
}

fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| CoreError::io(format!("列目录失败 {}", dir.display()), e))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        let full = e.path();
        if full.is_dir() {
            walk(base, &full, out)?;
        } else if name == ".DS_Store" {
            continue;
        } else {
            let rel = full
                .strip_prefix(base)
                .unwrap_or(&full)
                .to_string_lossy()
                .replace('\\', "/");
            let sha = sha256_file(&full)?;
            out.insert(rel, sha);
        }
    }
    Ok(())
}

/// 树哈希（规格算法定义）：sorted(rel) → rel \0 sha \n。
pub fn tree_hash_from_files(files: &BTreeMap<String, String>) -> String {
    let mut h = Sha256::new();
    for (rel, sha) in files.iter() {
        h.update(rel.as_bytes());
        h.update(b"\x00");
        h.update(sha.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

pub fn tree_hash(root: &Path) -> Result<String> {
    let files = list_files(root)?;
    Ok(tree_hash_from_files(&files))
}

/// 原子写：写 `<dest>.hub-tmp-<pid>` 后 rename；失败清理 tmp；父目录自动创建。
pub fn atomic_write_bytes(dest: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CoreError::io(format!("创建目录失败 {}", parent.display()), e))?;
    }
    let tmp = PathBuf::from(format!("{}.hub-tmp-{}", dest.display(), std::process::id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(CoreError::io(format!("原子写失败 {}", dest.display()), e));
    }
    std::fs::rename(&tmp, dest)
        .map_err(|e| CoreError::io(format!("rename 失败 {}", dest.display()), e))
}

pub fn atomic_write_text(dest: &Path, text: &str) -> Result<()> {
    atomic_write_bytes(dest, text.as_bytes())
}

/// 备份单文件到 backup_root：`<原名>.<时间戳>`，同秒碰撞 `-n` 后缀（规格契约）。
/// 返回备份文件绝对路径。
pub fn backup_file(src: &Path, backup_root: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(backup_root)
        .map_err(|e| CoreError::io(format!("创建备份目录失败 {}", backup_root.display()), e))?;
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let stamp = timestamp_compact();
    let mut target = backup_root.join(format!("{name}.{stamp}"));
    let mut n = 1;
    while target.exists() {
        target = backup_root.join(format!("{name}.{stamp}.{n}"));
        n += 1;
    }
    std::fs::copy(src, &target)
        .map_err(|e| CoreError::io(format!("备份失败 {}", src.display()), e))?;
    Ok(target)
}

fn timestamp_compact() -> String {
    let now = chrono::Local::now();
    now.format("%Y%m%d-%H%M%S").to_string()
}

/// 安全删除：只允许删 hub 管辖目录内的路径（防御纵深，规格契约）。
/// `hub_root` 之外的路径一律 PermissionError（与 Python safe_rm 对位）。
pub fn safe_rm(path: &Path, hub_root: &Path) -> Result<()> {
    let p = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let hub = hub_root.canonicalize().unwrap_or_else(|_| hub_root.to_path_buf());
    if p == hub || p.starts_with(&hub) {
        if p.is_dir() {
            std::fs::remove_dir_all(&p)
                .map_err(|e| CoreError::io(format!("删除失败 {}", p.display()), e))?;
        } else if p.exists() {
            std::fs::remove_file(&p)
                .map_err(|e| CoreError::io(format!("删除失败 {}", p.display()), e))?;
        }
        Ok(())
    } else {
        Err(CoreError::new(
            crate::error::Code::Io,
            format!("safe_rm 拒绝：{} 不在 hub 管辖内", path.display()),
        ))
    }
}

/// 递归复制目录（原子性无要求，直接 copytree）。
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let e = entry?;
        let ty = e.file_type()?;
        let target = dst.join(e.file_name());
        if ty.is_dir() {
            copy_dir_all(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), &target)?;
        }
    }
    Ok(())
}

/// rename（同卷）或 copy+rm（跨卷 fallback，对位 Python _move 的 EXDEV 兜底）。
pub fn rename_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) if src.is_dir() => {
            copy_dir_all(src, dst)?;
            fs::remove_dir_all(src)
        }
        Err(e) => Err(e),
    }
}

/// 读 JSON（非法/不存在 → None，与 Python read_json 口径一致）。
pub fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn atomic_write_creates_parents_and_cleans_tmp() {
        let base = tempfile::tempdir().unwrap();
        let dest = base.path().join("sub/dir/f.txt");
        atomic_write_bytes(&dest, b"data").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"data");
        let junk: Vec<_> = fs::read_dir(base.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("hub-tmp"))
            .collect();
        assert!(junk.is_empty());
    }

    #[test]
    fn backup_collision_same_second() {
        let base = tempfile::tempdir().unwrap();
        let src = base.path().join("f.txt");
        fs::write(&src, "a").unwrap();
        let bk = base.path().join("bk");
        let b1 = backup_file(&src, &bk).unwrap();
        fs::write(&src, "b").unwrap();
        let b2 = backup_file(&src, &bk).unwrap();
        assert_ne!(b1, b2);
        assert_eq!(fs::read_to_string(b1).unwrap(), "a");
        assert_eq!(fs::read_to_string(b2).unwrap(), "b");
    }

    #[test]
    fn safe_rm_rejects_outside_hub() {
        let hub = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("x");
        fs::create_dir_all(&victim).unwrap();
        assert!(safe_rm(&victim, hub.path()).is_err());
        assert!(victim.is_dir());
    }

    #[test]
    fn list_files_skips_ds_store_and_uses_slash() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("sub")).unwrap();
        fs::write(base.path().join("a.md"), "x").unwrap();
        fs::write(base.path().join(".DS_Store"), "junk").unwrap();
        fs::write(base.path().join("sub").join("b.txt"), "y").unwrap();
        let files = list_files(base.path()).unwrap();
        let keys: Vec<&String> = files.keys().collect();
        assert!(!keys.iter().any(|k| k.contains(".DS_Store")));
        assert!(keys.contains(&&"a.md".to_string()));
        assert!(keys.contains(&&"sub/b.txt".to_string()));
    }

    /// 黄金样本：与 tests/fixtures/golden/hashes.json（Python 录制）逐字节一致。
    /// 这是 Rust 重写的二值验收闸门。
    #[test]
    fn golden_tree_hash_matches_python() {
        let golden_path = root().join("tests/fixtures/golden/hashes.json");
        let golden = json(&std::fs::read_to_string(&golden_path).unwrap());
        let tree = tempfile::tempdir().unwrap();
        let root = tree.path();
        for (rel, _sha) in golden["files"].as_object().unwrap() {
            let full = root.join(rel);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            // 内容不重要——只要 list_files 的 sha 与录制时一致。
            // 录制时各文件内容见 spec_hash.build_tree；这里以 golden 内记录的
            // 文件 sha 反推内容不可行，因此直接写入确定内容并依赖"重新录制一致性"：
            // Python 端 build_tree 的内容是确定的（见 spec_hash.py）。
            let _ = &full;
        }
        // 内容按 spec_hash.build_tree 逐字节复刻：
        let contents: Vec<(&str, &str)> = vec![
            ("alpha/SKILL.md", "---\nname: alpha\n---\n正文\n"),
            ("alpha/sub/deep.txt", "deep\n"),
            ("beta/empty-dir/.keep", ""),
            ("gamma/中文条目.md", "中文内容\n"),
            ("delta.json", "{\"command\": \"x\"}"),
        ];
        for (rel, text) in &contents {
            let full = root.join(rel);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(&full, text).unwrap();
        }
        fs::create_dir_all(root.join("alpha").join(".hub-backup")).unwrap();
        fs::write(root.join("alpha").join(".DS_Store"), "junk").unwrap();

        let files = list_files(root).unwrap();
        let full_hash = tree_hash_from_files(&files);
        let expected_files = golden["files"].as_object().unwrap();
        for (rel, expected) in expected_files {
            let got = files.get(rel).unwrap_or_else(|| panic!("缺文件 {rel}"));
            assert_eq!(got, expected.as_str().unwrap(), "{rel}");
        }
        assert_eq!(full_hash, golden["tree"].as_str().unwrap(), "全树 hash");
    }

    fn root() -> PathBuf {
        // crates/depot-core → 仓根（三层上：depot-core → crates → depotd → 仓根）
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf()
    }

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }
}
