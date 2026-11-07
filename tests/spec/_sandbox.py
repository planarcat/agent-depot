"""行为规格套件 · 共享基座（Rust 重写的行为真源）。

定位（Plans/行为规格测试套件-固化计划.md）：
- 全部用例走 HTTP 黑盒（base URL 可配）：今天打 Python（HUB_BASE 未设时由本基座
  spawn 沙箱 server.py），Rust 重写后以 HUB_BASE 指向 depotd 原样复跑——套件即切换闸门。
- 每条用例精确断言（状态码 + 响应 shape + 磁盘副作用 + DB 状态 + 台账字段），
  按 L0-L4 标注强度；禁止只断 ok=True。
- 错误响应钉结构不钉文案：{ok: False, error 存在 + 类型关键词} 是契约，中文逐字文案豁免
  （否则 Rust 被文案绑死，且变异门禁的 String 存活变异虚高）。
- 每个测试类独立临时目录（修复旧套件共享 TMP 互删隐患）。
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

HUB_BASE = os.environ.get("HUB_BASE")   # 设置时：打外部服务（Rust 验收模式），不本地 spawn

# 断言强度分级标注（写进用例 docstring：L0 状态码 / L1 ok / L2 响应 shape /
# L3 磁盘+DB 副作用 / L4 台账 detail 字段）


def req(method, path, body=None, base=None):
    """HTTP 黑盒请求：返回 (status, parsed_json)。错误响应也解析 body。"""
    url = (base or HUB_BASE or "") + path
    if not url.startswith("http"):
        url = "http://127.0.0.1:%s%s" % (_PORT, url if url.startswith("/") else "/" + url)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


_PORT = None


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class SpecSandbox(unittest.TestCase):
    """规格套件基类：每类独立沙箱（独立 tmp + HOME 重定向 + 随机端口）。

    - HUB_BASE 已设（Rust 验收模式）：不 spawn，直接打外部服务；tmp 仅作夹具区
    - 否则：spawn server.py（与 test_hub.HubSandbox 同款隔离手段）
    """

    #: 子类可覆盖：True = 预置标准会话夹具（claude/codex/opencode 三工具）
    WITH_SESSIONS = False

    @classmethod
    def _sandbox_env(cls, home, hub_dir):
        """每个内置工具的默认根都改道临时目录（兜底手段是改 HOME——
        以后新增内置工具带 ~ 根也自动隔离，不用逐个补 env）。"""
        env = dict(os.environ)
        env.update({
            "HOME": home,
            "AGENT_HUB_DIR": hub_dir,
            "HUB_CLAUDE_PROJECTS": os.path.join(cls.tmp, "claude"),
            "CODEX_HOME": os.path.join(cls.tmp, "codex"),
            "HUB_OPENCODE_DB": cls.opencode_db,
            "HUB_WORKBUDDY_PROJECTS": os.path.join(cls.tmp, "workbuddy"),
            "HUB_ZCODE_DB": os.path.join(cls.tmp, "zcode.db"),
            "HUB_AUTOCLAW_DIR": os.path.join(cls.tmp, "autoclaw"),
            "HUB_AGENTMEMORY_SRC": cls.mem_src,
            "HUB_PORT": str(cls.port),
        })
        return env

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="spec-")
        cls.port = _free_port()
        cls.mem_src = os.path.join(cls.tmp, "mem-src.json")
        with open(cls.mem_src, "w") as f:
            f.write(json.dumps({"mcpServers": {"agentmemory": {
                "command": "agentmemory-mcp", "args": ["serve"]}}}))
        cls.opencode_db = os.path.join(cls.tmp, "opencode.db")
        if cls.WITH_SESSIONS:
            cls._seed_sessions()
        if HUB_BASE:
            cls.external = True
            cls.base = HUB_BASE
        else:
            cls.external = False
            cls.base = "http://127.0.0.1:%d" % cls.port
            home = os.path.join(cls.tmp, "home")
            os.makedirs(home, exist_ok=True)
            hub_dir = os.path.join(cls.tmp, "hub")
            cls.server_log = open(os.path.join(cls.tmp, "server.err"), "w")
            cls.proc = subprocess.Popen(
                [sys.executable, os.path.join(ROOT, "server.py")],
                env=cls._sandbox_env(home, hub_dir),
                stdout=subprocess.DEVNULL, stderr=cls.server_log)
        for _ in range(60):
            try:
                s, _d = req("GET", "/api/state", base=cls.base)
                if s == 200:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("spec server failed to start (%s)" % cls.base)

    @classmethod
    def _seed_sessions(cls):
        """标准三工具会话夹具（与 test_hub 同构：claude JSONL / codex rollout /
        opencode SQLite）。供会话/记忆/台账类契约复用。"""
        claude_dir = os.path.join(cls.tmp, "claude", "proj-x")
        os.makedirs(claude_dir, exist_ok=True)
        with open(os.path.join(claude_dir, "11111111-2222-4333-8444-555555555555.jsonl"), "w") as f:
            f.write(json.dumps({"type": "queue-operation", "timestamp": "2026-09-21T10:00:00.000Z",
                                "sessionId": "11111111-2222-4333-8444-555555555555",
                                "cwd": "/tmp/proj-x", "uuid": "u-seed-0", "parentUuid": None,
                                "version": "2.1.217"}) + "\n")
            f.write(json.dumps({"type": "user", "timestamp": "2026-09-21T10:00:01.000Z",
                                "sessionId": "11111111-2222-4333-8444-555555555555",
                                "cwd": "/tmp/proj-x", "uuid": "u-seed-1", "parentUuid": None,
                                "version": "2.1.217", "message": {"role": "user",
                                "content": "规格夹具：把构建脚本改成并行"}}) + "\n")
            f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-21T10:00:02.000Z",
                                "sessionId": "11111111-2222-4333-8444-555555555555",
                                "cwd": "/tmp/proj-x", "uuid": "u-seed-2", "parentUuid": None,
                                "version": "2.1.217", "message": {"role": "assistant",
                                "content": [{"type": "text", "text": "规格夹具：好的，先看现状。"}]}}) + "\n")
        codex_home = os.path.join(cls.tmp, "codex", "sessions", "2026", "09", "21")
        os.makedirs(codex_home, exist_ok=True)
        cid = "66666666-7777-4888-8999-000000000000"
        with open(os.path.join(codex_home, "rollout-2026-09-21T10-00-00-" + cid + ".jsonl"), "w") as f:
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:00.000Z", "type": "session_meta",
                                "payload": {"session_id": cid, "id": cid, "cwd": "/tmp/proj-y"}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:01.000Z", "type": "response_item",
                                "payload": {"type": "message", "role": "user",
                                            "content": [{"type": "input_text",
                                                         "text": "规格夹具：把日志级别改成 debug"}]}}) + "\n")
        conn = None
        try:
            import sqlite3
            conn = sqlite3.connect(cls.opencode_db)
            conn.executescript("""
            CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT,
              title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
              time_updated INTEGER, data TEXT);
            CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
              time_created INTEGER, time_updated INTEGER, data TEXT);
            """)
            conn.execute("INSERT INTO session VALUES('ses_spec_1','p','s','/tmp/proj-z','规格夹具','1',1758400000000,1758400100000)")
            conn.execute("INSERT INTO message VALUES('msg_a','ses_spec_1',1758400000000,0,?)",
                         (json.dumps({"role": "user"}),))
            conn.execute("INSERT INTO part VALUES('part_a','msg_a','ses_spec_1',1758400000000,0,?)",
                         (json.dumps({"type": "text", "text": "规格夹具：跑一下回归"}),))
            conn.commit()
        finally:
            if conn:
                conn.close()

    @classmethod
    def tearDownClass(cls):
        if not cls.external:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except Exception:
                cls.proc.kill()
            try:
                cls.server_log.close()
            except Exception:
                pass
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------- 断言助手 ----------

    def assertOk(self, s, d, code=200):
        """L1：状态码 + ok 布尔。"""
        self.assertEqual(s, code, d)
        if isinstance(d, dict) and "ok" in d:
            self.assertTrue(d["ok"], d)

    def assertErr(self, s, d, code, keyword=None):
        """错误结构契约：状态码 + {ok: False, error 非空}；keyword 为类型关键词（不钉文案）。"""
        self.assertEqual(s, code, d)
        self.assertIsInstance(d, dict)
        if "ok" in d:
            self.assertFalse(d["ok"], d)
        self.assertTrue(d.get("error"), d)
        if keyword:
            self.assertIn(keyword, str(d["error"]))
