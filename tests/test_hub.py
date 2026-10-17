#!/usr/bin/env python3
"""Integration tests for Agent Depot (sandboxed).

Runs a real server subprocess against synthetic tool data in a temp
directory — no real user sessions are touched. Verifies:
- incremental scan + content dedupe (idempotent re-scan)
- append detection (new lines -> new messages only)
- title extraction with noise filtering
- lineage duplicate-migration guard
- schedule config API
- memory CRUD + validation errors
- error paths (404 / 400)
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import socket
_s = socket.socket(); _s.bind(("127.0.0.1", 0)); PORT = _s.getsockname()[1]; _s.close()
BASE = "http://127.0.0.1:%d" % PORT


def req(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


CLAUDE_SID = "11111111-2222-4333-8444-555555555555"
CODEX_SID = "66666666-7777-4888-8999-000000000000"


def claude_line(typ, role=None, text=None, ts=None):
    o = {"type": typ, "timestamp": ts or "2026-09-21T10:00:00.000Z",
         "sessionId": CLAUDE_SID, "cwd": "/tmp/proj-x", "uuid": "u-" + str(time.time_ns()),
         "parentUuid": None, "version": "2.1.217"}
    if role:
        o["message"] = {"role": role, "content": [{"type": "text", "text": text}]}
    return json.dumps(o, ensure_ascii=False)


class HubSandbox:
    @classmethod
    def _sandbox_env(cls):
        """沙箱环境：必须把**每个**内置工具的默认根都改道到临时目录。

        只改 claude/codex/opencode 的 env 变量是不够的：workbuddy / zcode / autoclaw 的
        BUILTIN_TOOLS **自带 `root: ~/...`**，scanner 走 `self.root or env`，env 根本用不上；
        漏掉就会读到真实会话（内容搜索被真实数据挤出 top 40、套件慢一个量级）。

        所以兜底手段是改 `HOME`：所有 `~/...` 的 root / 记忆 / 技能路径都落到临时目录，
        以后新增内置工具（再带 `~` 根）也自动隔离，不用逐个补 env。
        """
        env = dict(os.environ)
        home = os.path.join(cls.tmp, "home")
        os.makedirs(home, exist_ok=True)
        env.update({
            "HOME": home,
            "AGENT_HUB_DIR": os.path.join(cls.tmp, "hub"),
            "HUB_AGENTMEMORY_SRC": cls.mem_src,
            "HUB_CLAUDE_PROJECTS": os.path.join(cls.tmp, "claude"),
            "CODEX_HOME": cls.codex_home,
            "HUB_OPENCODE_DB": cls.opencode_db,
            "HUB_WORKBUDDY_PROJECTS": os.path.join(cls.tmp, "workbuddy"),
            "HUB_ZCODE_DB": os.path.join(cls.tmp, "zcode.db"),
            "HUB_AUTOCLAW_DIR": os.path.join(cls.tmp, "autoclaw"),
            "HUB_PORT": str(PORT),
            "PATH": env.get("PATH", "") + os.pathsep + os.path.expanduser("~/.local/bin"),
        })
        return env

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="hub-test-")
        cls.claude_dir = os.path.join(cls.tmp, "claude", "proj-x")
        cls.codex_home = os.path.join(cls.tmp, "codex")
        cls.codex_dir = os.path.join(cls.codex_home, "sessions", "2026", "09", "21")
        os.makedirs(cls.claude_dir)
        os.makedirs(cls.codex_dir)
        # claude fixture
        cls.claude_file = os.path.join(cls.claude_dir, CLAUDE_SID + ".jsonl")
        with open(cls.claude_file, "w") as f:
            f.write(claude_line("queue-operation") + "\n")
            f.write(claude_line("user", "user", "帮我把构建脚本改成并行") + "\n")
            f.write(claude_line("assistant", "assistant", "好的，我先看下现状。") + "\n")
        # codex fixture
        cls.codex_file = os.path.join(cls.codex_dir, "rollout-2026-09-21T10-00-00-" + CODEX_SID + ".jsonl")
        with open(cls.codex_file, "w") as f:
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:00.000Z", "type": "session_meta",
                                "payload": {"session_id": CODEX_SID, "id": CODEX_SID, "cwd": "/tmp/proj-y"}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:01.000Z", "type": "response_item",
                                "payload": {"type": "message", "role": "user",
                                            "content": [{"type": "input_text",
                                                         "text": "<environment_context>\n<cwd>/tmp/proj-y</cwd>\n</environment_context>"}]}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:02.000Z", "type": "response_item",
                                "payload": {"type": "message", "role": "user",
                                            "content": [{"type": "input_text", "text": "把日志级别改成 debug"}]}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T10:00:03.000Z", "type": "response_item",
                                "payload": {"type": "message", "role": "assistant",
                                            "content": [{"type": "output_text", "text": "已把日志级别调整为 debug。"}]}}) + "\n")
        # opencode fixture (minimal schema)
        cls.opencode_db = os.path.join(cls.tmp, "opencode.db")
        conn = sqlite3.connect(cls.opencode_db)
        conn.executescript("""
        CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT,
          title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
          time_updated INTEGER, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
          time_updated INTEGER, data TEXT);
        """)
        conn.execute("INSERT INTO session VALUES('ses_test_1','p','s','/tmp/proj-z','测试会话','1',1758400000000,1758400100000)")
        conn.execute("INSERT INTO message VALUES('msg_a','ses_test_1',1758400000000,0,?)",
                     (json.dumps({"role": "user"}),))
        conn.execute("INSERT INTO part VALUES('part_a','msg_a','ses_test_1',1758400000000,0,?)",
                     (json.dumps({"type": "text", "text": "跑一下回归测试"}),))
        conn.execute("INSERT INTO message VALUES('msg_b','ses_test_1',1758400010000,0,?)",
                     (json.dumps({"role": "assistant"}),))
        conn.execute("INSERT INTO part VALUES('part_b','msg_b','ses_test_1',1758400010000,0,?)",
                     (json.dumps({"type": "text", "text": "回归已通过"}),))
        conn.commit(); conn.close()

        # 记忆总线克隆源夹具（wire-memory 测试用）
        cls.mem_src = os.path.join(cls.tmp, "mem-src.json")
        with open(cls.mem_src, "w") as f:
            f.write(json.dumps({"mcpServers": {"agentmemory": {"command": "agentmemory-mcp",
                                                               "args": ["serve"]}}}))
        env = cls._sandbox_env()
        cls.server_log = open(os.path.join(cls.tmp, "server.err"), "w")
        cls.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                                    env=env, stdout=subprocess.DEVNULL, stderr=cls.server_log)
        # wait for server
        for _ in range(50):
            try:
                s, d = req("GET", "/api/state")
                if s == 200:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("test server failed to start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except Exception:
            cls.proc.kill()
        try:
            cls.server_log.close()
        except Exception:
            pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------- scans ----------

class HubTest(HubSandbox, unittest.TestCase):
    def test_01_scan_all(self):
        s, d = req("POST", "/api/refresh", {})
        self.assertEqual(s, 200)
        by = {x["tool"]: x for x in d["results"]}
        self.assertEqual(by["claude"]["new_messages"], 2)
        self.assertEqual(by["codex"]["new_messages"], 3)
        self.assertEqual(by["opencode"]["new_messages"], 2)

    def test_02_rescan_idempotent(self):
        s, d = req("POST", "/api/refresh", {})
        for x in d["results"]:
            self.assertEqual(x["new_messages"], 0, "%s should be idempotent" % x["tool"])

    def test_03_append_incremental(self):
        with open(self.claude_file, "a") as f:
            f.write(claude_line("user", "user", "再加一条：并行度设为 4") + "\n")
        s, d = req("POST", "/api/refresh", {"tool": "claude"})
        self.assertEqual(d["results"][0]["new_messages"], 1)
        s, d = req("GET", "/api/state")
        sess = [x for x in d["sessions"] if x["sid"] == CLAUDE_SID][0]
        self.assertEqual(sess["msg_count"], 3)

    def test_04_title_noise_filter(self):
        s, d = req("GET", "/api/state")
        codex = [x for x in d["sessions"] if x["sid"] == CODEX_SID][0]
        # first user line is env noise -> title must be the real question
        self.assertIn("日志级别", codex["title"])

    def test_05_session_detail(self):
        s, d = req("GET", "/api/session?id=" + CODEX_SID)
        self.assertEqual(s, 200)
        roles = [m["role"] for m in d["messages"]]
        self.assertIn("user", roles)
        self.assertIn("assistant", roles)

    def test_06_migrate_same_tool_error(self):
        s, d = req("POST", "/api/migrate", {"sid": CLAUDE_SID, "target": "claude"})
        self.assertFalse(d["ok"])
        self.assertIn("无需迁移", d["error"])

    def test_07_duplicate_guard(self):
        # seed a migration record directly (simulating an earlier migration)
        db = os.path.join(self.tmp, "hub", "hub.db")
        conn = sqlite3.connect(db)
        conn.execute("INSERT INTO lineages(lid, created_at, origin_tool, origin_sid) "
                     "VALUES('lx-9999','2026-09-21T00:00:00','claude',?)", (CLAUDE_SID,))
        conn.execute("INSERT INTO migrations(lid, ts, src_tool, src_sid, dst_tool, dst_sid, status) "
                     "VALUES('lx-9999','2026-09-21T00:00:00','claude',?,'codex','fake-dst','ok')", (CLAUDE_SID,))
        conn.commit(); conn.close()
        s, d = req("POST", "/api/migrate", {"sid": CLAUDE_SID, "target": "codex"})
        self.assertTrue(d.get("duplicate"), d)
        self.assertFalse(d["ok"])
        # lineage visible in state
        s, st = req("GET", "/api/state")
        sess = [x for x in st["sessions"] if x["sid"] == CLAUDE_SID][0]
        self.assertEqual(sess.get("lid"), "lx-9999")

    def test_08_schedule_config(self):
        s, d = req("POST", "/api/schedule", {"tool": "all", "enabled": True, "interval_min": 15})
        self.assertTrue(d["ok"])
        self.assertEqual(d["schedule"]["all"]["interval_min"], 15)
        s, d = req("GET", "/api/schedule")
        self.assertTrue(d["all"]["enabled"])
        req("POST", "/api/schedule", {"tool": "all", "enabled": False})

    def test_09_memory_crud(self):
        s, d = req("POST", "/api/memory/add", {"title": "T1", "body": "记忆条目一", "kind": "note"})
        self.assertTrue(d["ok"]); mid = d["id"]
        s, d = req("GET", "/api/memories")
        self.assertTrue(any(m["id"] == mid for m in d["memories"]))
        s, d = req("POST", "/api/memory/delete", {"id": mid})
        self.assertTrue(d["ok"])
        s, d = req("GET", "/api/memories")
        self.assertFalse(any(m["id"] == mid for m in d["memories"]))

    def test_10_memory_validation(self):
        s, d = req("POST", "/api/memory/add", {"body": "   "})
        self.assertEqual(s, 400)
        self.assertFalse(d["ok"])

    def test_11_not_found_paths(self):
        s, d = req("GET", "/api/session?id=does-not-exist")
        self.assertEqual(s, 404)
        s, d = req("POST", "/api/migrate", {"sid": "does-not-exist", "target": "codex"})
        self.assertEqual(s, 404)




# ====================================================================
# Edge & failure cases (boundary hardening round)
# ====================================================================
import threading

class EdgeTest(HubSandbox, unittest.TestCase):
    """Boundary, failure and abuse cases on the same sandbox server."""

    def edge_file(self, sid):
        return os.path.join(self.claude_dir, sid + ".jsonl")


    def refresh(self, tool=None):
        return req("POST", "/api/refresh", {"tool": tool} if tool else {})

    def test_e01_corrupt_json_lines_skipped(self):
        """Malformed JSON lines must be skipped without crashing."""
        sid = "e01aaaaa-1111-4111-8111-111111111111"
        with open(self.edge_file(sid), "w") as f:
            f.write(claude_line("user", "user", "正常消息") + "\n")
            f.write("{corrupt json!!!\n")
            f.write("\n")  # blank
            f.write('{"type": "user", "message": ' + '{"x":' * 1)  # truncated
            f.write("\n")
            f.write(claude_line("assistant", "assistant", "仍然正常") + "\n")
        s, d = self.refresh("claude")
        self.assertEqual(s, 200)
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(s, 200)
        roles = [m["role"] for m in d["messages"]]
        self.assertEqual(roles, ["user", "assistant"])  # corrupt lines skipped

    def test_e02_empty_and_whitespace_file(self):
        sid = "e02aaaaa-1111-4111-8111-111111111111"
        for content in ("", "\n\n\n", "   \n   "):
            with open(self.edge_file(sid), "w") as f:
                f.write(content)
            s, d = self.refresh("claude")
            self.assertEqual(s, 200)
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(s, 200)
        self.assertEqual(len(d["messages"]), 0)

    def test_e03_file_shrink_resync(self):
        """File truncation/shrink must reset cursor and dedupe cleanly."""
        sid = "e03aaaaa-1111-4111-8111-111111111111"
        with open(self.edge_file(sid), "w") as f:
            f.write(claude_line("user", "user", "第一版内容") + "\n")
            f.write(claude_line("assistant", "assistant", "回复一") + "\n")
        self.refresh("claude")
        # rewrite with FEWER, different lines (shrink + rewrite)
        with open(self.edge_file(sid), "w") as f:
            f.write(claude_line("user", "user", "第二版重写内容") + "\n")
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        # dedupe keeps old rows; new content must appear; no crash
        texts = [m["content"] for m in d["messages"]]
        self.assertTrue(any("第二版重写内容" in t for t in texts))

    def test_e04_huge_message_roundtrip(self):
        """A ~200KB message must round-trip without truncation or crash."""
        sid = "e04aaaaa-1111-4111-8111-111111111111"
        big = "边界测试" + "x" * 200000
        with open(self.edge_file(sid), "w") as f:
            f.write(claude_line("user", "user", big) + "\n")
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertGreaterEqual(len(d["messages"][0]["content"]), 200000)

    def test_e05_unicode_and_emoji(self):
        sid = "e05aaaaa-1111-4111-8111-111111111111"
        txt = "中文🎉 emoji <script>alert(1)</script> \\backslash \t tab"
        with open(self.edge_file(sid), "w") as f:
            f.write(claude_line("user", "user", txt) + "\n")
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertIn("中文🎉", d["messages"][0]["content"])
        self.assertIn("<script>", d["messages"][0]["content"])  # stored raw; UI escapes

    def test_e06_codex_function_calls(self):
        """Codex tool events map to tool roles."""
        sid = "e06bbbb-2222-4111-8111-111111111111"
        path = os.path.join(self.codex_dir, "rollout-2026-09-21T11-00-00-" + sid + ".jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"timestamp": "2026-09-21T11:00:00.000Z", "type": "session_meta",
                                "payload": {"session_id": sid, "cwd": "/tmp/e06"}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T11:00:01.000Z", "type": "response_item",
                                "payload": {"type": "function_call", "name": "shell",
                                            "arguments": json.dumps({"cmd": "ls"})}}) + "\n")
            f.write(json.dumps({"timestamp": "2026-09-21T11:00:02.000Z", "type": "response_item",
                                "payload": {"type": "function_call_output", "output": "file1\nfile2"}}) + "\n")
        self.refresh("codex")
        s, d = req("GET", "/api/session?id=" + sid)
        ctypes = [m["content_type"] for m in d["messages"]]
        self.assertIn("tool_use", ctypes)
        self.assertIn("tool_result", ctypes)

    def test_e07_codex_no_session_meta(self):
        """A rollout without session_meta must not crash or create a session."""
        sid = "e07cccc-3333-4111-8111-111111111111"
        path = os.path.join(self.codex_dir, "rollout-2026-09-21T12-00-00-" + sid + ".jsonl")
        with open(path, "w") as f:
            f.write(json.dumps({"timestamp": "2026-09-21T12:00:00.000Z", "type": "response_item",
                                "payload": {"type": "message", "role": "user",
                                            "content": [{"type": "input_text", "text": "孤儿消息"}]}}) + "\n")
        s, d = self.refresh("codex")
        self.assertEqual(s, 200)
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(s, 404)  # no meta -> no session

    def test_e08_partial_line_withheld(self):
        """A trailing line without newline must be withheld until completed."""
        sid = "e08dddd-4444-4111-8111-111111111111"
        path = self.edge_file(sid)
        with open(path, "w") as f:
            f.write(claude_line("user", "user", "完整行") + "\n")
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(len(d["messages"]), 1)
        # append a partial line (no trailing newline)
        partial = claude_line("assistant", "assistant", "未完成的半行")
        with open(path, "a") as f:
            f.write(partial)  # no \n
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(len(d["messages"]), 1)  # withheld
        # complete it
        with open(path, "a") as f:
            f.write("\n")
        self.refresh("claude")
        s, d = req("GET", "/api/session?id=" + sid)
        self.assertEqual(len(d["messages"]), 2)  # now consumed

    def test_e09_opencode_zero_message_session(self):
        sid = "ses_e09_zero"
        conn = sqlite3.connect(self.opencode_db)
        conn.execute("INSERT INTO session VALUES(?,?,?,?,?,?,?,?)",
                     (sid, 'p', 's9', '/tmp/proj-z', '空会话', '1', 1758500000000, 1758500000000))
        conn.commit(); conn.close()
        self.refresh("opencode")
        s, d = req("GET", "/api/state")
        sess = [x for x in d["sessions"] if x["sid"] == sid]
        self.assertEqual(len(sess), 1)
        self.assertEqual(sess[0]["msg_count"], 0)

    def test_e10_failed_migration_not_a_duplicate(self):
        """A FAILED migration must not block re-migration."""
        # session exists (claude fixture) but no file on disk for casr? We simulate:
        # insert a failed migration record, then expect migrate NOT to be blocked.
        db = os.path.join(self.tmp, "hub", "hub.db")
        conn = sqlite3.connect(db)
        conn.execute("INSERT OR IGNORE INTO lineages(lid, created_at, origin_tool, origin_sid) "
                     "VALUES('lx-e10','2026-09-21T00:00:00','claude',?)", (CLAUDE_SID,))
        conn.execute("INSERT INTO migrations(lid, ts, src_tool, src_sid, dst_tool, dst_sid, status) "
                     "VALUES('lx-e10','2026-09-21T00:00:00','claude',?,'codex',NULL,'error')", (CLAUDE_SID,))
        conn.commit(); conn.close()
        # duplicate check uses status='ok' only -> must NOT report duplicate.
        # (the migrate call itself would hit real casr with a synthetic sid and fail;
        #  we only assert the guard logic via sync/duplicate response absence.)
        s, d = req("POST", "/api/migrate", {"sid": CLAUDE_SID, "target": "codex"})
        self.assertFalse(d.get("duplicate"), "failed migration must not block")

    def test_e11_concurrent_refresh_409(self):
        """Two simultaneous refreshes: exactly one succeeds, the other gets 409."""
        results = []
        def hit():
            s, d = req("POST", "/api/refresh", {"tool": "claude"})
            results.append(s)
        t1 = threading.Thread(target=hit); t2 = threading.Thread(target=hit)
        t1.start(); t2.start(); t1.join(); t2.join()
        self.assertIn(200, results)
        self.assertIn(409, results)

    def test_e12_schedule_invalid_interval(self):
        """Numeric junk is clamped to >=1; non-numeric junk gets a clean 400."""
        for bad in (0, -5):
            s, d = req("POST", "/api/schedule", {"tool": "claude", "enabled": False, "interval_min": bad})
            self.assertEqual(s, 200, "数值型应被钳制: %r" % bad)
        for bad in ("abc", None):
            s, d = req("POST", "/api/schedule", {"tool": "claude", "enabled": False, "interval_min": bad})
            self.assertEqual(s, 400, "非数值应返回 400: %r" % bad)
            self.assertFalse(d["ok"])
        s, d = req("GET", "/api/schedule")
        self.assertGreaterEqual(int(d["claude"]["interval_min"]), 1)

    def test_e13_schedule_unknown_scope_rejected(self):
        """v0.5.1: 未知范围不再静默忽略，返回 400 且配置不变。"""
        s, before = req("GET", "/api/schedule")
        s, d = req("POST", "/api/schedule", {"tool": "nonexistent", "enabled": True})
        self.assertEqual(s, 400)
        self.assertFalse(d["ok"])
        s, after = req("GET", "/api/schedule")
        self.assertNotIn("nonexistent", after)
        self.assertEqual(before, after)

    def test_e14_sql_injection_safe(self):
        """q parameter with SQL meta-characters must be inert (URL-encoded)."""
        import urllib.parse
        for payload in ("' OR 1=1 --", "%'; DROP TABLE sessions; --"):
            qs = urllib.parse.urlencode({"q": payload})
            s, d = req("GET", "/api/sessions?" + qs)
            self.assertEqual(s, 200, payload)
        s, d = req("GET", "/api/state")   # table still intact
        self.assertGreater(len(d["sessions"]), 0)

    def test_e15_scheduler_tick_direct(self):
        """Direct scheduler tick: due tool runs and is logged; second tick skips."""
        sys.path.insert(0, ROOT)
        import server as hub_server
        store = self  # not used; use sandbox store via a fresh Store on sandbox dir
        from hub.store import Store
        sandbox_store = Store(os.path.join(self.tmp, "hub", "hub.db"))
        sandbox_store.set_config("schedule", json.dumps(
            {"claude": {"enabled": True, "interval_min": 30}}))
        last_run = {}
        ran1 = hub_server.scheduler_tick(sandbox_store, last_run)
        self.assertIn("claude", ran1)
        ran2 = hub_server.scheduler_tick(sandbox_store, last_run)
        self.assertEqual(ran2, [])  # within interval
        # invalid interval must not crash
        sandbox_store.set_config("schedule", json.dumps(
            {"claude": {"enabled": True, "interval_min": "abc"}}))
        ran3 = hub_server.scheduler_tick(sandbox_store, {})
        self.assertIn("claude", ran3)

    def test_e16_restart_persistence(self):
        """Config + sessions must survive a server restart."""
        s, before = req("GET", "/api/state")
        n_sessions = len(before["sessions"])
        # restart the server subprocess with same env
        self.__class__.proc.terminate()
        self.__class__.proc.wait(timeout=5)
        env = self._sandbox_env()
        self.__class__.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server.py")],
            env=env, stdout=subprocess.DEVNULL, stderr=self.__class__.server_log)
        for _ in range(50):
            try:
                s, d = req("GET", "/api/state")
                if s == 200:
                    break
            except Exception:
                time.sleep(0.2)
        s, after = req("GET", "/api/state")
        self.assertEqual(len(after["sessions"]), n_sessions)
        self.assertIsNotNone(after["schedule"])



class V3Test(HubSandbox, unittest.TestCase):
    """v0.3 features: content search / markdown export / star."""

    def setUp(self):
        # make sure fixture data is scanned
        req("POST", "/api/refresh", {})

    def test_v01_content_search(self):
        import urllib.parse
        qs = urllib.parse.urlencode({"q": "并行"})
        s, d = req("GET", "/api/search?" + qs)
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        hit = [r for r in d["results"] if r["sid"] == CLAUDE_SID]
        self.assertTrue(hit, "应命中 claude 夹具会话")
        self.assertGreaterEqual(hit[0]["hits"], 1)
        self.assertIn("并行", hit[0]["snippet"])

    def test_v02_search_escape_and_empty(self):
        s, d = req("GET", "/api/search?q=")
        self.assertEqual(s, 400)
        s, d = req("GET", "/api/search?q=" + urllib.parse.quote("%"))
        self.assertEqual(s, 200)  # wildcard escaped, no crash
        s, d = req("GET", "/api/search?q=" + urllib.parse.quote("不存在的词xyz123"))
        self.assertEqual(s, 200)
        self.assertEqual(d["results"], [])

    def test_v03_export(self):
        s, d = req("GET", "/api/export?sid=" + CLAUDE_SID)
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        self.assertTrue(os.path.exists(d["path"]))
        content = open(d["path"]).read()
        self.assertIn("并行", content)
        s, d = req("GET", "/api/export?sid=does-not-exist")
        self.assertEqual(s, 404)
        s, d = req("GET", "/api/export")
        self.assertEqual(s, 400)

    def test_v04_star(self):
        s, d = req("POST", "/api/star", {"sid": CLAUDE_SID})
        self.assertTrue(d["ok"]); self.assertEqual(d["starred"], 1)
        s, d = req("GET", "/api/sessions?tool=claude")
        row = [x for x in d["sessions"] if x["sid"] == CLAUDE_SID][0]
        self.assertEqual(row["starred"], 1)
        s, d = req("POST", "/api/star", {"sid": CLAUDE_SID})
        self.assertEqual(d["starred"], 0)
        s, d = req("POST", "/api/star", {"sid": "nope"})
        self.assertEqual(s, 404)


class V4Test(HubSandbox, unittest.TestCase):
    """v0.4 extras endpoints: stats / memory search+export / batch export."""

    def setUp(self):
        req("POST", "/api/refresh", {})

    def _raw(self, path):
        with urllib.request.urlopen(BASE + path, timeout=10) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()

    def test_v4_1_stats(self):
        s, d = req("GET", "/api/stats")
        self.assertEqual(s, 200)
        st = d["stats"]
        self.assertGreaterEqual(st["totals"]["sessions"], 3)
        self.assertGreaterEqual(st["totals"]["messages"], 1)
        tools = {t["tool"] for t in st["by_tool"]}
        self.assertTrue({"claude", "codex", "opencode"} <= tools)
        self.assertTrue(st["by_day"])
        self.assertTrue(st["by_project"])

    def test_v4_2_memory_search_and_export(self):
        import urllib.parse as up
        req("POST", "/api/memory/add",
            {"title": "v4-marker", "body": "独特内容 v4-xyz-marker"})
        s, d = req("GET", "/api/memory/search?q=" + up.quote("v4-xyz-marker"))
        self.assertEqual(s, 200)
        self.assertTrue(d["results"])
        self.assertIn("v4-xyz-marker", d["results"][0]["snippet"])
        s, d = req("GET", "/api/memory/search?q=")
        self.assertEqual(s, 400)
        s, d = req("GET", "/api/memory/search?q=" + up.quote("%"))
        self.assertEqual(s, 200)
        # md export (raw download)
        s, ct, body = self._raw("/api/memory/export?format=md")
        self.assertEqual(s, 200)
        self.assertIn("text/markdown", ct)
        self.assertIn("v4-marker", body.decode())
        # json export
        s, ct, body = self._raw("/api/memory/export?format=json")
        self.assertEqual(s, 200)
        self.assertIsInstance(json.loads(body.decode()), list)
        # invalid format
        s, d = req("GET", "/api/memory/export?format=xml")
        self.assertEqual(s, 400)

    def test_v4_3_export_batch(self):
        s, d = req("POST", "/api/export/batch", {"sids": [CLAUDE_SID, CODEX_SID]})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        self.assertEqual(d["count"], 2)
        self.assertTrue(os.path.exists(d["path"]))
        import zipfile
        with zipfile.ZipFile(d["path"]) as zf:
            self.assertEqual(len(zf.namelist()), 2)
        # all-mode
        s, d = req("POST", "/api/export/batch", {})
        self.assertTrue(d["ok"])
        self.assertGreaterEqual(d["count"], 3)
        # invalid type
        s, d = req("POST", "/api/export/batch", {"sids": "abc"})
        self.assertEqual(s, 400)

    def test_v4_4_source_patch_and_delete_http(self):
        """HTTP verbs: PATCH update + DELETE removal must work on module routes."""
        s, d = req("POST", "/api/skills/sources",
                   {"name": "verb-test", "url": "/tmp/nowhere-demo"})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        sid = d["id"]
        s, d = req("PATCH", "/api/skills/sources/%d" % sid, {"poll_min": 42})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        s, d = req("GET", "/api/skills/sources")
        row = [x for x in d["sources"] if x["id"] == sid][0]
        self.assertEqual(row["poll_min"], 42)
        # non-POST verbs must not leak into legacy POST routes
        s, d = req("PATCH", "/api/refresh", {})
        self.assertEqual(s, 404)
        s, d = req("DELETE", "/api/skills/sources/%d" % sid)
        self.assertEqual(s, 200)
        s, d = req("GET", "/api/skills/sources")
        self.assertFalse(any(x["id"] == sid for x in d["sources"]))




class ToolsTest(HubSandbox, unittest.TestCase):
    """v0.5.1: 工具注册表 —— 添加 / 扫描 / 校验 / 停用 / 移除 / 动态范围。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # pi-agent 夹具（JSONL）
        cls.pi_dir = os.path.join(cls.tmp, "pi-fixture")
        os.makedirs(cls.pi_dir)
        cls.pi_sid = "019f0000-1111-7222-8333-444455556666"
        cls.pi_file = os.path.join(cls.pi_dir, "2026-09-21T10-00-00-000Z_" + cls.pi_sid + ".jsonl")
        lines = [
            {"type": "session", "id": cls.pi_sid, "timestamp": "2026-09-21T10:00:00.000Z", "cwd": "/tmp/proj-pi"},
            {"type": "message", "timestamp": "2026-09-21T10:00:01.000Z",
             "message": {"role": "user", "content": [{"type": "text", "text": "查一下构建产物大小"}]}},
            {"type": "message", "timestamp": "2026-09-21T10:00:02.000Z",
             "message": {"role": "assistant",
                         "content": [{"type": "text", "text": "产物约 10 MB。"},
                                     {"type": "toolCall", "name": "bash",
                                      "arguments": {"cmd": "du -sh dist"}}]}},
            {"type": "message", "timestamp": "2026-09-21T10:00:03.000Z",
             "message": {"role": "toolResult", "toolName": "bash",
                         "content": [{"type": "text", "text": "10M dist"}]}},
        ]
        with open(cls.pi_file, "w") as f:
            for o in lines:
                f.write(json.dumps(o, ensure_ascii=False) + "\n")
        # cursor 夹具（伪 state.vscdb：cursorDiskKV）
        cls.cursor_db = os.path.join(cls.tmp, "cursor-state.vscdb")
        cls.cursor_cid = "cccccccc-1111-4222-8333-444455556666"
        conn = sqlite3.connect(cls.cursor_db)
        conn.execute("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT)")
        composer = {"composerId": cls.cursor_cid, "name": "Cursor 夹具会话",
                    "createdAt": 1758400000000, "lastUpdatedAt": 1758400600000,
                    "fullConversationHeadersOnly": [{"bubbleId": "b1", "type": 1},
                                                    {"bubbleId": "b2", "type": 2}]}
        conn.execute("INSERT INTO cursorDiskKV VALUES(?,?)",
                     ("composerData:" + cls.cursor_cid, json.dumps(composer)))
        conn.execute("INSERT INTO cursorDiskKV VALUES(?,?)",
                     ("bubbleId:%s:b1" % cls.cursor_cid,
                      json.dumps({"type": 1, "text": "帮我修 ESLint 报错"})))
        rt = json.dumps({"root": {"children": [{"type": "text", "text": "已在保存时自动修复。"}]}})
        conn.execute("INSERT INTO cursorDiskKV VALUES(?,?)",
                     ("bubbleId:%s:b2" % cls.cursor_cid,
                      json.dumps({"type": 2, "text": "", "richText": rt})))
        conn.commit()
        conn.close()

    def test_t01_list_defaults(self):
        s, d = req("GET", "/api/tools")
        self.assertEqual(s, 200)
        ids = [t["id"] for t in d["tools"]]
        self.assertEqual(ids[:7], ["claude", "codex", "opencode",
                                   "workbuddy", "zcode", "autoclaw", "trae-cn"])
        self.assertTrue(all(t["builtin"] for t in d["tools"][:7]))
        # 口径：adapter 表新增「共享技能目录」agents（仅 Skills 分发，无会话采集）→ 9 变 10
        self.assertEqual(len(d["adapters"]), 10)
        self.assertIn("agents", [a["id"] for a in d["adapters"]])

    def test_t02_add_and_scan_pi(self):
        s, d = req("POST", "/api/tools", {"name": "Pi Fixture", "adapter": "pi", "root": self.pi_dir})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        self.assertEqual(d["tool"]["id"], "pi-fixture")
        s, d = req("POST", "/api/refresh", {"tool": "pi-fixture"})
        self.assertEqual(s, 200)
        r0 = d["results"][0]
        self.assertEqual(r0["new_messages"], 3)
        s, d = req("GET", "/api/state")
        sess = [x for x in d["sessions"] if x["sid"] == self.pi_sid][0]
        self.assertEqual(sess["tool"], "pi-fixture")
        self.assertEqual(sess["title"], "查一下构建产物大小")
        self.assertEqual(sess["msg_count"], 3)
        s, d = req("GET", "/api/session?id=" + self.pi_sid)
        roles = [m["role"] for m in d["messages"]]
        self.assertEqual(roles, ["user", "assistant", "tool"])
        self.assertIn("[tool_call] bash", d["messages"][1]["content"])
        self.assertIn("[tool_result:bash]", d["messages"][2]["content"])

    def test_t03_rescan_idempotent(self):
        s, d = req("POST", "/api/refresh", {"tool": "pi-fixture"})
        self.assertEqual(d["results"][0]["new_messages"], 0)

    def test_t04_cursor_fixture(self):
        s, d = req("POST", "/api/tools", {"name": "Cursor Fixture", "adapter": "cursor",
                                          "root": self.cursor_db})
        self.assertEqual(s, 200)
        s, d = req("POST", "/api/refresh", {"tool": "cursor-fixture"})
        r0 = d["results"][0]
        self.assertEqual(r0["new_messages"], 2, r0)
        s, d = req("GET", "/api/session?id=" + self.cursor_cid)
        self.assertEqual(d["title"], "Cursor 夹具会话")
        self.assertEqual([m["role"] for m in d["messages"]], ["user", "assistant"])
        self.assertIn("ESLint", d["messages"][0]["content"])
        self.assertIn("自动修复", d["messages"][1]["content"])  # richText 展平

    def test_t05_validation_and_missing_path(self):
        # 口径（2026-10 起）：名称不要求用户填——留空按格式产品名自动命名；
        # adapter 留空/未知时按路径内容识别。必填只剩「路径」。
        s, d = req("POST", "/api/tools", {"name": "", "adapter": "pi", "root": self.pi_dir})
        self.assertEqual(s, 200, d)
        self.assertTrue(d["tool"]["name"], "空名称应自动命名")
        names = [t["name"] for t in req("GET", "/api/tools")[1]["tools"]]
        self.assertEqual(len(names), len({n.lower() for n in names}), "自动命名不得重名：%s" % names)
        s, d = req("POST", "/api/tools", {"name": "X1", "adapter": "nope", "root": self.pi_dir})
        self.assertEqual(s, 200, "未知 adapter 应按路径内容识别，不应报错：%s" % d)
        self.assertIn(d["tool"]["adapter"], (None, "pi"))
        s, d = req("POST", "/api/tools", {"name": "X2", "adapter": "pi", "root": "  "})
        self.assertEqual(s, 400, "空路径必填")
        s, d = req("POST", "/api/tools", {"name": "Pi Fixture", "adapter": "pi", "root": self.pi_dir})
        self.assertEqual(s, 400, "重名应拒绝")
        s, d = req("POST", "/api/tools", {"name": "Ghost Tool", "adapter": "pi",
                                          "root": os.path.join(self.tmp, "nope-dir")})
        self.assertEqual(s, 200)
        self.assertTrue(d["warning"])
        s, d = req("POST", "/api/refresh", {"tool": "ghost-tool"})
        self.assertEqual(s, 200)
        self.assertEqual(d["results"][0]["files"], 0)

    def test_t06_patch_disable_enable(self):
        s, d = req("PATCH", "/api/tools/pi-fixture", {"name": "Pi Renamed"})
        self.assertEqual(s, 200)
        self.assertEqual(d["tool"]["name"], "Pi Renamed")
        s, d = req("PATCH", "/api/tools/pi-fixture", {"enabled": False})
        self.assertEqual(s, 200)
        self.assertFalse(d["tool"]["enabled"])
        s, d = req("POST", "/api/refresh", {"tool": "pi-fixture"})
        self.assertEqual(s, 400)
        s, d = req("PATCH", "/api/tools/pi-fixture", {"enabled": True})
        self.assertEqual(s, 200)
        s, d = req("POST", "/api/refresh", {"tool": "pi-fixture"})
        self.assertEqual(s, 200)
        # 自定义工具可改会话格式；未知格式 400；内置格式锁定 400
        s, d = req("PATCH", "/api/tools/pi-fixture", {"adapter": "claude"})
        self.assertEqual(s, 200)
        self.assertEqual(d["tool"]["adapter"], "claude")
        s, d = req("PATCH", "/api/tools/pi-fixture", {"adapter": "pi"})
        self.assertEqual(s, 200)
        self.assertEqual(d["tool"]["adapter"], "pi")
        s, d = req("PATCH", "/api/tools/pi-fixture", {"adapter": "nope"})
        self.assertEqual(s, 400)
        s, d = req("PATCH", "/api/tools/claude", {"adapter": "pi"})
        self.assertEqual(s, 400)

    def test_t07_delete_protections_and_retention(self):
        s, d = req("DELETE", "/api/tools/claude")
        self.assertEqual(s, 400)
        s, d = req("DELETE", "/api/tools/never-existed")
        self.assertEqual(s, 404)
        s, d = req("PATCH", "/api/tools/never-existed", {"enabled": True})
        self.assertEqual(s, 404)
        s, d = req("POST", "/api/schedule", {"tool": "pi-fixture", "enabled": True, "interval_min": 10})
        self.assertEqual(s, 200)
        s, d = req("GET", "/api/schedule")
        self.assertIn("pi-fixture", d)
        s, d = req("DELETE", "/api/tools/pi-fixture")
        self.assertEqual(s, 200)
        s, d = req("GET", "/api/schedule")
        self.assertNotIn("pi-fixture", d)
        s, d = req("GET", "/api/state")
        self.assertTrue(any(x["sid"] == self.pi_sid for x in d["sessions"]),
                        "移除工具后会话数据必须保留")

    def test_t08_schedule_scope_validation(self):
        s, d = req("POST", "/api/schedule", {"tool": "cursor-fixture", "enabled": True})
        self.assertEqual(s, 200)
        s, d = req("POST", "/api/schedule", {"tool": "no-such-scope", "enabled": True})
        self.assertEqual(s, 400)

    def test_t10_targets_sync(self):
        """集成字段 → 自动同步/回收 Skills 与 MCP 目标（origin 溯源）。"""
        sdir = os.path.join(self.tmp, "sync-skills")
        os.makedirs(sdir, exist_ok=True)
        mcfg = os.path.join(self.tmp, "sync-mcp.json")
        with open(mcfg, "w") as f:
            f.write("{}")
        s, d = req("POST", "/api/tools", {"name": "Sync Test", "adapter": "pi",
                                          "root": self.pi_dir,
                                          "skills_dir": sdir, "mcp_config": mcfg})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        self.assertEqual(len(d.get("targets_created") or []), 2)
        s, d = req("GET", "/api/skills/targets")
        self.assertTrue(any(os.path.expanduser(t["path"]) == sdir for t in d["targets"]))
        s, d = req("GET", "/api/mcp/targets")
        self.assertTrue(any(os.path.expanduser(t["path"]) == mcfg for t in d["targets"]))
        s, d = req("PATCH", "/api/tools/sync-test", {"skills_dir": ""})
        self.assertEqual(s, 200)
        self.assertIn("Sync Test Skills (全局)", d.get("targets_removed") or [])
        s, d = req("GET", "/api/skills/targets")
        self.assertFalse(any(os.path.expanduser(t["path"]) == sdir for t in d["targets"]))
        s, d = req("DELETE", "/api/tools/sync-test")
        self.assertEqual(s, 200)
        self.assertIn("Sync Test (全局)", d.get("targets_removed") or [])
        s, d = req("GET", "/api/mcp/targets")
        self.assertFalse(any(os.path.expanduser(t["path"]) == mcfg for t in d["targets"]))

    def test_t11_wire_memory(self):
        """记忆总线一键接入：克隆现有配置写入 + 备份 + 状态可视。"""
        cfg = os.path.join(self.tmp, "wire-mcp.json")
        with open(cfg, "w") as f:
            f.write('{"mcpServers": {}}')
        s, d = req("POST", "/api/tools", {"name": "Wire Test", "adapter": "pi",
                                          "root": self.pi_dir, "mcp_config": cfg})
        self.assertEqual(s, 200)
        s, d = req("POST", "/api/tools/wire-test/wire-memory", {})
        self.assertEqual(s, 200)
        self.assertTrue(d["ok"])
        with open(cfg) as f:
            w = json.load(f)
        self.assertEqual(w["mcpServers"]["agentmemory"]["command"], "agentmemory-mcp")
        import glob as _glob
        self.assertTrue(_glob.glob(cfg + ".bak-*"), "备份文件必须存在")
        s, d = req("GET", "/api/state")
        tool = [t for t in d["tool_list"] if t["id"] == "wire-test"][0]
        self.assertTrue(tool["memory_wired"])
        s, d = req("POST", "/api/tools/wire-test/wire-memory", {})
        self.assertTrue(d.get("already"), "重复接入应幂等")
        s, d = req("POST", "/api/tools/ghost-tool/wire-memory", {})
        self.assertEqual(s, 400, "无 MCP 配置的工具应拒绝")

    def test_t09_purge_delete_with_backup(self):
        """彻底删除：先备份再清数据；内置保护；未知范围 404。"""
        s, d = req("DELETE", "/api/tools/claude?purge=1")
        self.assertEqual(s, 400)
        s, d = req("DELETE", "/api/tools/never-existed?purge=1")
        self.assertEqual(s, 404)
        s, d = req("GET", "/api/state")
        before = [x for x in d["sessions"] if x["tool"] == "cursor-fixture"]
        self.assertEqual(len(before), 1)
        s, d = req("DELETE", "/api/tools/cursor-fixture?purge=1")
        self.assertEqual(s, 200)
        pd = d["purge"]
        self.assertTrue(pd["purged"])
        self.assertEqual(pd["sessions"], 1)
        self.assertEqual(pd["messages"], 2)
        self.assertTrue(pd["backup"])
        self.assertTrue(os.path.exists(pd["backup"]), "备份 zip 必须存在")
        s, d = req("GET", "/api/state")
        self.assertFalse([x for x in d["sessions"] if x["tool"] == "cursor-fixture"])
        s, d = req("GET", "/api/session?id=" + self.cursor_cid)
        self.assertEqual(s, 404, "数据应已清除")
        s, d = req("GET", "/api/schedule")
        self.assertNotIn("cursor-fixture", d, "定时配置应随删除清理")


if __name__ == "__main__":
    unittest.main(verbosity=2)

