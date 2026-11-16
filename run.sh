#!/bin/bash
# Agent Depot 服务启动（Rust depotd）
# profile → 端口 + 数据集 双隔离（2026-11-16 双壳端口分离）：
#   dev（默认）    → 8317 + ~/.agent-depot-dev（开发壳 AgentDepot-Dev.app 探测此口）
#   release（正式）→ 8318 + ~/.agent-depot   （正式壳 AgentDepot.app 探测此口）
# 两壳各 ensure 各的端口，开机竞速不再决定数据目录。HUB_PORT 仍可显式覆盖（测试用）。
# 前台/交互管理请用根目录 dev 指令：dev main / dev stop / dev status
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${AGENT_DEPOT_PROFILE:-dev}"
if [ "$PROFILE" = "dev" ]; then
  PORT="${HUB_PORT:-8317}"
else
  PORT="${HUB_PORT:-8318}"
fi
BIN="./depotd/target/debug/depotd"

curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/healthz" && exit 0

[ -x "$BIN" ] || (cd depotd && cargo build --workspace)
if [ "$PROFILE" = "dev" ]; then
  DEPOT_ENV=dev nohup "$BIN" --port "$PORT" serve > .depot.log 2>&1 &
else
  nohup "$BIN" --port "$PORT" serve > .depot-release.log 2>&1 &
fi
for _ in $(seq 1 50); do
  curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/healthz" && exit 0
  sleep 0.2
done
echo "depotd 启动失败，看 .depot.log" >&2
exit 1
