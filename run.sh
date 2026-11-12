#!/bin/bash
# Agent Depot 服务启动（Rust depotd）
# 数据集：AGENT_DEPOT_PROFILE=dev（默认，~/.agent-depot-dev）| release（~/.agent-depot）
# 桌面壳 ensure_service 兜底调用：确保 8317 有 depotd 在跑（幂等）。
# 前台/交互管理请用根目录 dev 指令：dev main / dev stop / dev status
set -euo pipefail
cd "$(dirname "$0")"
PORT="${HUB_PORT:-8317}"
BIN="./depotd/target/debug/depotd"

curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/healthz" && exit 0

[ -x "$BIN" ] || (cd depotd && cargo build --workspace)
PROFILE="${AGENT_DEPOT_PROFILE:-dev}"
if [ "$PROFILE" = "dev" ]; then
  DEPOT_ENV=dev nohup "$BIN" --port "$PORT" serve > .depot.log 2>&1 &
else
  nohup "$BIN" --port "$PORT" serve > .depot.log 2>&1 &
fi
for _ in $(seq 1 50); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/healthz" && exit 0
  sleep 0.2
done
echo "depotd 启动失败，看 .depot.log" >&2
exit 1
