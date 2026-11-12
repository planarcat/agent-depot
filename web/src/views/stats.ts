/* 统计页（对齐 Figma Pages.tsx · StatsPage）：KPI 4 卡 + 各工具会话数 + 最近迁移 lineage
   数据源：/api/stats（totals/by_tool/by_day/by_project）+ state.migrations */

import { api } from "../core/api.ts";
import { skeletonRows } from "../core/dom.ts";
import { esc, fmtNum } from "../core/format.ts";
import { state } from "../core/state.ts";
import { allTools, toolColorCls, toolShort } from "../core/tools.ts";
import type { MigrationRow, StatsResponse } from "../core/types/api.ts";

interface StatsCache {
  totals?: { sessions?: number; messages?: number; starred?: number; migrations?: number };
  by_tool?: { tool: string; sessions: number; messages: number }[];
}

function nameOf(toolId: string): string {
  const t = allTools().find((x) => x.id === toolId);
  return t ? t.name : toolId;
}

function chipOf(toolId: string): { short: string; cls: string } {
  const t = allTools().find((x) => x.id === toolId);
  const short = t ? toolShort(t) : String(toolId).slice(0, 2).toUpperCase();
  const cls = t ? toolColorCls(t) : "chip--muted";
  return { short, cls };
}

function html(st: StatsCache | null): string {
  const totals = st?.totals ?? {};
  const tools = st?.by_tool ?? [];
  const migs: MigrationRow[] = (state.migrations ?? []).slice(0, 8);
  const kpi = [
    { n: fmtNum(totals.sessions), l: "会话总数" },
    { n: fmtNum(totals.messages), l: "消息条数" },
    { n: fmtNum(totals.starred), l: "星标会话" },
    { n: fmtNum(totals.migrations), l: "迁移次数" },
  ];
  const max = Math.max(1, ...tools.map((t) => t.sessions || 0));
  return `
      <div class="statwrap">
        <div class="statkpi">
          ${kpi
            .map(
              (k) => `<div class="mcard lift statkpi__c"><div class="statkpi__n">${esc(k.n)}</div>
            <div class="statkpi__l">${esc(k.l)}</div></div>`,
            )
            .join("")}
        </div>
        <div class="statgrid">
          <section class="mcard statsec">
            <h3 class="statsec__h">各工具会话数</h3>
            <div class="statbars">
              ${
                tools
                  .map((t, i) => {
                    const c = chipOf(t.tool);
                    return `<div class="statbar">
                  <span class="mvi__src ${esc(c.cls)} statbar__chip">${esc(c.short)}</span>
                  <span class="statbar__name" title="${esc(nameOf(t.tool))}">${esc(nameOf(t.tool))}</span>
                  <span class="statbar__track"><span class="statbar__fill" style="width:${Math.round(((t.sessions || 0) / max) * 100)}%;background:var(--c-accent);animation-delay:${i * 40}ms"></span></span>
                  <span class="mono statbar__n">${esc(t.sessions)}</span></div>`;
                  })
                  .join("") || '<div class="hub-empty">还没有采集到会话</div>'
              }
            </div>
          </section>
          <section class="mcard statsec">
            <h3 class="statsec__h">最近迁移 · lineage</h3>
            ${
              migs.length
                ? migs
                    .map(
                      (m) => `
              <div class="statmig">
                <div class="mono statmig__t">${esc((m.ts || "").slice(5, 16).replace("T", " "))} ·
                  <span class="statmig__lid">${esc(m.lid)}</span></div>
                <div class="statmig__d">${esc(nameOf(m.src_tool))} → ${esc(nameOf(m.dst_tool))}
                  ${m.status ? ` · ${esc(m.status)}` : ""}${m.src_msg_count ? ` · ${esc(m.src_msg_count)} 条` : ""}</div>
              </div>`,
                    )
                    .join("")
                : '<div class="hub-empty">还没有迁移记录</div>'
            }
          </section>
        </div>
      </div>`;
}

export const StatsView = {
  async render(root: HTMLElement | null): Promise<void> {
    if (!root) return;
    root.innerHTML = `<div class="statwrap">${skeletonRows(3)}</div>`;
    let cache: StatsCache | null = null;
    try {
      const r = await api<StatsResponse>("/api/stats");
      cache = r.data.stats ?? null;
    } catch {
      cache = null;
    }
    root.innerHTML = html(cache);
  },
};
