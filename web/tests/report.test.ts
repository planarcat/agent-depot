import { afterEach, expect, test } from "bun:test";
import {
  flushReports,
  installGlobalReporting,
  measureAsync,
  measureRender,
  reportError,
  reportPerf,
} from "../src/core/report.ts";

const realFetch = globalThis.fetch;
let sent: Array<{ entries: Array<{ kind: string; message: string; detail?: unknown }> }> = [];

function mockFetch(fail = false): void {
  sent = [];
  globalThis.fetch = ((_path: string, init?: RequestInit) => {
    if (fail) return Promise.reject(new Error("offline"));
    sent.push(JSON.parse(String(init?.body ?? "{}")));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("reportError 入队并批量上报（含 kind/detail/ts）", async () => {
  mockFetch();
  reportError("boom", { where: "here" });
  await flushReports();
  const e = sent[0]?.entries[0];
  expect(e?.kind).toBe("error");
  expect(e?.message).toBe("boom");
  expect(e?.detail).toEqual({ where: "here" });
  expect(typeof (e as { ts?: string }).ts).toBe("string");
});

test("reportPerf 走 perf 通道", async () => {
  mockFetch();
  reportPerf("slow", { ms: 500 });
  await flushReports();
  expect(sent[0]?.entries[0]?.kind).toBe("perf");
});

test("消息截断到 200 字符 + 省略号", async () => {
  mockFetch();
  reportError("x".repeat(300));
  await flushReports();
  const msg = sent[0]?.entries[0]?.message ?? "";
  expect(Array.from(msg)).toHaveLength(201);
  expect(msg.endsWith("…")).toBe(true);
});

test("按 20 条一批上报，余量自动续批", async () => {
  mockFetch();
  for (let i = 0; i < 25; i += 1) reportError(`e${i}`);
  await flushReports();
  expect(sent[0]?.entries).toHaveLength(20);
  expect(sent[1]?.entries).toHaveLength(5);
  expect(sent[1]?.entries[4]?.message).toBe("e24");
});

test("队列上限 50：溢出丢最旧", async () => {
  mockFetch();
  for (let i = 0; i < 60; i += 1) reportError(`q${i}`);
  await flushReports();
  const total = sent.reduce((a, b) => a + b.entries.length, 0);
  expect(total).toBe(50);
  const first = sent[0]?.entries[0]?.message;
  expect(first).toBe("q10");
});

test("上报失败静默丢弃，不抛错、不重试风暴", async () => {
  mockFetch(true);
  reportError("lost");
  await flushReports();
  expect(sent).toHaveLength(0);
});

test("installGlobalReporting 幂等：错误事件只记一次", async () => {
  mockFetch();
  installGlobalReporting();
  installGlobalReporting();
  window.dispatchEvent(new ErrorEvent("error", { message: "uncaught-x" }));
  await flushReports();
  const msgs = sent[0]?.entries.map((e) => e.message) ?? [];
  expect(msgs.filter((m) => m === "uncaught-x")).toHaveLength(1);
});

test("installGlobalReporting 捕获 unhandledrejection", async () => {
  mockFetch();
  installGlobalReporting();
  const ev = new Event("unhandledrejection");
  Object.defineProperty(ev, "reason", { value: new Error("rejected-y") });
  window.dispatchEvent(ev);
  await flushReports();
  const e = sent[0]?.entries[0];
  expect(e?.message).toBe("unhandled rejection");
  expect(e?.detail).toMatchObject({ reason: "rejected-y" });
});

test("pagehide 用 sendBeacon 兜底投递缓冲", () => {
  mockFetch();
  installGlobalReporting();
  const beacons: Array<[string, unknown]> = [];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: unknown) => {
      beacons.push([url, body]);
      return true;
    },
  });
  reportError("last-gasp");
  window.dispatchEvent(new Event("pagehide"));
  expect(beacons).toHaveLength(1);
  expect(beacons[0]?.[0]).toBe("/api/frontend-errors");
});

test("measureRender：超阈值上报 slow render", async () => {
  mockFetch();
  measureRender("rows", () => undefined, -1);
  await flushReports();
  const e = sent[0]?.entries[0];
  expect(e?.message).toContain("slow render: rows");
  expect(e?.kind).toBe("perf");
});

test("measureRender：未超阈值不上报", async () => {
  mockFetch();
  measureRender("rows", () => undefined, 10_000);
  await flushReports();
  expect(sent).toHaveLength(0);
});

test("measureRender：异常仍测量并继续抛出", async () => {
  mockFetch();
  expect(() =>
    measureRender(
      "boom",
      () => {
        throw new Error("x");
      },
      -1,
    ),
  ).toThrow("x");
  await flushReports();
});

test("measureAsync：超阈值上报 slow view", async () => {
  mockFetch();
  await measureAsync("view:mcp", async () => undefined, -1);
  await flushReports();
  expect(sent[0]?.entries[0]?.message).toContain("slow view: view:mcp");
});
