/**
 * 连接画布状态机（纯逻辑，零 DOM）——四态连线，点击即落库。
 *
 * 口径（2026-11-05 拍板，2026-11-14 收敛）：
 *   绿实=全链接自动同步 / 绿虚=部分链接自动同步 / 灰虚=已链接不自动同步 / 无连线=不画线
 * 只有这四种状态，不存在暂存确认层——画布上的一切点击直接 PATCH/POST/DELETE 落库
 * （原型「编辑态」搬来的 stage / 确认条 / is-pending 红线已删，见 FIGMA_OVERRIDES.md 2026-11-14）。
 */

import type { DirBinding, DirLayout, ItemsResponse, TargetPublic } from "./types/api.ts";

export type Channel = "skills" | "mcp";

export const CHANNEL_LABEL: Record<Channel, string> = { skills: "Skills", mcp: "MCP" };

/** 连线视觉态。 */
export type LaneVisual = "full" | "part" | "blocked" | "paused" | "off";

export interface CanvasDir {
  id: number;
  name: string;
  counts: { skills: number; mcp: number };
  layout: DirLayout | null;
}

export interface CanvasState {
  dirs: CanvasDir[];
  repos: unknown[];
  tools: { id: string; name: string; color: number }[];
  skTargets: TargetPublic[];
  mcpTargets: TargetPublic[];
  binds: DirBinding[];
  items: Record<Channel, string[]>;
  selDir: number | null;
  selTool: string | null;
  selRepo: number | null;
  types: Record<Channel, boolean>;
  panelShown: boolean;
}

export function createCanvasState(): CanvasState {
  return {
    dirs: [],
    repos: [],
    tools: [],
    skTargets: [],
    mcpTargets: [],
    binds: [],
    items: { skills: [], mcp: [] },
    selDir: null,
    selTool: null,
    selRepo: null,
    types: { skills: true, mcp: true },
    panelShown: false,
  };
}

export function laneKey(dirId: number, toolId: string, ch: Channel): string {
  return `${dirId}:${toolId}:${ch}`;
}

export function targetOf(s: CanvasState, toolId: string, ch: Channel): TargetPublic | null {
  const list = ch === "mcp" ? s.mcpTargets : s.skTargets;
  return list.find((t) => t.tool === toolId) ?? null;
}

export function baseBind(
  s: CanvasState,
  dirId: number,
  toolId: string,
  ch: Channel,
): DirBinding | null {
  return (
    s.binds.find(
      (b) => b.dir_id === dirId && b.tool === toolId && (b.channels ?? []).includes(ch),
    ) ?? null
  );
}

/** 绑定存在（enabled 0/1 都算"已连线"）。 */
export function laneOn(s: CanvasState, dirId: number, toolId: string, ch: Channel): boolean {
  return baseBind(s, dirId, toolId, ch) !== null;
}

/** 已连线但暂停自动同步。 */
export function lanePaused(s: CanvasState, dirId: number, toolId: string, ch: Channel): boolean {
  const b = baseBind(s, dirId, toolId, ch);
  return b !== null && !b.enabled;
}

export function laneState(
  s: CanvasState,
  dirId: number,
  toolId: string,
  ch: Channel,
): "on" | "off" {
  return laneOn(s, dirId, toolId, ch) ? "on" : "off";
}

/** 该通道下"不跟随"的条目。 */
export function laneExcluded(
  s: CanvasState,
  dirId: number,
  toolId: string,
  ch: Channel,
): Set<string> {
  const b = baseBind(s, dirId, toolId, ch);
  return new Set(b?.excluded ?? []);
}

/** 同步模式（缺省 copy）。 */
export function laneMode(
  s: CanvasState,
  dirId: number,
  toolId: string,
  ch: Channel,
): "copy" | "link" {
  const b = baseBind(s, dirId, toolId, ch);
  return b?.mode ?? "copy";
}

export function itemOn(
  s: CanvasState,
  item: string,
  dirId: number,
  toolId: string,
  ch: Channel,
): boolean {
  return laneState(s, dirId, toolId, ch) === "on" && !laneExcluded(s, dirId, toolId, ch).has(item);
}

/** 通道线态（精确口径需要选中目录 + 条目清单）。 */
export function channelState(
  s: CanvasState,
  dirId: number,
  toolId: string,
  ch: Channel,
): LaneVisual {
  if (!laneOn(s, dirId, toolId, ch)) return "off";
  if (lanePaused(s, dirId, toolId, ch)) return "paused";
  const d = s.dirs.find((x) => x.id === dirId);
  if (!d) return "off";
  const total = d.counts[ch] ?? 0;
  if (total === 0) return "full";
  const ex = laneExcluded(s, dirId, toolId, ch);
  const exact = s.selDir === dirId && s.items[ch].length > 0;
  const exN = exact
    ? [...ex].filter((n) => s.items[ch].includes(n)).length
    : Math.min(ex.size, total);
  if (exN >= total) return "blocked";
  return exN > 0 ? "part" : "full";
}

/** 多通道聚合成一个圆点态：full > part > paused/blocked（都未连线 = null）。 */
export function aggState(s: CanvasState, dirId: number, toolId: string): LaneVisual | null {
  const sts = (["skills", "mcp"] as const)
    .map((ch) => channelState(s, dirId, toolId, ch))
    .filter((st) => st !== "off");
  if (sts.length === 0) return null;
  if (sts.includes("full")) return "full";
  if (sts.includes("part")) return "part";
  return sts.includes("paused") ? "paused" : "blocked";
}

/** 目录内某类条目名（从 items_view 响应提取，兼容旧 registry 字段）。 */
export function namesFromItems(res: Pick<ItemsResponse, "items">): string[] {
  return res.items.map((i) => i.name);
}
