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
PORT = 8399
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


class HubTest(unittest.TestCase):
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
        cls.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---------- scans ----------
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
