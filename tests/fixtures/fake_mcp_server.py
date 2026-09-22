#!/usr/bin/env python3
"""测试用最小 MCP stdio server：响应 initialize 与 tools/list。"""
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if msg.get("method") == "initialize" and "id" in msg:
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "1.0"}}}), flush=True)
    elif msg.get("method") == "tools/list" and "id" in msg:
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "tools": [{"name": "echo"}, {"name": "ping"}, {"name": "now"}]}}), flush=True)
