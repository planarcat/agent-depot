//! 工具注册表（对位 hub/tools_registry.py）：config 表 key="tools"（覆盖项 JSON）
//! + 内置常量合并。tools 无独立表——任何「tools 表」查询都是错的。

use rusqlite::Connection;
use serde_json::{json, Value};

/// 内置工具（Python BUILTIN_TOOLS 逐字段对齐；color 槽位一致）。
pub const BUILTIN_TOOLS: &str = r#"[
 {"id":"claude","name":"Claude Code","adapter":"claude","builtin":true,"color":1,
  "skills_dir":"~/.claude/skills","mcp_config":"~/.claude.json","mcp_format":"mcpServers"},
 {"id":"codex","name":"Codex CLI","adapter":"codex","builtin":true,"color":2,
  "skills_dir":"~/.agents/skills","mcp_config":"~/.codex/config.toml","mcp_format":null},
 {"id":"opencode","name":"OpenCode","adapter":"opencode","builtin":true,"color":3,
  "skills_dir":"~/.agents/skills","mcp_config":"~/.config/opencode/opencode.json","mcp_format":"mcp"},
 {"id":"workbuddy","name":"WorkBuddy","adapter":"workbuddy","builtin":true,"color":4,
  "root":"~/.workbuddy/projects","skills_dir":"~/.workbuddy/skills",
  "mcp_config":"~/.workbuddy/mcp.json","mcp_format":"mcpServers"},
 {"id":"zcode","name":"ZCode","adapter":"zcode","builtin":true,"color":5,
  "root":"~/.zcode/cli/db/db.sqlite","skills_dir":"~/.zcode/skills",
  "mcp_config":"~/.zcode/cli/config.json","mcp_format":"mcp.servers"},
 {"id":"autoclaw","name":"AutoClaw","adapter":"autoclaw","builtin":true,"color":6,
  "root":"~/.openclaw-autoclaw/agents","skills_dir":"~/.openclaw-autoclaw/skills",
  "mcp_config":"~/.openclaw-autoclaw/openclaw.json","mcp_format":"mcp.servers"},
 {"id":"trae-cn","name":"Trae CN","adapter":"trae-cn","builtin":true,"color":7,
  "root":"~/.trae-cn","skills_dir":"~/.trae-cn/skills",
  "mcp_config":"~/Library/Application Support/Trae CN/User/mcp.json","mcp_format":"mcpServers"},
 {"id":"agents","name":"Agents","adapter":"agents","builtin":true,"color":8,
  "skills_dir":"~/.agents/skills"}
]"#;

pub const ADAPTER_LABELS: &[(&str, &str)] = &[
    ("claude", "Claude Code 兼容（JSONL 目录）"),
    ("codex", "Codex 兼容（JSONL 目录）"),
    ("opencode", "OpenCode（SQLite 文件）"),
    ("pi", "Pi-Agent（JSONL 目录）"),
    ("cursor", "Cursor（composer 数据库）"),
    ("workbuddy", "WorkBuddy（JSONL 目录）"),
    ("zcode", "ZCode（SQLite 文件）"),
    ("autoclaw", "AutoClaw（JSONL 目录）"),
    ("trae-cn", "Trae CN（会话库加密，暂不可采集）"),
    ("agents", "共享技能目录（仅 Skills 分发，无会话采集）"),
];

pub fn adapter_root_default(adapter: &str) -> Option<&'static str> {
    Some(match adapter {
        "claude" => "~/.claude/projects",
        "codex" => "~/.codex",
        "opencode" => "~/.local/share/opencode/opencode.db",
        "pi" => "~/.pi/agent/sessions",
        "cursor" => "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        "workbuddy" => "~/.workbuddy/projects",
        "zcode" => "~/.zcode/cli/db/db.sqlite",
        "autoclaw" => "~/.openclaw-autoclaw/agents",
        "trae-cn" => "~/.trae-cn",
        "agents" => "~/.agents/skills",
        _ => return None,
    })
}

pub fn get_config(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM config WHERE key=?1", [key], |r| r.get(0))
        .ok()
}

pub fn set_config(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT INTO config(key, value) VALUES(?1,?2) \
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![key, value],
    );
}

fn saved_entries(conn: &Connection) -> Vec<Value> {
    get_config(conn, "tools")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|v| {
            v.as_array()
                .map(|a| {
                    a.iter()
                        .filter(|t| t.is_object() && t.get("id").is_some())
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

pub fn save_tools(conn: &Connection, entries: &[Value]) {
    set_config(conn, "tools", &serde_json::to_string(entries).unwrap_or_default());
}

/// 合并后的工具列表：内置在前、覆盖项合并、自定义按登记顺序；有自定义顺序以它为准。
pub fn load_tools(conn: &Connection) -> Vec<Value> {
    let saved = saved_entries(conn);
    let by_id: std::collections::HashMap<String, &Value> = saved
        .iter()
        .filter_map(|t| t["id"].as_str().map(|s| (s.to_string(), t)))
        .collect();
    let mut tools: Vec<Value> = serde_json::from_str::<Vec<Value>>(BUILTIN_TOOLS)
        .unwrap_or_default()
        .into_iter()
        .map(|mut t| {
            t["enabled"] = json!(true);
            if let Some(s) = t["id"].as_str().and_then(|id| by_id.get(id)) {
                if let Some(en) = s.get("enabled") {
                    t["enabled"] = en.clone();
                }
                if let Some(n) = s.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()) {
                    t["name"] = json!(n.chars().take(60).collect::<String>());
                }
                for k in ["skills_dir", "mcp_config", "mcp_format"] {
                    if let Some(v) = s.get(k) {
                        if !v.is_null() {
                            t[k] = v.clone();
                        }
                    }
                }
            }
            t
        })
        .collect();
    for t in &saved {
        let is_builtin = t["id"]
            .as_str()
            .map(|id| BUILTIN_IDS.contains(&id))
            .unwrap_or(false);
        if is_builtin {
            continue;
        }
        let mut t = t.clone();
        if t.get("enabled").is_none() {
            t["enabled"] = json!(true);
        }
        tools.push(t);
    }
    let order: Vec<String> = get_config(conn, "tools.order")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    if !order.is_empty() {
        let idx: std::collections::HashMap<&str, usize> =
            order.iter().enumerate().map(|(i, s)| (s.as_str(), i)).collect();
        tools.sort_by_key(|t| {
            t["id"]
                .as_str()
                .and_then(|id| idx.get(id).copied())
                .unwrap_or(order.len())
        });
    }
    tools
}

pub const BUILTIN_IDS: &[&str] = &[
    "claude", "codex", "opencode", "workbuddy", "zcode", "autoclaw", "trae-cn", "agents",
];

pub fn tool_by_id(conn: &Connection, tid: &str) -> Option<Value> {
    load_tools(conn).into_iter().find(|t| t["id"].as_str() == Some(tid))
}

pub fn set_order(conn: &Connection, ids: &[Value]) -> Vec<String> {
    let all_ids: Vec<String> = load_tools(conn)
        .iter()
        .filter_map(|t| t["id"].as_str().map(|s| s.to_string()))
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    let mut order = Vec::new();
    for i in ids {
        if let Some(s) = i.as_str() {
            if all_ids.contains(&s.to_string()) && seen.insert(s.to_string()) {
                order.push(s.to_string());
            }
        }
    }
    for i in &all_ids {
        if !seen.contains(i) {
            order.push(i.clone());
        }
    }
    set_config(conn, "tools.order", &serde_json::to_string(&order).unwrap_or_default());
    order
}

/// 给 /api/state 的注册表视图（含计数与路径可用性）。
pub fn public_list(conn: &Connection, counts: &Value) -> Vec<Value> {
    load_tools(conn)
        .iter()
        .map(|t| {
            let c = t["id"]
                .as_str()
                .and_then(|id| counts.get(id))
                .cloned()
                .unwrap_or(json!({}));
            let adapter = t["adapter"].as_str().unwrap_or("");
            let root = t
                .get("root")
                .and_then(|r| r.as_str())
                .filter(|r| !r.is_empty())
                .map(|s| s.to_string())
                .or_else(|| adapter_root_default(adapter).map(|s| s.to_string()));
            let root_exists: Value = match root.as_ref() {
                Some(r) => json!(shellexpand(r).exists()),
                None => Value::Null,
            };
            let label = ADAPTER_LABELS
                .iter()
                .find(|(a, _)| *a == adapter)
                .map(|(_, l)| l.to_string())
                .unwrap_or_else(|| adapter.to_string());
            json!({
                "id": t["id"], "name": t["name"], "adapter": t["adapter"],
                "skills_dir": t.get("skills_dir").cloned().unwrap_or(Value::Null),
                "mcp_config": t.get("mcp_config").cloned().unwrap_or(Value::Null),
                "mcp_format": t.get("mcp_format").cloned().unwrap_or(Value::Null),
                "builtin": t.get("builtin").and_then(|b| b.as_bool()).unwrap_or(false),
                "enabled": t.get("enabled").and_then(|b| b.as_bool()).unwrap_or(true),
                "color": t.get("color").and_then(|c| c.as_i64()).unwrap_or(0),
                "root": root,
                "root_exists": root_exists,
                "count": c.get("count").cloned().unwrap_or(json!(0)),
                "latest": c.get("latest").cloned().unwrap_or(Value::Null),
                "adapter_label": label,
                "root_hint": "",
            })
        })
        .collect()
}

pub fn shellexpand(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        std::path::PathBuf::from(home).join(rest)
    } else {
        std::path::PathBuf::from(p)
    }
}
