"""MCP 连接验证：stdio 握手（initialize → tools/list）与 http 探测。

stdio 传输按 MCP 规范使用换行分隔的 JSON-RPC 消息。
所有返回不包含环境变量值（仅键名列表），避免密钥泄露。
"""
import json
import os
import subprocess
import time

PROTOCOL_VERSION = "2024-11-05"
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                   "clientInfo": {"name": "agent-session-hub", "version": "0.4"}}}
INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
TOOLS = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}


def _read_msg(proc, deadline):
    """从 stdout 读一条 JSON-RPC 消息（跳过非 JSON 行）。"""
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except Exception:
            continue
    return None


def verify_stdio(command, args=None, env=None, timeout=12):
    t0 = time.time()
    full_env = dict(os.environ)
    full_env.update(env or {})
    env_keys = sorted((env or {}).keys())
    try:
        proc = subprocess.Popen([command] + (args or []), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=full_env)
    except FileNotFoundError:
        return {"ok": False, "transport": "stdio", "error": "命令不存在: %s" % command,
                "env_keys": env_keys}
    try:
        deadline = time.time() + timeout
        proc.stdin.write(json.dumps(INIT) + "\n")
        proc.stdin.flush()
        resp = _read_msg(proc, deadline)
        if not resp or "result" not in resp:
            err = ""
            try:
                err = (proc.stderr.read(400) or "")
            except Exception:
                pass
            return {"ok": False, "transport": "stdio",
                    "error": "initialize 无有效响应%s" % (": " + err.strip() if err.strip() else ""),
                    "env_keys": env_keys}
        si = resp["result"].get("serverInfo", {})
        proc.stdin.write(json.dumps(INITED) + "\n")
        proc.stdin.write(json.dumps(TOOLS) + "\n")
        proc.stdin.flush()
        tresp = _read_msg(proc, deadline)
        tool_count = None
        if tresp and "result" in tresp and isinstance(tresp["result"].get("tools"), list):
            tool_count = len(tresp["result"]["tools"])
        return {"ok": True, "transport": "stdio",
                "server_name": si.get("name"), "server_version": si.get("version"),
                "protocol": resp["result"].get("protocolVersion"),
                "tool_count": tool_count,
                "latency_ms": int((time.time() - t0) * 1000),
                "env_keys": env_keys}
    except Exception as e:
        return {"ok": False, "transport": "stdio", "error": str(e)[:300], "env_keys": env_keys}
    finally:
        try:
            proc.kill()
        except Exception:
            pass


def verify_http(url, headers=None, timeout=8):
    import urllib.request
    t0 = time.time()
    body = json.dumps(INIT).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            si = (data.get("result") or {}).get("serverInfo", {})
            return {"ok": resp.status == 200, "transport": "http", "status": resp.status,
                    "server_name": si.get("name"), "server_version": si.get("version"),
                    "latency_ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "transport": "http", "error": str(e)[:300]}


def verify(config):
    """config: 归一化 MCP 条目。→ 验证结果 dict。"""
    if config.get("url"):
        return verify_http(config["url"], config.get("headers"))
    if config.get("command"):
        return verify_stdio(config["command"], config.get("args"), config.get("env"))
    return {"ok": False, "error": "条目缺少 command 或 url"}
