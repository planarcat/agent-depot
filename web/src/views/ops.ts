/* 台账视图（统一 nv-layout）：左筛选 / 中流水 + 分页 / 右详情 */

import { api } from "../core/api.ts";
import { qs, qsa } from "../core/dom.ts";
import { esc } from "../core/format.ts";
import type { OpsRow } from "../core/types/api.ts";

interface OpsResponse {
  ok: boolean;
  total: number;
  items: OpsRow[];
}

interface OpsState {
  module: string;
  status: string;
  q: string;
  page: number;
  perPage: number;
  items: OpsRow[];
  total: number;
  sel: OpsRow | null;
}

const S: OpsState = {
  module: "all",
  status: "all",
  q: "",
  page: 1,
  perPage: 40,
  items: [],
  total: 0,
  sel: null,
};

const STATUS_CLS: Record<string, string> = { ok: "ok", failed: "err", conflict: "neutral" };

function statusCls(status: string): string {
  return STATUS_CLS[status] ?? "neutral";
}

async function load(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams({
    module: S.module,
    status: S.status,
    limit: String(S.perPage),
    offset: String((S.page - 1) * S.perPage),
  });
  if (S.q) params.set("q", S.q);
  const res = await api<OpsResponse>(`/api/ops?${params.toString()}`);
  const data = res.data;
  S.items = data.items ?? [];
  S.total = data.total ?? 0;
  render(root);
}

function render(root: HTMLElement): void {
  const ok = S.items.filter((o) => o.status === "ok").length;
  const failed = S.items.filter((o) => o.status === "failed").length;
  const conflict = S.items.filter((o) => o.status === "conflict").length;
  const skipped = S.items.filter((o) => o.status === "skipped").length;
  root.innerHTML = `
      <div class="nv-layout">
        <aside class="nv-left">
          <div class="nv-h"><span>模块</span></div>
          <div class="nv-srcs">
            ${["all", "sessions", "memory", "skills", "mcp", "system", "frontend"]
              .map(
                (m) => `
              <div class="nv-src-row ${S.module === m ? "is-on" : ""}" data-m="${m}">
                <span class="tool-dot ${m === "all" ? "" : "tool-dot--local"}"></span>
                <span class="nv-sname">${m === "all" ? "全部" : m}</span>
              </div>`,
              )
              .join("")}
          </div>
          <div class="nv-h" style="margin-top:var(--sp-2)"><span>状态</span></div>
          <div class="nv-srcs">
            ${[
              ["all", "全部"],
              ["ok", "成功"],
              ["failed", "失败"],
              ["conflict", "冲突"],
              ["skipped", "跳过"],
            ]
              .map(
                ([v, label]) => `
              <div class="nv-src-row ${S.status === v ? "is-on" : ""}" data-s="${v}">
                <span class="tool-dot ${v === "all" || v === "ok" ? "" : "tool-dot--local"}"></span>
                <span class="nv-sname">${label}</span>
              </div>`,
              )
              .join("")}
          </div>
        </aside>
        <main class="center sb-center nv-center" style="border:0">
          <div class="nv-stats">
            <div class="nv-stat"><b>${S.total}</b><span>符合条件（总）</span></div>
            <div class="nv-stat"><b>${ok}</b><span>成功 · 本页</span></div>
            <div class="nv-stat"><b style="color:var(--c-err)">${failed}</b><span>失败 · 本页</span></div>
            <div class="nv-stat"><b style="color:var(--c-warn)">${conflict}</b><span>冲突 · 本页</span></div>
            <div class="nv-stat"><b>${skipped}</b><span>跳过 · 本页</span></div>
          </div>
          <div class="center__toolbar">
            <input class="hub-input search" data-testid="ops-search" placeholder="搜索条目 / 动作…" value="${esc(S.q)}">
            <span class="sb-spacer"></span>
            <span class="mono-xs">共 <b data-testid="ops-count">${S.total}</b> 条</span>
            <a class="hub-btn btn-sm" data-testid="ops-export-csv" href="/api/ops/export?format=csv">导出 CSV</a>
            <a class="hub-btn btn-sm" data-testid="ops-export-json" href="/api/ops/export?format=json">导出 JSON</a>
          </div>
          <div class="rows" data-testid="ops-rows">
            ${
              S.items.length
                ? S.items
                    .map(
                      (o) => `
              <div class="row sb-row ${S.sel && S.sel.id === o.id ? "is-sel" : ""}" data-testid="ops-row" data-oid="${o.id}">
                <div class="mono-xs">${esc((o.ts || "").slice(5, 16).replace("T", " "))}</div>
                <div class="sb-row__main">
                  <span class="hub-badge hub-badge--neutral">${esc(o.module)}</span>
                  <span class="row__title">${esc(o.action)}</span>
                  <span class="hub-badge sb-status--${statusCls(o.status)}">${esc(o.status)}</span>
                  <div class="row__sub">${esc(o.item_name ?? "")} ${o.item_version ? `· ${esc(String(o.item_version).slice(0, 14))}` : ""} ${o.source_name ? `· 源 ${esc(o.source_name)}` : ""} ${o.target_name ? `· 目标 ${esc(o.target_name)}` : ""}</div>
                </div>
              </div>`,
                    )
                    .join("")
                : '<div class="hub-empty">没有匹配的操作记录</div>'
            }
          </div>
          <div class="nv-pager">
            <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? "disabled" : ""}>‹</button>
            <span class="nv-pinfo">第 ${S.page} 页 · 每页 ${S.perPage} · 共 ${S.total} 条</span>
            <button class="nv-pbtn" data-p="next" ${S.page * S.perPage >= S.total ? "disabled" : ""}>›</button>
          </div>
        </main>
        <aside class="nv-right">
          <div class="nv-h"><span>台账详情</span></div>
          <div id="ops-detail"><div class="nv-note">点击中栏任意一条记录查看详情。</div></div>
        </aside>
      </div>`;
  for (const row of qsa<HTMLElement>(".nv-src-row[data-m]", root)) {
    row.onclick = () => {
      S.module = row.dataset["m"] ?? "all";
      S.page = 1;
      void load(root);
    };
  }
  for (const row of qsa<HTMLElement>(".nv-src-row[data-s]", root)) {
    row.onclick = () => {
      S.status = row.dataset["s"] ?? "all";
      S.page = 1;
      void load(root);
    };
  }
  let timer: number | null = null;
  const search = qs<HTMLInputElement>('[data-testid="ops-search"]', root);
  if (search) {
    search.oninput = (e) => {
      if (timer !== null) clearTimeout(timer);
      const value = e.target instanceof HTMLInputElement ? e.target.value : "";
      timer = window.setTimeout(() => {
        S.q = value.trim();
        S.page = 1;
        void load(root);
      }, 250);
    };
  }
  for (const b of qsa<HTMLButtonElement>(".nv-pbtn[data-p]", root)) {
    b.onclick = () => {
      if (b.disabled) return;
      S.page = b.dataset["p"] === "prev" ? S.page - 1 : S.page + 1;
      void load(root);
    };
  }
  for (const row of qsa<HTMLElement>('[data-testid="ops-row"]', root)) {
    row.onclick = () => showDetail(root, Number(row.dataset["oid"]));
  }
  if (S.sel && S.items.some((o) => o.id === S.sel?.id)) showDetail(root, S.sel.id);
}

function showDetail(root: HTMLElement, oid: number): void {
  const o = S.items.find((x) => x.id === oid);
  if (!o) return;
  S.sel = o;
  for (const r of qsa<HTMLElement>('[data-testid="ops-row"]', root)) {
    r.classList.toggle("is-sel", Number(r.dataset["oid"]) === oid);
  }
  const box = qs<HTMLElement>("#ops-detail", root);
  if (!box) return;
  let extra = "";
  try {
    const detail: unknown = JSON.parse(o.detail || "null");
    if (detail && typeof detail === "object") {
      extra = `<div class="nv-sec"><span>detail</span></div>
          <pre class="sb-md">${esc(JSON.stringify(detail, null, 2))}</pre>`;
    }
  } catch {
    /* 非 JSON detail 忽略 */
  }
  box.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle" style="font-size:var(--fs-m)">${esc(o.action)} <span class="hub-badge hub-badge--neutral">${esc(o.module)}</span>
          <span class="hub-badge sb-status--${statusCls(o.status)}">${esc(o.status)}</span></div>
        <div class="nv-ddesc mono-xs">${esc(o.ts || "")}</div>
      </div>
      <div class="nv-sec"><span>对象</span></div>
      <div class="nv-frow"><span class="mono-xs">条目</span><span class="nv-fmeta">${esc(o.item_name ?? "—")}${o.item_version ? ` · ${esc(String(o.item_version).slice(0, 14))}` : ""}</span></div>
      <div class="nv-frow"><span class="mono-xs">来源</span><span class="nv-fmeta">${esc(o.source_name ?? "—")}</span></div>
      <div class="nv-frow"><span class="mono-xs">目标</span><span class="nv-fmeta">${esc(o.target_name ?? "—")}</span></div>
      ${o.reason ? `<div class="nv-sec"><span>原因</span></div><div class="nv-note sb-err-text">${esc(String(o.reason).slice(0, 400))}</div>` : ""}
      ${extra}`;
}

export const OpsView = {
  async render(root: HTMLElement): Promise<void> {
    await load(root);
  },
  refresh: load,
};
