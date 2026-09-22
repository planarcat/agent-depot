#!/usr/bin/env python3
"""Integration tests for Agent Session Hub (sandboxed).

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

        env = dict(os.environ)
        env.update({
            "AGENT_HUB_DIR": os.path.join(cls.tmp, "hub"),
            "HUB_CLAUDE_PROJECTS": os.path.join(cls.tmp, "claude"),
            "CODEX_HOME": cls.codex_home,
            "HUB_OPENCODE_DB": cls.opencode_db,
            "HUB_PORT": str(PORT),
            "PATH": env.get("PATH", "") + os.pathsep + os.path.expanduser("~/.local/bin"),
        })
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

    def test_e13_schedule_unknown_tool_ignored(self):
        s, before = req("GET", "/api/schedule")
        s, d = req("POST", "/api/schedule", {"tool": "nonexistent", "enabled": True})
        self.assertEqual(s, 200)
        s, after = req("GET", "/api/schedule")
        self.assertNotIn("nonexistent", after)

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
        env = dict(os.environ)
        env.update({
            "AGENT_HUB_DIR": os.path.join(self.tmp, "hub"),
            "HUB_CLAUDE_PROJECTS": os.path.join(self.tmp, "claude"),
            "CODEX_HOME": self.codex_home,
            "HUB_OPENCODE_DB": self.opencode_db,
            "HUB_PORT": str(PORT),
            "PATH": env.get("PATH", "") + os.pathsep + os.path.expanduser("~/.local/bin"),
        })
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
