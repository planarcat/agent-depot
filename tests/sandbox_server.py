#!/usr/bin/env python3
"""Sandbox server for failure-case E2E testing.

Spawns server.py with isolated data dirs and controlled fixtures:
  --port N        port to listen on (default 8399)
  --strip-casr    remove casr from PATH (engine-missing failure mode)
  --rows N        pre-seed N synthetic sessions directly into hub.db
  --empty         start with zero sessions (empty-state testing)
Prints "READY port=<N>" on stdout when ready; blocks until killed.
"""
import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=8399)
p.add_argument("--strip-casr", action="store_true")
p.add_argument("--rows", type=int, default=0)
p.add_argument("--seed", action="store_true", help="seed one valid synthetic session per tool")
a = p.parse_args()

tmp = tempfile.mkdtemp(prefix="hub-sandbox-")
claude_dir = os.path.join(tmp, "claude", "proj-x")
codex_home = os.path.join(tmp, "codex", "sessions", "2026", "09", "21")
os.makedirs(claude_dir); os.makedirs(codex_home)
hub_dir = os.path.join(tmp, "hub")

if a.seed:
    claude_sid = "aaa11111-2222-4333-8444-555555555555"
    with open(os.path.join(claude_dir, claude_sid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "user", "timestamp": "2026-09-21T10:00:00.000Z",
                            "sessionId": claude_sid, "cwd": "/tmp/sbx",
                            "message": {"role": "user", "content": [{"type": "text", "text": "沙箱种子会话"}]}}) + "\n")
        f.write(json.dumps({"type": "assistant", "timestamp": "2026-09-21T10:00:01.000Z",
                            "sessionId": claude_sid, "cwd": "/tmp/sbx",
                            "message": {"role": "assistant", "content": [{"type": "text", "text": "收到"}]}}) + "\n")

if a.rows:
    db = os.path.join(hub_dir, "hub.db")
    os.makedirs(hub_dir, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.executescript(open(os.path.join(ROOT, "hub", "store.py")).read().split('SCHEMA = """')[1].split('"""')[0])
    for i in range(a.rows):
        sid = "perf%04d-1111-4111-8111-111111111111" % i
        conn.execute("INSERT INTO sessions(sid, tool, title, cwd, msg_count, updated_at) VALUES(?,?,?,?,?,?)",
                     (sid, "claude", "性能测试会话 %03d" % i, "/tmp/perf", 2,
                      "2026-09-21T%02d:%02d:00" % (i % 24, i % 60)))
        for j in range(2):
            conn.execute("INSERT INTO messages(sid, tool, seq, ts, role, content, content_type, hash) "
                         "VALUES(?,?,?,?,?,?,?,?)",
                         (sid, "claude", j, None, "user" if j == 0 else "assistant",
                          "消息 %d-%d" % (i, j), "text", "h%d_%d" % (i, j)))
    conn.commit(); conn.close()

env = dict(os.environ)
env.update({
    "AGENT_HUB_DIR": hub_dir,
    "HUB_CLAUDE_PROJECTS": claude_dir,
    "CODEX_HOME": os.path.join(tmp, "codex"),
    "HUB_OPENCODE_DB": os.path.join(tmp, "opencode-nonexist.db"),  # no opencode data
    "HUB_PORT": str(a.port),
})
if a.strip_casr:
    env["PATH"] = os.pathsep.join(
        part for part in env.get("PATH", "").split(os.pathsep)
        if "local/bin" not in part)  # drop ~/.local/bin (casr)

proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env)
import signal
def _sig(_sig_num, _frame):
    proc.terminate()
    sys.exit(0)
signal.signal(signal.SIGTERM, _sig)
signal.signal(signal.SIGINT, _sig)
for _ in range(50):
    time.sleep(0.2)
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:%d/api/state" % a.port, timeout=2) as r:
            if r.status == 200:
                print("READY port=%d tmp=%s" % (a.port, tmp), flush=True)
                break
    except Exception:
        continue
else:
    print("FAILED to start", flush=True)
    proc.kill(); sys.exit(1)

try:
    proc.wait()
except KeyboardInterrupt:
    proc.terminate()
shutil.rmtree(tmp, ignore_errors=True)
