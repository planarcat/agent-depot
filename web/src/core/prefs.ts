/**
 * 本地常规偏好（浏览器 / 桌面 WebView 共享）：只影响展示与刷新节奏，不写后端。
 * localStorage 不可用（隐私模式 / 沙箱）时自动退回内存默认值。
 */

export type StartView = "sessions" | "memory" | "skills" | "mcp" | "ops" | "stats";
export type SessLayout = "detail" | "compact";

export interface Prefs {
  /** 会话列表每批渲染行数 */
  rowChunk: number;
  /** SSE 不可用时的轮询间隔（秒） */
  pollIntervalSec: number;
  /** 启动后默认进入的视图 */
  defaultView: StartView;
  /** 会话页默认布局 */
  sessLayout: SessLayout;
  /** 首次进入记忆页自动扫描各工具 */
  autoScanMemory: boolean;
  /** 前端错误/慢请求上报到台账 */
  reportFrontendErrors: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  rowChunk: 100,
  pollIntervalSec: 5,
  defaultView: "sessions",
  sessLayout: "detail",
  autoScanMemory: true,
  reportFrontendErrors: true,
};

const KEY = "agent-depot.prefs.v1";
const ROW_CHUNKS = new Set([50, 100, 200]);
const POLL_INTERVALS = new Set([5, 10, 30]);
const START_VIEWS = new Set<StartView>(["sessions", "memory", "skills", "mcp", "ops", "stats"]);
const SESS_LAYOUTS = new Set<SessLayout>(["detail", "compact"]);

let cached: Prefs | null = null;

function sanitize(raw: unknown): Prefs {
  const o = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rowChunk = Number(o["rowChunk"]);
  const pollIntervalSec = Number(o["pollIntervalSec"]);
  const defaultView = String(o["defaultView"] ?? "");
  const sessLayout = String(o["sessLayout"] ?? "");
  return {
    rowChunk: ROW_CHUNKS.has(rowChunk) ? rowChunk : DEFAULT_PREFS.rowChunk,
    pollIntervalSec: POLL_INTERVALS.has(pollIntervalSec)
      ? pollIntervalSec
      : DEFAULT_PREFS.pollIntervalSec,
    defaultView: START_VIEWS.has(defaultView as StartView)
      ? (defaultView as StartView)
      : DEFAULT_PREFS.defaultView,
    sessLayout: SESS_LAYOUTS.has(sessLayout as SessLayout)
      ? (sessLayout as SessLayout)
      : DEFAULT_PREFS.sessLayout,
    autoScanMemory:
      typeof o["autoScanMemory"] === "boolean" ? o["autoScanMemory"] : DEFAULT_PREFS.autoScanMemory,
    reportFrontendErrors:
      typeof o["reportFrontendErrors"] === "boolean"
        ? o["reportFrontendErrors"]
        : DEFAULT_PREFS.reportFrontendErrors,
  };
}

/** 读取偏好（带内存缓存；坏数据自动回默认值）。 */
export function getPrefs(): Prefs {
  if (cached) return cached;
  let raw: unknown = null;
  try {
    const text = localStorage.getItem(KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    /* 隐私模式 / 非浏览器环境 */
  }
  cached = sanitize(raw);
  return cached;
}

/** 合并保存并广播 `depot:prefs-changed`。 */
export function setPrefs(patch: Partial<Prefs>): Prefs {
  const next = sanitize({ ...getPrefs(), ...patch });
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent("depot:prefs-changed", { detail: next }));
  return next;
}

/** 恢复默认值（清掉存储项）。 */
export function resetPrefs(): Prefs {
  cached = { ...DEFAULT_PREFS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("depot:prefs-changed", { detail: cached }));
  return cached;
}
