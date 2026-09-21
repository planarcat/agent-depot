#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PID_FILE=".hub.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE" && echo "stopped"
else
  echo "not running"; rm -f "$PID_FILE"
fi
