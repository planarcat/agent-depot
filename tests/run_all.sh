#!/bin/bash
# Agent Session Hub · 全量测试编排
#   1) 样式规范 lint   2) API 集成测试（沙箱）   3) E2E 无头（真实 Chrome/CDP）   4) E2E 有头（GUI 冒烟）
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
echo "========== 1/6 样式规范 lint =========="
python3 tests/lint_styles.py || FAIL=1
echo; echo "========== 2/6 API 集成测试（沙箱隔离） =========="
python3 tests/test_hub.py 2>&1 | tail -4 || FAIL=1
echo; echo "========== 3/6 模块集成测试（Skills + MCP + Extras） =========="
python3 tests/test_skills.py 2>&1 | tail -3 || FAIL=1
python3 tests/test_mcp.py 2>&1 | tail -3 || FAIL=1
python3 tests/test_extras.py 2>&1 | tail -3 || FAIL=1
echo; echo "========== 4/6 E2E 无头（真实 Chrome + CDP） =========="
node tests/e2e.mjs; [ $? -ne 0 ] && FAIL=1
echo; echo "========== 5/6 E2E 有头冒烟（GUI 会话） =========="
node tests/e2e.mjs --headed --smoke; [ $? -ne 0 ] && FAIL=1
echo; echo "========== 6/6 E2E 沙箱失败场景（无头） =========="
node tests/e2e_sandbox.mjs; [ $? -ne 0 ] && FAIL=1
echo; echo "========== 汇总 =========="
if [ $FAIL -eq 0 ]; then echo "ALL SUITES PASSED ✓  证据: tests/evidence/"; else echo "SOME SUITES FAILED ✗"; fi
exit $FAIL
