"""MCP 连接验证：stdio 握手（initialize → tools/list）与 http 探测。

stdio 传输按 MCP 规范使用换行分隔的 JSON-RPC 消息。
所有返回不包含环境变量值（仅键名列表），避免密钥泄露。
"""
import json
import os
import subprocess
import time

PROTOCOL_VERSION = "2024-11-05"
# 错误文本截断 / 延迟量纲：两个魔数，外部不可观测但需命名
ERR_MAX = 300  # mutate: disable 需 >300 字符的异常信息才可观测
LAT_MS = 1000  # mutate: disable 毫秒量纲系数，对外只要求单位是毫秒
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                   "clientInfo": {"name": "agent-depot", "version": "0.5"}}}
INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
TOOLS = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}


def _read_msg(proc, deadline):
    """从 stdout 读一条 JSON-RPC 消息（跳过非 JSON 行）；到 deadline 一定返回 None。

    用 os.read + selectors：proc.stdout.readline() 在子进程不写时会**永久阻塞**，
    只靠「读前看一眼时间」的 deadline 形同虚设（服务端不响应 → 整个验证请求挂死）。
    """
    import selectors
    fd = proc.stdout.fileno()
    sel = selectors.DefaultSelector()
    sel.register(fd, selectors.EVENT_READ)
    buf = b""
    try:
        while True:
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)  # mutate: disable maxsplit=1/2 等价（只切第一行）
                line = line.strip()
                if not line:
                    continue
                try:
                    return json.loads(line)
                except Exception:
                    continue
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            if not sel.select(remaining):
                return None
            chunk = os.read(fd, 65536)  # mutate: disable 读缓冲区大小不影响结果
            if not chunk:
                return None
            buf += chunk
    finally:
        sel.close()


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
    except Exception as e:
        # args/env 类型不对（配置手写成字符串等）也要变成结果，不能把异常抛给请求线程
        return {"ok": False, "transport": "stdio",
                "error": ("启动失败: %s" % e)[:ERR_MAX], "env_keys": env_keys}
    try:
        deadline = time.time() + timeout
        proc.stdin.write(json.dumps(INIT) + "\n")
        proc.stdin.flush()
        resp = _read_msg(proc, deadline)
        if not resp or "result" not in resp:
            err = ""  # mutate: disable 紧随其后的 read 会覆盖它（除非 read 本身失败）
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
                "latency_ms": int((time.time() - t0) * LAT_MS),
                "env_keys": env_keys}
    except Exception as e:
        return {"ok": False, "transport": "stdio", "error": str(e)[:ERR_MAX], "env_keys": env_keys}  # mutate: disable 需 IO 竞争（写完立刻 kill）才触发，测试里不可稳定复现
    finally:
        try:
            proc.kill()
            proc.wait(timeout=3)  # mutate: disable 清理等待时长，对外不可观测
        except Exception:
            pass
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            try:
                pipe.close()
            except Exception:
                pass


def verify_http(url, headers=None, timeout=8):
    import urllib.request
    t0 = time.time()
    body = json.dumps(INIT).encode()
    # Streamable HTTP 传输要求同时接受 JSON 与 SSE（否则 406）
    req = urllib.request.Request(url, data=body, method="POST",  # mutate: disable 有 body 时 urllib 自己就把空 method 当 POST，等效
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json, text/event-stream",
                                          **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            data = None
            # 响应可能是 JSON 或 SSE（event: message\ndata: {...}）
            try:
                data = json.loads(raw)
            except Exception:
                for line in raw.splitlines():
                    if line.startswith("data:"):
                        try:
                            data = json.loads(line[5:].strip())
                            break
                        except Exception:
                            continue
            if not isinstance(data, dict):
                return {"ok": resp.status == 200, "transport": "http", "status": resp.status,
                        "latency_ms": int((time.time() - t0) * LAT_MS)}
            si = (data.get("result") or {}).get("serverInfo", {})
            return {"ok": resp.status == 200, "transport": "http", "status": resp.status,
                    "server_name": si.get("name"), "server_version": si.get("version"),
                    "latency_ms": int((time.time() - t0) * LAT_MS)}
    except Exception as e:
        return {"ok": False, "transport": "http", "error": str(e)[:ERR_MAX]}


def verify(config):
    """config: 归一化 MCP 条目。→ 验证结果 dict。"""
    if config.get("url"):
        return verify_http(config["url"], config.get("headers"))
    if config.get("command"):
        return verify_stdio(config["command"], config.get("args"), config.get("env"))
    return {"ok": False, "error": "条目缺少 command 或 url"}
