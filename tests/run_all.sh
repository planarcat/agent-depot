#!/bin/bash
# Agent Depot · 全量测试编排（交付/验收用）
#   A. check 全链路（tests/check.sh：钉桩 → lint → API → 模块）
#   B. E2E 三步（真实 Chrome/CDP：无头全量 → 有头冒烟 → 沙箱失败场景）
# 推之前只要绿就够：pre-push 自动跑 check.sh；本脚本用于交活前完整验收。
# 质量卡口说明见 AGENTS.md「质量卡口」节。
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
echo "########## A. check 全链路（钉桩 → lint → API → 模块） ##########"
bash tests/check.sh || FAIL=1
echo; echo "########## B. E2E 真实浏览器 ##########"
echo "========== B1/3 E2E 无头（真实 Chrome + CDP） =========="
node tests/e2e.mjs; [ $? -ne 0 ] && FAIL=1
echo; echo "========== B2/3 E2E 有头冒烟（GUI 会话） =========="
node tests/e2e.mjs --headed --smoke; [ $? -ne 0 ] && FAIL=1
echo; echo "========== B3/3 E2E 沙箱失败场景（无头） =========="
node tests/e2e_sandbox.mjs; [ $? -ne 0 ] && FAIL=1
echo; echo "========== 汇总 =========="
if [ $FAIL -eq 0 ]; then echo "ALL SUITES PASSED ✓  证据: tests/evidence/"; else echo "SOME SUITES FAILED ✗"; fi
exit $FAIL
