#!/bin/bash
# Rust 验收闸门：每个 spec 文件一个全新 depotd 实例 + 共享沙箱根。
# 依赖：depotd/target/debug/depotd（cargo build --workspace）
# 退出码：任一文件 FAILED 或 depotd panic → 1
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPOTD="$ROOT/depotd/target/debug/depotd"
[ -x "$DEPOTD" ] || { echo "depotd 不存在：$DEPOTD（先 cargo build --workspace）" >&2; exit 2; }

FAIL=0
for f in "$ROOT"/tests/spec/spec_*.py; do
  name=$(basename "$f" .py)
  SB=$(mktemp -d "/tmp/depotd-$name.XXXX")
  mkdir -p "$SB/hub"
  PORT=$((20000 + RANDOM % 5000))
  ENV_BASE=(AGENT_HUB_DIR="$SB/hub" HOME="$SB" DEPOT_SANDBOX="$SB"
            HUB_CLAUDE_PROJECTS="$SB/claude" CODEX_HOME="$SB/codex"
            HUB_WORKBUDDY_PROJECTS="$SB/workbuddy" HUB_ZCODE_DB="$SB/zcode.db"
            HUB_AUTOCLAW_DIR="$SB/autoclaw" HUB_OPENCODE_DB="$SB/opencode.db")
  env "${ENV_BASE[@]}" "$DEPOTD" --port $PORT serve > "$SB/depotd.log" 2>&1 &
  PID=$!
  # 轮询就绪（最多 10s），替代固定 sleep
  for _ in $(seq 1 50); do
    curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/state" && break
    sleep 0.2
  done
  OUT=$(env "${ENV_BASE[@]}" HUB_BASE="http://127.0.0.1:$PORT" \
    python3 -m unittest discover -s "$ROOT/tests/spec" -p "$(basename $f)" 2>&1 | tail -2)
  echo "[$name] $(echo "$OUT" | tr '\n' ' ')"
  echo "$OUT" | grep -q "^OK" || { FAIL=1; echo "$OUT" | grep -E "FAIL|ERROR" | head -5; }
  kill $PID 2>/dev/null; wait $PID 2>/dev/null
  PANICS=$(grep "panicked at" "$SB/depotd.log" 2>/dev/null | grep -vc PoisonError)
  if [ "${PANICS:-0}" != "0" ]; then
    echo "[$name] !!! depotd panics: $PANICS（panic 即门禁失败）"
    FAIL=1
  fi
  rm -rf "$SB"
done
exit $FAIL
