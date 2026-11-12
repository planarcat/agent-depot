/** 应用状态容器（单点真源）：由 /api/state 填充，视图只读/受控写。 */

import type {
  LedgerRow,
  MemoryNote,
  MigrationRow,
  ScheduleMap,
  SessionRow,
  ToolCount,
  WatchStatus,
} from "./types/api.ts";

export type ViewId =
  | "sessions"
  | "memory"
  | "skills"
  | "mcp"
  | "ops"
  | "stats"
  | "connect"
  | "settings";

export interface SessionFilter {
  /** 'all' 或工具 id */
  tool: string;
  text: string;
}

export interface DetailCacheEntry {
  at: number;
  title: string;
  tool: string;
  cwd: string | null;
  messages: unknown[];
  starred?: number;
  resume?: string;
}

export interface AppState {
  version: string;
  rev: number;
  watch: WatchStatus;
  now: string;
  tools: Record<string, ToolCount>;
  sessions: SessionRow[];
  ledger: LedgerRow[];
  migrations: MigrationRow[];
  schedule: ScheduleMap;
  memories: MemoryNote[];
  engine: { casr: boolean; agentmemory: boolean };

  filter: string;
  selected: Set<string>;
  tab: string;
  view: ViewId;

  /* 会话视图（手风琴布局） */
  _toolFocus: string | null;
  _panelOff: boolean;
  _migTargets: string[];
  _sessLayout: "detail" | "list";
  _sessFullH: number;
  _sessAnim: boolean;

  /* 详情缓存（sid → 详情） */
  _detailCache: Record<string, DetailCacheEntry>;
  _animateOpen: string | null;
}

export const state: AppState = {
  version: "",
  rev: 0,
  watch: {
    backend: "off",
    rev: 0,
    events: 0,
    resyncs: 0,
    watched: 0,
    fds: 0,
    subs: 0,
    degraded: false,
  },
  now: "",
  tools: {},
  sessions: [],
  ledger: [],
  migrations: [],
  schedule: {},
  memories: [],
  engine: { casr: false, agentmemory: false },
  filter: "all",
  selected: new Set<string>(),
  tab: "migrate",
  view: "sessions",
  _toolFocus: null,
  _panelOff: false,
  _migTargets: [],
  _sessLayout: "detail",
  _sessFullH: 0,
  _sessAnim: false,
  _detailCache: {},
  _animateOpen: null,
};
