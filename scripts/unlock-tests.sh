#!/usr/bin/env bash
# 解锁测试目录（与 lock-tests.sh 同一份清单，反向操作）。非 macOS 自动跳过。
#
# 解锁 = 要改测试 = commit 写清三件事：
#   解锁了哪些文件、为什么改（口径出处）、改了什么口径。
# 改完必须锁回去：bash scripts/lock-tests.sh
#
# 用法：bash scripts/unlock-tests.sh
set -euo pipefail

if ! command -v chflags >/dev/null 2>&1; then
  echo "本机不支持 chflags（非 macOS）→ 无需解锁，不影响流程。"
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TESTS="$ROOT/tests"

[ -d "$TESTS" ] || { echo "仓里没有 tests/ → 无事可做。"; exit 0; }

# 1) 先解目录本层（否则改不动）
chflags nouchg "$TESTS" 2>/dev/null || true

# 2) 再逐文件解锁（本就未锁的也过一遍，无副作用）
FILES=$(find "$TESTS" -type f \( -name '*.py' -o -name '*.mjs' \) \
  -not -path '*/__pycache__/*' -not -path '*/evidence/*' | sort)

count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  chflags nouchg "$f" 2>/dev/null || true
  count=$((count + 1))
done <<< "$FILES"

echo "已解锁：tests/ 目录（本层）+ $count 个判据文件"
echo
echo "改完记得锁回去：bash scripts/lock-tests.sh"
echo "commit message 必须写清：解锁了哪些文件 / 为什么改（口径出处）/ 改了什么口径。"
