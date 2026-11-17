//! Style lint 规则本体（原 tests/lint_styles.py，2026-11-17 随「去 Python 化」内建进 depot-gate）。
//!
//! Rules:
//! - No hex colors in app files (html / app.css / hub-ui.css) — tokens only.
//! - No hardcoded px font-size in app files.
//! - No bare-number z-index (use var(--z-*)); `0` / `-1` allowed as resets.
//! - tokens.css is the single source of truth (exempt).
//!
//! 详见 DESIGN.md §11 禁止项。违规条目格式 `{rel}:{line} <原因>` 是 lint_baseline
//! 展示与判据测试断言的契约，勿改。

use regex::Regex;
use std::fs;
use std::path::Path;

/// lint 范围：固定 3 个界面文件；tokens.css 豁免（唯一真源）。
pub const APP_FILES: [&str; 3] = ["web/index.html", "web/app.css", "web/hub-ui.css"];

/// 扫单个文件，返回违规条目列表（不存在则为空）。
pub fn scan_file(root: &Path, rel: &str) -> Vec<String> {
    let mut violations = Vec::new();
    let path = root.join(rel);
    let Ok(content) = fs::read_to_string(path) else {
        return violations;
    };
    let hex = Regex::new(r"#[0-9a-fA-F]{3,8}\b").unwrap();
    let fs_px = Regex::new(r"font-size\s*:\s*\d+(\.\d+)?px").unwrap();
    let zindex = Regex::new(r"z-index\s*:\s*(-?\d+)").unwrap();

    for (i, line) in content.split('\n').enumerate() {
        let ln = i + 1;
        let stripped = line.trim();
        // 朴素块注释跳过（与 Python 版一致：剥首尾空白后看开头）
        if stripped.starts_with("<!--") || stripped.starts_with('*') || stripped.starts_with("/*") {
            continue;
        }
        for m in hex.find_iter(line) {
            violations.push(format!(
                "{rel}:{ln} hex color {} → use var(--c-*)",
                m.as_str()
            ));
        }
        for _ in fs_px.find_iter(line) {
            violations.push(format!("{rel}:{ln} px font-size → use var(--fs-*)"));
        }
        for m in zindex.captures_iter(line) {
            let n = &m[1];
            if n == "0" || n == "-1" {
                continue; // 重置值豁免
            }
            violations.push(format!("{rel}:{ln} bare z-index {n} → use var(--z-*)"));
        }
    }
    violations
}

/// 独立入口：手动跑样式 lint（原 `python3 tests/lint_styles.py`）。返回退出码。
pub fn run(root: &Path) -> u32 {
    let mut violations = Vec::new();
    for rel in APP_FILES {
        violations.extend(scan_file(root, rel));
    }
    if !violations.is_empty() {
        println!("STYLE LINT FAILED ({} violations):", violations.len());
        for v in violations.iter().take(40) {
            println!("  - {v}");
        }
        return 1;
    }
    println!(
        "STYLE LINT PASSED: {} files, no hardcoded colors/font-sizes/z-index",
        APP_FILES.len()
    );
    0
}
