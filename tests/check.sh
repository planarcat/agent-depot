#!/bin/bash
# check 全链路（Rust 时代）—— pre-push 门禁
#   0) depot-gate 构建  1) spec 留痕守卫  2) web lint 基线（均由 depot-gate 子命令承担）
#   3) 前端全链路（biome + tsc + bun build + 体积/覆盖率门禁）
#   4) cargo 单测 + 行为真源 spec 78 条（depotd/tests/spec_*.rs，每文件一个独立 depotd 实例）
#   5) 桌面壳单测
# E2E 三步不在这里（要起真 Chrome）—— 验收用 bash tests/run_all.sh 全量。
# 变异门禁待 cargo-mutants 试点（判据已就位：spec 78 条进了 cargo test，行为层可被变异打到）。
set -uo pipefail
FAIL=0

# 门禁本体：depot-gate（原 scripts/check_spec_guards.py / lint_baseline.py / tests/lint_styles.py，2026-11-17 Rust 化）
# 先构建：宁可多花几秒增量编译，也不拿旧二进制当门禁
(cd depotd && cargo build -p depot-gate --quiet) || FAIL=1
depotd/target/debug/depot-gate spec-guards || FAIL=1
depotd/target/debug/depot-gate lint-baseline || FAIL=1

# 前端：biome + tsc + bun build + 体积预算 + core 覆盖率门禁
# bun build 顺带产出 web/dist —— 第 4 步 spec_surface 的「HEAD / = 200」断言依赖它
(cd web && bun run check:ci) || FAIL=1

# 后端：cargo 单测 + 行为真源 spec 78 条（cargo test 自动先重建，无「旧二进制假绿」问题）
(cd depotd && cargo test --workspace --quiet) || FAIL=1

# 桌面壳（Tauri）：设置持久化 / LaunchAgent 生成等纯逻辑单测
(cd desktop/src-tauri && cargo test --quiet) || FAIL=1

if [ "$FAIL" = "0" ]; then
  echo "========== check 汇总 =========="
  echo "CHECK PASSED ✓"
else
  echo "========== check 汇总 =========="
  echo "CHECK FAILED ✗"
  exit 1
fi
