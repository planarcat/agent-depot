/**
 * 前端可观测：未捕获异常 / Promise rejection / 慢请求 / 慢渲染 → 批量上报 depotd 台账。
 * 上报自身绝不允许再抛错（fail-safe）；失败静默丢弃（不重试风暴）。
 */

import { getPrefs } from "./prefs.ts";

export type ReportKind = "error" | "perf";

export interface ReportEntry {
  kind: ReportKind;
  message: string;
  detail?: Record<string, unknown>;
  ts: string;
}

const MAX_QUEUE = 50;
const BATCH_LIMIT = 20;
const DEBOUNCE_MS = 1000;

let queue: ReportEntry[] = [];
let timer: number | null = null;
let installed = false;

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, max = 200): string {
  const chars = Array.from(String(text ?? ""));
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`;
}

function enqueue(kind: ReportKind, message: string, detail?: Record<string, unknown>): void {
  if (!getPrefs().reportFrontendErrors) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  const entry: ReportEntry = { kind, message: truncate(message), ts: nowIso() };
  if (detail) entry.detail = detail;
  queue.push(entry);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    void flush();
  }, DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue.slice(0, BATCH_LIMIT);
  queue = queue.slice(batch.length);
  try {
    await fetch("/api/frontend-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    // 上报失败静默丢弃：可观测性不能反过来制造故障
  }
  if (queue.length > 0) scheduleFlush();
}

/** 立即清空队列（页面卸载 / 测试用；正常路径走 1s 防抖）。 */
export async function flushReports(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  while (queue.length > 0) {
    await flush();
  }
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/** 记一条前端错误（业务代码 / 全局钩子共用）。 */
export function reportError(message: string, detail?: Record<string, unknown>): void {
  enqueue("error", message, detail);
}

/** 记一条性能观测（慢请求 / 慢渲染）。 */
export function reportPerf(message: string, detail?: Record<string, unknown>): void {
  enqueue("perf", message, detail);
}

/** 页面卸载时的同步兜底（fetch 可能被中断，sendBeacon 由浏览器接管投递）。 */
function flushBeacon(): void {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  try {
    const blob = new Blob([JSON.stringify({ entries: batch })], { type: "application/json" });
    if (
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon("/api/frontend-errors", blob)
    ) {
      return;
    }
  } catch {
    /* 走下面的 fetch 兜底 */
  }
  void fetch("/api/frontend-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: batch }),
    keepalive: true,
  }).catch(() => undefined);
}

/** 安装全局钩子（幂等）。 */
export function installGlobalReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    reportError(e.message || "unknown error", {
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: truncate(e.error instanceof Error ? (e.error.stack ?? "") : "", 400),
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    reportError("unhandled rejection", {
      reason: truncate(reason instanceof Error ? reason.message : String(reason), 300),
      stack: truncate(reason instanceof Error ? (reason.stack ?? "") : "", 400),
    });
  });
  // 关页/切后台前把缓冲冲掉（1s 防抖窗口内的最后一批错误不丢）
  window.addEventListener("pagehide", () => {
    flushBeacon();
  });
}

/** 渲染耗时测量：mark 名称唯一化，超过阈值即上报。 */
export function measureRender(label: string, fn: () => void, thresholdMs = 100): void {
  const start = performance.now();
  try {
    fn();
  } finally {
    const ms = Math.round(performance.now() - start);
    if (ms > thresholdMs) reportPerf(`slow render: ${label}`, { ms, threshold: thresholdMs });
  }
}

/** 异步渲染/视图切换测量（拉数据 + DOM 构建全长）。 */
export async function measureAsync(
  label: string,
  fn: () => Promise<void>,
  thresholdMs = 200,
): Promise<void> {
  const start = performance.now();
  try {
    await fn();
  } finally {
    const ms = Math.round(performance.now() - start);
    if (ms > thresholdMs) reportPerf(`slow view: ${label}`, { ms, threshold: thresholdMs });
  }
}
