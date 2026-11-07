//! MCP 配置归一化（共享）：键白名单 + command/url 必备（对位 catalog._normalize_mcp_entry）。

pub const ALLOWED: [&str; 8] = ["command", "args", "env", "url", "headers", "type", "transport", "cwd"];

/// 归一化单条 server 配置：白名单键 + 需 command 或 url；非法返回 None。
/// 注意：与 depot-mcp::normalize_config 不同，本函数**不内嵌 name 键**
/// （catalog 口径 norm["name"] 仅在 parse 阶段由调用方处理）。
pub fn normalize_entry(cfg: &serde_json::Value, name: &str) -> Option<serde_json::Value> {
    let obj = cfg.as_object()?;
    let mut out = serde_json::Map::new();
    for k in ALLOWED {
        if let Some(v) = obj.get(k) {
            if !v.is_null() {
                out.insert(k.to_string(), v.clone());
            }
        }
    }
    if !out.contains_key("command") && !out.contains_key("url") {
        return None;
    }
    if let Some(env) = out.get("env") {
        if !env.is_object() {
            return None;
        }
    }
    if !out.contains_key("type") {
        let t = if out.contains_key("url") { "http" } else { "stdio" };
        out.insert("type".into(), serde_json::Value::String(t.into()));
    }
    let _ = name;
    Some(serde_json::Value::Object(out))
}

/// 密钥脱敏：保留头 2 尾 2，中间星号（fsutil.mask_secret 对位）。
pub fn mask_secret(v: Option<&str>) -> Option<String> {
    let s = v?;
    if s.len() <= 4 {
        return Some("*".repeat(s.len()));
    }
    let chars: Vec<char> = s.chars().collect();
    let stars = chars.len().saturating_sub(4).max(4);
    Some(format!("{}{}{}", chars[0..2].iter().collect::<String>(),
        "*".repeat(stars),
        chars[chars.len() - 2..].iter().collect::<String>()))
}
