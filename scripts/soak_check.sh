#!/bin/bash
# depotd 内存/存活冒烟门禁（2026-11-08 FileIdMap 事故的规格化复现）。
# 在真实 dev 库 + 真实监控树上跑混合负载，断言：启动快、RSS 有界、事件流动。
# 用法：bash scripts/soak_check.sh [轮数，默认 60]
# 退出码：任一断言失败 → 1
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPOTD="$ROOT/depotd/target/debug/depotd"
ROUNDS="${1:-60}"
PORT=$((21000 + RANDOM % 4000))

# 真实监控树上的探针目录（watch 事件会真实流动）
PROBE_DIR="$HOME/.claude/projects/_depotd_soak_$$"
mkdir -p "$PROBE_DIR"
cleanup() { kill $PID 2>/dev/null; rm -rf "$PROBE_DIR"; }
trap cleanup EXIT

AGENT_HUB_DIR="$HOME/.agent-depot-dev" DEPOT_ENV=dev \
  "$DEPOTD" --port $PORT serve > /tmp/depotd-soak.log 2>&1 &
PID=$!

# 断言1：启动 2s 内可用（FileIdMap 事故时卡死数分钟）
START=$(date +%s%N)
for _ in $(seq 1 20); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/healthz" && break
  sleep 0.1
done
ELAPSED_MS=$(( ($(date +%s%N) - START) / 1000000 ))
if [ "$ELAPSED_MS" -gt 2000 ]; then
  echo "✗ 启动耗时 ${ELAPSED_MS}ms > 2000ms（疑似监控树遍历回归）"; exit 1
fi
echo "✓ 启动 ${ELAPSED_MS}ms"

rss_kb() { ps -o rss= -p $PID | tr -d ' '; }
BASE=$(rss_kb)
echo "基线 RSS: $((BASE/1024))MB"

# 断言2：混合负载下 RSS 有界（每轮 state + local-dirs + ops + 一次真实 watch 探针）
for i in $(seq 1 "$ROUNDS"); do
  curl -s -o /dev/null -m 10 "http://127.0.0.1:$PORT/api/state"
  curl -s -o /dev/null -m 10 "http://127.0.0.1:$PORT/api/local-dirs"
  curl -s -o /dev/null -m 10 "http://127.0.0.1:$PORT/api/ops?limit=200"
  echo "soak $i" > "$PROBE_DIR/probe.txt"    # 监控树内真实写文件 → watcher 事件流动
  H=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/healthz")
  if echo "$H" | grep -q '"degraded":true'; then
    echo "✗ 第 $i 轮 degraded 置位：$H"; exit 1
  fi
done
sleep 2
END=$(rss_kb)
GROWTH_KB=$(( END - BASE ))
GROWTH_MB=$(( GROWTH_KB / 1024 ))
echo "混合负载 $ROUNDS 轮后 RSS: $((END/1024))MB（增长 ${GROWTH_MB}MB）"

# 断言3：RSS 增长 < 150MB（NoCache 修复后典型 <10MB；FileIdMap 回归时 GB 级）
if [ "$GROWTH_MB" -ge 150 ]; then
  echo "✗ RSS 增长 ${GROWTH_MB}MB ≥ 150MB（疑似内存泄漏回归）"
  sample $PID 2 -file /tmp/depotd_soak_sample.txt >/dev/null 2>&1 && \
    echo "  现场已存 /tmp/depotd_soak_sample.txt"
  exit 1
fi
echo "✓ RSS 有界"

# 断言3b：事件确实在流动（探针写文件 → watcher → rev 前进）
REV1=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/healthz" | python3 -c "import json,sys;print(json.load(sys.stdin)['rev'])")
sleep 1.5
echo "soak watch-probe $RANDOM" > "$PROBE_DIR/probe.txt"
sleep 1.5
REV2=$(curl -s -m 3 "http://127.0.0.1:$PORT/api/healthz" | python3 -c "import json,sys;print(json.load(sys.stdin)['rev'])")
if [ "${REV2:-0}" -le "${REV1:-0}" ]; then
  echo "✗ watcher 事件未流动（rev $REV1 → $REV2）"; exit 1
fi
echo "✓ watcher 事件流动（rev $REV1 → $REV2）"

# 断言4：请求仍响应（无自旋失响应）
for p in /api/state /api/sessions; do
  code=$(curl -s -o /dev/null -m 5 -w "%{http_code}" "http://127.0.0.1:$PORT$p")
  [ "$code" = "200" ] || { echo "✗ $p 响应 $code（服务可能自旋）"; exit 1; }
done
echo "✓ 全部通过：启动 ${ELAPSED_MS}ms · RSS 增长 ${GROWTH_MB}MB · 事件流动 · 响应正常"
