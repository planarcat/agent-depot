//! [钉桩] 测试软改松检查 —— 扫描测试文件里的 skip / only / todo。
//!
//! 能力边界：只做文本断言，不解析 AST；
//! 覆盖不了「动态拼接出来的 skip」和「用 if 包住整个用例」（那类要靠代码审查）。
//! 用途：测试是判据 —— unittest.skip / it.only / xit 这类软改松 = 判据悄悄失效。
//! 这里一律红灯，逼着走「解锁 + 留痕」的正门：
//!   真需要跳过时，在那一行加 `spec-guard: allowed <为什么>` 就是留痕（会在输出里列出来）。
//!
//! 来源：原 scripts/check_spec_guards.py（由 JS 版 checkSpecGuards.mjs 适配，2026-11-17 迁入 Rust）。
//! 扫描范围：tests/ 下 *.py 与 *.mjs（.py 在 spec 真源迁走后自然 no-op，保留向后兼容）。

use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SKIP_DIRS: [&str; 2] = ["__pycache__", "evidence"]; // evidence = 产出物，不是判据
const ALLOW_MARK: &str = "spec-guard: allowed";

struct Pattern {
    rex: Regex,
    label: &'static str,
}

/// 逐行扫描：注掉整行不算（防止文档性注释误报）
fn patterns() -> Vec<Pattern> {
    vec![
        Pattern {
            rex: Regex::new(r"@\s*unittest\s*\.\s*(?:skip|skipIf|skipUnless|expectedFailure)\b").unwrap(),
            label: "unittest.skip",
        },
        Pattern {
            rex: Regex::new(
                r"@\s*(?:pytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)|pytest\s*\.\s*skip)\b",
            )
            .unwrap(),
            label: "pytest.skip",
        },
        Pattern {
            rex: Regex::new(r"\bunittest\s*\.\s*skip(?:If|Unless)?\s*\(").unwrap(),
            label: "unittest.skip(...)",
        },
        Pattern {
            rex: Regex::new(r"\bself\s*\.\s*skipTest\s*\(").unwrap(),
            label: "self.skipTest(...)",
        },
        Pattern {
            rex: Regex::new(r"@\s*(?:skip|skipIf|skipUnless)\s*\(").unwrap(),
            label: "裸 skip 装饰器",
        },
        Pattern {
            rex: Regex::new(r"\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo|fails)\b").unwrap(),
            label: "skip/only/todo",
        },
        Pattern {
            rex: Regex::new(r"\b(?:xit|xdescribe|xtest)\s*\(").unwrap(),
            label: "xit/xdescribe/xtest",
        },
    ]
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#') || t.starts_with("//") || t.starts_with('*') || t.starts_with("/*")
}

fn is_test_file(name: &str) -> bool {
    name.ends_with(".py") || name.ends_with(".mjs")
}

fn collect_files(tests: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in WalkDir::new(tests).into_iter().filter_entry(|e| {
        // 跳过产出物目录：整棵剪掉，不进去
        !e.file_type().is_dir() || !SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref())
    }) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if is_test_file(&name) {
            files.push(entry.into_path());
        }
    }
    files.sort();
    files
}

/// 返回退出码：0 = 干净或无 tests/，1 = 有软改松。
pub fn run(root: &Path) -> u32 {
    let tests = root.join("tests");
    if !tests.is_dir() {
        println!("[钉桩] check_spec_guards：仓里没有 tests/ → 不检查（不新建空目录凑数）");
        return 0;
    }

    let pats = patterns();
    let files = collect_files(&tests);
    let mut violations: Vec<String> = Vec::new();
    let mut allowed: Vec<String> = Vec::new();

    for path in &files {
        let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned();
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        for (ln, line) in content.split('\n').enumerate() {
            let ln = ln + 1;
            if is_comment(line) {
                continue;
            }
            for p in &pats {
                let Some(m) = p.rex.find(line) else { continue };
                let hit = format!("{}:{} 出现 {}（{}）", rel, ln, p.label, m.as_str().trim());
                if line.contains(ALLOW_MARK) {
                    allowed.push(hit);
                } else {
                    violations.push(hit);
                }
                break; // 一行只报一次（同一行可能命中多条规则，重复报是噪音）
            }
        }
    }

    for a in &allowed {
        println!("· 留痕放行 {a}");
    }
    for v in &violations {
        println!("✗ {v} —— 测试被软改松，走解锁+留痕的正门");
    }

    println!(
        "\n[钉桩] check_spec_guards：{} 个判据文件扫完，软改松 {} 处（留痕放行 {} 处）",
        files.len(),
        violations.len(),
        allowed.len()
    );
    if !violations.is_empty() {
        println!("自救：① 测试文件改不动 = 被锁 → bash scripts/unlock-tests.sh（改完锁回）");
        println!("     ② 确实必须跳过 → 同一行加 `spec-guard: allowed <理由>`，并在 commit message 写清口径");
        return 1;
    }
    0
}
