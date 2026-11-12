/**
 * API 契约类型（Tier 1 形状的唯一前端真源）。
 * 与 depotd Rust serde 输出逐字段对齐；运行时校验见 core/validate.ts。
 */

/* ---------------- 通用 ---------------- */

export interface OkEnvelope {
  ok: boolean;
  error?: string;
  code?: string;
}

/* ---------------- 工具注册表 ---------------- */

export interface ToolPublic {
  id: string;
  name: string;
  adapter: string | null;
  skills_dir: string | null;
  mcp_config: string | null;
  mcp_format: string | null;
  builtin: boolean;
  enabled: boolean;
  color: number;
  root: string | null;
  root_exists: boolean | null;
  count: number;
  latest: string | null;
  adapter_label: string;
  root_hint: string;
  memory_wired?: boolean | null;
}

export interface ToolCount {
  count: number;
  latest: string | null;
}

/* ---------------- 会话 / 迁移 ---------------- */

export interface MigrationRow {
  id: number;
  lid: string;
  ts: string;
  src_tool: string;
  src_sid: string;
  dst_tool: string;
  dst_sid: string | null;
  status: string;
  src_msg_count: number | null;
}

export interface SessionRow {
  sid: string;
  tool: string;
  title: string | null;
  cwd: string | null;
  source_file: string | null;
  started_at: string | null;
  updated_at: string | null;
  msg_count: number;
  title_source: string | null;
  starred: number;
  lid?: string;
  migrations?: MigrationRow[];
}

export interface MessageRow {
  seq: number;
  ts: string | null;
  role: string | null;
  content: string | null;
  content_type: string;
  attachments: unknown[];
}

export interface SessionDetail {
  sid: string;
  tool: string;
  title: string | null;
  cwd: string | null;
  source_file: string | null;
  started_at: string | null;
  updated_at: string | null;
  msg_count: number;
  title_source: string | null;
  starred: number;
  messages: MessageRow[];
}

/* ---------------- 台账 ---------------- */

export interface OpsRow {
  id: number;
  ts: string;
  module: string;
  actor: string;
  action: string;
  item_kind: string | null;
  item_name: string | null;
  item_version: string | null;
  source_id: number | null;
  target_id: number | null;
  status: string;
  error_code: string | null;
  reason: string | null;
  detail: string;
  extra: Record<string, unknown>;
  target_name?: string | null;
  source_name?: string | null;
}

export interface LedgerRow {
  id: number;
  ts: string;
  action: string;
  detail: string | null;
}

/* ---------------- 记忆 ---------------- */

export interface MemoryNote {
  id: number;
  ts: string | null;
  kind: string;
  title: string;
  body: string;
}

export interface MemoryItem {
  id: number;
  source_tool: string;
  kind: string;
  scope: string;
  name: string;
  version: number;
  hash: string | null;
  prev_hash: string | null;
  last_source_hash: string | null;
  source_path: string | null;
  updated_at: string | null;
  status: string;
  kind_label?: string;
  deployments?: MemoryDeployment[];
  content?: string;
  source_changed?: boolean;
  source_hash?: string | null;
}

export interface MemoryDeployment {
  tool: string;
  path: string;
  status: string;
  deployed_at: string | null;
}

export interface MemoryTool {
  id: string;
  name: string;
  color: number;
  readable: boolean;
  writable: boolean;
  degraded: boolean;
  error: string | null;
  has_layout: boolean;
  scanned: boolean;
}

export interface MemoryOverview extends OkEnvelope {
  tools: MemoryTool[];
  items: MemoryItem[];
  memstore: string;
}

/* ---------------- 目录 / 绑定 / 目标 ---------------- */

export interface DirCounts {
  skills: number;
  mcp: number;
}

export interface DirLayout {
  skills?: string[];
  mcp?: string[];
}

export interface DirBinding {
  id: number;
  dir_id: number;
  target_id: number;
  mode: "copy" | "link";
  enabled: boolean;
  created_at: string;
  last_sync_at: string | null;
  last_result: SyncAgg | null;
  channels: string[];
  excluded: string[];
  dir_name: string;
  dir_path?: string;
  target_name: string;
  target_path?: string;
  tool: string | null;
  target_kind: string;
}

export interface LocalDir {
  id: number;
  name: string;
  path: string;
  origin: string;
  enabled: boolean;
  created_at: string;
  layout: DirLayout | null;
  counts: DirCounts;
  bindings: DirBinding[];
}

export interface SyncAgg {
  added: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
  excluded?: number;
  removed?: number;
  error?: string;
}

export interface TargetPublic {
  id: number;
  name: string;
  kind: string;
  tool: string | null;
  path: string;
  format_key: string | null;
  tool_name?: string | null;
}

/* ---------------- 条目（Skills / MCP） ---------------- */

export type ItemStatus = "installed" | "not-installed" | "update-available" | "local-modified";

export interface PerTargetState {
  target_id: number;
  target: string;
  state: "latest" | "stale" | "missing";
  deployed_version?: string | null;
  local_version?: string | null;
  deployed_at?: string | null;
}

export interface ItemRow {
  name: string;
  version: string | null;
  source_name?: string | null;
  source_id?: number | null;
  manual?: boolean;
  dir_id?: number | null;
  dir_name?: string | null;
  description?: string;
  transport?: string;
  target?: string;
  env_keys?: string[];
  status: ItemStatus;
  local_version?: string | null;
  hash?: string;
  updated_at?: string | null;
  modified?: boolean;
  deployments?: DeploymentRef[];
  per_target?: PerTargetState[];
}

export interface DeploymentRef {
  target?: string | null;
  target_id?: number;
  hash?: string | null;
}

export interface ItemsResponse extends OkEnvelope {
  items: ItemRow[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
  targets: ItemsTarget[];
}

export interface ItemsTarget {
  id: number;
  name: string;
  tool: string | null;
  tool_name?: string | null;
  path: string;
  kind?: string;
  format_key?: string;
  items: { latest: number; stale: number; missing: number; total: number };
  stale_names: string[];
}

export interface RegistryRow {
  name: string;
  version: string | null;
  hash: string;
  updated_at?: string | null;
  manual: boolean;
  dir_id?: number | null;
  modified: boolean;
  deployments: DeploymentRef[];
  transport?: string;
  target?: string;
  env_keys?: string[];
}

export interface ItemDetail {
  ok: boolean;
  name: string;
  kind?: string;
  skill_md?: string | null;
  files?: string[];
  content?: string;
  config?: Record<string, unknown>;
  env_masked?: Record<string, string | null>;
  version?: string | null;
  manual?: boolean;
  dir_id?: number | null;
  dir_name?: string | null;
  from_source?: boolean;
  error?: string;
}

/* ---------------- Sources ---------------- */

export interface SourceRow {
  id: number;
  kind: string;
  name: string;
  url: string;
  branch: string;
  subdir: string;
  auth_ref: string | null;
  enabled: boolean;
  poll_min: number;
  created_at: string;
  last_sync_at: string | null;
  last_commit: string | null;
  last_error: string | null;
  repo_id: number | null;
  item_count: number;
  snapshot_count: number;
  registry_count: number;
}

export interface RemoteRepo {
  id: number;
  name: string;
  url: string;
  branch: string;
  subdir: string;
  auth_ref: string | null;
  poll_min: number;
  created_at: string;
  modules: string[];
  sources: Record<string, SourceRow>;
}

/* ---------------- /api/state ---------------- */

export interface ScheduleEntry {
  enabled: boolean;
  interval_min: number;
}

export type ScheduleMap = Record<string, ScheduleEntry>;

export interface WatchStatus {
  backend: string;
  rev: number;
  events: number;
  resyncs: number;
  watched: number;
  fds: number;
  subs: number;
  degraded: boolean;
  failed_watches?: number;
}

export interface StateResponse {
  version: string;
  rev: number;
  watch: WatchStatus;
  tools: Record<string, ToolCount>;
  tool_list: ToolPublic[];
  sessions: SessionRow[];
  ledger: LedgerRow[];
  migrations: MigrationRow[];
  schedule: ScheduleMap;
  engine: { casr: boolean; agentmemory: boolean };
  memories: MemoryNote[];
  now: string;
}

export interface ModulesResponse {
  ok: boolean;
  modules: ModuleEntry[];
}

export interface ModuleEntry {
  id: string;
  name: string;
  desc: string;
  enabled: boolean;
  nav: { key: string; label: string; order: number };
}

/* ---------------- 统计 ---------------- */

export interface StatsResponse {
  ok: boolean;
  stats: {
    totals: { sessions: number; messages: number; starred: number; migrations: number };
    by_tool: { tool: string; sessions: number; messages: number }[];
    by_day: { day: string | null; sessions: number }[];
    by_project: { project: string | null; sessions: number }[];
  };
}

/* ---------------- SSE ---------------- */

export interface SseHello {
  rev: number;
  backend: string;
  degraded: boolean;
  watch: WatchStatus;
}

export interface SseChange {
  rev: number;
  scopes: string[];
  full: boolean;
  ts?: number;
  lagged?: number;
}

/* ---------------- 健康 ---------------- */

export interface HealthResponse {
  ok: boolean;
  degraded: boolean;
  uptime_s: number;
  rss_kb: number;
  fds: number;
  rev: number;
  events: number;
  watched: number;
  failed_watches: number;
  subs: number;
}
