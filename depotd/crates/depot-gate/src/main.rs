//! depot-gate —— 门禁工具箱（check.sh 第 0/1 步的本体）。
//!
//! 子命令：
//!   spec-guards    测试软改松守卫（原 scripts/check_spec_guards.py，2026-11-17 随「去 Python 化」迁入）
//!   lint-baseline  样式告警基线（原 scripts/lint_baseline.py；样式规则原 tests/lint_styles.py 已内建）
//!
//! 口径出处：仓库根 AGENTS.md 质量卡口。输出文案与退出码契约与 Python 版逐字对齐——
//! 判据测试 `crates/depot-gate/tests/lint_baseline.rs` 断言这些文案，改文案必须同步改判据。
//!
//! ROOT 一律取**当前工作目录**（调用方保证在仓根跑，check.sh 与钩子均如此）。

mod lint_baseline;
mod spec_guards;
mod styles;

use clap::Parser;

#[derive(Parser)]
#[command(
    name = "depot-gate",
    version,
    about = "门禁工具箱：测试软改松守卫 + 样式告警基线",
    disable_help_subcommand = true
)]
enum Cmd {
    /// 测试软改松检查——扫描 tests/ 里 skip/only/todo，一律红灯逼走解锁+留痕正门
    SpecGuards,
    /// 样式规则 lint（原 tests/lint_styles.py 手动入口，无基线，全量零容忍）
    Styles,
    /// lint 基线：只对「本次变更文件」比对样式告警数，任一文件超基线即红
    LintBaseline {
        /// 全量模式（不看 git，所有 lint 文件都比对）
        #[arg(long)]
        all: bool,
        /// 打印基点与变更集推导过程
        #[arg(long)]
        explain: bool,
        /// 把已改善的文件下调到当前值（永不上调）
        #[arg(long, conflicts_with = "init")]
        ratchet: bool,
        /// 基线不存在时按当前全量结果生成
        #[arg(long)]
        init: bool,
    },
}

fn main() -> std::process::ExitCode {
    let root = std::env::current_dir().expect("取不到当前目录");
    match Cmd::parse() {
        Cmd::SpecGuards => std::process::ExitCode::from(spec_guards::run(&root) as u8),
        Cmd::Styles => std::process::ExitCode::from(styles::run(&root) as u8),
        Cmd::LintBaseline {
            all,
            explain,
            ratchet,
            init,
        } => std::process::ExitCode::from(
            lint_baseline::run(&root, lint_baseline::Opts {
                all,
                explain,
                ratchet,
                init,
            }) as u8,
        ),
    }
}
