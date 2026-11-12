/* ====================================================================
   Agent Depot · 主应用入口
   UI 规范：所有反馈走 HubUI（toast/confirm/prompt）；所有按钮 loading 走 is-loading。
   会话页（工具卡 / 筛选 / 列表 / 选择 / 迁移面板）/ SSE 实时刷新 / 搜索 / 导出 /
   调度 / 笔记记忆视图 / 视图切换 / 滚动记忆 / 设置中心接线 / window.* 桥接。
   ==================================================================== */

import { registerAppActions } from "./core/actions.ts";
import { api, post, setSlowRequestReporter } from "./core/api.ts";
import {
  applyModuleVisibility,
  byId,
  collapseRows,
  copyText,
  flash,
  keySet,
  mustById,
  mustQs,
  qs,
  qsa,
  skeletonRows,
} from "./core/dom.ts";
import { esc, fmtBytes, fmtTime, INTERVALS, stripAttPlaceholders } from "./core/format.ts";
import { MV } from "./core/mv.ts";
import { installGlobalReporting, measureAsync, measureRender, reportPerf } from "./core/report.ts";
import { state } from "./core/state.ts";
import {
  allTools,
  sessionTools,
  setTools,
  toolById,
  toolColorCls,
  toolName,
  toolShort,
} from "./core/tools.ts";
import type {
  MemoryNote,
  MessageRow,
  ModulesResponse,
  OkEnvelope,
  SessionDetail,
  SessionRow,
  SseChange,
  SseHello,
  StateResponse,
  ToolPublic,
} from "./core/types/api.ts";
import { hasLazyView, loadView } from "./core/view-loader.ts";
import { HubUI } from "./hub-ui.ts";

declare global {
  interface Window {
    /** index.html 定时任务面板的内联 onclick 仍按全局函数调用。 */
    closeSchedule?: () => void;
  }
}

/* ---------- 全局错误兜底 / 可观测 ---------- */

const hubErrors: string[] = [];
window.__hubErrors = hubErrors;
window.addEventListener("error", (e) => {
  hubErrors.push(String(e.message));
});

// ⌘R / Ctrl+R / F5 刷新兜底（Tauri 壳由原生菜单接管；浏览器直开时行为一致）
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    window.location.reload();
  } else if (e.key === "F5") {
    e.preventDefault();
    window.location.reload();
  }
});

installGlobalReporting();
setSlowRequestReporter((path, ms, status) => {
  reportPerf(`slow request: ${path}`, { ms, status });
});

// Tauri 壳外（浏览器）⌘R/F5 由浏览器自带；壳内已由原生菜单接管。此处仅兜底：
// 壳内若菜单事件未达（旧版本 App），⌘R 也能刷新。
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    window.location.reload();
  } else if (e.key === "F5") {
    e.preventDefault();
    window.location.reload();
  }
});

/* ---------- 接口响应形状（仅本页用到的字段） ---------- */

interface StateApiResponse extends StateResponse {
  error?: string;
}

interface StarResponse extends OkEnvelope {
  starred: boolean;
}

interface RefreshResult {
  tool: string;
  name?: string;
  new_messages?: number;
  error?: string | null;
  skipped?: boolean;
}

interface RefreshResponse extends OkEnvelope {
  results?: RefreshResult[];
}

interface MigrateResponse extends OkEnvelope {
  duplicate?: boolean;
  lid?: string;
}

interface SyncPreviewResponse {
  sync?: {
    delta?: number | null;
    base_count?: number;
    current_count?: number;
  };
}

interface ExportResponse extends OkEnvelope {
  bytes?: number;
  path?: string;
}

interface SearchHit {
  sid: string;
  tool: string;
  title?: string | null;
  snippet?: string | null;
  hits?: number;
  starred?: number;
}

interface SearchResponse extends OkEnvelope {
  results?: SearchHit[];
}

interface LineageMigration {
  status?: string;
  src_tool?: string;
  dst_tool?: string;
}

interface LineageResponse {
  lid?: string | null;
  migrations?: LineageMigration[];
}

interface Attachment {
  kind: string;
  name: string;
  url: string;
  download: string;
  mime: string;
  size: number | null;
}

interface DetailEntry {
  sid: string;
  tool: string;
  title: string | null;
  starred: number;
  chain: string;
  messagesHTML: string;
  resume: string;
}

interface LiveEvent {
  scopes: string[];
  full: boolean;
}

interface LiveBefore {
  rows: Map<string, number>;
  items: Set<string>;
}

/** 会话页局部 UI 状态：core/state 的类型口径与旧实现不一致，这里按原语义承接。 */
let sessDetail: string | null = null;
let sessLayout: "detail" | "compact" = "detail";
const detailCache: Record<string, DetailEntry | null> = {};

/* ---------- state ---------- */

async function loadState(): Promise<void> {
  const r = await api<StateApiResponse>("/api/state");
  if (r.status !== 200) {
    renderLoadError(r.data.error);
    return;
  }
  Object.assign(state, r.data);
  setTools(r.data.tool_list ?? []);
  const valid = new Set((state.sessions ?? []).map((s) => s.sid));
  for (const sid of [...state.selected]) {
    if (!valid.has(sid)) state.selected.delete(sid);
  }
  renderAll();
  // 模块可见性：/api/modules 状态驱动导航显隐（禁用模块隐藏入口）
  api<ModulesResponse>("/api/modules")
    .then((mr) => {
      if (mr.data.ok) {
        applyModuleVisibility(mr.data.modules ?? []);
        const cur = qs<HTMLElement>(".mod-nav button.is-on");
        if (cur) syncNavIndicator(cur.dataset["view"] ?? "sessions");
      }
    })
    .catch(() => {
      /* 后台刷新失败静默：下一轮事件/轮询会再试 */
    });
}

function renderLoadError(msg: string | undefined): void {
  mustById("session-rows").innerHTML =
    '<div class="hub-empty">加载失败：' +
    esc(msg || "未知错误") +
    '<div class="hub-empty__hint">检查服务是否运行：./run.sh</div></div>';
}

function renderAll(): void {
  renderToolGrid();
  renderFilterSeg();
  renderRows();
  renderStatus();
  renderSelCount();
  renderPanel();
}

/* ---------- 工具卡片网格（会话视图顶部） ---------- */

// 口径 B（2026-10-14 定稿）：停用 = 在所有界面隐藏（含其历史会话）。
// 与设置页文案「禁用的工具在所有界面隐藏」一致：卡片 / 侧栏 / 列表 / 迁移目标同口径，
// 一律只认启用且有会话根目录的工具；重新启用即恢复可见。
// 卡片不再展示会话计数（用户反馈：数字与列表重复、工具停用时常为 0）——
// 计数改写进 aria-label；隐藏节点保留供读屏与 E2E 断言（工具视图列表头已显示 N / 总数）
function toolCardHead(t: ToolPublic, count: number): string {
  // 数量标签：**一直显示**（没有条目就显示 0）。恒为 28×28 正方形，
  // 分档：1~2 位原字号；3~5 位 is-n3/n4/n5 收字号收字距；≥6 位（十万级）方块放不下精确数，
  // 改用语义符号 ∞ 代表「更多」，精确数保留在 title 悬浮提示（不丢信息）。
  const n = String(count);
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
  const first = `<span class="tcard__cnt mono${lenCls}" title="${esc(tip)}" data-testid="count-${esc(t.id)}">${esc(shown)}</span>`;
  return `<span class="tcard__acts">${first}</span>`;
}

function toolCardHtml(t: ToolPublic): string {
  const info = state.tools[t.id] ?? { count: 0, latest: null };
  const warn = t.enabled ? (t.root_exists === false ? "路径不可用" : "") : "已停用";
  const title = [t.name, warn, t.root, "最近活动 " + fmtTime(info.latest)]
    .filter((x): x is string => Boolean(x))
    .join(" · ");
  // 对齐 Figma ToolCard：方形卡片 + 右上角计数 + 居中 色块/名称；路径等信息进 title 提示。
  // 卡片上不放 ⟳/→ 按钮（2026-10-14 按注解去掉，太丑）：单工具采集走侧栏 ⟳、迁移走迁移面板或把会话拖到卡片上
  return `
    <div class="tcard ${state.filter === t.id ? "is-on" : ""} ${t.enabled ? "" : "is-off"}"
         data-testid="tool-card-${esc(t.id)}" data-tool="${esc(t.id)}" data-testid-drop="drop-${esc(t.id)}"
         title="${esc(title)}">
      <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
      ${toolCardHead(t, info.count)}
      <button class="tcard__open" data-testid="tool-open-${esc(t.id)}"
              aria-label="进入 ${esc(t.name)} 的会话视图（${info.count} 条会话）">
        <span class="tcard__chip ${toolColorCls(t)}">${esc(toolShort(t))}</span>
        <span class="tcard__nm">${esc(t.name)}</span>
      </button>
    </div>`;
}

function renderToolGrid(): void {
  const box = byId<HTMLElement>("tool-cards");
  if (!box) return;
  const list = sessionTools();
  const counts = state.tools ?? {};
  const total = list.reduce((n, t) => n + (counts[t.id]?.count ?? 0), 0);
  // 选中切换走就地类名同步（不重建卡片），保住「描边生长 + 背景扫入」动效（2026-10-20）
  const sig = list.map((t) => `${t.id}:${counts[t.id]?.count ?? 0}`).join(",");
  if (box.dataset["sig"] === sig) {
    for (const c of qsa<HTMLElement>(".tcard", box)) {
      c.classList.toggle("is-on", c.dataset["tool"] === state.filter);
    }
    renderSessBar();
    applySessLayout(false);
    return;
  }
  box.dataset["sig"] = sig;
  // 详细布局 = 来源分组（对齐 记忆/Skills/MCP 的 srcgroups；用户指令 2026-10-19「会话也接入」）：
  // 组侧板（图标/名称/统计/说明）+ 卡片；卡片沿用 toolCardHTML，testid 与拖拽迁移落点原样保留
  box.innerHTML = `
    <div class="srcgroup" data-g="tool">
      <div class="srcgroup__side" role="button" tabindex="0" data-gfold="tool" title="点击折叠 / 展开本组">
        <div class="srcgroup__toph">
          <span class="srcgroup__ic" style="color:var(--c-tool-p5)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/></svg></span>
          <span class="srcgroup__name">工具</span>
          <span class="srcgroup__fold">${MV.chev()}</span>
        </div>
        <div class="mono srcgroup__meta">${list.length} 源 · ${total} 条</div>
        <div class="srcgroup__d">点卡片进入该工具的会话；拖会话行到卡片可迁移</div>
      </div>
      <div class="srcgroup__body"><div><div class="srcgroup__grid">${list.map(toolCardHtml).join("")}</div></div></div>
    </div>`;
  for (const c of qsa<HTMLElement>(".tcard", box)) bindToolCard(c);
  HubUI.drawFrames(box); // 像素级描边路径构建 + 尺寸随动（ResizeObserver 在助手内）
  MV.bindGroups(byId("view-sessions"));
  renderSessBar();
  applySessLayout(false);
}

function bindToolCard(card: HTMLElement): void {
  const tid = card.dataset["tool"] ?? "";
  const open = card.querySelector<HTMLElement>(".tcard__open");
  if (open) open.onclick = () => enterTool(tid);
  // 卡片本身是迁移落点（拖会话行到卡片上）；ondragover 必须 preventDefault，drop 才会触发
  card.ondragover = (e) => {
    e.preventDefault();
    card.classList.add("is-hot");
  };
  card.ondragleave = () => card.classList.remove("is-hot");
  card.ondrop = (e) => {
    e.preventDefault();
    card.classList.remove("is-hot");
    const ids = (e.dataTransfer?.getData("text/plain") ?? "").split(",").filter(Boolean);
    migrateConfirmInline(tid, ids.length ? ids : [...state.selected]);
  };
}

/* ---------- 顶部布局切换（对齐 记忆/Skills/MCP；用户指令 2026-10-19「会话也接入」） ---------- */

function focusTool(): ToolPublic | null {
  return state._toolFocus ? toolById(state._toolFocus) : null;
}

/** 简略条内容：全部工具 chip + 当前工具的 ⟳ 单工具采集（判据 testid：focus-refresh） */
function renderSessBar(): void {
  const bar = byId<HTMLElement>("sess-bar");
  if (!bar) return;
  const list = sessionTools();
  const counts = state.tools ?? {};
  const focus = focusTool();
  // 内容未变只同步选中类名，保住 chip 描边动效（2026-10-20）
  // 签名只含「chip 集合 + 数量」：选中变化本身就是要就地切类名的情形，
  // 若把 focus 放进来，切换工具就会重建整条 → 新节点天生带 is-on，描边动效没有起点（2026-10-20 修）
  const sig =
    list.map((t) => `${t.id}:${counts[t.id]?.count ?? 0}`).join(",") + (focus ? "|r" : ""); // 只区分「有无刷新按钮」，仍不含具体工具 id（换工具要走就地切类名）
  if (bar.dataset["sig"] === sig) {
    for (const b of qsa<HTMLElement>(".cbar__it", bar)) {
      b.classList.toggle("is-on", b.dataset["src"] === state._toolFocus);
    }
    // 重新绑定刷新按钮（换工具时早期返回，闭包里 focus 可能还是上一个工具）
    const rb0 = qs<HTMLButtonElement>('[data-testid="focus-refresh"]', bar);
    if (rb0 && focus) rb0.onclick = () => void refreshOne(focus.id, rb0);
    return;
  }
  bar.dataset["sig"] = sig;
  bar.innerHTML = MV.chipBar({
    prefix: "sess",
    items: list.map((t) => ({
      id: t.id,
      name: t.name,
      short: toolShort(t),
      cls: toolColorCls(t),
      count: counts[t.id]?.count ?? 0,
    })),
    activeId: state._toolFocus,
    groups: [{ kind: "tool", label: "工具", ids: list.map((t) => t.id), actions: [] }],
  });
  HubUI.drawFrames(bar); // 像素级描边路径构建 + 尺寸随动（ResizeObserver 在助手内）
  MV.growIn(bar); // 首次进入简略布局时补播选中动效
  if (focus) {
    const cbar = qs<HTMLElement>(".cbar", bar);
    if (cbar) {
      cbar.insertAdjacentHTML(
        "beforeend",
        '<button class="hub-btn btn-sm" data-testid="focus-refresh" title="刷新当前工具">⟳</button>',
      );
    }
    const rb = qs<HTMLButtonElement>('[data-testid="focus-refresh"]', bar);
    if (rb) rb.onclick = () => void refreshOne(focus.id, rb);
  }
  for (const b of qsa<HTMLButtonElement>(".cbar__it", bar)) {
    b.onclick = () => sessPick(b.dataset["src"] ?? "", false);
  }
  const back = byId<HTMLElement>("sess-barback");
  if (back) {
    back.onclick = () => {
      sessLayout = "detail";
      state._sessAnim = true;
      renderAll();
    };
  }
}

/** 布局落地：animate=true 时走两帧过渡（高度钉→下一帧切类名）；renderAll 里恒为 false（幂等即时） */
function applySessLayout(animate: boolean): void {
  const hdr = byId<HTMLElement>("sess-hdr");
  if (!hdr) return;
  const top = byId<HTMLElement>("sess-top");
  const compact = sessLayout === "compact";
  if (!compact) {
    const fullH = top ? top.scrollHeight : 0;
    if (fullH) state._sessFullH = fullH; // compact 时卡片区绝对定位量不到，提前缓存
  }
  if (state._sessFullH) hdr.style.setProperty("--hdr-full", Math.round(state._sessFullH) + "px");
  const apply = (): void => {
    hdr.style.height = "";
    hdr.classList.toggle("is-compact", compact);
    hdr.dataset["layout"] = compact ? "compact" : "detail";
  };
  const wantAnim = animate || state._sessAnim;
  state._sessAnim = false;
  const prev = hdr.dataset["layout"] ?? "";
  const next = compact ? "compact" : "detail";
  if (!(wantAnim && prev) || prev === next) apply();
  else {
    hdr.style.height = Math.round(hdr.getBoundingClientRect().height) + "px";
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }
  if (compact) {
    const dt = hdr.querySelector<HTMLElement>("#sess-hdrtoggle");
    if (dt) dt.hidden = true;
  } else {
    MV.hdrToggle(hdr, "sess", () => {
      sessLayout = "compact";
      state._sessAnim = true;
      renderAll();
    });
  }
  const bar = byId<HTMLElement>("sess-bar");
  if (bar) {
    bar.hidden = !compact;
    // 条在详细布局里是 display:none，量不到尺寸 → 描边路径建不出来；显示之后补建并补播一次选中动效
    if (compact && prev !== next) {
      HubUI.drawFrames(bar);
      MV.growIn(bar);
    }
  }
}

// 详细卡片点击（fromCards=true）与简略 chip 点击共用：点已选 = 只取消，布局不变；点新工具 = 选中（卡片路径同时收合成条）
function sessPick(id: string, _fromCards: boolean): void {
  const same = state._toolFocus === id;
  if (same) {
    state._toolFocus = null;
    state.filter = "all";
  } else {
    state._toolFocus = id;
    state.filter = id;
    // 改动：点工具卡片只「进入该工具的会话筛选」，不再自动收合成简略布局
    //（用户指令 2026-10-20「取消点击卡片进入简略布局」）
  }
  sessDetail = null;
  state._panelOff = false;
  state.selected.clear(); // 换工具=换作用域：已选随之清空，避免"已选 N 条但列表里一条没勾"
  renderAll();
}

// 兼容旧入口名：卡片打开按钮仍走这里
function enterTool(id: string): void {
  sessPick(id, true);
}

/* ---------- filter seg（内置 + 自定义工具，全部按注册表动态生成） ---------- */

let lastSegSig = "__init__";

// 工具筛选不再用 chips（2026-10-14 按注解去掉）：点工具卡片或侧栏进入该工具视图，
// 列表头只保留「全部 / ★ 星标」。
function renderFilterSeg(): void {
  const seg = byId<HTMLElement>("filter-seg");
  if (!seg) return;
  // 口径 B：停用/已移除的工具不该继续筛 → 选中态回退「全部」，避免页签消失后悬空
  if (state.filter !== "all" && state.filter !== "starred") {
    const act = allTools().find((t) => t.id === state.filter);
    if (!(act && act.enabled)) state.filter = "all";
  }
  if (lastSegSig !== "bound") {
    lastSegSig = "bound";
    for (const b of qsa<HTMLButtonElement>("button", seg)) {
      b.onclick = () => setFilter(b.dataset["filter"] ?? "all");
    }
  }
  // 「★ 星标」在底部选择栏（用户指令 2026-10-19「星标筛选放到下面」）：toggle 语义，再点回「全部」
  const star = byId<HTMLElement>("star-toggle");
  if (star && !star.dataset["bound"]) {
    star.dataset["bound"] = "1";
    star.onclick = () => setFilter(state.filter === "starred" ? "all" : "starred");
  }
  syncFilterSegActive();
}

function syncFilterSegActive(): void {
  for (const b of qsa<HTMLElement>("#filter-seg button")) {
    b.classList.toggle("is-on", b.dataset["filter"] === state.filter);
  }
  const star = byId<HTMLElement>("star-toggle");
  if (star) star.classList.toggle("is-on", state.filter === "starred");
}

/* ---------- rows ---------- */

// 会话可见域 = 启用工具的会话（口径 B）；筛选 / 搜索都在这个域内做
/** 会话列表分批：首屏 100 行，触底再追加（655 行场景首屏 DOM 降一个数量级）。 */
const ROW_CHUNK = 100;
let rowObserver: IntersectionObserver | null = null;

function scopedSessions(): SessionRow[] {
  const allowed = new Set(sessionTools().map((t) => t.id));
  return (state.sessions ?? []).filter((s) => allowed.has(s.tool));
}

function visibleSessions(): SessionRow[] {
  let list = scopedSessions();
  if (state.filter === "starred") list = list.filter((s) => s.starred);
  else if (state.filter !== "all") list = list.filter((s) => s.tool === state.filter);
  const q = (mustById<HTMLInputElement>("search-input").value || "").trim().toLowerCase();
  if (q) {
    list = list.filter(
      (s) => (s.title || "").toLowerCase().includes(q) || (s.sid || "").toLowerCase().includes(q),
    );
  }
  return list;
}

/** 绑定单行会话的全部交互（幂等：已绑定行直接跳过）。 */
function bindSessionRow(row: HTMLElement): void {
  if (row.dataset["bound"]) return;
  row.dataset["bound"] = "1";
  const sid = row.dataset["sid"] ?? "";
  const cb = row.querySelector<HTMLInputElement>("input[type=checkbox]");
  if (cb) {
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) state.selected.add(sid);
      else state.selected.delete(sid);
      row.classList.toggle("is-sel", cb.checked);
      state._panelOff = false;
      renderSelCount();
    };
  }
  qsa<HTMLButtonElement>(".mvi-acts [data-act]", row).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const act = b.dataset["act"];
      if (act === "star") {
        const rr = await post<StarResponse>("/api/star", { sid });
        if (!rr.data.ok) {
          HubUI.toast("收藏失败：" + (rr.data.error || ""), "error");
          return;
        }
        const sm = (state.sessions ?? []).find((x) => x.sid === sid);
        if (sm) sm.starred = rr.data.starred ? 1 : 0;
        const dd = detailCache[sid];
        if (dd) dd.starred = rr.data.starred ? 1 : 0;
        HubUI.toast(rr.data.starred ? "已收藏" : "已取消收藏", "success");
        renderRows();
        return;
      }
      if (act === "copy") {
        try {
          await navigator.clipboard.writeText(`casr resume ${sid}`);
          HubUI.toast("已复制 resume 命令", "success");
        } catch {
          HubUI.toast("复制失败（剪贴板被限制）", "warn");
        }
      } else {
        void openSession(sid).then(() => byId<HTMLElement>("sess-export")?.click());
      }
    };
  });
  // 箭头是唯一的"收起"入口（行头点击改成幂等打开后）：已展开 → 收起，否则 → 展开
  const chev = row.querySelector<HTMLElement>(".mvi__chev");
  if (chev) {
    chev.onclick = (e) => {
      e.stopPropagation();
      if (sessDetail === sid) closeSession(sid);
      else void openSession(sid);
    };
  }
  // 点击整行 = 展开 / 收起（就地切换，不重画整表）
  // 行内按钮（勾选 / 收藏 / 折叠箭头 / 详情里的操作）一律不触发展开切换
  row.onclick = (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest("button, input, a")) return;
    toggleSession(sid);
  };
  // 点详情内容任意处 = **不收起**（用户指令 2026-10-19「点击正文不收起」）：内容区用于阅读/选择，
  // 误点不打断；收起只走行头点击或行尾箭头
  const accin = row.querySelector<HTMLElement>(".mvi__accin");
  if (accin) {
    accin.onclick = (e) => {
      e.stopPropagation();
    };
  }
  row.ondragstart = (e) => {
    if (!state.selected.has(sid)) {
      state.selected.add(sid);
      state._panelOff = false;
      renderSelCount();
    }
    e.dataTransfer?.setData("text/plain", [...state.selected].join(","));
  };
}

function renderRows(): void {
  measureRender("sessions.rows", renderRowsInner, 80);
}

function renderRowsInner(): void {
  renderSessStats();
  // 切换工具卡时内容列重播 fadeX（稿子 App.tsx：<div key={activeToolId ?? 'all'} className="a-fadeX">）
  // key 不变时（搜索 / 勾选 / 星标过滤等）不重播，避免无意义闪烁。
  const sessRoot = byId<HTMLElement>("view-sessions");
  if (sessRoot) MV.swap(sessRoot, state._toolFocus || "all", "#session-rows");
  // 选中集合收敛到可见域（启用工具的会话）：避免"已选 1 条"却列表全空（2026-10-14 用户实测）
  const scopedIds = new Set(scopedSessions().map((s) => s.sid));
  for (const sid of [...state.selected]) {
    if (!scopedIds.has(sid)) state.selected.delete(sid);
  }
  const box = mustById<HTMLElement>("session-rows");
  const all = scopedSessions();
  if (!all.length) {
    box.innerHTML =
      (state.sessions ?? []).length > 0
        ? '<div class="hub-empty">当前没有启用工具的会话</div>'
        : '<div class="hub-empty">还没有会话数据<div class="hub-empty__hint">点右上角「全部刷新」开始采集</div></div>';
    renderSessPager();
    return;
  }
  const list = visibleSessions();
  if (!list.length) {
    box.innerHTML =
      '<div class="hub-empty">没有匹配的会话<div class="hub-empty__hint">调整筛选或搜索词试试</div></div>';
    renderSessPager();
    return;
  }
  const showTool = !state._toolFocus;
  const openIdx = list.findIndex((s) => sessDetail === s.sid);
  const initial = Math.min(list.length, Math.max(ROW_CHUNK, openIdx + 1));
  const rowHtml = (s: SessionRow): string => {
    const open = sessDetail === s.sid;
    const anim = open && state._animateOpen === s.sid; // 本次新展开：先渲染收起态，下一帧再展开
    const sel = state.selected.has(s.sid);
    const t = toolById(s.tool);
    const lid = s.lid
      ? `<span class="hub-badge" data-testid="lid-badge">[hub:${s.lid}]</span>`
      : "";
    // 会话行也用统一条目组件：去掉右侧「N 条 · 时间」元信息、胶囊；悬停动作按 Skills 对齐（收藏 / 复制命令 / 导出）
    const acts =
      '<span class="mvi-acts">' +
      `<button class="hub-btn btn-sm${s.starred ? " is-on" : ""}" data-act="star" data-testid="row-star" title="${s.starred ? "取消收藏" : "收藏"}">${s.starred ? "已收藏" : "收藏"}</button>` +
      '<button class="hub-btn btn-sm" data-act="copy" data-testid="row-copy" title="复制 resume 命令">复制</button>' +
      '<button class="hub-btn btn-sm" data-act="export" data-testid="row-export" title="导出 Markdown">导出</button>' +
      "</span>";
    return MV.item({
      id: s.sid,
      testid: "row",
      chkTestid: "row-check",
      sel,
      open: open && !anim,
      attrs: `data-sid="${esc(s.sid)}" data-msgs="${esc(String(s.msg_count ?? ""))}" data-tool="${esc(s.tool)}" draggable="true"${anim ? ' data-anim="1"' : ""}`,
      chipText: showTool ? toolShort(t) : "",
      chipCls: showTool ? toolColorCls(t) : "",
      title: s.title || "(无标题)",
      // 副标题按 Skills 的「来源 · 描述」形态：这里用 工具名 · 更新时间（原右侧的 N 条·时间 已去掉）
      sub: `${t ? t.name : s.tool} · ${fmtTime(s.updated_at)}`,
      extra: `${acts}${lid}`,
      body: open ? detailHtml(s.sid) : "",
    });
  };

  rowObserver?.disconnect();
  rowObserver = null;
  box.innerHTML = list.slice(0, initial).map(rowHtml).join("");
  for (const row of qsa<HTMLElement>('[data-testid="row"]', box)) bindSessionRow(row);
  if (initial < list.length) {
    const sentinel = document.createElement("div");
    sentinel.style.height = "1px";
    sentinel.setAttribute("aria-hidden", "true");
    box.appendChild(sentinel);
    let shown = initial;
    rowObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const next = list.slice(shown, shown + ROW_CHUNK);
        shown += next.length;
        sentinel.insertAdjacentHTML("beforebegin", next.map(rowHtml).join(""));
        for (const row of qsa<HTMLElement>('[data-testid="row"]', box)) bindSessionRow(row);
        if (shown >= list.length) {
          rowObserver?.disconnect();
          rowObserver = null;
          sentinel.remove();
        }
      },
      { root: box, rootMargin: "600px" },
    );
    rowObserver.observe(sentinel);
  }
  // 本帧标记为“新展开”的行：下一帧补 is-open，让 grid-template-rows 过渡真正跑一次
  if (state._animateOpen) {
    state._animateOpen = null;
    requestAnimationFrame(() => {
      for (const r of qsa<HTMLElement>('[data-anim="1"]', box)) r.classList.add("is-open");
    });
  }
  bindDetailHandlers();
  renderSessPager();
  renderSelCount();
}

function selectAll(cb: HTMLInputElement): void {
  const list = visibleSessions();
  for (const s of list) {
    if (cb.checked) state.selected.add(s.sid);
    else state.selected.delete(s.sid);
  }
  renderRows();
  renderSelCount();
}

function sessSelAll(): void {
  for (const s of visibleSessions()) state.selected.add(s.sid);
  renderRows();
  renderSelCount();
}

function sessSelInvert(): void {
  for (const s of visibleSessions()) {
    if (state.selected.has(s.sid)) state.selected.delete(s.sid);
    else state.selected.add(s.sid);
  }
  renderRows();
  renderSelCount();
}

function sessSelNone(): void {
  state.selected.clear();
  renderRows();
  renderSelCount();
}

function renderSessPager(): void {
  // 兜底：已选集必须 ⊆ 当前作用域（切工具 / 数据刷新 / 搜索过滤后都可能残留）
  {
    const ids = new Set(scopedSessions().map((s) => s.sid));
    for (const sid of [...state.selected]) {
      if (!ids.has(sid)) state.selected.delete(sid);
    }
  }
  const info = byId<HTMLElement>("sess-pinfo");
  // 页脚只留这一处计数（2026-10-14：左侧那个「已选 N 条」与之重复，已删）
  if (info) {
    info.innerHTML =
      `已选 <b id="sel-count" data-testid="sel-count">${state.selected.size}</b>` +
      ` · 显示 ${visibleSessions().length} 条 · 共 ${scopedSessions().length} 条`; // 会话口径：已选 N · 显示 M · 共 K
  }
  const none = byId<HTMLButtonElement>("sess-sel-none");
  if (none) none.disabled = !state.selected.size;
}

function renderSessStats(): void {
  const box = byId<HTMLElement>("sess-stats");
  if (!box) return;
  const list = state.sessions ?? [];
  const tools = new Set(list.map((s) => s.tool)).size;
  const migrated = list.filter((s) => s.lid).length;
  const starred = list.filter((s) => s.starred).length;
  const msgs = list.reduce((a, s) => a + (s.msg_count || 0), 0);
  box.innerHTML = `
    <div class="nv-stat"><b>${list.length}</b><span>会话${state.filter === "all" ? "" : " · 当前筛选"}</span></div>
    <div class="nv-stat"><b>${tools}</b><span>已接入工具</span></div>
    <div class="nv-stat"><b>${msgs}</b><span>消息总量</span></div>
    <div class="nv-stat"><b>${migrated}</b><span>迁移勾连（lineage）</span></div>
    <div class="nv-stat"><b>${starred}</b><span>★ 收藏</span></div>`;
}

function renderSelCount(): void {
  const noneBtn = byId<HTMLButtonElement>("sess-sel-none");
  if (noneBtn) noneBtn.disabled = !state.selected.size;
  renderSessPager();
  renderPanel();
}

/* ---------- status ---------- */

function renderStatus(): void {
  const eng = byId<HTMLElement>("engine-badge");
  if (eng) {
    eng.textContent =
      state.engine && state.engine.casr ? "引擎 casr · 已连接" : "引擎 casr · 未安装（只读模式）";
  }
  const schedOn = Object.values(state.schedule ?? {}).filter((s) => s.enabled).length;
  mustById("status-sched").textContent =
    `定时调度：${schedOn ? schedOn + " 个范围已启用" : "未启用"}`;
  mustById("status-mem").textContent = `记忆 ${(state.memories ?? []).length} 条`;
  const am = byId<HTMLElement>("status-am");
  if (am) {
    am.textContent =
      state.engine && state.engine.agentmemory
        ? "记忆总线 agentmemory · 运行中 (:3113)"
        : "记忆总线 agentmemory · 未运行";
  }
}

function setFilter(tool: string): void {
  state.filter = tool;
  state.selected.clear(); // 换筛选作用域：清空已选，保持"勾选集合 ⊆ 当前可见列表"
  sessDetail = null;
  // 切到别的工具/全部 → 退出工具视图（顶部恢复详细网格）；进入工具视图走 enterTool
  if (state._toolFocus && state._toolFocus !== tool) state._toolFocus = null;
  renderToolGrid();
  syncFilterSegActive();
  renderRows();
}

/* ---------- 迁移目标面板（展开会话或勾选后从右侧滑出） ---------- */

// 可选目标：有会话根路径的工具，排除当前聚焦工具与会话原属工具
function panelTargets(): ToolPublic[] {
  const sids = state.selected.size ? [...state.selected] : sessDetail ? [sessDetail] : [];
  const srcTools = new Set(
    sids
      .map((sid) => (state.sessions ?? []).find((x) => x.sid === sid)?.tool)
      .filter((x): x is string => Boolean(x)),
  );
  // 迁移目标 = 启用且有会话根目录的工具（与卡片/列表同口径）
  return sessionTools().filter((t) => t.id !== state._toolFocus && !srcTools.has(t.id));
}

function renderPanel(): void {
  const panel = byId<HTMLElement>("sess-panel");
  const host = byId<HTMLElement>("sess-panel-in");
  if (!(panel && host)) return;
  const n = state.selected.size || (sessDetail ? 1 : 0);
  const show = !state._panelOff && n > 0;
  panel.classList.toggle("is-in", show);
  if (!show) return;
  const d = sessDetail ? (detailCache[sessDetail] ?? null) : null;
  const targets = panelTargets();
  // 已被移除的工具自动退出选中集合
  state._migTargets = state._migTargets.filter((id) => targets.some((t) => t.id === id));
  const selNow = (): string =>
    state.selected.size
      ? `已选 <b class="mono">${state.selected.size}</b> 条`
      : `当前：${esc(d?.title || d?.sid || "—")}`;
  // 统一目标选择组件（用户 2026-10-20「目标选择：按 skills 对齐」）
  const picker = MV.targetPicker({
    prefix: "sess",
    items: targets.map((t) => ({
      id: t.id,
      name: t.name,
      dotCls: toolColorCls(t),
      testid: `sess-target-${t.id}`,
    })),
    chosen: state._migTargets.map(String),
    selLine: selNow(),
    selLineFn: () => selNow(),
    goText: "迁移",
    goTextFn: (set) => {
      const list = targets.filter((t) => set.has(String(t.id)));
      const what = list.length
        ? list.length === 1
          ? list[0]?.name
          : `${list.length} 个工具`
        : "…";
      return `迁移 ${n} 条到 ${what}`;
    },
    onChange: (ids) => {
      state._migTargets = ids;
    },
    onGo: () => panelMigrate(),
  });
  host.innerHTML = `
    <div class="spanel__h">
      <h3>目标</h3>
      <button class="spanel__x" id="sess-panel-close" title="收起" aria-label="收起">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    ${picker.html}`;
  picker.bind(host);
  const closeBtn = host.querySelector<HTMLElement>("#sess-panel-close");
  if (closeBtn) closeBtn.onclick = closePanel;
}

/** 目标面板「迁移」主按钮：用当前选中目标迁移已选 / 当前展开的会话。 */
function panelMigrate(): void {
  const sids = state.selected.size ? [...state.selected] : sessDetail ? [sessDetail] : [];
  migrateConfirmInline(state._migTargets, sids);
}

function closePanel(): void {
  state._panelOff = true;
  renderPanel();
}

/* ---------- migration（工具卡片与迁移面板即迁移目标；确认条内联在面板内） ---------- */

/**
 * 迁移确认条（内联在目标面板里，替代弹窗）。targets 可以是单个工具 id 或 id 数组。
 * 底部台账已按用户指令 2026-10-20 去掉 → 确认条直接挂在面板底部（.spanel__in 末尾）。
 */
function migrateConfirmInline(targets: string | string[], ids: string[]): void {
  if (!ids.length) {
    HubUI.toast("先勾选要迁移的会话，或展开一条会话", "warn");
    return;
  }
  const tlist = (Array.isArray(targets) ? targets : [targets]).filter((x): x is string =>
    Boolean(x),
  );
  if (!tlist.length) return;
  // 确认条插在目标面板内 → 先把面板展开并记下目标，保证用户看得见
  state._panelOff = false;
  state._migTargets = tlist;
  renderPanel();
  const bySid = new Map(state.sessions.map((s) => [s.sid, s] as const));
  const items = ids
    .map((id) => bySid.get(id))
    .filter((s): s is SessionRow => s !== undefined && !tlist.includes(s.tool));
  if (!items.length) {
    HubUI.toast("所选会话已属于目标工具，无需迁移", "warn");
    return;
  }
  const tNames = tlist.map((t) => toolById(t)?.name || toolName(t) || t).join("、");
  const old = byId<HTMLElement>("mig-confirm");
  if (old) old.remove();
  const bar = document.createElement("div");
  bar.className = "nv-migconfirm";
  bar.id = "mig-confirm";
  const preview =
    items.length <= 3
      ? "<br>" + items.map((s) => esc((s.title || s.sid).slice(0, 30))).join("<br>")
      : `<br>${esc(((items[0]?.title || items[0]?.sid) ?? "").slice(0, 30))} 等`;
  bar.innerHTML = `
    <div class="nv-migconfirm__txt">迁移 <b>${items.length}</b> 条 → <b>${esc(tNames)}</b>${preview}
    <span class="mono-xs">生成新副本，源不动，入 lineage</span></div>
    <div class="nv-migconfirm__acts">
      <button class="hub-btn btn-sm" data-act="cancel">取消</button>
      <button class="hub-btn btn-sm hub-btn--primary" data-act="go">开始迁移</button>
    </div>`;
  const cancel = bar.querySelector<HTMLElement>('[data-act="cancel"]');
  if (cancel) cancel.onclick = () => bar.remove();
  const go = bar.querySelector<HTMLElement>('[data-act="go"]');
  if (go) {
    go.onclick = async (e) => {
      bar.remove();
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.classList.add("is-loading");
      await runMigration(items, tlist, false);
    };
  }
  const anchor = byId<HTMLElement>("sess-panel-in");
  (anchor || document.body).appendChild(bar);
  bar.scrollIntoView({ block: "nearest" });
}

async function runMigration(
  items: SessionRow[],
  targets: string | string[],
  force: boolean,
): Promise<void> {
  // 多选：targets 可以是单个 id 或 id 数组；逐「目标 × 会话」发起迁移（后端一次只认一个 target）
  const tlist = (Array.isArray(targets) ? targets : [targets]).filter((x): x is string =>
    Boolean(x),
  );
  const ok: { s: SessionRow; r: MigrateResponse; tg: string }[] = [];
  const dup: { s: SessionRow; tg: string }[] = [];
  const err: { s: SessionRow; msg: string }[] = [];
  const total = tlist.length * items.length;
  let done = 0;
  const toastEl = HubUI.toast("迁移中… 0/" + total, "info", 60_000);
  for (const tg of tlist) {
    for (const s of items) {
      if (s.tool === tg) {
        done++;
        continue;
      } // 已经是该工具，跳过
      const r = await post<MigrateResponse>("/api/migrate", {
        sid: s.sid,
        target: tg,
        force: !!force,
      });
      if (r.data.ok) ok.push({ s, r: r.data, tg });
      else if (r.data.duplicate) dup.push({ s, tg });
      else err.push({ s, msg: r.data.error || "迁移失败（HTTP " + r.status + "，引擎 casr）" });
      done++;
      const msgEl = toastEl.querySelector<HTMLElement>(".hub-toast__msg");
      if (msgEl) msgEl.textContent = `迁移中… ${done}/${total}`;
    }
  }
  toastEl.remove();
  if (ok.length) {
    const lids = ok.map((o) => o.r.lid).filter((x): x is string => Boolean(x));
    const tnames = [...new Set(ok.map((o) => toolName(o.tg) || o.tg))].join("、");
    HubUI.toast(
      `${ok.length} 条已迁移到 ${tnames}` +
        (lids.length ? `（${[...new Set(lids)].join(", ")}）` : ""),
      "success",
    );
  }
  if (err.length) {
    HubUI.toast(`${err.length} 条失败：${err[0]?.msg.slice(0, 60) ?? ""}`, "error", 5200);
  }
  if (dup.length) {
    // fetch increment info for a richer message (single-item case gets exact delta)
    let inc = "";
    const dupItems = dup.map((d) => d.s);
    if (dup.length === 1) {
      const d0 = dup[0];
      if (d0) {
        const pv = await api<SyncPreviewResponse>(
          "/api/sync/preview?sid=" + encodeURIComponent(d0.s.sid) + "&target=" + d0.tg,
        );
        const s = pv.data.sync;
        if (s && typeof s.delta === "number") {
          inc =
            s.delta > 0
              ? `<br><br>该会话自上次迁移后<b>新增 ${s.delta} 条消息</b>（基线 ${s.base_count} → 当前 ${s.current_count}），可「同步更新」生成修订副本。`
              : "<br><br>自上次迁移后<b>没有新消息</b>，通常无需同步。";
        }
      }
    }
    const dupTargets = [...new Set(dup.map((d) => d.tg))];
    HubUI.confirm(
      "检测到已迁移过的会话",
      `${dup.length} 条会话此前已迁移到 ${dupTargets.map((t) => toolName(t) || t).join("、")}（同一 lineage 通道已记录，避免重复副本）。` +
        inc +
        "<br><br>「同步更新」会生成目标工具内的新修订副本（不覆盖旧副本、不动源会话）。",
      async () => {
        await runMigration(dupItems, dupTargets, true);
      },
      { confirmText: "同步更新", cancelText: "忽略跳过" },
    );
  }
  state.selected.clear();
  await loadState();
}

/* ---------- refresh ---------- */

async function refreshAll(btn: HTMLElement): Promise<void> {
  btn.classList.add("is-loading");
  const r = await post<RefreshResponse>("/api/refresh");
  btn.classList.remove("is-loading");
  if (r.data.ok) {
    const sum = (r.data.results ?? [])
      .map((x) => `${toolName(x.tool) || x.tool} +${x.error ? "err" : x.new_messages}`)
      .join(" · ");
    HubUI.toast("全量刷新完成：" + sum, "success");
  } else {
    HubUI.toast("刷新失败：" + (r.data.error || "未知错误"), "error");
  }
  await loadState();
}

async function refreshOne(tool: string, btn: HTMLElement): Promise<void> {
  btn.classList.add("is-loading");
  const r = await post<RefreshResponse>("/api/refresh", { tool });
  btn.classList.remove("is-loading");
  if (r.data.ok) {
    const s = (r.data.results ?? [])[0];
    HubUI.toast(
      `${toolName(tool)} 刷新完成 · 新增 ${s?.error ? "失败" : s?.new_messages} 条消息`,
      s?.error ? "error" : "success",
    );
  } else {
    HubUI.toast("刷新失败：" + (r.data.error || ""), "error");
  }
  await loadState();
}

/* ---------- schedule ---------- */

function schedScopes(): [string, string][] {
  const list: [string, string][] = [["all", "全部工具"]];
  // 定时扫描针对会话采集：无会话根路径（root 为空）的工具不列
  for (const t of allTools()) {
    if (t.enabled && t.root) list.push([t.id, t.name]);
  }
  return list;
}

function openSchedule(): void {
  const body = mustById<HTMLElement>("sched-body");
  body.innerHTML = schedScopes()
    .map(([k, name]) => {
      const cfg = state.schedule[k] ?? { enabled: false, interval_min: 30 };
      return `<div class="sched__row" data-testid="sched-row-${k}">
      <span class="sched__name">${name}</span>
      ${HubUI.select({
        testid: "sched-interval-" + k,
        value: cfg.interval_min,
        options: INTERVALS.map((m) => ({ value: m, label: "每 " + m + " 分钟" })),
      })}
      <span class="switch ${cfg.enabled ? "is-on" : ""}" data-testid="sched-toggle-${k}">
        <span class="switch__track"></span></span>
    </div>`;
    })
    .join("");
  for (const sw of qsa<HTMLElement>(".switch", body)) {
    sw.onclick = () => sw.classList.toggle("is-on");
  }
  mustById("sched-overlay").classList.add("is-open");
}

function closeSchedule(): void {
  mustById("sched-overlay").classList.remove("is-open");
}

async function saveSchedule(btn: HTMLElement): Promise<void> {
  btn.classList.add("is-loading");
  for (const [k] of schedScopes()) {
    const row = qs<HTMLElement>(`[data-testid="sched-row-${k}"]`);
    if (!row) continue;
    const sw = row.querySelector<HTMLElement>(".switch");
    const enabled = sw ? sw.classList.contains("is-on") : false;
    const sel = mustQs<HTMLElement & { value: string }>(".hub-select", row);
    const interval = Number.parseInt(sel.value, 10);
    await post("/api/schedule", { tool: k, enabled, interval_min: interval });
  }
  btn.classList.remove("is-loading");
  HubUI.toast("定时任务已保存", "success");
  closeSchedule();
  await loadState();
}

/* ---------- tools registry ----------
   2026-10-16：去掉「添加工具」能力（用户指令）；工具弹窗随之删除。
   编辑 / 启停 / 删除 / 接入记忆总线 统一在「设置 → 工具」的行内面板（web/views/settings.js）。
   后端 POST /api/tools 仍在（测试夹具与内置工具初始化用），前端不再暴露入口。 */

/* ---------- content search (v0.3) ---------- */

async function runContentSearch(q: string): Promise<void> {
  const r = await api<SearchResponse>("/api/search?q=" + encodeURIComponent(q));
  const panel = byId<HTMLElement>("search-panel");
  if (!panel) return;
  const allowed = new Set(sessionTools().map((t) => t.id)); // 口径 B：只搜可见域
  const hits = (r.data.results ?? []).filter((x) => allowed.has(x.tool));
  if (!(r.data.ok && hits.length)) {
    panel.innerHTML = '<div class="hub-empty" style="padding:var(--sp-4)">没有消息内容匹配</div>';
    panel.style.display = "";
    return;
  }
  panel.innerHTML = hits
    .map(
      (x) => `
    <div class="search-item" data-testid="search-item" data-sid="${esc(x.sid)}">
      <span class="search-item__tool">${esc(toolName(x.tool) || x.tool)}</span>
      <span class="search-item__title">${esc(x.title || x.sid.slice(0, 12))}</span>
      <span class="search-item__snip">${esc(x.snippet || "")}</span>
      <span class="search-item__hits">${x.hits}×</span>
    </div>`,
    )
    .join("");
  panel.style.display = "";
  for (const el of qsa<HTMLElement>(".search-item", panel)) {
    el.onclick = () => {
      hideSearchPanel();
      void openSessionFull(el.dataset["sid"] ?? "");
    };
  }
}

function hideSearchPanel(): void {
  const panel = byId<HTMLElement>("search-panel");
  if (panel) panel.style.display = "none";
}

/* ---------- preview actions (v0.3) ---------- */

function resumeCommand(s: Pick<SessionDetail, "tool" | "sid" | "cwd">): string {
  if (s.tool === "claude") return "claude --resume " + s.sid;
  if (s.tool === "codex") return "codex resume " + s.sid;
  if (s.tool === "opencode") {
    return 'cd "' + (s.cwd || "") + '" && opencode   # 在会话列表中选择 ' + s.sid.slice(0, 12);
  }
  return (
    "# 在 " +
    toolName(s.tool) +
    " 中继续会话 " +
    s.sid.slice(0, 12) +
    (s.cwd ? "（目录：" + s.cwd + "）" : "")
  );
}

/* ---------- 会话详情（v0.8：列表行内联手风琴；同时镜像到 preview-* 节点供兼容） ---------- */

/* 附件图标（线性，1.8 线宽，与模块图标同一套） */
const ATT_ICONS: Record<string, string> = {
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="m21 15-4.5-4.5L9 18"/></svg>',
  text:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/></svg>',
  pdf:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6v5H9z"/><path d="M9 16h6"/></svg>',
  audio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>',
  video:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 6 3-6 3z"/></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function toAttachment(value: unknown): Attachment {
  const o = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    kind: typeof o["kind"] === "string" && o["kind"] ? o["kind"] : "file",
    name: typeof o["name"] === "string" && o["name"] ? o["name"] : "附件",
    url: typeof o["url"] === "string" ? o["url"] : "",
    download: typeof o["download"] === "string" ? o["download"] : "",
    mime: typeof o["mime"] === "string" ? o["mime"] : "",
    size: typeof o["size"] === "number" ? o["size"] : null,
  };
}

/** 一条消息的附件：图片直接大图预览，其余给文件行（点击弹窗或下载）。 */
function attsHtml(m: MessageRow): string {
  const list = (m.attachments ?? []).map(toAttachment);
  if (!list.length) return "";
  return (
    '<div class="msg__atts">' +
    list
      .map((a) => {
        const kind = a.kind || "file";
        const name = a.name || "附件";
        const attrs =
          `data-att-url="${esc(a.url || "")}" data-att-dl="${esc(a.download || a.url || "")}"` +
          ` data-att-kind="${esc(kind)}" data-att-mime="${esc(a.mime || "")}" data-att-name="${esc(name)}"`;
        if (kind === "image") {
          return (
            `<button type="button" class="msg__att msg__att--img" ${attrs} aria-label="查看图片 ${esc(name)}">` +
            `<img src="${esc(a.url || "")}" alt="${esc(name)}" loading="lazy"></button>`
          );
        }
        if (kind === "folder") {
          return (
            `<div class="msg__att msg__file is-disabled"><span class="msg__att-ic">${ATT_ICONS["folder"] ?? ""}</span>` +
            `<span class="msg__att-nm">${esc(name)}</span><span class="msg__att-sz">文件夹</span></div>`
          );
        }
        const size = fmtBytes(a.size);
        return (
          `<button type="button" class="msg__att msg__file" ${attrs} aria-label="打开 ${esc(name)}">` +
          `<span class="msg__att-ic">${ATT_ICONS[kind] ?? ATT_ICONS["file"] ?? ""}</span>` +
          `<span class="msg__att-nm">${esc(name)}</span>` +
          (size ? `<span class="msg__att-sz">${esc(size)}</span>` : "") +
          "</button>"
        );
      })
      .join("") +
    "</div>"
  );
}

/** 附件预览：图片 / 文本 / PDF / 音视频分别走弹窗，其它直接下载。 */
function openAttachment(ds: DOMStringMap): void {
  const kind = ds["attKind"] || "file";
  const name = ds["attName"] || "附件";
  const url = ds["attUrl"];
  const dl = ds["attDl"] || url;
  if (!url) return;
  const download = (): void => {
    const a = document.createElement("a");
    a.href = dl ?? "";
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  if (kind === "folder") {
    HubUI.toast("文件夹无法预览", "info");
    return;
  }
  if (kind === "image") {
    HubUI.modal({
      title: name,
      bodyHTML: `<img class="att-view att-view--img" src="${esc(url)}" alt="${esc(name)}">`,
      confirmText: "下载",
      cancelText: "关闭",
      wide: true,
      onConfirm: () => {
        download();
        return false;
      },
    });
    return;
  }
  if (kind === "text") {
    const m = HubUI.modal({
      title: name,
      bodyHTML: '<div class="att-loading">正在读取…</div>',
      confirmText: "关闭",
      cancelText: null,
      wide: true,
    });
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((text) => {
        const body = m.overlay.querySelector<HTMLElement>(".hub-modal__body");
        const pre = document.createElement("pre");
        pre.className = "att-view att-view--text";
        pre.textContent =
          text.length > 200_000
            ? text.slice(0, 200_000) + "\n\n…（内容过长，已截断；完整文件请下载）"
            : text;
        if (body) {
          body.innerHTML = "";
          body.appendChild(pre);
        }
      })
      .catch(() => {
        const body = m.overlay.querySelector<HTMLElement>(".hub-modal__body");
        if (body) body.textContent = "读取失败：文件可能已删除或无法访问";
      });
    return;
  }
  if (kind === "pdf") {
    HubUI.modal({
      title: name,
      bodyHTML: `<iframe class="att-view att-view--pdf" src="${esc(url)}" title="${esc(name)}"></iframe>`,
      confirmText: "下载",
      cancelText: "关闭",
      wide: true,
      onConfirm: () => {
        download();
        return false;
      },
    });
    return;
  }
  if (kind === "audio" || kind === "video") {
    const tag = kind === "audio" ? "audio" : "video";
    HubUI.modal({
      title: name,
      bodyHTML: `<${tag} class="att-view att-view--media" controls src="${esc(url)}"></${tag}>`,
      confirmText: "下载",
      cancelText: "关闭",
      onConfirm: () => {
        download();
        return false;
      },
    });
    return;
  }
  download();
}

// 附件点击统一走**捕获阶段**委托：详情内容区会 stopPropagation（防误点收起），
// 冒泡阶段收不到，必须在捕获阶段先接住。
document.addEventListener(
  "click",
  (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-att-url]") : null;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    openAttachment(el.dataset);
  },
  true,
);

// 拉取会话详情（消息 + lineage 链）写入缓存；重复打开命中缓存不再请求
async function loadSessionDetail(sid: string): Promise<void> {
  const r = await api<SessionDetail>("/api/session?id=" + encodeURIComponent(sid));
  if (r.status !== 200) {
    detailCache[sid] = null;
    HubUI.toast("会话不存在或已清理", "error");
    return;
  }
  const s = r.data;
  let chainHtml = `${toolName(s.tool) || s.tool} · ${s.sid}`;
  try {
    const lin = await api<LineageResponse>(
      "/api/lineage?tool=" + s.tool + "&sid=" + encodeURIComponent(s.sid),
    );
    const lid = lin.data.lid;
    if (lid) {
      const hops = (lin.data.migrations ?? [])
        .filter((m) => m.status === "ok")
        .map(
          (m) =>
            `${toolName(m.src_tool ?? "") || m.src_tool} → ${toolName(m.dst_tool ?? "") || m.dst_tool}`,
        );
      chainHtml += ` · [hub:${lid}]` + (hops.length ? " · " + hops.join(" · ") : "");
    }
  } catch {
    /* lineage 可选：失败不影响详情展示 */
  }
  const messages = s.messages ?? [];
  const messagesHtml = messages.length
    ? messages
        .map((m) => {
          const cls =
            m.role === "assistant" ? " msg--assistant" : m.role === "tool" ? " msg--tool" : "";
          const role =
            (m.role || "?").toUpperCase() + (m.ts ? " · " + String(m.ts).slice(11, 16) : "");
          const text = stripAttPlaceholders(m.content || "", m.attachments ?? []);
          const bubble = text ? `<div class="msg__bubble">${esc(text.slice(0, 6000))}</div>` : "";
          return `<div class="msg${cls}"><div class="msg__role">${esc(role)}</div>${bubble}${attsHtml(m)}</div>`;
        })
        .join("")
    : '<div class="hub-empty">该会话暂无可显示的文本消息</div>';
  detailCache[sid] = {
    sid: s.sid,
    tool: s.tool,
    title: s.title,
    starred: s.starred,
    chain: chainHtml,
    messagesHTML: messagesHtml,
    resume: resumeCommand(s),
  };
}

// 手风琴内容：未缓存 → 占位；缓存为 null → 已清理
function detailHtml(sid: string): string {
  const d = detailCache[sid];
  if (d === undefined) return '<div class="srow__load">正在读取会话详情…</div>';
  if (d === null) return '<div class="srow__load">会话不存在或已清理</div>';
  return `
    <div class="dhead">
      <div class="dtitle" data-testid="sess-detail-title">${d.starred ? '<span class="dstar">★</span>' : ""}${esc(d.title || "(无标题)")}</div>
      <div class="dchain" id="sess-detail-chain">${esc(d.chain)}</div>
      <div class="dops">
        <button class="hub-btn btn-sm" id="sess-star">${d.starred ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="hub-btn btn-sm" id="sess-resume">复制 resume 命令</button>
        <button class="hub-btn btn-sm" id="sess-export">导出 Markdown</button>
      </div>
    </div>
    <div class="sess-msgs" id="sess-detail-body">${d.messagesHTML}</div>`;
}

// 展开一条会话：点击行只展开（不收起，收起走行尾箭头）；迁出面板随即滑出
/**
 * 旧路径：设详情 + 整表重绘。用于"目标会话可能不在当前列表里"的入口
 * （搜索结果、外部跳转），此时就地展开找不到行。
 */
async function openSessionFull(sid: string): Promise<void> {
  sessDetail = sid;
  state._animateOpen = sid;
  state._panelOff = false;
  // 展开即选中（用户指令 2026-10-20：收起时取消选中）
  state.selected.add(sid);
  renderSelCount();
  renderRows();
  renderPanel();
  if (detailCache[sid] === undefined) {
    await loadSessionDetail(sid);
    renderRows();
    renderPanel();
  }
}

/** 打开某会话详情：优先就地把展开体填进当前行（不重画列表） */
async function openSession(sid: string): Promise<void> {
  const row = qs<HTMLElement>(`#session-rows .mvi[data-sid="${CSS.escape(sid)}"]`);
  sessDetail = sid;
  state._panelOff = false;
  // 展开即选中（用户指令 2026-10-20：收起时取消选中）；勾选框跟着变
  state.selected.add(sid);
  if (row) {
    const cb = row.querySelector<HTMLInputElement>('[data-testid="row-check"]');
    if (cb) cb.checked = true;
  }
  renderSelCount();
  if (detailCache[sid] === undefined) {
    if (row && !row.classList.contains("is-open")) {
      // 先展开 + 占位，再异步填内容（用户立刻看到高度过渡，而不是等网络）
      const acc = row.querySelector<HTMLElement>(".mvi__accin");
      if (acc) acc.innerHTML = '<div class="srow__load">加载中…</div>';
      row.classList.remove("is-open");
      void row.offsetWidth;
      row.classList.add("is-open");
    }
    await loadSessionDetail(sid);
    fillDetailInPlace(row, sid);
    renderPanel();
    bindDetailHandlers();
    return;
  }
  fillDetailInPlace(row, sid);
  renderPanel();
  bindDetailHandlers();
}

/** 把详情体就地填进指定行并展开（行不存在时退回整表重绘） */
function fillDetailInPlace(row: HTMLElement | null, sid: string): void {
  if (!row) {
    renderRows();
    renderPanel();
    return;
  }
  const acc = row.querySelector<HTMLElement>(".mvi__accin");
  if (acc) acc.innerHTML = detailHtml(sid);
  row.classList.remove("is-open");
  void row.offsetWidth; // 重启动画：grid-template-rows 0fr → 1fr
  row.classList.add("is-open");
  const chev = row.querySelector<HTMLElement>(".mvi__chev");
  if (chev) chev.title = "收起";
}

/** 收起：只去掉类名，让高度过渡把它收回去（不重画） */
function closeSession(sid: string): void {
  const row = qs<HTMLElement>(`#session-rows .mvi[data-sid="${CSS.escape(sid)}"]`);
  sessDetail = null;
  state._panelOff = false;
  // 收起即取消选中（用户指令 2026-10-20）
  state.selected.delete(sid);
  if (row) {
    const cb = row.querySelector<HTMLInputElement>('[data-testid="row-check"]');
    if (cb) cb.checked = false;
  }
  renderSelCount();
  if (row) {
    row.classList.remove("is-open");
    const chev = row.querySelector<HTMLElement>(".mvi__chev");
    if (chev) chev.title = "展开";
  }
  renderPanel();
}

/**
 * 点会话行头：展开 / 收起（toggle）。
 * 改动：2026-10-20 一度改成"幂等打开"（为迁就 E2E 的时序假设），用户随即要求改回
 * ——「为什么点击不会收起了？」。现恢复 toggle：已展开再点 = 收起（同时取消勾选）。
 */
function toggleSession(sid: string): void {
  if (sessDetail === sid) {
    closeSession(sid);
    return;
  }
  void openSession(sid);
}

// 绑定当前展开行的操作按钮（收藏 / resume / 导出），并同步预览镜像节点
function bindDetailHandlers(): void {
  const sid = sessDetail;
  const d = sid ? detailCache[sid] : null;
  if (!d) return;
  const starBtn = byId<HTMLButtonElement>("sess-star");
  if (starBtn) {
    starBtn.onclick = async () => {
      const rr = await post<StarResponse>("/api/star", { sid: d.sid });
      if (!rr.data.ok) {
        HubUI.toast("收藏失败：" + (rr.data.error || ""), "error");
        return;
      }
      d.starred = rr.data.starred ? 1 : 0;
      const s = (state.sessions ?? []).find((x) => x.sid === d.sid);
      if (s) s.starred = rr.data.starred ? 1 : 0;
      HubUI.toast(rr.data.starred ? "已收藏" : "已取消收藏", "success");
      renderRows();
    };
  }
  const resBtn = byId<HTMLButtonElement>("sess-resume");
  if (resBtn) {
    resBtn.onclick = async () => {
      const ok = await copyText(d.resume);
      HubUI.toast(
        ok ? "已复制：" + d.resume : "复制失败，请手动复制：" + d.resume,
        ok ? "success" : "warn",
        5200,
      );
    };
  }
  const expBtn = byId<HTMLButtonElement>("sess-export");
  if (expBtn) {
    expBtn.onclick = async () => {
      expBtn.classList.add("is-loading");
      const rr = await api<ExportResponse>("/api/export?sid=" + encodeURIComponent(d.sid));
      expBtn.classList.remove("is-loading");
      if (rr.data.ok) {
        HubUI.toast(
          "已导出 " + ((rr.data.bytes ?? 0) / 1024).toFixed(1) + " KB → " + (rr.data.path ?? ""),
          "success",
          5600,
        );
      } else {
        HubUI.toast("导出失败：" + (rr.data.error || ""), "error");
      }
    };
  }
  mirrorPreview(d);
}

// preview-* 覆盖层已不再弹出（详情改列表内联），节点保留并同步，旧调用仍可用
function mirrorPreview(d: DetailEntry): void {
  const pt = byId<HTMLElement>("preview-title");
  if (!pt) return;
  pt.textContent = d.title || "(无标题)";
  mustById("preview-chain").textContent = d.chain;
  mustById("preview-body").innerHTML = d.messagesHTML;
  const starBtn = mustById<HTMLButtonElement>("preview-star");
  starBtn.textContent = d.starred ? "★ 已收藏" : "☆ 收藏";
  starBtn.onclick = async () => {
    const rr = await post<StarResponse>("/api/star", { sid: d.sid });
    if (rr.data.ok) {
      d.starred = rr.data.starred ? 1 : 0;
      HubUI.toast(rr.data.starred ? "已收藏" : "已取消收藏", "success");
      renderRows();
    } else {
      HubUI.toast("收藏失败：" + (rr.data.error || ""), "error");
    }
  };
  mustById<HTMLButtonElement>("preview-resume").onclick = async () => {
    const ok = await copyText(d.resume);
    HubUI.toast(
      ok ? "已复制：" + d.resume : "复制失败，请手动复制：" + d.resume,
      ok ? "success" : "warn",
      5200,
    );
  };
  const exportBtn = mustById<HTMLButtonElement>("preview-export");
  exportBtn.onclick = async () => {
    exportBtn.classList.add("is-loading");
    const rr = await api<ExportResponse>("/api/export?sid=" + encodeURIComponent(d.sid));
    exportBtn.classList.remove("is-loading");
    if (rr.data.ok) {
      HubUI.toast(
        "已导出 " + ((rr.data.bytes ?? 0) / 1024).toFixed(1) + " KB → " + (rr.data.path ?? ""),
        "success",
        5600,
      );
    } else {
      HubUI.toast("导出失败：" + (rr.data.error || ""), "error");
    }
  };
}

function closePreview(): void {
  mustById("preview-overlay").classList.remove("is-open");
}

/* ---------- 骨架屏 / 行收起 / 闪烁 ---------- */

window.skeletonRows = skeletonRows;
window.collapseRows = collapseRows;

/** 刷新后：新出现的行 + 受影响来源的卡片 一起闪一下 */
function flashChanges(ev: LiveEvent, before: LiveBefore): void {
  const scopes = ev.scopes || [];
  // 1) 来源卡片：tool:<id> / memory:<id> → 对应卡片
  for (const sc of scopes) {
    const id = String(sc).split(":")[1];
    if (!id) continue;
    if (sc === "memory:hub") {
      // hub 中间体：没有对应卡片 → 让记忆列表整块闪一下
      flash(qs<HTMLElement>("#mv-rows"));
      continue;
    }
    for (const el of qsa<HTMLElement>(
      `.tcard[data-src="${CSS.escape(id)}"], [data-testid="tool-card-${CSS.escape(id)}"]`,
    )) {
      flash(el);
    }
  }
  // 2) 新出现的行（会话 / 模块条目）
  if (before.rows instanceof Map) {
    // 按"数据层面的变化"判断：会话是新出现的，或消息数变了（DOM 会整块重建，不能靠节点比对）
    for (const r of qsa<HTMLElement>("#session-rows .mvi[data-sid]")) {
      const prev = before.rows.get(r.dataset["sid"] ?? ""); // undefined = 新会话
      const now = r.dataset["msgs"] === undefined ? null : Number(r.dataset["msgs"]);
      if (prev === undefined || (now !== null && prev !== now)) flash(r);
    }
  }
  if (before.items) {
    for (const r of qsa<HTMLElement>(
      "#sk-rows .mvi[data-id], #mp-rows .mvi[data-id], #mv-rows .mvi[data-id]",
    )) {
      if (!before.items.has(r.dataset["id"] ?? "")) flash(r);
    }
  }
}

/* ====================================================================
   即时刷新（SSE）：磁盘变动 → 后端推 → 前端只刷新受影响的那一块
   后端 hub/watcher.py：kqueue（macOS/BSD，stdlib）/ watchdog（若装了）/
   manifest 兜底，合并抖动后经 /api/events 推送 {rev, scopes, full}。
   自身写入（POST/PATCH/DELETE）后端立刻 broadcast，不等 watcher。
   断线或环境不支持 EventSource 时，退回自适应轮询（可见 3s / 后台 60s）。
   ==================================================================== */
const LIVE = {
  es: null as EventSource | null,
  pollTimer: null as number | null,
  retryTimer: null as number | null,
  retryMs: 1_000, // SSE 断线重连：1s 起，指数翻倍，上限 30s
  lastRev: 0,
  mode: "idle",
  events: 0,
  lastWrite: 0,
  lastInput: 0,
};

function activeViewId(): string {
  const v = qs<HTMLElement>(".view.is-active");
  return v ? v.id.replace(/^view-/u, "") : "sessions";
}

/** 只刷新当前可见模块（其它模块等切过去时自然重渲染） */
async function refreshView(id: string): Promise<void> {
  if (id === "sessions") {
    renderAll();
    return;
  }
  // settings 不参与 SSE 静默刷新（打开时现拉）；其余懒加载视图统一走运行时
  if (!hasLazyView(id) || id === "settings") return;
  const root = byId<HTMLElement>("view-" + id);
  if (!root) return;
  const view = await loadView(id);
  await view.refresh(root);
}

function markLive(mode: string, ev?: LiveEvent): void {
  LIVE.mode = mode;
  document.body.dataset["live"] = mode;
  const dot = byId<HTMLElement>("live-dot");
  if (!dot) return;
  const st = state.watch;
  const scope = ev?.scopes ? ev.scopes.join(",") : "";
  dot.dataset["mode"] = mode;
  dot.textContent =
    mode === "sse" ? `即时 · ${st.backend || "watch"}` : `轮询 · ${mode.replace(/^poll:/u, "")}`;
  if (scope) {
    dot.title = `磁盘变动即时刷新（${scope}）· 后端 ${st.backend || "watch"} · rev ${state.rev || 0}`;
  }
  dot.hidden = false;
}

function applyLiveUpdate(ev: LiveEvent): void {
  LIVE.events += 1;
  // 安静窗口：自己刚写过 / 用户刚点过（弹窗流程、列表操作）→ UI 已自己刷新过，
  // 这时再推一次"外部刷新"会把用户/测试正在进行的操作打断。
  const quiet =
    Date.now() - (LIVE.lastWrite || 0) < 900 || Date.now() - (LIVE.lastInput || 0) < 1500;
  // 注意：这些遮罩在 DOM 里常态存在，必须按"可见"判断（否则永远 busy，事件全被吞掉）
  const busy = qsa<HTMLElement>(".hub-modal, .setwin, .preview-overlay.is-open").some(
    (el) => el.offsetParent !== null,
  );
  if (busy) return;
  const scopes = ev.scopes || [];
  const full = !!ev.full;
  const active = activeViewId();
  // 抓"刷新前"的 key，用于刷新后高亮新出现的行
  const before: LiveBefore = {
    rows: new Map((state.sessions ?? []).map((x) => [x.sid, x.msg_count] as const)),
    items: keySet("#sk-rows .mvi[data-id], #mp-rows .mvi[data-id], #mv-rows .mvi[data-id]", "id"),
  };
  // 外壳（台账 / 工具 / 会话计数）总是跟着变
  loadState()
    .then(() => {
      renderAll();
      flashChanges(ev, before);
      markLive(LIVE.mode, ev);
    })
    .catch(() => {
      /* 后台刷新失败静默：下一轮事件/轮询会再试 */
    });
  if (quiet) return;
  const toolDirty = scopes.some((s) => s.indexOf("tool:") === 0);
  const memDirty = scopes.some((s) => s.indexOf("memory:") === 0);
  // 本地目录 / 本地库：外部改 SKILL.md、registry 文件或链接目录内容 → 刷 Skills/MCP 视图
  // （读取时会顺带扫描同步，SSE 只负责叫醒前端来读）
  const regDirty = scopes.some(
    (s) => s === "hub:registry" || s === "hub:sources" || s === "hub:localdirs",
  );
  let target: string | null = null;
  if (full || scopes.indexOf("hub") >= 0) target = active;
  else if (active === "memory" && memDirty) target = "memory";
  else if (active === "connect" && (toolDirty || memDirty || regDirty)) target = "connect";
  else if (active === "skills" && (toolDirty || memDirty || regDirty)) target = "skills";
  else if (active === "mcp" && (toolDirty || regDirty)) target = "mcp";
  else if (active === "ops") target = "ops";
  if (target) {
    refreshView(target)
      .then(() => flashChanges(ev, before))
      .catch(() => {
        /* 后台刷新失败静默：下一轮事件/轮询会再试 */
      });
  }
}

function startFallbackPolling(reason: string): void {
  if (LIVE.pollTimer) return;
  const tick = (): void => {
    const hidden = document.visibilityState === "hidden";
    loadState()
      .then(() => {
        renderAll();
        if (LIVE.mode.indexOf("poll:") === 0) markLive(LIVE.mode);
      })
      .catch(() => {
        /* 后台刷新失败静默：下一轮事件/轮询会再试 */
      });
    LIVE.pollTimer = window.setTimeout(tick, hidden ? 60_000 : 3000);
  };
  LIVE.mode = "poll:" + reason;
  LIVE.pollTimer = window.setTimeout(tick, 3000);
  markLive(LIVE.mode);
}

function stopFallbackPolling(): void {
  if (LIVE.pollTimer) {
    window.clearTimeout(LIVE.pollTimer);
    LIVE.pollTimer = null;
  }
}

function sseJson<T extends object>(e: Event): Partial<T> {
  if (!(e instanceof MessageEvent) || typeof e.data !== "string") return {};
  try {
    const v: unknown = JSON.parse(e.data);
    return v !== null && typeof v === "object" ? (v as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** SSE 断线退避重连（EventSource 原生重连固定 3s，服务重启时会造成请求风暴）。 */
function scheduleSseReconnect(connect: () => void): void {
  if (LIVE.retryTimer !== null) return;
  const delay = Math.round(LIVE.retryMs * (0.8 + Math.random() * 0.4)); // ±20% 抖动，避免多端同拍
  LIVE.retryMs = Math.min(30_000, LIVE.retryMs * 2);
  markLive("sse-retry");
  LIVE.retryTimer = window.setTimeout(() => {
    LIVE.retryTimer = null;
    connect();
  }, delay);
}

function startLiveUpdates(): void {
  // 记录用户最近一次交互：用于"别在用户操作途中推外部刷新"
  for (const t of ["click", "keydown", "input"]) {
    document.addEventListener(
      t,
      () => {
        LIVE.lastInput = Date.now();
      },
      true,
    );
  }
  if (!window.EventSource) {
    startFallbackPolling("no-sse");
    return;
  }
  const connect = (): void => {
    LIVE.es?.close();
    let es: EventSource;
    try {
      es = new EventSource("/api/events");
    } catch {
      scheduleSseReconnect(connect);
      return;
    }
    LIVE.es = es;
    es.addEventListener("hello", (e) => {
      const d = sseJson<SseHello>(e);
      const changed = (d.rev ?? 0) > (state.rev || 0);
      LIVE.lastRev = d.rev ?? 0;
      LIVE.retryMs = 1_000; // 连接恢复：退避归零
      stopFallbackPolling();
      markLive("sse");
      if (changed) applyLiveUpdate({ scopes: ["hub"], full: true }); // 断线期间的变更一次补齐
    });
    es.addEventListener("change", (e) => {
      const d = sseJson<SseChange>(e);
      if (d.rev && d.rev <= LIVE.lastRev) return; // 去重（自己写入的 bump 也在内）
      LIVE.lastRev = d.rev ?? LIVE.lastRev;
      applyLiveUpdate({ scopes: d.scopes ?? [], full: !!d.full });
    });
    es.addEventListener("ping", () => {
      /* 心跳仅保活 */
    });
    es.onopen = () => {
      stopFallbackPolling();
      markLive("sse");
    };
    es.onerror = () => {
      // 关掉原生重连，改为自管指数退避 + 抖动
      es.close();
      if (LIVE.es === es) LIVE.es = null;
      startFallbackPolling("sse-down");
      scheduleSseReconnect(connect);
    };
  };
  connect();
}

/* ---------- module navigation (v0.4) ---------- */

const SYS_PAGES: Record<string, string> = { schedule: "sched-overlay" }; // 设置已改为普通页面（view），见 SETTINGS_VIEW
const SETTINGS_VIEW = "settings-overlay";
let LastView = "sessions";
const MOUNTED = new Set<string>(); // 已渲染过的视图：再切回来只静默刷新，不重建

/** 记住 / 还原容器内各滚动区的位置（静默刷新后不跳回顶部） */
function snapshotScroll(el: HTMLElement): Record<string, number> {
  const box: Record<string, number> = {};
  for (const n of qsa<HTMLElement>('.nv-list, #session-rows, [id$="-rows"]', el)) {
    if (n.id) box[n.id] = n.scrollTop;
  }
  const center = qs<HTMLElement>(".nv-center", el);
  box["__win"] = center ? center.scrollTop : 0;
  return box;
}

function restoreScroll(el: HTMLElement, box: Record<string, number>): void {
  for (const n of qsa<HTMLElement>('.nv-list, #session-rows, [id$="-rows"]', el)) {
    if (n.id && box[n.id] !== undefined) n.scrollTop = box[n.id] ?? 0;
  }
  const c = qs<HTMLElement>(".nv-center", el);
  if (c && box["__win"]) c.scrollTop = box["__win"];
}

/** 准备视图内容：首次挂载才 render；再次进入只静默刷新（数据可能已被 SSE 更新） */
async function mountView(id: string, el: HTMLElement): Promise<void> {
  const first = !MOUNTED.has(id);
  MOUNTED.add(id);
  const box = first ? null : snapshotScroll(el);
  try {
    await measureAsync("view:" + id, async () => {
      if (id === "sessions") {
        if (first) renderAll();
      } else {
        // 懒加载：首次切到该视图才下载对应 chunk
        const view = await loadView(id);
        await (first ? view.render(el) : view.refresh(el));
      }
    });
  } catch (e) {
    HubUI.toast("视图加载失败：" + (e instanceof Error ? e.message : ""), "error");
  }
  if (box) restoreScroll(el, box);
}

/** 导航选中态：文字高亮 + 滑动块跟随 */
function syncNavIndicator(id: string): void {
  const nav = byId<HTMLElement>("mod-nav");
  const ind = nav ? nav.querySelector<HTMLElement>(".mod-nav__ind") : null;
  const btn = nav
    ? qsa<HTMLButtonElement>("button", nav).find((b) => b.dataset["view"] === id && !b.hidden)
    : undefined;
  if (nav) {
    for (const b of qsa<HTMLButtonElement>("button", nav)) {
      b.classList.toggle("is-on", b.dataset["view"] === id);
    }
  }
  if (!ind) return;
  if (!btn) {
    ind.classList.remove("is-on");
    return;
  }
  ind.style.left = btn.offsetLeft + "px";
  ind.style.width = btn.offsetWidth + "px";
  ind.classList.add("is-on");
}

window.addEventListener("resize", () => {
  const cur = qs<HTMLElement>(".mod-nav button.is-on");
  if (cur) syncNavIndicator(cur.dataset["view"] ?? "");
});

function closeSysPages(except: string | null): void {
  for (const [k, ov] of Object.entries(SYS_PAGES)) {
    if (k === except) continue;
    const el = byId<HTMLElement>(ov);
    if (el) el.classList.remove("is-open", "is-page");
  }
}

function openSysPage(id: string): void {
  const ovId = SYS_PAGES[id];
  if (!ovId) return;
  const ov = byId<HTMLElement>(ovId);
  if (!ov) return;
  closeSysPages(id);
  ov.classList.add("is-open", "is-page");
  for (const b of qsa<HTMLButtonElement>(".mod-nav button")) {
    b.classList.toggle("is-on", b.dataset["view"] === id);
  }
  if (id === "schedule" && !ov.dataset["loaded"]) {
    ov.dataset["loaded"] = "1";
    openSchedule();
  }
}

function sysPageOpen(id: string): boolean {
  const ovId = SYS_PAGES[id];
  if (!ovId) return false;
  const ov = byId<HTMLElement>(ovId);
  return !!(ov && ov.classList.contains("is-open"));
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const id of Object.keys(SYS_PAGES)) {
    if (sysPageOpen(id)) void switchView(LastView);
  }
});

async function switchView(id: string): Promise<void> {
  if (SYS_PAGES[id]) {
    openSysPage(id); // 定时任务等"整页 overlay"（暂时隐藏）
    return;
  }
  closeSysPages(null);
  if (id !== "settings") LastView = id;
  const target = id === "settings" ? SETTINGS_VIEW : "view-" + id;
  const next = byId<HTMLElement>(target);
  if (!next) return;
  if (next.classList.contains("is-active")) {
    await mountView(id, next); // 再点当前页签 = 轻刷新（并复位该页内部状态）
    syncNavIndicator(id);
    return;
  }

  // ① 先把内容准备好（首次挂载 / 已挂载则静默刷新），再让它进场 —— 不再"空壳淡入 → 内容跳出"
  await mountView(id, next);

  // ② 旧视图淡出 120ms，与新视图进场重叠（不再有硬切/空白帧）
  for (const prev of qsa<HTMLElement>(".view.is-active")) {
    if (prev === next) continue;
    prev.classList.add("is-leaving");
    setTimeout(() => {
      prev.classList.remove("is-active", "is-leaving");
      if (prev.id === SETTINGS_VIEW) prev.classList.remove("is-open"); // 旧判据：关闭后不得留 is-open
    }, 130);
  }
  next.classList.remove("is-leaving");
  next.classList.toggle("is-open", id === "settings"); // 设置页兼容旧判据
  next.classList.add("is-active");
  syncNavIndicator(id);
}

/* ====================================================================
   「笔记 · 本地」子视图（legacy）：与四个模块同一套条目/列表观感。
   结构：统计行 → 搜索/导出行 → 行内新建条 → 统一条目行（MV.item）+ 展开体（内容 / 删除）。
   数据仍走 /api/memory/add | /api/memory/search | /api/memory/delete。
   ==================================================================== */

function memItemsHtml(list: MemoryNote[], openId: string | null): string {
  if (!list.length) return '<div class="hub-empty">记忆区还是空的</div>';
  return list
    .map((m) => {
      const kindName = m.kind === "migration-summary" ? "迁移记录" : "笔记";
      const excerpt = String(m.body || "")
        .replace(/\s+/gu, " ")
        .slice(0, 90);
      return MV.item({
        id: m.id || "n-" + Math.random().toString(36).slice(2),
        testid: "mv-item",
        chkTestid: "mv-note-check",
        sel: state.selected.has(String(m.id)),
        open: String(openId) === String(m.id),
        chipText: m.kind === "migration-summary" ? "迁" : "笔记",
        chipCls: "chip--muted",
        title: m.title || "(无标题)",
        sub: `${kindName} · ${fmtTime(m.ts)} · ${excerpt}`,
        extra: `<span class="mvi-acts"><button class="hub-btn btn-sm hub-btn--danger" data-note-del="${esc(String(m.id || ""))}">删除</button></span>`,
        body: `<pre class="mvi__pre" style="margin:0">${esc(m.body || "")}</pre>`,
      });
    })
    .join("");
}

/** 删除一条 hub 记忆（笔记视图的悬停删除与展开体删除共用） */
function delNote(root: HTMLElement, id: string | number | null | undefined): void {
  HubUI.confirm(
    "删除记忆",
    "确认删除这条记忆？<br>（仅删除 hub 记忆，不影响任何原生会话）",
    async () => {
      const r = await post<OkEnvelope>("/api/memory/delete", { id: Number(id) || id });
      if (r.data.ok) {
        HubUI.toast("已删除", "success");
        await loadState();
        renderMemoryView(root);
      } else {
        HubUI.toast("删除失败：" + (r.data.error || ""), "error");
      }
    },
    { confirmText: "删除", danger: true },
  );
}

const MEM_VIEW = { q: "", open: null as string | null };

function renderMemoryView(root: HTMLElement): void {
  const list = (state.memories ?? []).filter(
    (m) =>
      !MEM_VIEW.q ||
      String(m.title || "")
        .toLowerCase()
        .includes(MEM_VIEW.q.toLowerCase()) ||
      String(m.body || "")
        .toLowerCase()
        .includes(MEM_VIEW.q.toLowerCase()),
  );
  const all = state.memories ?? [];
  const busTools = allTools().filter((t) => t.mcp_config && t.enabled);
  const wired = busTools.filter((t) => t.memory_wired === true).length;
  root.innerHTML = `
    <div class="nv-stats" data-testid="mv-stats">
      <div class="nv-stat"><b>${all.length}</b><span>记忆总条数</span></div>
      <div class="nv-stat"><b>${all.filter((m) => m.kind === "note").length}</b><span>笔记</span></div>
      <div class="nv-stat"><b>${all.filter((m) => m.kind === "migration-summary").length}</b><span>迁移记录</span></div>
      <div class="nv-stat"><b>${wired}/${busTools.length}</b><span>记忆总线已接入</span></div>
    </div>
    <div class="slist__search" style="padding:var(--sp-2) 0">
      <div class="ssearch"><span class="ssearch__ic">${MV.ic("search")}</span>
        <input id="mv-q" data-testid="mv-search" placeholder="搜索记忆（全文）…" value="${esc(MEM_VIEW.q)}">
      </div>
      <span class="slist__seg">
        <a class="hub-btn btn-sm" data-testid="mv-export-md" href="/api/memory/export?format=md">导出 MD</a>
        <a class="hub-btn btn-sm" data-testid="mv-export-json" href="/api/memory/export?format=json">导出 JSON</a>
      </span>
    </div>
    <div class="notes-compose">
      <input class="hub-input" id="mv-title" data-testid="memory-title" placeholder="标题（可选）">
      <input class="hub-input" id="mv-body" data-testid="memory-body" placeholder="记一条：偏好、决策、约定…">
      <button class="hub-btn hub-btn--primary btn-sm" data-testid="mv-add">保存记忆</button>
    </div>
    <div class="nv-list" data-testid="mv-list">${memItemsHtml(list, MEM_VIEW.open)}</div>`;
  const addBtn = mustQs<HTMLButtonElement>('[data-testid="mv-add"]', root);
  addBtn.onclick = async () => {
    const body = mustQs<HTMLInputElement>("#mv-body", root).value.trim();
    if (!body) {
      HubUI.toast("内容不能为空", "error");
      return;
    }
    addBtn.classList.add("is-loading");
    const r = await post<OkEnvelope>("/api/memory/add", {
      title: mustQs<HTMLInputElement>("#mv-title", root).value.trim(),
      body,
      kind: "note",
    });
    addBtn.classList.remove("is-loading");
    if (r.data.ok) {
      HubUI.toast("记忆已保存", "success");
      await loadState();
      renderMemoryView(root);
    } else {
      HubUI.toast("保存失败：" + (r.data.error || ""), "error");
    }
  };
  let timer: number | undefined;
  const qInput = mustQs<HTMLInputElement>("#mv-q", root);
  qInput.oninput = () => {
    window.clearTimeout(timer);
    MEM_VIEW.q = qInput.value.trim();
    timer = window.setTimeout(() => renderMemoryView(root), 250);
  };
  // 条目行：点行头就地展开 / 收起（不重建列表）；展开即选中
  for (const row of qsa<HTMLElement>('[data-testid="mv-list"] .mvi', root)) {
    const id = row.dataset["id"] ?? "";
    const setOpen = (on: boolean): void => {
      row.classList.toggle("is-open", on);
      MEM_VIEW.open = on ? id : null;
      const cb = row.querySelector<HTMLInputElement>(".mvi__chk");
      if (cb) cb.checked = on;
      row.classList.toggle("is-sel", on);
      // 展开体：首次展开时注入正文（与其它模块的"展开即出内容"一致）
      const acc = row.querySelector<HTMLElement>(".mvi__accin");
      if (on && acc && !acc.innerHTML.trim()) {
        const m = (state.memories ?? []).find((x) => String(x.id) === String(id));
        acc.innerHTML =
          '<div class="nv-dops"><button class="hub-btn btn-sm hub-btn--danger" id="mv-detail-del">删除</button></div>' +
          `<pre class="mvi__pre">${esc(m?.body ?? "")}</pre>`;
        const d2 = acc.querySelector<HTMLElement>("#mv-detail-del");
        if (d2) {
          d2.onclick = (ev) => {
            ev.stopPropagation();
            delNote(root, id);
          };
        }
      }
    };
    // 行任意处点击都展开（与其它模块一致）；按钮/勾选框不触发
    row.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.closest("input, button")) return;
      setOpen(!row.classList.contains("is-open"));
    };

    const chev = row.querySelector<HTMLElement>(".mvi__chev");
    if (chev) {
      chev.onclick = (e) => {
        e.stopPropagation();
        setOpen(!row.classList.contains("is-open"));
      };
    }
    const cb = row.querySelector<HTMLInputElement>(".mvi__chk");
    if (cb) {
      cb.onclick = (e) => {
        e.stopPropagation();
        setOpen(cb.checked);
      };
    }
    const del = row.querySelector<HTMLElement>("[data-note-del]");
    if (del) {
      del.onclick = (e) => {
        e.stopPropagation();
        delNote(root, del.dataset["noteDel"]);
      };
    }
  }
  HubUI.drawFrames(root);
}

/* ---------- 视图动作注册（打断 main ↔ views 循环依赖） ---------- */

registerAppActions({
  renderAll,
  renderRows,
  renderPanel,
  renderMemoryView: () => {
    const host = byId<HTMLElement>("mv-notes-host");
    if (host) renderMemoryView(host);
  },
  switchView,
  loadState,
});

/* ---------- init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = mustById<HTMLButtonElement>("refresh-all");
  refreshBtn.onclick = () => void refreshAll(refreshBtn);
  // 设置 / 统计 / 定时任务 已是顶栏导航项，统一由 switchView 处理（见 openSysPage）

  mustById<HTMLButtonElement>("sched-close").onclick = closeSchedule;
  const schedSave = mustById<HTMLButtonElement>("sched-save");
  schedSave.onclick = () => void saveSchedule(schedSave);
  mustById<HTMLElement>("sched-overlay").addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "sched-overlay") closeSchedule();
  });
  let searchTimer: number | undefined;
  const searchInput = mustById<HTMLInputElement>("search-input");
  searchInput.oninput = () => {
    renderRows();
    window.clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      hideSearchPanel();
      return;
    }
    searchTimer = window.setTimeout(() => void runContentSearch(q), 250);
  };
  document.addEventListener("click", (e) => {
    const panel = byId<HTMLElement>("search-panel");
    const target = e.target;
    if (
      panel &&
      panel.style.display !== "none" &&
      target instanceof Node &&
      !panel.contains(target) &&
      (!(target instanceof HTMLElement) || target.id !== "search-input")
    ) {
      hideSearchPanel();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSearchPanel();
  });
  // sel-all 复选框随列表头移除，改为分页器上的全选按钮（sess-sel-all）
  const legacySelAll = byId<HTMLInputElement>("sel-all");
  if (legacySelAll) {
    legacySelAll.onchange = (e) => {
      if (e.currentTarget instanceof HTMLInputElement) selectAll(e.currentTarget);
    };
  }
  // 记忆新增已并入记忆视图（mv-add）；侧栏旧入口已移除
  mustById<HTMLButtonElement>("preview-close").onclick = closePreview;
  mustById<HTMLElement>("preview-overlay").addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.id === "preview-overlay") closePreview();
  });
  for (const b of qsa<HTMLButtonElement>("#filter-seg button")) {
    b.onclick = () => setFilter(b.dataset["filter"] ?? "all");
  }
  const selAllBtn = byId<HTMLButtonElement>("sess-sel-all");
  if (selAllBtn) selAllBtn.onclick = sessSelAll;
  const selInvBtn = byId<HTMLButtonElement>("sess-sel-invert");
  if (selInvBtn) selInvBtn.onclick = sessSelInvert;
  const selNoneBtn = byId<HTMLButtonElement>("sess-sel-none");
  if (selNoneBtn) selNoneBtn.onclick = sessSelNone;
  for (const b of qsa<HTMLButtonElement>(".mod-nav button")) {
    b.onclick = () => {
      const view = b.dataset["view"] ?? "";
      // 定时任务：沿用原来的直接开面板（openSchedule 自己负责渲染 + is-open），
      // 只额外同步导航高亮；不经过视图切换的异步流程。
      if (view === "schedule") {
        for (const x of qsa<HTMLButtonElement>(".mod-nav button")) {
          x.classList.toggle("is-on", x === b);
        }
        syncNavIndicator("schedule");
        openSchedule();
        return;
      }
      void switchView(view);
    };
  }

  loadState()
    .then(() => {
      markLive("sse");
      MOUNTED.add("sessions"); // 首屏已渲染过
      syncNavIndicator("sessions");
    })
    .catch((e: unknown) => renderLoadError(e instanceof Error ? e.message : String(e)));
  startLiveUpdates(); // 即时刷新（SSE）；断开时自动退回轮询
});

/* ---------- e2e / 调试桥（行为契约，勿删） ---------- */

window.hubApp = {
  state,
  loadState,
  setFilter,
  openSession,
  switchView,
  LIVE,
  applyLiveUpdate,
  startLiveUpdates,
  migrateFlow: (targets: string | string[], ids?: string[]) =>
    migrateConfirmInline(targets, ids ?? [...state.selected]),
};
window.MV = MV;
window.applyModuleVisibility = applyModuleVisibility;
// 兼容旧全局：connect 视图的 drawFrames 兜底检查 + index.html 定时任务「取消」内联 onclick。
window.HubUI = HubUI;
window.closeSchedule = closeSchedule;
