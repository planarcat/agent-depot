//! Git 源接入（对位 hub/lib/gitsrc.py + catalog.py）：git CLI 子进程 +
//! 源缓存目录 + skills/mcp 目录解析。Tier 2 内部实现，行为对齐 Python。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::error::{CoreError, Result};

pub struct GitOut {
    pub code: i32,
    pub out: String,
    pub err: String,
}

/// 带真实超时的子进程运行（对位 Python subprocess.run(timeout=…)）：
/// 超时 kill 进程，code=124（与 GNU timeout 惯例一致），err 注明超时。
pub fn run_cmd(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration,
               envs: &[(&str, &str)]) -> GitOut {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_ASKPASS", "echo");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let child = match cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return GitOut { code: -1, out: String::new(), err: e.to_string() },
    };
    let start = std::time::Instant::now();
    let mut child = child;
    let deadline_kill = |c: &mut std::process::Child| {
        let _ = c.kill();
        let _ = c.wait();
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 收尾读输出（进程已退出，管道不会再增长）
                let mut out = String::new();
                let mut err = String::new();
                if let Some(mut io) = child.stdout.take() {
                    use std::io::Read;
                    let _ = io.read_to_string(&mut out);
                }
                if let Some(mut io) = child.stderr.take() {
                    use std::io::Read;
                    let _ = io.read_to_string(&mut err);
                }
                return GitOut {
                    code: status.code().unwrap_or(-1),
                    out,
                    err,
                };
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    deadline_kill(&mut child);
                    return GitOut {
                        code: 124,
                        out: String::new(),
                        err: format!("命令超时（{}s）被终止", timeout.as_secs()),
                    };
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                return GitOut { code: -1, out: String::new(), err: e.to_string() };
            }
        }
    }
}

pub fn run_git(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> GitOut {
    run_cmd("git", args, cwd, timeout, &[])
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
        let raw = if parts.len() >= 2 {
            format!("{}-{}", parts[parts.len() - 2], parts[parts.len() - 1])
        } else {
            parts.last().copied().unwrap_or("repo").to_string()
        };
        return slug(&raw);
    }
    // 本地路径取末级目录名；过 slug 清洗（Python 同款），空/危险名（".."）回落 "repo"
    let base = Path::new(&s)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| s.clone());
    let cleaned = slug(&base);
    if cleaned.is_empty() {
        "repo".into()
    } else {
        cleaned
    }
}

/// 对位 hub/paths.py:_slug：保留字母数字与 . _ -（含 CJK 等非 ASCII 字母），
/// 其余转 -，压缩连续 -，去掉首尾 - 和 .
fn slug(s: &str) -> String {
    let mapped: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in mapped.chars() {
        if ch == '-' {
            if !prev_dash {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(ch);
            prev_dash = false;
        }
    }
    out.trim_matches(|c| c == '-' || c == '.').to_string()
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
/// 已知差异（vs Python gitsrc.py）：`auth_ref` 未移植（resolve_auth 的 env:/file:
/// 凭据注入与 ASKPASS 告警链缺失），传入恒被忽略——私有仓库需预置凭据（如
/// credential helper），或先补实现再迁移此类源。
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
    // 打码范围仅覆盖 URL 内嵌凭据（scheme://…@…）；Python _masked 还会按
    // 环境变量 token 做全局替换——本实现未移植该分支
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
        // 根级 SKILL.md（dirpath 为空）→ Python 口径名 "root-skill"
        let name = if dirpath.is_empty() {
            "root-skill".to_string()
        } else {
            dirpath.rsplit('/').next().unwrap_or("root-skill").to_string()
        };
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
            // Rust 简化：仅收集含 SKILL.md 的目录（Python catalog 还认 skill.json，
            // 见 catalog.py:38——本实现未移植该分支）
            continue;
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
            if let Some(mut norm) = crate::mcputil::normalize_entry(&cfg, &name) {
                // hash 口径与 Python catalog.parse_mcp 完全一致：
                // sha256(json.dumps(带 name 的 norm, sort_keys=True, ensure_ascii=False))
                // （紧凑键序不一致会让迁移后的 items.source_hash 全部失配 → 首轮全量伪变更）
                if let Some(o) = norm.as_object_mut() {
                    // Python norm 的 name 在最前，但 sort_keys 会重排——插入顺序无关
                    o.insert("name".into(), Value::String(name.clone()));
                }
                let canon = python_json_sorted(&norm);
                let mut h = Sha256::new();
                h.update(canon.as_bytes());
                // meta 里不落 name（与 normalize_entry 既有语义一致：写入时的 name 由 key 表达）
                if let Some(o) = norm.as_object_mut() {
                    o.remove("name");
                }
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

pub fn _unused(e: CoreError) -> CoreError {
    e
}

#[allow(dead_code)]
pub fn result_stub() -> Result<()> {
    Ok(())
}

/// Python `json.dumps(obj, sort_keys=True, ensure_ascii=False)` 默认分隔符等价实现
/// （`, ` / `: `；字符串走标准 JSON 转义；键序递归排序）。仅用于 source_hash 口径对齐。
fn python_json_sorted(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}: {}", serde_json::to_string(k).unwrap_or_default(), python_json_sorted(&m[*k])))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(python_json_sorted).collect();
            format!("[{}]", parts.join(", "))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}
