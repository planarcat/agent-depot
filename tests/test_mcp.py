#!/usr/bin/env python3
"""MCP 模块集成测试：JSON/TOML 目标适配器 + 冲突/回退/幂等 + 握手验证。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TMP = tempfile.mkdtemp(prefix="hub-mcp-test-")
os.environ["AGENT_HUB_DIR"] = os.path.join(TMP, "hub-home")

from hub.store import Store                      # noqa: E402
from hub.core import schema, fsutil              # noqa: E402
from hub.modules import mod_mcp as M             # noqa: E402


def git(*args, cwd=None):
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, capture_output=True)


class McpFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = Store()
        schema.ensure(cls.store)
        # fixture source repo
        src = os.path.join(TMP, "mcp-src")
        os.makedirs(src)
        git("init", "-q", "-b", "main", src)
        os.makedirs(os.path.join(src, "mcp"))
        with open(os.path.join(src, "mcp", "mcp.json"), "w") as f:
            json.dump({"mcpServers": {
                "fake-echo": {"command": sys.executable,
                              "args": [os.path.join(ROOT, "tests/fixtures/fake_mcp_server.py")],
                              "env": {"FAKE_TOKEN": "${FAKE_TOKEN}"}},
                "remote-api": {"url": "https://example.invalid/mcp", "type": "http"},
            }}, f)
        git("add", ".", cwd=src)
        subprocess.run(["git", "-C", src, "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-qm", "v1"], check=True)
        cls.src = src
        # fixture targets
        cls.claude_json = os.path.join(TMP, "fake-claude.json")
        with open(cls.claude_json, "w") as f:
            json.dump({"mcpServers": {"preexisting": {"command": "x"}}, "otherState": 1}, f)
        cls.codex_toml = os.path.join(TMP, "fake-codex.toml")
        with open(cls.codex_toml, "w") as f:
            f.write('model = "gpt-5"\n')

    def test_01_source_pull(self):
        r = M.add_source(self.store, "mcpfix", self.src, "main")
        self.assertTrue(r["ok"], r)
        self.__class__.sid = r["id"]
        p = M.pull_source(self.store, self.sid)
        self.assertTrue(p["ok"], p)
        self.assertEqual(sorted(p["added"]), ["fake-echo", "remote-api"])

    def test_02_update_registry(self):
        res = M.update_registry(self.store, ["fake-echo", "remote-api"], self.sid)
        self.assertEqual([r["status"] for r in res], ["installed", "installed"], res)
        cfg = fsutil.read_json(os.path.join(M.registry_root(), "fake-echo.json"))
        self.assertEqual(cfg["env"]["FAKE_TOKEN"], "${FAKE_TOKEN}")   # 占位符原样保存

    def test_03_targets_and_json_distribute(self):
        t = M.add_target(self.store, "fake-claude", "mcp_json", "claude", self.claude_json, "mcpServers")
        self.assertTrue(t["ok"], t)
        self.__class__.tj = t["id"]
        res = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res[0]["status"], "ok", res)
        data = json.load(open(self.claude_json))
        self.assertEqual(data["mcpServers"]["fake-echo"]["command"], sys.executable)
        self.assertEqual(data["mcpServers"]["preexisting"]["command"], "x")   # 原有条目保留
        self.assertEqual(data["otherState"], 1)                              # 其他字段保留

    def test_04_json_idempotent(self):
        res = M.distribute_mcp(self.store, ["fake-echo"], [self.tj])
        self.assertEqual(res[0]["status"], "skipped", res)

    def test_05_json_conflict_unmanaged(self):
        # 目标里塞一个同名非托管条目
        data = json.load(open(self.claude_json))
        data["mcpServers"]["remote-api"] = {"command": "user-own"}
        json.dump(data, open(self.claude_json, "w"))
        res = M.distribute_mcp(self.store, ["remote-api"], [self.tj])
        self.assertEqual(res[0]["status"], "conflict", res)
        # force 覆盖 + 备份存在
        res2 = M.distribute_mcp(self.store, ["remote-api"], [self.tj], force=True)
        self.assertEqual(res2[0]["status"], "ok", res2)
        dep = M._deployment(self.store, "remote-api", self.tj)
        backup_rel = json.loads(dep["detail"]).get("backup")
        self.assertTrue(backup_rel)
        # 备份内容 = 被覆盖前的用户自有版本（死断言修复：算出来就要 assert）
        backup_full = os.path.join(TMP, backup_rel) if not os.path.isabs(backup_rel) else backup_rel
        self.assertTrue(os.path.isfile(backup_full), backup_rel)
        self.assertIn("user-own", open(backup_full).read())

    def test_06_toml_distribute(self):
        t = M.add_target(self.store, "fake-codex", "mcp_toml", "codex", self.codex_toml)
        self.assertTrue(t["ok"], t)
        self.__class__.tt = t["id"]
        res = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res[0]["status"], "ok", res)
        text = open(self.codex_toml).read()
        self.assertIn('model = "gpt-5"', text)                    # 原有内容保留
        self.assertIn("[mcp_servers.fake-echo]", text)
        self.assertIn("# >>> hub:managed: fake-echo >>>", text)
        self.assertIn('command = %s' % json.dumps(sys.executable), text)
        # 幂等
        res2 = M.distribute_mcp(self.store, ["fake-echo"], [t["id"]])
        self.assertEqual(res2[0]["status"], "skipped", res2)

    def test_07_toml_native_table_conflict(self):
        # 手工写入原生表（非托管）→ 冲突
        with open(self.codex_toml, "a") as f:
            f.write('\n[mcp_servers.remote-api]\nurl = "https://user.example/mcp"\n')
        M.update_registry(self.store, ["remote-api"], self.sid)
        res = M.distribute_mcp(self.store, ["remote-api"], [self.tt])
        self.assertEqual(res[0]["status"], "conflict", res)
        # force 覆盖：托管块替换，原生表仍在（我们不删用户内容）→ 需要人工处理提示
        res2 = M.distribute_mcp(self.store, ["remote-api"], [self.tt], force=True)
        self.assertEqual(res2[0]["status"], "ok", res2)
        text = open(self.codex_toml).read()
        self.assertIn("# >>> hub:managed: remote-api >>>", text)

    def test_08_verify_handshake(self):
        r = M.verify_item(self.store, "fake-echo")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["tool_count"], 3)
        self.assertEqual(r["server_name"], "fake-mcp")
        # 失败路径：不可达 URL
        r2 = M.verify_item(self.store, "remote-api")
        self.assertFalse(r2["ok"])
        self.assertTrue(r2.get("error"))

    def test_09_rollback(self):
        # 本地改动 fake-echo.json 后 force 更新会先留快照; 这里直接测回退路径
        p = os.path.join(M.registry_root(), "fake-echo.json")
        with open(p, "w") as f:
            json.dump({"command": "locally-modified"}, f)
        res = M.update_registry(self.store, ["fake-echo"], self.sid, force=True)
        self.assertEqual(res[0]["status"], "updated")
        r = M.rollback_registry(self.store, "fake-echo")
        self.assertTrue(r["ok"], r)
        content = open(p).read()
        self.assertIn("locally-modified", content)   # 回退到被覆盖前的本地版本

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(TMP, ignore_errors=True)


class McpVerifyUnit(unittest.TestCase):
    """连接验证器（hub/lib/mcpverify.py）的直接判据——不经 Store/台账。

    存在意义：集成用例只断言 ok / tool_count，握手内容的常量、错误文案、
    http 分支全都没被卸住（变异得分只有 31.6%）。这里把每一支都卸上。
    """

    FAKE_SERVER = os.path.join(ROOT, "tests", "fixtures", "fake_mcp_server.py")

    @staticmethod
    def _http_server(handler):
        import http.server
        import threading

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv, "http://127.0.0.1:%d/mcp" % srv.server_address[1]

    def test_v01_stdio_handshake_fields(self):
        from hub.lib.mcpverify import verify_stdio
        r = verify_stdio(sys.executable, [self.FAKE_SERVER], env={"B": "2", "A": "1"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["protocol"], "2024-11-05")      # 协议版本常量
        self.assertEqual(r["server_name"], "fake-mcp")
        self.assertEqual(r["server_version"], "1.0")
        self.assertEqual(r["tool_count"], 3)
        self.assertEqual(r["env_keys"], ["A", "B"])       # 只回键名、排序、不含值
        self.assertGreaterEqual(r["latency_ms"], 1)         # 量纲：毫秒（/1000 会变 0）
        self.assertLess(r["latency_ms"], 60000)             # 且不是「加上 t0」量级的异常值

    def test_v02_stdio_missing_command(self):
        from hub.lib.mcpverify import verify_stdio
        r = verify_stdio("/nonexistent-bin-for-mcpverify")
        self.assertFalse(r["ok"])
        self.assertIn("命令不存在", r["error"])
        self.assertEqual(r["transport"], "stdio")
        self.assertEqual(r["env_keys"], [])

    def test_v03_stdio_no_valid_response(self):
        from hub.lib.mcpverify import verify_stdio
        # 一个只会吐垃圾并退出码 0 的『服务端』→ 必须报「无有效响应」而不是崩
        r = verify_stdio(sys.executable, ["-c", "import sys;sys.stdin.readline();print('not json')"])
        self.assertFalse(r["ok"])
        self.assertIn("无有效响应", r["error"])
        self.assertEqual(r["transport"], "stdio")
        self.assertEqual(r["env_keys"], [])
        # 空 stderr 时不能拼出 "无有效响应: "（尾巴带冒号 = 把空串当成了错误文本）
        self.assertNotIn(":", r["error"])
        self.assertTrue(r["error"].endswith("无有效响应"), r["error"])

    def test_v03b_stdio_tool_list_absent(self):
        """initialize 成功但 tools/list 无响应 → ok 仍为真，tool_count 为 None（不是 0/崩）。"""
        from hub.lib.mcpverify import verify_stdio
        r = verify_stdio(sys.executable, [self.FAKE_SERVER], env={"FAKE_MCP_MODE": "nolist"},
                         timeout=0.6)  # 短超时：默认 12s 另有判据（test_v03e）钉住
        self.assertTrue(r["ok"], r)
        self.assertIsNone(r["tool_count"], r)

    def test_v03c_stdio_stderr_is_forwarded_truncated(self):
        """握手失败时把 stderr 前 400 字节带进 error，且按 400 截断。"""
        from hub.lib.mcpverify import verify_stdio
        code = "import sys;sys.stdin.readline();sys.stderr.write('X'*600);sys.exit(0)"
        r = verify_stdio(sys.executable, ["-c", code])
        self.assertFalse(r["ok"])
        self.assertIn("无有效响应", r["error"])
        self.assertEqual(r["error"].count("X"), 400, "stderr 应按 400 字节截断后原样带上")
        self.assertIn("无有效响应: ", r["error"])      # 有 stderr 时必须带冒号分隔


    def test_v03d_exception_path(self):
        """异常路径（Popen 参数非法）→ ok=False 且带 error，不是 None / 抛穿。"""
        from hub.lib.mcpverify import verify_stdio
        r = verify_stdio(sys.executable, args=5)
        self.assertIsNotNone(r)
        self.assertFalse(r["ok"])
        self.assertTrue(r["error"])
        self.assertEqual(r["transport"], "stdio")
        self.assertEqual(r["env_keys"], [])

    def test_v03g_stdio_dies_immediately(self):
        """服务端启动后立刻退出（管道写不进去）→ 运行时异常也要变成结果，不能抛穿。"""
        from hub.lib.mcpverify import verify_stdio
        r = verify_stdio(sys.executable, ["-c", "pass"])
        self.assertIsNotNone(r)
        self.assertFalse(r["ok"], r)
        self.assertTrue(r.get("error"))
        self.assertEqual(r["transport"], "stdio")
        self.assertEqual(r["env_keys"], [])

    def test_v03e_default_timeouts(self):
        """文档承诺的默认超时（stdio 12s / http 8s）一旦被改，判据就该红。"""
        import inspect
        from hub.lib import mcpverify as V
        self.assertEqual(inspect.signature(V.verify_stdio).parameters["timeout"].default, 12)
        self.assertEqual(inspect.signature(V.verify_http).parameters["timeout"].default, 8)

    def test_v04_http_json_response(self):
        import http.server
        payload = json.dumps({"jsonrpc": "2.0", "id": 1,
                              "result": {"serverInfo": {"name": "http-mcp", "version": "2.1"}}})

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                import time as _t
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                _t.sleep(0.05)      # 让延迟可观测：毫秒量纲被改会露馅
                accept = self.headers.get("Accept") or ""
                ctype = self.headers.get("Content-Type") or ""
                if "text/event-stream" not in accept or "application/json" not in ctype:
                    self.send_error(406)       # Accept 不兼容 SSE → 406（真实端点常见）
                    return
                body = payload.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_error(405)

        srv, url = self._http_server(H)
        try:
            from hub.lib.mcpverify import verify_http
            r = verify_http(url)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["transport"], "http")
            self.assertEqual(r["status"], 200)
            self.assertEqual(r["server_name"], "http-mcp")
            self.assertEqual(r["server_version"], "2.1")
            self.assertGreaterEqual(r["latency_ms"], 40, r)   # 端点睡 50ms：单位是毫秒（/1000 会变 0）
            self.assertLess(r["latency_ms"], 60000)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_v05_http_sse_response_and_unreachable(self):
        import http.server

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                decoy = b'xxxxx{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"decoy-mcp"}}}'
                body = (decoy + b'\nevent: message\ndata:{"jsonrpc":"2.0","id":1,'
                        b'"result":{"serverInfo":{"name":"sse-mcp","version":"0.9"}}}\n\n')
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv, url = self._http_server(H)
        try:
            from hub.lib.mcpverify import verify_http
            r = verify_http(url)                       # SSE 也要能解析出 serverInfo
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["server_name"], "sse-mcp")
        finally:
            srv.shutdown()
            srv.server_close()
        dead = verify_http("http://127.0.0.1:1/mcp", timeout=1)
        self.assertFalse(dead["ok"])
        self.assertTrue(dead.get("error"))
        self.assertEqual(dead["transport"], "http")
        # 非 JSON / 无 serverInfo 的 200 响应：ok 看状态码，不带 server_name
        class Plain(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                import time as _t
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                _t.sleep(0.05)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"hi")

            def log_message(self, *a):
                pass

        srv2, url2 = self._http_server(Plain)
        try:
            r2 = verify_http(url2)
            self.assertTrue(r2["ok"], r2)
            self.assertIsNone(r2.get("server_name"))
            self.assertEqual(r2["transport"], "http")
            self.assertEqual(r2["status"], 200)
            self.assertGreaterEqual(r2["latency_ms"], 40, r2)
            self.assertLess(r2["latency_ms"], 60000)
        finally:
            srv2.shutdown()
            srv2.server_close()

    def test_v05b_http_invalid_utf8_body(self):
        """响应体含非法 UTF-8 字节 → 用 replace 解码，仍要拿到 serverInfo（不能整段失败）。"""
        import http.server

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = b'{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"bad\xff-mcp"}}}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv, url = self._http_server(H)
        try:
            from hub.lib.mcpverify import verify_http
            r = verify_http(url)
            self.assertTrue(r["ok"], r)
            self.assertIn("mcp", r["server_name"] or "")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_v06_verify_dispatch(self):
        from hub.lib.mcpverify import verify
        # 既没 url 也没 command → 拒绝，并点名缺什么
        r = verify({})
        self.assertFalse(r["ok"])
        self.assertIn("command", r["error"])
        self.assertIn("url", r["error"])
        # 有 url → 走 http（不可达也要带 transport=http，而不是走 stdio）
        r3 = verify({"url": "http://127.0.0.1:1/mcp", "headers": {"X-A": "1"}})
        self.assertFalse(r3["ok"])
        self.assertEqual(r3["transport"], "http")
        # headers 必须真的透传：这个端点缺 X-Test 头就 403
        import http.server

        class NeedHeader(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if self.headers.get("X-Test") != "1":
                    self.send_error(403)
                    return
                body = json.dumps({"jsonrpc": "2.0", "id": 1,
                                   "result": {"serverInfo": {"name": "hdr-mcp"}}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv3, url3 = self._http_server(NeedHeader)
        try:
            ok = verify({"url": url3, "headers": {"X-Test": "1"}})
            self.assertTrue(ok["ok"], ok)
            self.assertEqual(ok["server_name"], "hdr-mcp")
            bad = verify({"url": url3})
            self.assertFalse(bad["ok"], bad)
        finally:
            srv3.shutdown()
            srv3.server_close()
        # 有 command → 走 stdio，且 env 的键能被观测
        r2 = verify({"command": sys.executable, "args": [self.FAKE_SERVER], "env": {"E": "1"}})
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["transport"], "stdio")
        self.assertEqual(r2["env_keys"], ["E"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
