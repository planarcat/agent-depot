//! Git 源接入（对位 hub/lib/gitsrc.py + catalog.py）：git CLI 子进程 +
//! 源缓存目录 + skills/mcp 目录解析。Tier 2 内部实现，行为对齐 Python。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::error::{CoreError, Result};

pub struct GitOut {
    pub code: i32,
    pub out: String,
    pub err: String,
}

pub fn run_git(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> GitOut {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "echo");
    match cmd.output() {
        Ok(o) => GitOut {
            code: o.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&o.stdout).to_string(),
            err: String::from_utf8_lossy(&o.stderr).to_string(),
        },
        Err(e) => GitOut { code: -1, out: String::new(), err: e.to_string() },
    }
}

fn valid_branch(branch: &str) -> bool {
    !branch.is_empty() && branch != "HEAD" && branch != "*" && branch != "head"
}

/// 从 Git URL 提取可读仓库名（owner-repo；本地路径取末级目录名）。
pub fn repo_name(url: &str) -> String {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if s.ends_with(".git") {
        s.truncate(s.len() - 4);
    }
    if s.is_empty() {
        return "repo".into();
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("ssh://")
        || s.starts_with("git://") || s.starts_with("git@")
    {
        let norm = s.replace(':', "/");
        let parts: Vec<&str> = norm.split('/').filter(|p| !p.is_empty()).collect();
        // git@host:owner/repo → 取最后两段
        if parts.len() >= 2 {
            return format!("{}-{}", parts[parts.len() - 2], parts[parts.len() - 1]);
        }
        return parts.last().unwrap_or(&"repo").to_string();
    }
    Path::new(&s)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| s.clone())
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// 远程源缓存目录：`<hub>/sources/<kind>/<仓库名>[-<分支>][-<子目录>]`。
pub fn source_cache_dir(hub: &Path, kind: &str, url: &str, branch: &str, subdir: &str) -> PathBuf {
    let mut name = repo_name(url);
    let b = branch.trim();
    if !b.is_empty() && b != "main" && b != "master" {
        name.push('-');
        name.push_str(&slug(b));
    }
    let sd = subdir.trim();
    if !sd.is_empty() {
        name.push('-');
        name.push_str(&slug(sd));
    }
    hub.join("sources").join(kind).join(name)
}

/// clone 或 fetch；返回 (commit 短哈希, resolved_branch, 非致命警告)。
pub fn ensure_cache(
    cache: &Path,
    url: &str,
    branch: &str,
    _auth_ref: Option<&str>,
) -> std::result::Result<(String, Option<String>, Option<String>), String> {
    if !cache.join(".git").is_dir() {
        if let Some(parent) = cache.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut args = vec!["clone", "--filter=blob:none"];
        let br = valid_branch(branch).then(|| branch.to_string());
        let branch_owned;
        if let Some(b) = &br {
            args.push("--branch");
            branch_owned = b.clone();
            args.push(&branch_owned);
        }
        let url_s = url.to_string();
        let cache_s = cache.to_string_lossy().to_string();
        args.push(&url_s);
        args.push(&cache_s);
        let r = run_git(&args, None, Duration::from_secs(600));
        if r.code != 0 {
            let _ = std::fs::remove_dir_all(cache);
            return Err(masked(&if r.err.is_empty() { r.out } else { r.err }));
        }
    } else {
        if valid_branch(branch) {
            let br = branch.to_string();
            let r = run_git(&["fetch", "--prune", "origin", &br], Some(cache), Duration::from_secs(300));
            if r.code != 0 {
                return Err(masked(&if r.err.is_empty() { r.out } else { r.err }));
            }
            let reset_to = format!("origin/{branch}");
            let r = run_git(&["reset", "--hard", &reset_to], Some(cache), Duration::from_secs(120));
            if r.code != 0 {
                let r = run_git(&["reset", "--hard", "FETCH_HEAD"], Some(cache), Duration::from_secs(120));
                if r.code != 0 {
                    return Err(masked(&if r.err.is_empty() { r.out } else { r.err }));
                }
            }
        } else {
            let r = run_git(&["fetch", "--prune", "origin"], Some(cache), Duration::from_secs(300));
            if r.code != 0 {
                return Err(masked(&if r.err.is_empty() { r.out } else { r.err }));
            }
            let r = run_git(&["reset", "--hard", "FETCH_HEAD"], Some(cache), Duration::from_secs(120));
            if r.code != 0 {
                return Err(masked(&if r.err.is_empty() { r.out } else { r.err }));
            }
        }
    }
    let r = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], Some(cache), Duration::from_secs(30));
    let resolved = if r.code == 0 { Some(r.out.trim().to_string()) } else { None };
    let r = run_git(&["rev-parse", "--short", "HEAD"], Some(cache), Duration::from_secs(30));
    if r.code != 0 {
        return Err("读取本地缓存提交失败".into());
    }
    Ok((r.out.trim().to_string(), resolved, None))
}

fn masked(s: &str) -> String {
    // 不向外暴露完整 URL 凭据：token 形态一律打码
    let mut out = String::new();
    for tok in s.split_whitespace() {
        if tok.contains("://") && tok.contains('@') {
            if let Some(idx) = tok.find("://") {
                out.push_str(&tok[..idx + 3]);
                out.push_str("***@");
                if let Some(slash) = tok[idx + 3..].find('/') {
                    out.push_str(&tok[idx + 3 + slash + 1..]);
                }
                out.push(' ');
                continue;
            }
        }
        out.push_str(tok);
        out.push(' ');
    }
    out.trim().chars().take(300).collect()
}

/// `git ls-tree -r <commit>` → {相对 subdir 路径: blob hash}。
pub fn ls_tree(cache: &Path, commit: &str, subdir: &str) -> BTreeMap<String, String> {
    let r = run_git(&["ls-tree", "-r", commit], Some(cache), Duration::from_secs(60));
    let mut files = BTreeMap::new();
    if r.code != 0 {
        return files;
    }
    let prefix = if subdir.trim().is_empty() {
        String::new()
    } else {
        format!("{}/", subdir.trim().trim_matches('/'))
    };
    for line in r.out.lines() {
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let mut it = meta.split_whitespace();
        let _mode = it.next();
        let _typ = it.next();
        let Some(blob) = it.next() else { continue };
        if !prefix.is_empty() {
            if !path.starts_with(&prefix) {
                continue;
            }
            files.insert(path[prefix.len()..].to_string(), blob.to_string());
        } else {
            files.insert(path.to_string(), blob.to_string());
        }
    }
    files
}

pub fn show_bytes(cache: &Path, commit: &str, path: &str) -> Option<Vec<u8>> {
    let spec = format!("{commit}:{path}");
    let r = run_git(&["show", &spec], Some(cache), Duration::from_secs(60));
    if r.code != 0 {
        return None;
    }
    Some(r.out.into_bytes())
}

/// 极简 YAML frontmatter 子集：--- 块内 key: value。
pub fn parse_frontmatter(text: &str) -> BTreeMap<String, String> {
    let mut fm = BTreeMap::new();
    if !text.starts_with("---") {
        return fm;
    }
    let Some(end) = text[3..].find("\n---") else { return fm };
    for line in text[3..3 + end].lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        fm.insert(
            k.trim().to_string(),
            v.trim().trim_matches('"').trim_matches('\'').to_string(),
        );
    }
    fm
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SourceItem {
    pub name: String,
    pub path: String,
    pub source_hash: String,
    pub version: Option<String>,
    pub meta: serde_json::Value,
}

/// skills 目录约定：任意深度下含 SKILL.md 的目录 = 一个 skill。
pub fn parse_skills(
    files: &BTreeMap<String, String>,
    cache: &Path,
    commit: &str,
    subdir: &str,
) -> Vec<SourceItem> {
    use sha2::{Digest, Sha256};
    // 收集含 SKILL.md 的目录
    let mut dirs: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for rel in files.keys() {
        if rel.ends_with("/SKILL.md") || rel == "SKILL.md" {
            let dirpath = rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
            dirs.entry(dirpath).or_default().push(rel);
        }
    }
    let prefix = if subdir.trim().is_empty() {
        String::new()
    } else {
        format!("{}/", subdir.trim().trim_matches('/'))
    };
    let mut out = Vec::new();
    for (dirpath, _) in dirs {
        let name = dirpath.rsplit('/').next().unwrap_or("root-skill").to_string();
        let skill_md_rel = if dirpath.is_empty() {
            "SKILL.md".to_string()
        } else {
            format!("{dirpath}/SKILL.md")
        };
        let dir_prefix = if dirpath.is_empty() {
            String::new()
        } else {
            format!("{dirpath}/")
        };
        let dir_files: BTreeMap<&String, &String> = files
            .iter()
            .filter(|(p, _)| {
                p.starts_with(&dir_prefix) && !p.starts_with(&format!("{dir_prefix}.versions/"))
            })
            .collect();
        if !dir_files.contains_key(&skill_md_rel) {
            continue; // 只有 skill.json 没 SKILL.md 的目录跳过
        }
        let fm = show_bytes(cache, commit, &skill_md_rel)
            .and_then(|raw| String::from_utf8(raw).ok())
            .map(|t| parse_frontmatter(&t))
            .unwrap_or_default();
        let mut h = Sha256::new();
        for (p, bh) in &dir_files {
            h.update(p.as_bytes());
            h.update(b"\x00");
            h.update(bh.as_bytes());
            h.update(b"\n");
        }
        let full_path = if prefix.is_empty() {
            if dirpath.is_empty() { ".".to_string() } else { dirpath.clone() }
        } else if dirpath.is_empty() {
            prefix.trim_end_matches('/').to_string()
        } else {
            format!("{prefix}{dirpath}")
        };
        out.push(SourceItem {
            name: fm.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or(name),
            path: full_path,
            source_hash: hex::encode(h.finalize()),
            version: fm.get("version").filter(|v| !v.is_empty()).cloned(),
            meta: serde_json::json!({"description": fm.get("description").cloned().unwrap_or_default()}),
        });
    }
    // 去重
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|s| seen.insert(s.name.clone()));
    out
}

/// mcp 目录约定：subdir 内 mcp.json（集合/单条/映射）与 mcp/*.json。
pub fn parse_mcp(
    files: &BTreeMap<String, String>,
    cache: &Path,
    commit: &str,
    subdir: &str,
) -> Vec<SourceItem> {
    use sha2::{Digest, Sha256};
    let prefix = if subdir.trim().is_empty() {
        String::new()
    } else {
        format!("{}/", subdir.trim().trim_matches('/'))
    };
    let mut candidates: Vec<&String> = files
        .keys()
        .filter(|rel| {
            rel.ends_with(".json")
                && (rel.ends_with("/mcp.json") || rel.as_str() == "mcp.json" || rel.starts_with("mcp/"))
        })
        .collect();
    candidates.sort();
    let mut out = Vec::new();
    for rel in candidates {
        let Some(raw) = show_bytes(cache, commit, rel) else { continue };
        let Ok(text) = String::from_utf8(raw) else { continue };
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let mut entries: Vec<(String, serde_json::Value)> = Vec::new();
        if let Some(servers) = data.get("mcpServers").and_then(|s| s.as_object()) {
            entries.extend(servers.iter().map(|(k, v)| (k.clone(), v.clone())));
        } else if data.is_object() && (data.get("command").is_some() || data.get("url").is_some()) {
            let nm = data
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    Path::new(rel)
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
            let mut cfg = data.clone();
            if let Some(o) = cfg.as_object_mut() {
                o.remove("name");
            }
            entries.push((nm, cfg));
        } else if let Some(o) = data.as_object() {
            entries.extend(
                o.iter()
                    .filter(|(_, v)| v.is_object())
                    .map(|(k, v)| (k.clone(), v.clone())),
            );
        }
        for (name, cfg) in entries {
            if let Some(norm) = crate::mcputil::normalize_entry(&cfg, &name) {
                let canon = serde_json::to_string(
                    &remap_sorted(&norm),
                )
                .unwrap_or_default();
                let mut h = Sha256::new();
                h.update(canon.as_bytes());
                out.push(SourceItem {
                    name,
                    path: format!("{prefix}{rel}"),
                    source_hash: hex::encode(h.finalize()),
                    version: None,
                    meta: norm,
                });
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|s| seen.insert(s.name.clone()));
    out
}

fn remap_sorted(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut out = serde_json::Map::new();
            for (k, val) in m {
                out.insert(k.clone(), remap_sorted(val));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn _unused(e: CoreError) -> CoreError {
    e
}

#[allow(dead_code)]
pub fn result_stub() -> Result<()> {
    Ok(())
}
