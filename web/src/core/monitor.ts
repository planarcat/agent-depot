/**
 * 开发版监控页的纯逻辑：健康采样、增量、历史窗口、迷你折线。
 * 全部无 DOM，便于单测；真实轮询在 settings.ts 的监控 pane。
 */

import type { HealthzResponse } from "./types/api.ts";

export interface HealthSample {
  at: number;
  rev: number;
  events: number;
  rssKb: number;
  fds: number;
  subs: number;
  watched: number;
  failed: number;
  degraded: boolean;
  uptimeS: number;
}

export interface HealthDelta {
  rev: number;
  events: number;
  rssKb: number;
  fds: number;
  subs: number;
}

export function sampleFromHealth(h: HealthzResponse, at = Date.now()): HealthSample {
  return {
    at,
    rev: Number(h.rev) || 0,
    events: Number(h.events) || 0,
    rssKb: Number(h.rss_kb) || 0,
    fds: Number(h.fds) || 0,
    subs: Number(h.subs) || 0,
    watched: Number(h.watched) || 0,
    failed: Number(h.failed_watches) || 0,
    degraded: !!h.degraded,
    uptimeS: Number(h.uptime_s) || 0,
  };
}

/** 与上一采样的差值；首帧返回 null。 */
export function diffSamples(prev: HealthSample | null, cur: HealthSample): HealthDelta | null {
  if (!prev) return null;
  return {
    rev: cur.rev - prev.rev,
    events: cur.events - prev.events,
    rssKb: cur.rssKb - prev.rssKb,
    fds: cur.fds - prev.fds,
    subs: cur.subs - prev.subs,
  };
}

/** 追加采样并保留最近 max 条。 */
export function pushSample(history: HealthSample[], cur: HealthSample, max = 60): HealthSample[] {
  const next = [...history, cur];
  return next.length <= max ? next : next.slice(next.length - max);
}

/** 每两个采样之间的事件增量（事件/秒的近似）。 */
export function eventRateSeries(history: HealthSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const cur = history[i];
    if (!prev || !cur) continue;
    out.push(Math.max(0, cur.events - prev.events));
  }
  return out;
}

/** SVG polyline 的 points（viewBox 0 0 width height）；空/单点返回空串。 */
export function sparklinePoints(values: number[], width = 100, height = 32): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - 1 - ((v - min) / span) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${r}s`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

export function formatRss(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** +3 / -2 / 0 / —（首帧）。 */
export function formatDelta(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : String(n);
}
