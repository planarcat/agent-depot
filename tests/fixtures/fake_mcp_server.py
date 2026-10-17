#!/usr/bin/env python3
"""测试用最小 MCP stdio server：响应 initialize 与 tools/list。

同时**校验客户端的握手内容**（像真服务端那样）：协议版本 / clientInfo / jsonrpc /
id / initialized 通知任一项不对，就回 JSON-RPC error 或直接退出——
这样「客户端把协议版本、客户端名、通知方法写错」的变异才杀得掉，而不是静默通过。

环境变量：
  FAKE_MCP_MODE=nolist   initialize 正常响应，但**不响应** tools/list（用于覆盖 tool_count=None）
"""
import json
import os
import sys

MODE = os.environ.get("FAKE_MCP_MODE", "")


def send(obj):
    print(json.dumps(obj), flush=True)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    method = msg.get("method")
    mid = msg.get("id")
    if method == "initialize" and mid is not None:
        p = msg.get("params") or {}
        ok = (p.get("protocolVersion") == "2024-11-05"
              and bool((p.get("clientInfo") or {}).get("name"))
              and bool((p.get("clientInfo") or {}).get("version"))
              and isinstance(p.get("capabilities"), dict)
              and msg.get("jsonrpc") == "2.0"
              and mid == 1)
        if not ok:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32602, "message": "bad initialize params"}})
            continue
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-mcp", "version": "1.0"}}})
    elif method == "tools/list" and mid is not None:
        if MODE == "nolist":
            continue
        if msg.get("jsonrpc") != "2.0":
            sys.exit(2)
        if mid != 2:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32602, "message": "bad tools/list id"}})
            continue
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "tools": [{"name": "echo"}, {"name": "ping"}, {"name": "now"}]}})
    elif mid is None:
        # 通知：只接受标准初始化完成通知，否则视为客户端违约直接退出
        if not (msg.get("jsonrpc") == "2.0" and method == "notifications/initialized"):
            sys.exit(2)
