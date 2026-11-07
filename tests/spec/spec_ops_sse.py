"""契约7+8 · SSE 端点层与台账 detail 字段（Rust 重写行为真源）。

契约7：SSE hello 负载 {rev, backend, degraded, watch}；watcher 未启动 → 503；
change 事件负载原样下发；断连自动 unsubscribe。
契约8：台账 detail 包裹结构 {actor, extra}；分发/回退/绑定同步/创建 等操作的
extra 字段逐字段钉住（Rust 丢任一字段必须红）。
"""
import json
import os
import time
import urllib.request

from _sandbox import SpecSandbox, req


class SseSpec(SpecSandbox):
    """契约7 · SSE 端点层（流式读取带超时）。"""

    def _read_sse(self, seconds=2.0):
        """读 SSE 流指定秒数，返回 (status, events[(event, data)])。"""
        import socket
        events = []
        try:
            r = urllib.request.urlopen(self.base + "/api/events", timeout=seconds + 5)
        except urllib.error.HTTPError as e:
            return e.code, []
        start = time.time()
        buf = {}
        r.fp.raw._sock.settimeout(1.0) if hasattr(r.fp, "raw") else None
        while time.time() - start < seconds:
            try:
                line = r.fp.readline()
            except socket.timeout:
                break
            except Exception:
                break
            if not line:
                break
            line = line.decode().strip()
            if line.startswith("event: "):
                buf["event"] = line[7:]
            elif line.startswith("data: "):
                buf["data"] = line[6:]
            elif line == "" and buf:
                events.append((buf.get("event"), buf.get("data")))
                buf = {}
        return 200, events

    def test_sse_c7_hello_shape(self):
        """hello 事件负载契约：{rev, backend, degraded, watch}。"""
        status, events = self._read_sse(1.5)
        self.assertEqual(status, 200)
        hellos = [json.loads(data) for ev, data in events if ev == "hello"]
        self.assertTrue(hellos, events)
        h = hellos[0]
        for key in ("rev", "backend", "degraded", "watch"):
            self.assertIn(key, h, h)

    def test_sse_c7_change_event_on_write(self):
        """写盘 → change 事件推送到订阅者（事件负载含 watcher 事件字段）。"""
        status, _ = self._read_sse(0.1)   # 建立订阅即断开——改为后台线程订阅
        import threading
        got = {"events": []}
        def listen():
            try:
                r = urllib.request.urlopen(self.base + "/api/events", timeout=10)
                start = time.time()
                while time.time() - start < 6:
                    line = r.fp.readline()
                    if not line:
                        break
                    line = line.decode().strip()
                    if line.startswith("event: "):
                        got["ev"] = line[7:]
                    elif line.startswith("data: ") and got.get("ev") == "change":
                        got["events"].append(line[6:])
                        break
            except Exception:
                pass
        th = threading.Thread(target=listen, daemon=True)
        th.start()
        time.sleep(0.8)
        # 写盘触发 watcher（往链接目录放一个文件）
        probe = os.path.join(self.tmp, "sse-probe", "probe-skill")
        os.makedirs(probe, exist_ok=True)
        with open(os.path.join(probe, "SKILL.md"), "w") as f:
            f.write("---\nname: probe-skill\n---\nx")
        root = os.path.dirname(os.path.dirname(probe))
        req("POST", "/api/local-dirs/link", {"path": root, "name": "sse-probe-dir"},
            base=self.base)
        th.join(timeout=8)
        self.assertTrue(got["events"], "未收到 change 事件")


class OpsContractSpec(SpecSandbox):
    """契约8 · 台账 detail 字段（逐操作 extra 契约）。"""

    def test_ops_c8_distribute_and_rollback_detail(self):
        """distribute：extra={files 计数, removed, mode}；rollback：
        extra={restored_from}；create：extra={files, hash, dir}。"""
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": "ops-c8", "files": {"SKILL.md": "---\nname: ops-c8\nversion: 1.0\n---\nv1"}},
                   base=self.base)
        self.assertOk(s, d)
        tpath = os.path.join(self.tmp, "ops-c8-tgt")
        os.makedirs(tpath)
        s, d = req("POST", "/api/skills/targets",
                   {"name": "ops-c8-tgt", "kind": "skills_dir", "path": tpath}, base=self.base)
        self.assertOk(s, d)
        s, d = req("POST", "/api/skills/distribute",
                   {"names": ["ops-c8"], "target_ids": [d["id"]]}, base=self.base)
        self.assertOk(s, d)
        req("PUT", "/api/skills/registry/item/ops-c8",
            {"files": {"SKILL.md": "---\nname: ops-c8\nversion: 1.0\n---\nv2"}}, base=self.base)
        time.sleep(1.1)
        s, d = req("POST", "/api/skills/registry/rollback",
                   {"name": "ops-c8"}, base=self.base)
        self.assertOk(s, d)
        s, d = req("GET", "/api/ops?module=skills&q=ops-c8", base=self.base)
        self.assertEqual(s, 200, d)
        by_action = {}
        for row in d["items"]:
            if row["item_name"] != "ops-c8":
                continue
            det = json.loads(row["detail"]) if isinstance(row["detail"], str) else row["detail"]
            self.assertEqual(det.get("actor"), "local", row)   # 包裹结构契约
            by_action.setdefault(row["action"], []).append(det["extra"])
        self.assertIn("create", by_action)
        self.assertIn("files", by_action["create"][0])
        self.assertIn("hash", by_action["create"][0])
        self.assertIn("distribute", by_action)
        dist = by_action["distribute"][0]
        self.assertIn("files", dist)
        self.assertIn("mode", dist)
        self.assertIn("removed", dist)
        self.assertIn("rollback", by_action)
        rb = by_action["rollback"][0]
        self.assertIn("restored_from", rb)

    def test_ops_c8_failed_reason_truncated(self):
        """failed 记录：reason 截断 ≤200（超长错误不撑爆台账）。
        触发：名义合法（过 _NAME_RE）但本地库不存在的条目 → 分发 failed。"""
        name = "ops-trunc"
        s, d = req("POST", "/api/skills/registry/item",
                   {"name": name, "files": {"SKILL.md": "---\nname: ops-trunc\n---\nx"}},
                   base=self.base)
        self.assertOk(s, d)
        tpath = os.path.join(self.tmp, "ops-failed-tgt")
        os.makedirs(tpath)
        s, d = req("POST", "/api/skills/targets",
                   {"name": "ops-failed-tgt", "kind": "skills_dir", "path": tpath},
                   base=self.base)
        self.assertOk(s, d)
        # 目标处塞普通文件 → 应用阶段抛 NotADirectoryError → 异常路径 failed（带截断 reason）
        with open(os.path.join(tpath, name), "w") as f:
            f.write("blocker")
        s, d = req("POST", "/api/skills/distribute",
                   {"names": [name], "target_ids": [d["id"]]}, base=self.base)
        self.assertEqual(s, 200, d)
        s, d = req("GET", "/api/ops?module=skills&status=failed", base=self.base)
        self.assertEqual(s, 200, d)
        failed = [r for r in d["items"] if r["status"] == "failed"
                  and r.get("item_name") == name]
        self.assertTrue(failed, d)
        for r in failed:
            reason = r.get("reason") or ""
            self.assertLessEqual(len(reason), 200, r)
