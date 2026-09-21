#!/usr/bin/env python3
"""Agent Session Hub — local console server.

Zero-dependency (stdlib only). Serves the web UI and a JSON API:
  GET  /api/state                 -> tools + sessions + ledger + engine status
  GET  /api/session?id=...        -> session detail + messages
  POST /api/refresh               -> {tool?: "claude"|"codex"|"opencode"} incremental scan
  POST /api/migrate               -> {sid, target} migrate via casr
  GET/POST /api/schedule          -> per-tool schedule config (enabled, interval_min)
  GET  /                          -> web/index.html

Scheduler runs in-thread; every due tool refresh is recorded to the ledger.
"""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from hub.store import Store, now_iso          # noqa: E402
from hub.scanners import scan_all             # noqa: E402
from hub import migrator                      # noqa: E402

PORT = int(os.environ.get("HUB_PORT", "8317"))

DEFAULT_SCHEDULE = {
    "claude":   {"enabled": False, "interval_min": 30},
    "codex":    {"enabled": False, "interval_min": 30},
    "opencode": {"enabled": False, "interval_min": 30},
}


class Scheduler(threading.Thread):
    daemon = True

    def __init__(self, store):
        super().__init__(name="hub-scheduler")
        self.store = store
        self.stop_event = threading.Event()
        self._last_run = {}   # tool -> epoch

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                pass
            self.stop_event.wait(20)

    def tick(self):
        raw = self.store.get_config("schedule")
        sched = json.loads(raw) if raw else dict(DEFAULT_SCHEDULE)
        now = time.time()
        for tool, cfg in sched.items():
            if not cfg.get("enabled"):
                continue
            iv = max(1, int(cfg.get("interval_min", 30))) * 60
            if now - self._last_run.get(tool, 0) >= iv:
                self._last_run[tool] = now
                results = scan_all(self.store, tools=[tool])
                self.store.log("refresh:scheduled", {"tool": tool, "results": results})


STORE = Store()
SCHED = Scheduler(STORE)
SCHED.start()
REFRESH_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentSessionHub/0.1"

    def log_message(self, fmt, *args):
        pass  # keep console quiet

    # ---------- helpers ----------
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode())
        except Exception:
            return {}

    def _file(self, rel, ctype):
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            self._json({"error": "not found"}, 404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- GET ----------
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/" or u.path == "/index.html":
            return self._file("web/index.html", "text/html; charset=utf-8")
        if u.path == "/api/state":
            raw = STORE.get_config("schedule")
            return self._json({
                "tools": STORE.counts_by_tool(),
                "sessions": STORE.list_sessions(),
                "ledger": STORE.ledger_recent(20),
                "schedule": json.loads(raw) if raw else DEFAULT_SCHEDULE,
                "engine": {"casr": migrator.available()},
                "now": now_iso(),
            })
        if u.path == "/api/session":
            sid = parse_qs(u.query).get("id", [""])[0]
            sess = STORE.session(sid)
            if not sess:
                return self._json({"error": "not found"}, 404)
            sess["messages"] = STORE.messages(sid)
            return self._json(sess)
        if u.path == "/api/schedule":
            raw = STORE.get_config("schedule")
            return self._json(json.loads(raw) if raw else DEFAULT_SCHEDULE)
        return self._json({"error": "not found"}, 404)

    # ---------- POST ----------
    def do_POST(self):
        u = urlparse(self.path)
        data = self._body()
        if u.path == "/api/refresh":
            tool = data.get("tool")
            if not REFRESH_LOCK.acquire(blocking=False):
                return self._json({"ok": False, "error": "刷新正在进行中"}, 409)
            try:
                results = scan_all(STORE, tools=[tool] if tool else None)
                STORE.log("refresh", {"manual": True, "tool": tool, "results": results})
                return self._json({"ok": True, "results": results,
                                   "tools": STORE.counts_by_tool()})
            finally:
                REFRESH_LOCK.release()
        if u.path == "/api/migrate":
            sid = data.get("sid")
            target = data.get("target")
            sess = STORE.session(sid) if sid else None
            if not sess:
                return self._json({"ok": False, "error": "会话不存在"}, 404)
            r = migrator.migrate(STORE, sid, sess["tool"], target)
            return self._json(r)
        if u.path == "/api/schedule":
            sched = json.loads(STORE.get_config("schedule") or "null") or dict(DEFAULT_SCHEDULE)
            tool = data.get("tool")
            if tool in sched:
                if "enabled" in data:
                    sched[tool]["enabled"] = bool(data["enabled"])
                if "interval_min" in data:
                    sched[tool]["interval_min"] = max(1, int(data["interval_min"]))
            STORE.set_config("schedule", json.dumps(sched))
            STORE.log("config", {"schedule": sched})
            return self._json({"ok": True, "schedule": sched})
        return self._json({"error": "not found"}, 404)


def main():
    addr = ("127.0.0.1", PORT)
    httpd = ThreadingHTTPServer(addr, Handler)
    print("Agent Session Hub -> http://127.0.0.1:%d  (Ctrl-C to stop)" % PORT)
    print("hub dir: %s" % STORE.db.db if False else "hub db:  ~/.agent/hub/hub.db")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
