/**
 * 模块版式组件库（记忆 / Skills / MCP 共用）：来源卡片 · 分组 · 目标选择 · 条目行 · 骨架。
 * 结构与类名是视觉契约（DESIGN.md / e2e data-testid），改动前先对稿。
 */

import { HubUI } from "../hub-ui.ts";
import { qs, qsa } from "./dom.ts";
import { esc } from "./format.ts";
import { state } from "./state.ts";
import { allTools, toolColorCls, toolShort } from "./tools.ts";
import type { LedgerRow } from "./types/api.ts";

const SVG_CHEV =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

export type Tone = "muted" | "accent" | "ok" | "warn" | "err";

export function pill(tone: Tone | undefined, text: string): string {
  return `<span class="pill pill--${tone ?? "muted"}">${esc(text)}</span>`;
}

const VIRTUAL: Record<string, [string, string]> = {
  notes: ["NB", "chip--accent"],
  local: ["LO", "chip--accent"],
  remote: ["RM", "chip--muted"],
  all: ["全", "chip--accent"],
  manual: ["手动", "chip--muted"],
};

function toolOf(id: string): { id: string; name: string; color: number } {
  const t = allTools().find((x) => x.id === id);
  return t ?? { id, name: id, color: 1 };
}

export function short(id: string): string {
  const v = VIRTUAL[id];
  if (v) return v[0];
  return toolShort(toolOf(id));
}

export function cls(id: string): string {
  const v = VIRTUAL[id];
  if (v) return v[1];
  return toolColorCls(toolOf(id));
}

export function chip(chipShort: string, chipCls: string | undefined): string {
  return `<span class="mvi__src ${chipCls || "chip--muted"}">${esc(chipShort || "")}</span>`;
}

const ICONS: Record<string, string> = {
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11A8.5 8.5 0 1 0 12 20.5"/>' +
    '<path d="M20.5 4v7h-7"/></svg>',
  layout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l4-4 4 4M8 16l4 4 4-4M4 12h16"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>' +
    '<path d="M10 11v6M14 11v6"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/>' +
    '<path d="M16 16l4.5 4.5"/></svg>',
  gear:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33' +
    " 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06" +
    "a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9" +
    "a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3V3" +
    "a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06" +
    'A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

export function ic(name: string): string {
  return ICONS[name] ?? "";
}

type GroupKind = "local" | "remote" | "tool";

const GKIND: Record<GroupKind, { tint: string; icon: string }> = {
  local: {
    tint: "var(--c-accent)",
    icon: '<path d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4"/>',
  },
  remote: {
    tint: "var(--c-tool-p8)",
    icon: '<path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>',
  },
  tool: {
    tint: "var(--c-tool-p5)",
    icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>',
  },
};

export interface CardAct {
  key: string;
  label: string;
  title?: string;
  danger?: boolean;
  icon?: string;
  testid?: string;
}

export interface SourceCard {
  id: string;
  name: string;
  short?: string;
  cls?: string;
  off?: boolean;
  title?: string;
  count?: number;
  tag?: string;
  acts?: CardAct[];
}

export interface SourceGroup {
  kind: GroupKind;
  label: string;
  desc?: string;
  ids: string[];
  actions?: string[];
}

export interface Stat {
  n: number;
  label: string;
  tone?: "warn";
}

export interface TopOptions {
  prefix: string;
  label?: string;
  sources: SourceCard[];
  counts?: Record<string, number>;
  activeId?: string | null;
  groups?: SourceGroup[];
  bulk?: string;
  stats?: Stat[];
  hint?: string;
}

function cardHead(s: SourceCard, o: TopOptions, count: number | ""): string {
  const cntTid = o.prefix ? `${o.prefix}-cnt-${s.id}` : "";
  const n = count === "" ? "0" : String(count);
  const tip = `${n} 个条目`;
  const big = n.length >= 6;
  const shown = big ? "∞" : n;
  const lenCls = big
    ? ""
    : n.length >= 5
      ? " is-n5"
      : n.length === 4
        ? " is-n4"
        : n.length === 3
          ? " is-n3"
          : "";
  const acts = s.acts ?? [];
  const pull = acts.find((a) => a.key === "pull");
  const others = acts
    .filter((a) => a.key !== "pull")
    .map(
      (a) =>
        `<button class="tcard__act ${a.danger ? "is-danger" : ""}" data-act="${esc(a.key)}"
        ${a.testid ? `data-testid="${esc(a.testid)}"` : ""} title="${esc(a.title || a.label)}"
        aria-label="${esc(a.title || a.label)}">${a.icon || esc(a.label)}</button>`,
    )
    .join("");
  const first = pull
    ? `<button class="tcard__pull" data-act="pull" title="拉取（${esc(n)} 个条目）" aria-label="拉取">
           <span class="tcard__cnt mono${lenCls}" ${cntTid ? `data-testid="${esc(cntTid)}"` : ""}>${esc(shown)}</span>
           <span class="tcard__pullic">${pull.icon ?? ""}</span>
         </button>`
    : `<span class="tcard__cnt mono${lenCls}" title="${esc(tip)}" ${cntTid ? `data-testid="${esc(cntTid)}"` : ""}>${esc(shown)}</span>`;
  return `<span class="tcard__acts${pull ? " has-acts" : ""}">${first}${others}</span>`;
}

/** 唯一的来源卡片组件：会话页工具卡 / 记忆来源 / Skills 来源 / MCP 来源都是它。 */
export function card(s: SourceCard, o: TopOptions): string {
  const active =
    o.activeId !== null && o.activeId !== undefined && String(o.activeId) === String(s.id);
  const count = s.count ?? o.counts?.[s.id] ?? 0;
  return `
      <div class="tcard ${active ? "is-on" : ""} ${s.off ? "is-off" : ""}"
           data-src="${esc(s.id)}" title="${esc(s.title || s.name)}"
           ${o.prefix ? `data-testid="${esc(o.prefix)}-card-${esc(s.id)}"` : ""}>
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        ${cardHead(s, o, count)}
        <button class="tcard__open" aria-label="${esc(s.name)}">
          <span class="tcard__chip ${s.cls || "chip--muted"}">${esc(s.short ?? "")}</span>
          <span class="tcard__nm">${esc(s.name)}</span>
        </button>
        ${s.tag ? `<span class="tcard__tag">${s.tag}</span>` : ""}
      </div>`;
}

/** 顶部来源卡片 + 批量按钮 + 统计条 + hint；给 groups 时按来源类型分组。 */
export function top(o: TopOptions): string {
  if (o.groups && o.groups.length > 0) {
    const panels = o.groups
      .map((g) => {
        const list = (o.sources ?? []).filter((s) => g.ids.includes(s.id));
        if (list.length === 0) return "";
        const total = list.reduce((n, s) => n + (o.counts?.[s.id] ?? 0), 0);
        const k = GKIND[g.kind];
        return `
          <div class="srcgroup" data-g="${esc(g.kind)}">
            <div class="srcgroup__side" role="button" tabindex="0" data-gfold="${esc(g.kind)}"
                 title="点击折叠 / 展开本组">
              <div class="srcgroup__toph">
                <span class="srcgroup__ic" style="color:${k.tint}">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${k.icon}</svg></span>
                <span class="srcgroup__name">${esc(g.label)}</span>
                <span class="srcgroup__fold">${SVG_CHEV}</span>
              </div>
              <div class="mono srcgroup__meta">${list.length} 源 · ${total} 条</div>
              <div class="srcgroup__d" title="${esc(g.desc ?? "")}">${esc(g.desc ?? "")}</div>
              <div class="srcgroup__acts">${(g.actions ?? [])
                .map(
                  (a) =>
                    `<button class="hub-btn btn-sm" data-gact="${esc(g.kind)}:${esc(a)}">${esc(a)}</button>`,
                )
                .join("")}</div>
            </div>
            <div class="srcgroup__body">
              <div>
                <div class="srcgroup__grid">${list.map((x) => card(x, o)).join("")}</div>
              </div>
            </div>
          </div>`;
      })
      .join("");
    return (
      `
        <div class="srcgroups" data-testid="${esc(o.prefix)}-sources">${panels}</div>
        <div class="mv-stats">${(o.stats ?? [])
          .map(
            (x) =>
              `<span class="mv-stat ${x.tone === "warn" ? "is-warn" : ""}">` +
              `<b>${esc(String(x.n))}</b><span>${esc(x.label)}</span></span>`,
          )
          .join("")}` +
      `${o.bulk ? `<span class="mv-stats__acts">${o.bulk}</span>` : ""}` +
      `${o.hint ? `<span class="mv-hint" title="${esc(o.hint)}">${esc(o.hint)}</span>` : ""}</div>`
    );
  }
  const cards = (o.sources ?? [])
    .map(
      (s) => `
      <div class="tcard ${o.activeId === s.id ? "is-on" : ""} ${s.off ? "is-off" : ""}"
           data-src="${esc(s.id)}" title="${esc(s.title || s.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        ${cardHead(s, o, o.counts?.[s.id] ?? 0)}
        <button class="tcard__open" aria-label="${esc(s.name)}">
          <span class="tcard__chip ${s.cls || "chip--muted"}">${esc(s.short ?? "")}</span>
          <span class="tcard__nm">${esc(s.name)}</span>
        </button>
      </div>`,
    )
    .join("");
  return (
    `
      ${o.bulk ? `<div class="mv-top__h"><span class="mv-top__acts">${o.bulk}</span></div>` : ""}
      <div class="tgrid" data-testid="${esc(o.prefix)}-sources">${cards}</div>
      <div class="mv-stats">${(o.stats ?? [])
        .map(
          (x) =>
            `<span class="mv-stat ${x.tone === "warn" ? "is-warn" : ""}">` +
            `<b>${esc(String(x.n))}</b><span>${esc(x.label)}</span></span>`,
        )
        .join("")}` +
    `${o.hint ? `<span class="mv-hint" title="${esc(o.hint)}">${esc(o.hint)}</span>` : ""}</div>`
  );
}

/**
 * 卡片区就地同步：签名（来源 id + 数量）不变时只切 is-on，不重建 DOM
 * （重建节点天生带 is-on → CSS 过渡没有起点）。返回 true = 走了就地分支。
 */
export function syncCards(
  host: HTMLElement | null,
  html: string,
  sig: string,
  activeId: string | null | undefined,
): boolean {
  if (!host) return false;
  if (host.dataset["cardsig"] === sig) {
    const on = activeId === null || activeId === undefined ? null : String(activeId);
    for (const c of qsa<HTMLElement>(".tcard[data-src]", host)) {
      c.classList.toggle("is-on", on !== null && String(c.dataset["src"]) === on);
    }
    return true;
  }
  host.dataset["cardsig"] = sig;
  host.innerHTML = html;
  HubUI.drawFrames(host);
  growIn(host);
  return false;
}

export interface PickerItem {
  id: string;
  name: string;
  dotCls?: string;
  sub?: string;
  meta?: string;
  title?: string;
  testid?: string;
}

export interface PickerOptions {
  prefix: string;
  items: PickerItem[];
  chosen: string[];
  selLine?: string;
  selLineFn?: (set: Set<string>) => string;
  goText?: string;
  goTextFn?: (set: Set<string>) => string;
  emptyHint?: string;
  extraHTML?: string;
  onChange?: (ids: string[]) => void;
  onGo?: (ids: string[]) => void;
}

export interface Picker {
  html: string;
  bind: (host: ParentNode | null) => void;
}

/** 统一目标选择组件（多选行 + 全选/清空 + 主按钮）。 */
export function targetPicker(o: PickerOptions): Picker {
  const items = o.items;
  const chosen = new Set(o.chosen.map(String));
  const rows = items
    .map(
      (it) => `
      <li><button class="stgt ${chosen.has(String(it.id)) ? "is-on" : ""}" data-target="${esc(String(it.id))}"
          ${it.testid ? `data-testid="${esc(it.testid)}"` : ""} aria-pressed="${chosen.has(String(it.id)) ? "true" : "false"}"
          title="${esc(it.title || it.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        <span class="stgt__dot ${it.dotCls || "tool-dot--local"}"></span>
        <span class="stgt__txt">
          <span class="stgt__nm">${esc(it.name)}</span>
          ${it.sub ? `<span class="stgt__sub">${esc(it.sub)}</span>` : ""}
        </span>
        ${it.meta ? `<span class="stgt__radio-note">${esc(it.meta)}</span>` : ""}
        <span class="stgt__radio"></span>
      </button></li>`,
    )
    .join("");
  const html = `
      <div class="spanel__sel" data-testid="${esc(o.prefix)}-picker-sel">${o.selLine ?? ""}</div>
      <ul class="spanel__targets is-multi" data-testid="${esc(o.prefix)}-picker-targets">
        ${rows || `<li class="stgt__none">没有可选的目标：${esc(o.emptyHint ?? "先在 设置 → 工具 里接入目标目录")}</li>`}
      </ul>
      ${o.extraHTML ?? ""}
      <div class="spanel__go">
        <button class="hub-btn btn-sm spanel__quick" data-testid="${esc(o.prefix)}-picker-quick" ${items.length ? "" : "disabled"}>全选</button>
        <button class="spanel__gobtn" data-testid="${esc(o.prefix)}-picker-go" ${chosen.size ? "" : "disabled"}>${esc(o.goText ?? "")}</button>
      </div>`;

  function bind(host: ParentNode | null): void {
    if (!host) return;
    const sel = qs<HTMLElement>(`[data-testid="${o.prefix}-picker-sel"]`, host);
    const quick = qs<HTMLButtonElement>(`[data-testid="${o.prefix}-picker-quick"]`, host);
    const go = qs<HTMLButtonElement>(`[data-testid="${o.prefix}-picker-go"]`, host);
    const set = new Set(o.chosen.map(String));
    const allOn = (): boolean => items.length > 0 && items.every((i) => set.has(String(i.id)));
    const sync = (): void => {
      for (const b of qsa<HTMLElement>(".spanel__targets .stgt", host)) {
        const on = set.has(String(b.dataset["target"]));
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      if (quick) quick.textContent = allOn() ? "清空" : "全选";
      if (sel && o.selLineFn) sel.innerHTML = o.selLineFn(set);
      if (go) {
        go.disabled = set.size === 0;
        if (o.goTextFn) go.textContent = o.goTextFn(set);
      }
      o.onChange?.([...set]);
    };
    for (const b of qsa<HTMLElement>(".spanel__targets .stgt", host)) {
      b.onclick = () => {
        const id = String(b.dataset["target"]);
        if (set.has(id)) set.delete(id);
        else set.add(id);
        sync();
      };
    }
    if (quick) {
      quick.onclick = () => {
        const all = allOn();
        set.clear();
        if (!all) for (const i of items) set.add(String(i.id));
        sync();
      };
    }
    if (go)
      go.onclick = () => {
        if (set.size > 0) o.onGo?.([...set]);
      };
    sync();
    HubUI.drawFrames(host as ParentNode);
  }
  return { html, bind };
}

/** 详细布局左上角的「切换为简略布局」按钮（悬停工具区才浮现）。 */
export function hdrToggle(
  hdr: HTMLElement | null,
  prefix: string,
  onToggle: () => void,
): HTMLButtonElement | null {
  if (!hdr) return null;
  let b = qs<HTMLButtonElement>(`#${prefix}-hdrtoggle`, hdr);
  if (!b) {
    b = document.createElement("button");
    b.id = `${prefix}-hdrtoggle`;
    b.className = "hdr__toggle";
    b.innerHTML = ic("layout");
    hdr.appendChild(b);
  }
  b.title = "切换到简略布局";
  b.setAttribute("aria-label", "切换到简略布局");
  b.hidden = false;
  b.onclick = onToggle;
  return b;
}

/** 新渲染块里已有 is-on 时补播一次选中动效（构造过渡起点）。 */
export function growIn(root: ParentNode | null): void {
  const on = root ? qs<HTMLElement>(".is-on", root) : null;
  if (!on) return;
  on.classList.remove("is-on");
  void on.getBoundingClientRect();
  on.classList.add("is-on");
}

/** 分组折叠：点左侧信息面板切换（按钮点击不触发）；幂等。 */
export function bindGroups(root: ParentNode | null): void {
  if (!root) return;
  for (const group of qsa<HTMLElement>("[data-gfold]", root)) {
    if (group.dataset["gfoldBound"]) continue;
    group.dataset["gfoldBound"] = "1";
    const toggle = (): void => {
      const grp = group.closest(".srcgroup");
      if (grp instanceof HTMLElement) grp.classList.toggle("is-closed");
    };
    group.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest("button")) return;
      toggle();
    };
    group.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    };
  }
}

/** 内容区过渡：仅在"当前来源/工具"变化时重播 fadeX（同源刷新不闪）。 */
export function swap(root: ParentNode, key: string | null, hostSel?: string): void {
  const host = hostSel
    ? qs<HTMLElement>(hostSel, root)
    : (qs<HTMLElement>(".slist .nv-list", root) ?? qs<HTMLElement>(".nv-list", root));
  if (!host) return;
  const k = String(key ?? "all");
  if (host.dataset["mvKey"] === k) return;
  host.dataset["mvKey"] = k;
  host.classList.remove("mv-swap");
  void host.offsetWidth;
  host.classList.add("mv-swap");
}

export interface SideOptions {
  prefix: string;
  items: SourceCard[];
  activeId?: string | null;
  groups?: SourceGroup[];
  extra?: string;
}

/** 侧边栏（来源切换 + 额外动作）。 */
export function side(o: SideOptions): string {
  const wrap = (t: SourceCard): string => `
      <button class="sside__it ${t.id === o.activeId ? "is-on" : ""} ${t.off ? "is-off" : ""}"
              data-src="${esc(t.id)}" title="${esc(t.title || t.name)}">
        <span class="sside__chip ${t.cls || "chip--muted"}">${esc(t.short ?? "")}</span>
        <span class="sside__nm">${esc(t.name)}</span>
        <span class="sside__n">${t.count !== undefined && t.count !== 0 ? t.count : ""}</span>
      </button>`;
  let body: string;
  if (o.groups && o.groups.length > 0) {
    body = o.groups
      .map((g) => {
        const list = o.items.filter((t) => g.ids.includes(t.id));
        if (list.length === 0) return "";
        return `<div class="sside__grp">${esc(g.label)}</div>${list.map(wrap).join("")}`;
      })
      .join("");
  } else {
    body = o.items.map(wrap).join("");
  }
  return `<button class="sside__back" id="${esc(o.prefix)}-back" title="返回全部来源">‹</button>${body}${o.extra ?? ""}`;
}

export interface ChipBarOptions {
  prefix: string;
  items: SourceCard[];
  activeId?: string | null;
  groups: SourceGroup[];
}

/** 横向来源条：卡片区收成一条 chip 栏（分组标题 + 动作 + 来源 chip + 返回）。 */
export function chipBar(o: ChipBarOptions): string {
  const chipHtml = (t: SourceCard): string => `
      <button class="cbar__it ${t.id === o.activeId ? "is-on" : ""}" data-src="${esc(t.id)}"
              title="${esc(t.title || t.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        <span class="cbar__ic ${t.cls || "chip--muted"}">${esc(t.short ?? "")}</span>
        <span class="cbar__nm">${esc(t.name)}</span>
        <span class="cbar__n mono">${t.count ?? 0}</span>
      </button>`;
  return `<div class="cbar">
      <button class="cbar__back" id="${esc(o.prefix)}-barback" title="切换到详细布局" aria-label="切换到详细布局">${ic("layout")}</button>
      ${o.groups
        .map((gr) => {
          const list = o.items.filter((t) => gr.ids.includes(t.id));
          return `<span class="cbar__grp">
          <span class="cbar__label">${esc(gr.label)}</span>
          ${(gr.actions ?? [])
            .map(
              (a) =>
                `<button class="hub-btn btn-sm" data-gact="${esc(gr.kind)}:${esc(a)}">${esc(a)}</button>`,
            )
            .join("")}
          ${list.map(chipHtml).join("")}
        </span>`;
        })
        .join("")}
    </div>`;
}

export interface ItemOptions {
  id: string | number;
  testid?: string;
  chkTestid?: string;
  sel?: boolean;
  open?: boolean;
  chipText?: string;
  chipCls?: string;
  title: string;
  titleTitle?: string;
  sub?: string;
  meta?: string;
  pillText?: string;
  pillTone?: Tone;
  extra?: string;
  body?: string;
  attrs?: string;
}

/** 唯一的条目行组件（记忆 / Skills / MCP / 会话共用）。 */
export function item(o: ItemOptions): string {
  const c = (suf: string): string => `mvi${suf}`;
  const main = `<span class="mvi__main">
            <span class="mvi__title" title="${esc(o.titleTitle || o.title)}">${esc(o.title)}</span>
            <span class="mvi__sub" title="${esc(o.sub ?? "")}">${esc(o.sub ?? "")}</span>
          </span>`;
  return `
      <div class="${c("")} ${o.open ? "is-open" : ""} ${o.sel ? "is-sel" : ""}${o.chipText ? " has-chip" : ""}" data-id="${esc(o.id)}"
           ${o.testid ? `data-testid="${esc(o.testid)}"` : ""} ${o.attrs ?? ""}>
        <div class="${c("__head")}">
          <input type="checkbox" class="${c("__chk")}" ${o.sel ? "checked" : ""}
                 ${o.chkTestid ? `data-testid="${esc(o.chkTestid)}"` : ""} aria-label="勾选">
          ${o.chipText ? chip(o.chipText, o.chipCls) : ""}
          ${main}
          ${o.meta && !o.open ? `<span class="${c("__meta")}">${esc(o.meta)}</span>` : ""}
          ${o.pillText ? pill(o.pillTone, o.pillText) : ""}
          ${o.extra ?? ""}
          <button class="${c("__chev")}" title="${o.open ? "收起" : "展开"}">${SVG_CHEV}</button>
        </div>
        <div class="${c("__acc")}"><div class="${c("__accin")}">${o.open ? (o.body ?? '<div class="srow__load">加载中…</div>') : ""}</div></div>
      </div>`;
}

export interface AccAction {
  key: string;
  label: string;
  title?: string;
  disabled?: boolean;
  testid?: string;
}

export interface AccOptions {
  meta?: string;
  source?: string;
  text?: string;
  actions?: AccAction[];
}

/** 条目行内展开体：头部 meta · 来源 + 动作按钮，下方内容预览。 */
export function accBody(o: AccOptions): string {
  const acts = (o.actions ?? [])
    .map(
      (a) =>
        `<button class="hub-btn btn-sm" data-acc="${esc(a.key)}"
      ${a.testid ? `data-testid="${esc(a.testid)}"` : ""} ${a.disabled ? "disabled" : ""}
      ${a.title ? `title="${esc(a.title)}"` : ""}>${esc(a.label)}</button>`,
    )
    .join("");
  const bh =
    o.meta || o.source
      ? `<div class="mvi__bh"><span class="mono">${esc(o.meta ?? "")}</span>` +
        `<span>· 来源 ${esc(o.source ?? "")}</span><span class="mvi__bacts">${acts}</span></div>`
      : "";
  return `<div class="mvi__body">${bh}
      <pre class="mvi__pre" data-acc-pre>${esc(o.text ?? "加载中…")}</pre></div>`;
}

export interface LedgerLine {
  time: string;
  op: string;
  name: string;
  bad: boolean;
}

/** 最近台账（从 state.ledger 里按关键词挑）。 */
export function recentLedger(keywords: string[], n = 5): LedgerLine[] {
  const rows: LedgerRow[] = state.ledger ?? [];
  const hit = rows.filter((l) => keywords.some((k) => String(l.action ?? "").includes(k)));
  return hit.slice(0, n).map((l) => {
    let name = "";
    try {
      const d: unknown = JSON.parse(l.detail ?? "{}");
      if (d && typeof d === "object") {
        const obj = d as Record<string, unknown>;
        const tools = Array.isArray(obj["tools"]) ? (obj["tools"] as unknown[]).join(",") : "";
        name = String(obj["item_name"] ?? obj["name"] ?? obj["sid"] ?? obj["tool"] ?? tools ?? "");
      }
    } catch {
      name = String(l.detail ?? "").slice(0, 40);
    }
    const failed = /fail|error|冲突/u.test(String(l.detail ?? ""));
    return {
      time: String(l.ts ?? "")
        .slice(5, 16)
        .replace("T", " "),
      op: (l.action ?? "") + (failed ? " · failed" : ""),
      name,
      bad: failed,
    };
  });
}

export function ledger(rows: LedgerLine[] | null | undefined): string {
  if (!rows || rows.length === 0) return '<div class="nv-note">暂无记录</div>';
  return rows
    .map(
      (l) => `<div class="mv-ledger__row">
      <div class="mv-ledger__t">${esc(l.time)} · <span class="mv-ledger__op ${l.bad ? "is-bad" : ""}">${esc(l.op)}</span></div>
      <div class="mv-ledger__n">${esc(l.name || "")}</div></div>`,
    )
    .join("");
}

export interface ShellOptions {
  prefix: string;
  top?: string;
  q?: string;
  placeholder?: string;
  title?: string;
}

/** 整体骨架：顶部 + 主体三栏容器。 */
export function shell(o: ShellOptions): string {
  return `
      <div class="mv-shell">
        <section class="sess-tools" id="${esc(o.prefix)}-top">${o.top ?? ""}</section>
        <div class="sess__main">
          <aside class="sside" id="${esc(o.prefix)}-side" hidden></aside>
          <section class="slist" id="${esc(o.prefix)}-col">
            <div class="slist__search"><label class="ssearch">
              <span class="ssearch__ic">${ic("search")}</span>
              <input id="${esc(o.prefix)}-q" placeholder="${esc(o.placeholder ?? "搜索…")}" value="${esc(o.q ?? "")}">
            </label></div>
            <div class="nv-list" id="${esc(o.prefix)}-rows"></div>
            <div class="slist__foot">
              <button class="nv-pbtn" id="${esc(o.prefix)}-selall">全选</button>
              <button class="nv-pbtn" id="${esc(o.prefix)}-selinv">反选</button>
              <button class="nv-pbtn" id="${esc(o.prefix)}-selnone">清空</button>
              <span class="nv-pinfo" id="${esc(o.prefix)}-info"></span>
            </div>
          </section>
          <aside class="spanel" id="${esc(o.prefix)}-panel"></aside>
        </div>
      </div>`;
}

export const MV = {
  pill,
  chip,
  ic,
  head: cardHead,
  chipBar,
  syncCards,
  growIn,
  hdrToggle,
  targetPicker,
  bindGroups,
  accBody,
  card,
  chev: (): string => SVG_CHEV,
  short,
  cls,
  top,
  side,
  item,
  ledger,
  recentLedger,
  shell,
  swap,
};
