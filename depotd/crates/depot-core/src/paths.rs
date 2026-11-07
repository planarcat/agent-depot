//! 路径解析：hub 目录（env AGENT_HUB_DIR / ~/.agent-depot[-dev] fallback）。
//! 与 Python `hub/paths.py` 同一套解析规则（Tier 2：允许未来演进，但迁移期对齐）。

use std::path::{Path, PathBuf};

/// 解析 hub 数据目录。优先级：env `AGENT_HUB_DIR` > `~/.agent-depot-dev`（当
/// `DEPOT_ENV=dev`）> `~/.agent-depot`。
pub fn hub_dir() -> PathBuf {
    if let Ok(d) = std::env::var("AGENT_HUB_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    if std::env::var("DEPOT_ENV").as_deref() == Ok("dev") {
        return PathBuf::from(home).join(".agent-depot-dev");
    }
    PathBuf::from(home).join(".agent-depot")
}

/// registry/skills 与 registry/mcp 根（默认库条目落盘位置）。
pub fn registry_root(hub: &Path, kind: &str) -> PathBuf {
    hub.join("registry").join(if kind == "mcp" { "mcp" } else { "skills" })
}

pub fn versions_root(hub: &Path, kind: &str, name: &str) -> PathBuf {
    hub.join("registry")
        .join(".versions")
        .join(if kind == "mcp" { "mcp" } else { "skills" })
        .join(name)
}

/// 确保目录存在。
pub fn ensure_dir(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}
