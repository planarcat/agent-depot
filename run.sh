#!/bin/bash
# Agent Depot launcher
#   ./run.sh          start in background (pid file + log)
#   ./run.sh --fg     run in foreground (Ctrl-C to stop)
#   ./run.sh --open   start (if needed) and open browser window
set -euo pipefail
cd "$(dirname "$0")"
PORT="${HUB_PORT:-8317}"
PID_FILE=".hub.pid"
LOG_FILE=".hub.log"

started() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if started; then echo "already running (pid $(cat "$PID_FILE"))"; return 0; fi
  nohup python3 server.py >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  if started; then echo "started: pid $(cat "$PID_FILE") · log .hub.log · http://127.0.0.1:$PORT"
  else echo "failed to start; see .hub.log"; tail -5 "$LOG_FILE"; exit 1; fi
}

case "${1:-}" in
  --fg)   exec python3 server.py ;;
  --open) start; open "http://127.0.0.1:$PORT" ;;
  *)      start ;;
esac
