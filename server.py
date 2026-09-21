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

from hub.store import (Store, now_iso, ensure_lineage_schema,   # noqa: E402
                       lineage_info, migration_history,
                       ensure_memory_schema, add_memory,
                       list_memories, delete_memory, sync_status)
from hub.scanners import scan_all             # noqa: E402
from hub import migrator                      # noqa: E402

PORT = int(os.environ.get("HUB_PORT", "8317"))

DEFAULT_SCHEDULE = {
    "all":       {"enabled": False, "interval_min": 30},
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
                if tool == "all":
                    results = scan_all(self.store)
                else:
                    results = scan_all(self.store, tools=[tool])
                self.store.log("refresh:scheduled", {"tool": tool, "results": results})
                # per-tool schedule also updates session-level last_seen


STORE = Store()
ensure_lineage_schema(STORE)
ensure_memory_schema(STORE)
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

    def _file(self, rel, ctype=None):
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path) or not os.path.isfile(path):
            self._json({"error": "not found"}, 404)
            return
        if ctype is None:
            ext = os.path.splitext(path)[1].lower()
            ctype = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                     ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                     ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json"}.get(
                         ext, "application/octet-stream")
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
        # static assets: web/<name> and tests/<name> are servable (read-only)
        if u.path.startswith("/assets/"):
            return self._file(os.path.join("web", u.path[len("/assets/"):]))
        if u.path.startswith("/tests/"):
            return self._file(u.path.lstrip("/"))
        if u.path == "/api/state":
            raw = STORE.get_config("schedule")
            sessions = STORE.list_sessions()
            for s in sessions:
                lin = lineage_info(STORE, s["tool"], s["sid"])
                if lin:
                    s["lid"] = lin["lid"]
                    s["migrations"] = lin["migrations"]
            return self._json({
                "tools": STORE.counts_by_tool(),
                "sessions": sessions,
                "ledger": STORE.ledger_recent(20),
                "migrations": migration_history(STORE, limit=20),
                "schedule": json.loads(raw) if raw else DEFAULT_SCHEDULE,
                "engine": {"casr": migrator.available()},
                "memories": list_memories(STORE, limit=50),
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
        if u.path == "/api/memories":
            return self._json({"memories": list_memories(STORE, limit=100)})
        if u.path == "/api/sync/preview":
            q = parse_qs(u.query)
            sid = q.get("sid", [""])[0]
            tool = q.get("tool", [""])[0]
            target = q.get("target", [""])[0]
            sess = STORE.session(sid) if sid else None
            if not sess or not target:
                return self._json({"error": "sid & target required"}, 400)
            st = sync_status(STORE, sess["tool"], sid, target)
            return self._json({"sync": st})
        if u.path == "/api/lineage":
            q = parse_qs(u.query)
            tool = q.get("tool", [""])[0]
            sid = q.get("sid", [""])[0]
            if not tool or not sid:
                return self._json({"error": "tool & sid required"}, 400)
            return self._json(lineage_info(STORE, tool, sid) or {})
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
            r = migrator.migrate(STORE, sid, sess["tool"], target,
                                 force=bool(data.get("force")))
            if r.get("ok") and r.get("new_id"):
                # pick up the new native session immediately
                scan_all(STORE, tools=[target])
                add_memory(STORE,
                           "会话「%s」已迁移 %s → %s（lid %s，新会话 %s）。目标工具内 resume 即可继续。"
                           % (sess.get("title") or sid[:16], sess["tool"], target,
                              r.get("lid"), r.get("new_id")),
                           title="迁移记录 · " + (sess.get("title") or sid[:16])[:40],
                           kind="migration-summary",
                           refs={"lid": r.get("lid"), "sid": sid, "target": target},
                           source="migrate")
            return self._json(r)
        if u.path == "/api/memory/add":
            body = (data.get("body") or "").strip()
            if not body:
                return self._json({"ok": False, "error": "内容不能为空"}, 400)
            mid = add_memory(STORE, body, title=data.get("title"),
                             kind=data.get("kind") or "note")
            return self._json({"ok": True, "id": mid})
        if u.path == "/api/memory/delete":
            mid = data.get("id")
            if not mid:
                return self._json({"ok": False, "error": "id required"}, 400)
            ok = delete_memory(STORE, int(mid))
            return self._json({"ok": ok})
        if u.path == "/api/schedule":
            sched = json.loads(STORE.get_config("schedule") or "null") or dict(DEFAULT_SCHEDULE)
            # ensure keys exist (e.g. "all" added after first boot)
            for k, v in DEFAULT_SCHEDULE.items():
                sched.setdefault(k, dict(v))
            tool = data.get("tool")
            if tool in sched:
                if "enabled" in data:
                    sched[tool]["enabled"] = bool(data["enabled"])
                if "interval_min" in data:
                    sched[tool]["interval_min"] = max(1, int(data["interval_min"]))
                sched[tool]["interval_min"] = max(1, int(sched[tool].get("interval_min", 30)))
            STORE.set_config("schedule", json.dumps(sched))
            STORE.log("config", {"schedule": tool, "value": data})
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
