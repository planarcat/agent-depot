#!/bin/bash
# Agent Depot · check 全链路（快线）—— 这是本仓的 `pnpm check` 等价物。
#   0) 判据钉桩（软改松扫描）  1) lint 基线（只比本次变更，超基线即红）
#   2) API 集成（沙箱）        3) 模块集成 + 门禁自测
# E2E 三步不在这里（要起真 Chrome，数分钟）—— 验收用 bash tests/run_all.sh。
# 变异门禁不在这里（数分钟）—— 改测试 / 改被盯模块时手动跑 python3 scripts/mutate.py。
# pre-push 钩子自动跑本脚本：不绿推不出去。
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

# 惰性执行：套件文件不存在就跳过（工作树里还没落地的套件不该让卡口变红）
run_suite() {
	if [ ! -f "$1" ]; then
		echo "  · 跳过（该套件不在本次检出）：$1"
		return 0
	fi
	python3 "$1" 2>&1 | tail -3 || FAIL=1
}
echo "========== 0/4 判据钉桩（软改松扫描） =========="
python3 scripts/check_spec_guards.py || FAIL=1
echo; echo "========== 1/4 lint 基线（样式规则，见 tests/lint_styles.py） =========="
python3 scripts/lint_baseline.py || FAIL=1
echo; echo "========== 2/4 API 集成测试（沙箱隔离） =========="
python3 tests/test_hub.py 2>&1 | tail -4 || FAIL=1
echo; echo "========== 3/4 模块集成 + 门禁自测（Skills + MCP + Manual + Extras + Watcher + lint 基线） =========="
run_suite tests/test_skills.py
run_suite tests/test_mcp.py
run_suite tests/test_manual_mcp.py
run_suite tests/test_extras.py
run_suite tests/test_watcher.py
run_suite tests/test_lint_baseline.py
echo; echo "========== check 汇总 =========="
if [ $FAIL -eq 0 ]; then echo "CHECK PASSED ✓"; else echo "CHECK FAILED ✗"; fi
exit $FAIL
