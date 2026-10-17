#!/usr/bin/env bash
# 锁测试目录（macOS 内核级只读：chflags uchg）。非 macOS 自动跳过。
#
# 与灵创体系的唯一偏离（原因写死在这里）：
#   目录锁用「本层 uchg」，不用 -R 递归 —— 递归会把 tests/evidence/ 一起锁死，
#   e2e 就写不了截图与 e2e-report-*.json。实测：本层 uchg 只挡 tests/ 这一层的
#   新建/改名/删除，子目录（evidence/、fixtures/）内部照旧可写。
#   效果仍与文档一致：改 / 建 / 删 判据文件三向皆拒。
#
# 用法：bash scripts/lock-tests.sh
set -euo pipefail

if ! command -v chflags >/dev/null 2>&1; then
  echo "本机不支持 chflags（非 macOS）→ 跳过上锁，不影响流程。"
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TESTS="$ROOT/tests"

if [ ! -d "$TESTS" ]; then
  echo "仓里没有 tests/ → 不锁，也不新建空目录凑数。"
  exit 0
fi

# 1) 判据文件逐个上锁（tests/**/*.py、*.mjs；evidence/ 是产出物不是判据，跳过）
FILES=$(find "$TESTS" -type f \( -name '*.py' -o -name '*.mjs' \) \
  -not -path '*/__pycache__/*' -not -path '*/evidence/*' | sort)

count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  chflags uchg "$f"
  count=$((count + 1))
done <<< "$FILES"

# 2) 目录本层上锁 → 挡住「顺手新建一个判据文件」
chflags uchg "$TESTS"

echo "已上锁：tests/ 目录（本层）+ $count 个判据文件（含 fixtures），evidence/ 保持可写"
echo
echo "提示：解锁用 bash scripts/unlock-tests.sh；解锁后改测试，commit message 里必须写清为什么改、改了什么口径。"
