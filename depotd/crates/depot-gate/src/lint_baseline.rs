//! [lint 基线] 只对「本次变更文件」比对样式告警数，任一文件超基线即红。
//!
//! 为什么要基线：全量零容忍在单人单分支时最严；
//!   一旦有远程仓库、多分支并行，别人分支带进来的存量告警会让所有人的检查一起红，
//!   而且这和你本次改动无关。基线 = 只登记存量，**新增**才拦。
//!
//! 「本次变更」怎么算（多分支安全）：
//!   1. 基点 = 下列候选与 HEAD 的 merge-base 中**离 HEAD 最近**的那个：
//!        $LINT_BASE（pre-push 会传远端 sha）> 上游 @{u} > origin 默认分支 > 本地 main/master
//!      取「最近」能同时覆盖：上游是自己同名分支、从 main 合并过、rebase 到新 main 之后。
//!   2. 已提交部分只走 first-parent 链：
//!        普通提交 → 它改的文件；合并提交 → 只算「与所有父提交都不同」的文件（冲突解决 / evil merge），
//!        对方分支带进来的文件不算你的。
//!   3. 未提交部分 = 工作区相对 HEAD 的改动 + 未跟踪文件；
//!      合并进行中（有 MERGE_HEAD）时，内容与 MERGE_HEAD 一致的文件 = 对方带入，不算。
//!   4. 门禁本体（depot-gate 源码 crate）或基线文件被改 → 自动切全量模式。
//!   5. 不在 git 仓库 / 还没有提交 / 没有任何参照分支（无远程的单机仓）→ 全量模式。
//!
//! 基线只许降、不许静默升：
//!   --ratchet  把已改善的文件下调到当前值（永不上调）
//!   --init     基线文件不存在时按当前全量结果生成（已存在则拒绝）
//!   上调只能手改 scripts/lint-baseline.json —— 提交门禁会拦下，走 LOCAL_GUARD_OK=1 留痕。
//!
//! 来源：原 scripts/lint_baseline.py（2026-11-17 迁入 Rust）。git 全部子进程调 CLI，
//! 命令与参数与 Python 版逐条相同，语义零漂移。输出文案是判据测试的断言契约，勿改。

use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::styles;

const BASELINE_REL: &str = "scripts/lint-baseline.json";
const BASELINE_NOTE: &str = "lint 存量登记（depot-gate lint-baseline 读取）。只许降（--ratchet），不许静默升；手改升高须走提交门禁留痕（LOCAL_GUARD_OK=1，commit 写清理由）。";
const RULE_SOURCE: &str = "depot-gate 内建（原 tests/lint_styles.py）";

/// 门禁本体路径（相对仓根）：其中任一文件被本次变更触及 → 全量模式。
fn is_full_trigger(changed: &str) -> bool {
    changed == BASELINE_REL || changed.starts_with("depotd/crates/depot-gate/")
}

#[derive(Debug)]
pub struct Opts {
    pub all: bool,
    pub explain: bool,
    pub ratchet: bool,
    pub init: bool,
}

// --------------------------------------------------------------------------- git

/// 等价 Python 版 `git(*args)`：`git -c core.quotepath=off …`，cwd=仓根，返回 (rc, stdout)。
fn git(root: &Path, args: &[&str]) -> (i32, String) {
    let out = Command::new("git")
        .arg("-c")
        .arg("core.quotepath=off")
        .args(args)
        .current_dir(root)
        .output();
    match out {
        Ok(o) => (
            o.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&o.stdout).into_owned(),
        ),
        Err(_) => (-1, String::new()),
    }
}

fn git_ok(root: &Path, args: &[&str]) -> Option<String> {
    let (rc, out) = git(root, args);
    if rc == 0 {
        Some(out.trim().to_string())
    } else {
        None
    }
}

fn names_z(out: &str) -> Vec<String> {
    out.split('\0')
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
}

/// 返回 (基点 commit | None, 说明)。None = 没有可用提交（全量）。
fn resolve_base(root: &Path) -> (Option<String>, String) {
    if git_ok(root, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return (None, "不在 git 仓库".into());
    }
    let head = git_ok(root, &["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    if head.is_none() {
        return (None, "仓库还没有任何提交".into());
    }

    let mut cands: Vec<(String, String)> = Vec::new(); // (说明, 参照)
    let env_base = std::env::var("LINT_BASE").unwrap_or_default();
    let env_base = env_base.trim();
    if !env_base.is_empty() {
        cands.push(("$LINT_BASE".into(), env_base.into()));
    }
    if let Some(up) = git_ok(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        cands.push((format!("上游 {up}"), up));
    }
    if let Some(origin_head) = git_ok(root, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) {
        cands.push((
            format!(
                "origin 默认分支 {}",
                origin_head.trim_start_matches("refs/remotes/")
            ),
            origin_head,
        ));
    }
    for b in ["main", "master"] {
        let r = format!("refs/remotes/origin/{b}");
        if git_ok(root, &["rev-parse", "-q", "--verify", &r]).is_some() {
            cands.push((format!("origin/{b}"), r));
        }
    }
    let current = git_ok(root, &["symbolic-ref", "-q", "--short", "HEAD"]).unwrap_or_default();
    for b in ["main", "master"] {
        if b != current && git_ok(root, &["rev-parse", "-q", "--verify", &format!("refs/heads/{b}")]).is_some() {
            cands.push((format!("本地 {b}"), format!("refs/heads/{b}")));
        }
    }

    let mut best: Option<(usize, String, String)> = None; // (距离, 说明, mb)
    for (desc, r) in &cands {
        let verify = format!("{r}^{{commit}}");
        if git_ok(root, &["rev-parse", "-q", "--verify", &verify]).is_none() {
            continue; // 例如 pre-push 传来的远端 sha 本地没有
        }
        let Some(mb) = git_ok(root, &["merge-base", r, "HEAD"]) else {
            continue;
        };
        let dist: usize = git_ok(root, &["rev-list", "--count", &format!("{mb}..HEAD")])
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if best.as_ref().map_or(true, |(d, _, _)| dist < *d) {
            best = Some((dist, desc.clone(), mb));
        }
    }

    let Some((dist, desc, mb)) = best else {
        // 没有任何参照分支（单机仓 / 没远程）→「本次变更」无从定义。
        // 不能退化成「只看未提交」：那样提交到 main 的违规以后再也查不到。全量比对基线才安全。
        return (None, "无上游 / 无默认分支，变更集无从定义".into());
    };
    let short = mb[..8.min(mb.len())].to_string();
    (
        Some(mb),
        format!("merge-base({desc}, HEAD) = {short}（距 HEAD {dist} 个提交）"),
    )
}

fn committed_changes(root: &Path, base: &str) -> HashSet<String> {
    let out = git_ok(
        root,
        &["rev-list", "--first-parent", "--parents", &format!("{base}..HEAD")],
    )
    .unwrap_or_default();
    let mut files = HashSet::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let Some(c) = parts.next() else { continue };
        let parents: Vec<&str> = parts.collect();
        let (_, o) = if parents.len() <= 1 {
            git(
                root,
                &[
                    "diff-tree",
                    "-r",
                    "--no-commit-id",
                    "--name-only",
                    "--no-renames",
                    "-z",
                    "--root",
                    c,
                ],
            )
        } else {
            // 合并提交：只算与「所有」父提交都不同的文件（冲突解决 / evil merge）
            git(
                root,
                &["diff-tree", "-r", "--cc", "--no-commit-id", "--name-only", "-z", c],
            )
        };
        files.extend(names_z(&o));
    }
    files
}

/// 返回 (算你的, 合并带入被排除的)。
fn worktree_changes(root: &Path) -> (HashSet<String>, Vec<String>) {
    let (_, o1) = git(root, &["diff", "--name-only", "--no-renames", "-z", "HEAD"]);
    let (_, o2) = git(root, &["ls-files", "--others", "--exclude-standard", "-z"]);
    let mut files: HashSet<String> = names_z(&o1).into_iter().chain(names_z(&o2)).collect();
    let mut merged_in: Vec<String> = Vec::new();
    if git_ok(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_some() {
        let mut sorted: Vec<&String> = files.iter().collect();
        sorted.sort();
        for f in sorted {
            let p = root.join(f);
            if !p.is_file() {
                continue;
            }
            let theirs = git_ok(root, &["rev-parse", "-q", "--verify", &format!("MERGE_HEAD:{f}")]);
            let mine = git_ok(root, &["hash-object", "--", f]);
            if theirs.is_some() && mine.is_some() && theirs == mine {
                merged_in.push(f.clone());
            }
        }
        for f in &merged_in {
            files.remove(f);
        }
    }
    (files, merged_in)
}

// --------------------------------------------------------------------------- 基线

#[derive(Deserialize)]
struct BaselineFile {
    #[serde(rename = "_说明", default)]
    note: String,
    #[serde(default)]
    rule_source: String,
    #[serde(default)]
    files: BTreeMap<String, u64>,
}

fn load_baseline(path: &Path) -> Option<BaselineFile> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_baseline(path: &Path, note: &str, rule_source: &str, files: &BTreeMap<String, u64>) {
    // 与 Python 版 json.dump(indent=2) 同构：字段顺序固定（_说明 → rule_source → files），
    // 只登记 >0 的存量，键排序，结尾换行。手写序列化以钉死字段顺序。
    let mut s = String::from("{\n");
    s += &format!("  \"_说明\": {},\n", serde_json::to_string(note).expect("note 序列化失败"));
    s += &format!(
        "  \"rule_source\": {},\n",
        serde_json::to_string(rule_source).expect("rule_source 序列化失败")
    );
    let items: Vec<String> = files
        .iter()
        .filter(|(_, v)| **v > 0)
        .map(|(k, v)| format!("    {}: {}", serde_json::to_string(k).unwrap(), v))
        .collect();
    if items.is_empty() {
        s += "  \"files\": {}\n}\n";
    } else {
        s += "  \"files\": {\n";
        s += &items.join(",\n");
        s += "\n  }\n}\n";
    }
    let _ = fs::write(path, s);
}

fn baseline_abs(root: &Path) -> PathBuf {
    root.join(BASELINE_REL)
}

/// 返回退出码。
pub fn run(root: &Path, opts: Opts) -> u32 {
    let baseline_path = baseline_abs(root);
    let scope: Vec<String> = styles::APP_FILES.iter().map(|s| s.to_string()).collect();
    let details: BTreeMap<String, Vec<String>> = scope
        .iter()
        .map(|f| (f.clone(), styles::scan_file(root, f)))
        .collect();
    let count: BTreeMap<&String, usize> = details.iter().map(|(f, v)| (f, v.len())).collect();

    if opts.init {
        if baseline_path.exists() {
            println!(
                "✗ {BASELINE_REL} 已存在 → 拒绝覆盖（只许 --ratchet 下调；上调请手改并走门禁留痕）"
            );
            return 2;
        }
        let files: BTreeMap<String, u64> = count
            .iter()
            .map(|(f, n)| (f.to_string(), *n as u64))
            .collect();
        save_baseline(&baseline_path, BASELINE_NOTE, RULE_SOURCE, &files);
        let cur = load_baseline(&baseline_path).map(|b| b.files).unwrap_or_default();
        let cur_s = serde_json::to_string(&cur).unwrap_or_default();
        println!("[lint 基线] 已生成 {BASELINE_REL}：{cur_s}");
        return 0;
    }

    let Some(base_data) = load_baseline(&baseline_path) else {
        println!("✗ 缺基线文件 {BASELINE_REL} → 先 depot-gate lint-baseline --init");
        return 2;
    };
    let mut allowed = base_data.files.clone();

    if opts.ratchet {
        let mut lowered: Vec<String> = Vec::new();
        let mut refused: Vec<String> = Vec::new();
        for (f, n) in &count {
            let a = allowed.get(*f).copied().unwrap_or(0) as usize;
            if *n < a {
                allowed.insert(f.to_string(), *n as u64);
                lowered.push(format!("{f} {a}→{n}"));
            } else if *n > a {
                refused.push(format!("{f} 当前 {n} > 基线 {a}"));
            }
        }
        save_baseline(&baseline_path, &base_data.note, &base_data.rule_source, &allowed);
        let tail = if lowered.is_empty() {
            String::new()
        } else {
            format!("：{}", lowered.join("；"))
        };
        println!("[lint 基线] ratchet：下调 {} 项{}", lowered.len(), tail);
        for r in &refused {
            println!("  ⛔ 不上调：{r}（新增告警请修掉，不是刷基线）");
        }
        return 0;
    }

    // ---- 推导本次变更集
    let mut merged_in: Vec<String> = Vec::new();
    let (mode, base_desc, changed): (String, String, HashSet<String>);
    if opts.all {
        changed = scope.iter().map(|s| s.to_string()).collect();
        mode = "全量（--all）".into();
        base_desc = "—".into();
    } else {
        let (base, desc) = resolve_base(root);
        match base {
            None => {
                changed = scope.iter().map(|s| s.to_string()).collect();
                mode = format!("全量（{desc}）");
                base_desc = desc;
            }
            Some(base) => {
                let committed = committed_changes(root, &base);
                let (wt, mi) = worktree_changes(root);
                merged_in = mi;
                let mut ch = committed.clone();
                ch.extend(wt.iter().cloned());
                let hits: Vec<&String> = ch.iter().filter(|f| is_full_trigger(f)).collect();
                if !hits.is_empty() {
                    let mut names: Vec<String> = hits.into_iter().map(|s| s.clone()).collect();
                    names.sort();
                    mode = format!("全量（规则或基线被改：{}）", names.join(", "));
                    base_desc = desc;
                    changed = scope.iter().map(|s| s.to_string()).collect();
                } else {
                    mode = "增量".into();
                    base_desc = desc;
                    changed = ch;
                }
                if opts.explain {
                    let mut cs: Vec<String> = committed.into_iter().collect();
                    cs.sort();
                    println!(
                        "  已提交（first-parent）：{}",
                        if cs.is_empty() { "—".into() } else { cs.join(", ") }
                    );
                    let mut ws: Vec<String> = wt.iter().cloned().collect();
                    ws.sort();
                    println!(
                        "  未提交：{}",
                        if ws.is_empty() { "—".into() } else { ws.join(", ") }
                    );
                }
            }
        }
    }

    let targets: Vec<&String> = scope.iter().filter(|f| changed.contains(*f)).collect();
    println!("[lint 基线] 模式：{mode} · 基点：{base_desc}");
    let mi_tail = if merged_in.is_empty() {
        String::new()
    } else {
        let mut mi = merged_in.clone();
        mi.sort();
        format!("（合并带入、不计：{}）", mi.join(", "))
    };
    println!(
        "            本次变更命中 lint 范围 {}/{} 个文件{}",
        targets.len(),
        scope.len(),
        mi_tail
    );

    let mut failed = 0;
    let mut improved: Vec<String> = Vec::new();
    for &f in &targets {
        let n = count[f];
        let a = allowed.get(f).copied().unwrap_or(0) as usize;
        if n > a {
            failed += 1;
            println!("  ✗ {f} 告警 {n} > 基线 {a}（新增 {}）：", n - a);
            for v in details[f].iter().take(30) {
                println!("      - {v}");
            }
        } else {
            println!("  ✓ {f} 告警 {n} ≤ 基线 {a}");
            if n < a {
                improved.push(f.clone());
            }
        }
    }
    if !improved.is_empty() {
        println!(
            "  ↓ 已改善：{} → 可 depot-gate lint-baseline --ratchet 下调基线",
            improved.join(", ")
        );
    }

    if failed > 0 {
        println!("[lint 基线] FAILED：{failed} 个文件超基线。修掉新增告警（不要刷基线）。");
        return 1;
    }
    println!("[lint 基线] PASSED");
    0
}
