#!/bin/bash
# check 全链路（Rust 时代）—— pre-push 门禁
#   1) spec 留痕守卫  2) web lint 基线  3) cargo 单测  4) 行为真源 spec 78 条打 depotd（每文件独立沙箱实例）
# E2E 三步不在这里（要起真 Chrome）—— 验收用 bash scripts/run_spec_rust.sh 全量 + node tests/e2e.mjs。
# 变异门禁已随 Python 栈移除（Rust 侧暂无对应物）。
set -uo pipefail
FAIL=0

python3 scripts/check_spec_guards.py || FAIL=1
python3 scripts/lint_baseline.py || FAIL=1

(cd depotd && cargo test --workspace --quiet) || FAIL=1

[ -x depotd/target/debug/depotd ] || (cd depotd && cargo build --workspace)
bash scripts/run_spec_rust.sh || FAIL=1

if [ "$FAIL" = "0" ]; then
  echo "========== check 汇总 =========="
  echo "CHECK PASSED ✓"
else
  echo "========== check 汇总 =========="
  echo "CHECK FAILED ✗"
  exit 1
fi
