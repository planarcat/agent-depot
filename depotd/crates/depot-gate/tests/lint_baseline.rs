//! lint 基线（depot-gate lint-baseline）判据：多分支 / 合并 / rebase 场景下只拦「本次新增」。
//!
//! （原 tests/test_lint_baseline.py，2026-11-17 随「去 Python 化」翻译为 cargo 判据；
//! 用例编号与断言文案一一对应，输出文案改了必须同步改这里。）
//!
//! 每个用例都在临时目录里建真实的 git 环境：bare 远程 + 工作克隆（+ 第二个克隆模拟同事），
//! 跑 depot-gate 二进制（CARGO_BIN_EXE 注入），不碰本仓 git 状态。
//!
//! 初始 main：
//!   web/hub-ui.css 有 2 条存量告警，基线登记 {"web/hub-ui.css": 2}
//!   web/app.css / web/index.html 干净；other.txt 为普通文件
//!   depotd/crates/depot-gate/src/lib.rs 为门禁本体占位（改它 = 切全量，test_11 用）
//!
//! ⚠ 环境泄漏防线（AGENTS.md 钩子泄漏教训）：子进程 env 显式剥掉
//! GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / LINT_BASE，别让夹具 git 写进真实仓库。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// CARGO_BIN_EXE_* 只在测试进程运行时注入，不能 env! 编译期取。
/// 新版 cargo 用原始名（带连字符），老版转下划线——两个名字都试。
fn bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        std::env::var("CARGO_BIN_EXE_depot-gate")
            .or_else(|_| std::env::var("CARGO_BIN_EXE_depot_gate"))
            .expect("cargo 未注入 CARGO_BIN_EXE_depot-gate")
    })
}

// ------------------------------------------------------------------ 环境与进程

fn apply_env(c: &mut Command, home: &Path) {
    c.env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("LINT_BASE")
        .env("HOME", home)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@localhost")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@localhost")
        .env("GIT_CONFIG_NOSYSTEM", "1");
}

/// 跑 git，返回 (rc, stdout+stderr)。check=true 时失败即 panic（对齐 Python 版 AssertionError）。
fn git_cmd(cwd: &Path, home: &Path, args: &[&str], check: bool) -> (i32, String) {
    let mut c = Command::new("git");
    c.args(args).current_dir(cwd);
    apply_env(&mut c, home);
    let out = c.output().unwrap_or_else(|e| panic!("起 git 进程失败：{e}"));
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let rc = out.status.code().unwrap_or(-1);
    if check && rc != 0 {
        panic!("git {} 失败：{}", args.join(" "), text);
    }
    (rc, text)
}

fn gate_cmd(cwd: &Path, home: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> (i32, String) {
    let mut c = Command::new(bin());
    c.args(args).current_dir(cwd);
    apply_env(&mut c, home);
    for (k, v) in extra_env {
        c.env(k, v);
    }
    let out = c.output().unwrap_or_else(|e| panic!("起 depot-gate 进程失败：{e}"));
    (
        out.status.code().unwrap_or(-1),
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    )
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == ".git" {
            continue; // 等价 shutil.ignore_patterns(".git")——带过去就不是「无远程单机仓」了
        }
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
        }
    }
}

// ------------------------------------------------------------------ 夹具

struct Repo {
    path: PathBuf,
    home: PathBuf,
}

impl Repo {
    fn git(&self, args: &[&str]) -> (i32, String) {
        git_cmd(&self.path, &self.home, args, true)
    }

    fn git_may_fail(&self, args: &[&str]) -> (i32, String) {
        git_cmd(&self.path, &self.home, args, false)
    }

    fn write(&self, rel: &str, text: &str) {
        let p = self.path.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn append(&self, rel: &str, text: &str) {
        use std::io::Write;
        let p = self.path.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(p).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn commit(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }

    fn lint(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, String) {
        let mut full = vec!["lint-baseline"];
        full.extend(args);
        gate_cmd(&self.path, &self.home, &full, env)
    }

    /// 独立规则 lint（原 tests/lint_styles.py 手动入口）：全量零容忍，退出码即结果。
    fn full_lint(&self) -> i32 {
        gate_cmd(&self.path, &self.home, &["styles"], &[]).0
    }

    fn baseline(&self) -> serde_json::Value {
        let text = fs::read_to_string(self.path.join("scripts/lint-baseline.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        v["files"].clone()
    }

    fn rev_parse(&self, r: &str) -> String {
        let (_, out) = self.git(&["rev-parse", r]);
        out.trim().to_string()
    }
}

struct Fixture {
    tmp: tempfile::TempDir,
    me: Repo,
}

fn clone(origin: &Path, path: PathBuf, home: &Path) -> Repo {
    let mut c = Command::new("git");
    c.args(["clone", "-q"]).arg(origin).arg(&path).current_dir(path.parent().unwrap());
    apply_env(&mut c, home);
    let st = c.status().unwrap_or_else(|e| panic!("起 git 进程失败：{e}"));
    assert!(st.success(), "clone 失败");
    Repo { path, home: home.to_path_buf() }
}

fn setup() -> Fixture {
    let tmp = tempfile::tempdir().expect("建临时目录失败");
    let home = tmp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let origin = tmp.path().join("origin.git");
    git_cmd(
        tmp.path(),
        &home,
        &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()],
        true,
    );
    let me = clone(&origin, tmp.path().join("me"), &home);
    me.write("web/index.html", "<html><body>ok</body></html>\n");
    me.write("web/app.css", ".a { color: var(--c-text); }\n");
    me.write("web/hub-ui.css", ".legacy1 { color: #111; }\n.legacy2 { color: #222; }\n");
    me.write("other.txt", "base\n");
    me.write(
        "scripts/lint-baseline.json",
        "{\"rule_source\": \"depot-gate\", \"files\": {\"web/hub-ui.css\": 2}}\n",
    );
    me.write("depotd/crates/depot-gate/src/lib.rs", "// gate 本体占位（改它 = 门禁被改，lint-baseline 切全量）\n");
    me.commit("init");
    me.git(&["push", "-q", "-u", "origin", "main"]);
    me.git(&["remote", "set-head", "origin", "-a"]);
    Fixture { tmp, me }
}

impl Fixture {
    fn feature(&self, name: &str) {
        self.me.git(&["checkout", "-q", "-b", name]);
        self.me.git(&["push", "-q", "-u", "origin", name]);
    }

    /// 同事绕过检查往 main 推了一条 index.html 告警（基线没跟着改）。
    fn colleague_pushes_violation_to_main(&self, also_other: bool) {
        let home = self.me.home.clone();
        let mate = clone(
            &self.tmp.path().join("origin.git"),
            self.tmp.path().join("mate"),
            &home,
        );
        mate.write("web/index.html", "<html><body style=\"color:#f00\">x</body></html>\n");
        if also_other {
            mate.write("other.txt", "theirs\n");
        }
        mate.commit("mate: index 告警");
        mate.git(&["push", "-q", "origin", "main"]);
        self.me.git(&["fetch", "-q", "origin"]);
    }

    /// feat 改 other.txt 并推送；同事在 main 上改 other.txt + 塞 index 告警 → 合并必冲突。
    fn diverge_on_other_txt(&self) {
        self.feature("feat");
        self.me.write("other.txt", "mine\n");
        self.me.commit("feat: 改 other");
        self.me.git(&["push", "-q"]);
        self.colleague_pushes_violation_to_main(true);
    }
}

// ------------------------------------------------------------------ 基本面

#[test]
fn test_01_clean_main_passes() {
    let f = setup();
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("增量"), "{out}");
    assert!(out.contains("命中 lint 范围 0/3"), "{out}");
}

#[test]
fn test_02_feature_new_violation_fails() {
    let f = setup();
    f.feature("feat");
    f.me.append("web/app.css", ".b { color: #fff; }\n");
    f.me.commit("feat: 新增告警");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("web/app.css 告警 1 > 基线 0"), "{out}");
    assert!(out.contains("web/app.css:2 hex color #fff"), "{out}");
}

#[test]
fn test_03_uncommitted_violation_fails() {
    let f = setup();
    f.feature("feat");
    f.me.append("web/app.css", ".b { color: #abcdef; }\n");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("hex color #abcdef"), "{out}");
}

#[test]
fn test_04_legacy_debt_does_not_block_unrelated_work() {
    // 存量告警不拦与之无关的改动——而全量零容忍会把所有人一起拦住（这正是要基线的原因）。
    let f = setup();
    f.feature("feat");
    f.me.write("other.txt", "mine\n");
    f.me.commit("feat: 无关改动");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert_eq!(f.me.full_lint(), 1, "前提：全量 lint 在存量下本应是红的");
}

#[test]
fn test_05_legacy_file_touched_only_new_counts() {
    let f = setup();
    f.feature("feat");
    f.me.append("web/hub-ui.css", ".clean { color: var(--c-ok); }\n");
    f.me.commit("feat: 碰存量文件但不新增");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("web/hub-ui.css 告警 2 ≤ 基线 2"), "{out}");
    f.me.append("web/hub-ui.css", ".bad { color: #333; }\n");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("web/hub-ui.css 告警 3 > 基线 2（新增 1）"), "{out}");
}

// ------------------------------------------------------------------ 合并 / rebase

#[test]
fn test_06_merge_in_progress_excludes_their_files() {
    // 合并进行中：对方带入的文件不算你的（§九 合并期误报）。
    let f = setup();
    f.diverge_on_other_txt();
    let (rc, out) = f.me.git_may_fail(&["merge", "origin/main"]);
    assert_ne!(rc, 0, "前提：other.txt 应冲突，合并停在进行中：{out}");
    let (_, naive) = f.me.git(&["diff", "--name-only", "@{u}"]);
    assert!(naive.contains("web/index.html"), "前提：朴素 diff 会把对方文件算进来：{naive}");
    f.me.write("other.txt", "mine+theirs\n");
    f.me.git(&["add", "other.txt"]);
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("合并带入、不计：web/index.html"), "{out}");
}

#[test]
fn test_07_after_merge_commit_still_excludes_their_files() {
    // 合并已提交但未推送：first-parent + combined diff，对方文件仍不算。
    let f = setup();
    f.diverge_on_other_txt();
    f.me.git_may_fail(&["merge", "origin/main"]);
    f.me.write("other.txt", "mine+theirs\n");
    f.me.git(&["add", "other.txt"]);
    f.me.git(&["commit", "-q", "--no-edit"]);
    let (_, naive) = f.me.git(&["diff", "--name-only", "@{u}..HEAD"]);
    assert!(naive.contains("web/index.html"), "前提：朴素区间 diff 会误报：{naive}");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
}

#[test]
fn test_08_evil_merge_is_caught() {
    // 解冲突时顺手塞进新告警（与两个父提交都不同）→ 必须拦。合并中、合并后都拦。
    let f = setup();
    f.diverge_on_other_txt();
    f.me.git_may_fail(&["merge", "origin/main"]);
    f.me.write("other.txt", "mine+theirs\n");
    f.me.append("web/app.css", ".evil { color: #0f0; }\n");
    f.me.git(&["add", "other.txt", "web/app.css"]);
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("web/app.css 告警 1 > 基线 0"), "{out}");
    f.me.git(&["commit", "-q", "--no-edit"]);
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("web/app.css 告警 1 > 基线 0"), "{out}");
    assert!(!out.contains("web/index.html 告警"), "{out}");
}

#[test]
fn test_09_rebase_onto_new_main_passes() {
    // rebase 到新 main 后：基点取离 HEAD 最近的 merge-base，main 上别人的提交不算。
    let f = setup();
    f.feature("feat");
    f.me.append("web/app.css", ".mine { color: var(--c-ok); }\n");
    f.me.commit("feat: 干净改动");
    f.me.git(&["push", "-q"]);
    f.colleague_pushes_violation_to_main(false);
    f.me.git(&["rebase", "-q", "origin/main"]);
    let (_, naive) = f.me.git(&["diff", "--name-only", "@{u}..HEAD"]);
    assert!(naive.contains("web/index.html"), "前提：只按上游算会误报：{naive}");
    let (rc, out) = f.me.lint(&["--explain"], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("origin"), "{out}");
}

#[test]
fn test_10_pre_push_base_env_is_honored() {
    // pre-push 传入的远端 sha（LINT_BASE）参与选基点；本地没有的 sha 被忽略而不是报错。
    let f = setup();
    f.feature("feat");
    f.me.append("web/app.css", ".b { color: #abc; }\n");
    f.me.commit("feat: 告警");
    let (rc, out) = f.me.lint(&[], &[("LINT_BASE", &"0".repeat(40))]);
    assert_eq!(rc, 1, "{out}");
    let sha = f.me.rev_parse("HEAD");
    let sha_ref = sha.as_str();
    let (rc, out) = f.me.lint(&[], &[("LINT_BASE", sha_ref)]);
    assert_eq!(rc, 0, "{out}"); // 远端已是这个提交 → 没有本次变更
    assert!(out.contains("$LINT_BASE"), "{out}");
}

// ------------------------------------------------------------------ 模式切换

#[test]
fn test_11_rule_change_switches_to_full() {
    let f = setup();
    f.feature("feat");
    f.me.append("depotd/crates/depot-gate/src/lib.rs", "// rule tweak\n");
    f.me.commit("feat: 改规则");
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("全量（规则或基线被改"), "{out}");
    assert!(out.contains("命中 lint 范围 3/3"), "{out}");
}

#[test]
fn test_12_no_remote_falls_back_to_full_not_worktree_only() {
    // 单机仓（无远程）：不能退化成只看未提交——否则提交到 main 的告警永远查不到。
    let f = setup();
    let solo_path = f.tmp.path().join("solo");
    copy_dir(&f.me.path, &solo_path);
    let home = f.me.home.clone();
    git_cmd(&solo_path, &home, &["init", "-q", "-b", "main"], true);
    let r = Repo { path: solo_path, home };
    r.commit("init");
    r.append("web/app.css", ".x { color: #123; }\n");
    r.commit("main: 直接提交告警");
    let (rc, out) = r.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
    assert!(out.contains("全量"), "{out}");
    assert!(out.contains("web/app.css 告警 1 > 基线 0"), "{out}");
}

// ------------------------------------------------------------------ 基线维护

#[test]
fn test_13_ratchet_only_lowers() {
    let f = setup();
    f.feature("feat");
    f.me.write(
        "web/hub-ui.css",
        ".legacy1 { color: var(--c-a); }\n.legacy2 { color: #222; }\n",
    );
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("已改善"), "{out}");
    let (rc, out) = f.me.lint(&["--ratchet"], &[]);
    assert_eq!(rc, 0, "{out}");
    assert_eq!(f.me.baseline(), serde_json::json!({"web/hub-ui.css": 1}));
    f.me.append("web/hub-ui.css", ".n1 { color: #111; }\n.n2 { color: #222; }\n");
    let (_, out) = f.me.lint(&["--ratchet"], &[]);
    assert!(out.contains("不上调"), "{out}");
    assert_eq!(
        f.me.baseline(),
        serde_json::json!({"web/hub-ui.css": 1}),
        "ratchet 永不上调"
    );
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 1, "{out}");
}

#[test]
fn test_14_init_refuses_overwrite_and_missing_baseline_errors() {
    let f = setup();
    let (rc, out) = f.me.lint(&["--init"], &[]);
    assert_eq!(rc, 2, "{out}");
    assert!(out.contains("拒绝覆盖"), "{out}");
    fs::remove_file(f.me.path.join("scripts/lint-baseline.json")).unwrap();
    let (rc, out) = f.me.lint(&[], &[]);
    assert_eq!(rc, 2, "{out}");
    assert!(out.contains("--init"), "{out}");
}
