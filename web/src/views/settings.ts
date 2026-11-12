/* 设置中心 v3：左锚点导航（通用 / 模块 / 工具 / 远程仓库 / 桌面 / 关于）+ 右内容面板。
   修改即时生效；工具增删改在行内 accordion 完成。 */

import { appActions } from "../core/actions.ts";
import { api, post, send } from "../core/api.ts";
import {
  type DesktopProfile,
  type DesktopSettings,
  desktopAvailable,
  getDesktopProfile,
  getDesktopSettings,
  setDesktopSettings,
} from "../core/desktop.ts";
import { applyModuleVisibility, byId, qs, qsa } from "../core/dom.ts";
import { esc } from "../core/format.ts";
import { getPrefs, resetPrefs, type SessLayout, type StartView, setPrefs } from "../core/prefs.ts";
import { state } from "../core/state.ts";
import { allTools, toolColorCls, toolShort } from "../core/tools.ts";
import type {
  ModuleEntry,
  ModulesResponse,
  RemoteRepo,
  StateResponse,
  ToolPublic,
} from "../core/types/api.ts";
import type { ToastType } from "../hub-ui.ts";
import { HubUI } from "../hub-ui.ts";

const SVG_GRIP =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">' +
  '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>' +
  '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>' +
  '<circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

const MODULE_LABEL: Record<string, string> = {
  sessions: "会话",
  memory: "记忆",
  skills: "Skills",
  mcp: "MCP",
};
const MODULE_DESC: Record<string, string> = {
  sessions: "多工具会话采集 / 浏览 / 迁移（lineage 勾连）",
  memory: "长期记忆（db + 每日 Markdown 日志）",
  skills: "Skill 源拉取 / 本地编写 / 分发到各工具目录",
  mcp: "MCP 源与手动条目 / 写入各工具配置 / 握手验证",
};
const PANE_TITLE: Record<string, string> = {
  general: "通用",
  modules: "模块",
  tools: "工具",
  remotes: "远程仓库",
  desktop: "桌面",
  env: "关于",
};
const PANE_SUB: Record<string, string> = {
  general: "列表刷新节奏与本地偏好",
  modules: "启用或停用顶部导航模块",
  tools: "排序、启停与路径配置",
  remotes: "仓库地址与所属模块",
  desktop: "菜单栏、开机启动与 Dock 图标",
  env: "版本与存储位置",
};

interface SettingsState {
  pane: string;
}

const S: SettingsState = { pane: "modules" };

function pane(name: string): HTMLElement | null {
  return qs<HTMLElement>(`.setpane[data-pane="${name}"]`);
}

function switchPane(name: string): void {
  S.pane = name;
  for (const b of qsa<HTMLElement>(".setwin__item")) {
    b.classList.toggle("is-on", b.dataset["pane"] === name);
  }
  for (const p of qsa<HTMLElement>(".setpane")) {
    p.classList.toggle("is-on", p.dataset["pane"] === name);
  }
  const title = byId<HTMLElement>("settings-title");
  if (title) title.textContent = PANE_TITLE[name] ?? name;
  const sub = byId<HTMLElement>("settings-sub");
  if (sub) sub.textContent = PANE_SUB[name] ?? "";
  void render();
}

async function render(): Promise<void> {
  const ver = byId<HTMLElement>("settings-version");
  if (ver) ver.textContent = `Agent Depot ${state.version}`;
  if (S.pane === "general") renderGeneral();
  if (S.pane === "modules") await renderModules();
  if (S.pane === "tools") await renderTools();
  if (S.pane === "remotes") await renderRemotes();
  if (S.pane === "desktop") await renderDesktop();
  if (S.pane === "env") renderEnv();
}

async function openSettings(): Promise<void> {
  const overlay = byId<HTMLElement>("settings-overlay");
  if (overlay && !overlay.classList.contains("is-active")) {
    void appActions().switchView("settings");
    return;
  }
  const ver = byId<HTMLElement>("settings-version");
  if (ver) ver.textContent = `Agent Depot ${state.version}`;
  await render();
}

async function closeSettings(): Promise<void> {
  await appActions().switchView("sessions");
}

/* ==================== 通用（本地偏好） ==================== */

function prefToggle(
  label: string,
  desc: string,
  key: "autoScanMemory" | "reportFrontendErrors",
  on: boolean,
  testid: string,
): string {
  return `
      <div class="setrow" data-testid="${testid}">
        <div class="setrow__txt">
          <div class="setrow__name">${esc(label)}</div>
          <div class="setrow__desc">${esc(desc)}</div>
        </div>
        <button class="set-toggle ${on ? "is-on" : ""}" data-pref="${key}"
                data-testid="${testid}-toggle" role="switch" aria-checked="${on ? "true" : "false"}"
                aria-label="${esc(label)} ${on ? "已开启" : "已关闭"}">
          <span class="set-toggle__knob"></span>
        </button>
      </div>`;
}

function renderGeneral(): void {
  const box = pane("general");
  if (!box) return;
  const p = getPrefs();
  box.innerHTML = `
      <p class="setpane__hint">只保存在本机（浏览器 / 桌面客户端），不影响服务端数据。</p>
      <div class="setcard--list">
        <div class="setrow" data-testid="settings-general-row-chunk">
          <div class="setrow__txt">
            <div class="setrow__name">会话列表每批行数</div>
            <div class="setrow__desc">首屏渲染行数，触底自动追加；会话多时调小首屏更快</div>
          </div>
          <div class="setrow__chips">${HubUI.select({
            testid: "settings-general-chunk",
            value: p.rowChunk,
            options: [
              { value: 50, label: "50 行" },
              { value: 100, label: "100 行" },
              { value: 200, label: "200 行" },
            ],
          })}</div>
        </div>
        <div class="setrow" data-testid="settings-general-row-poll">
          <div class="setrow__txt">
            <div class="setrow__name">实时连接断开时的刷新间隔</div>
            <div class="setrow__desc">SSE 不可用时退回轮询；间隔越短越实时，后台标签页固定降到 60s</div>
          </div>
          <div class="setrow__chips">${HubUI.select({
            testid: "settings-general-poll",
            value: p.pollIntervalSec,
            options: [
              { value: 5, label: "5 秒" },
              { value: 10, label: "10 秒" },
              { value: 30, label: "30 秒" },
            ],
          })}</div>
        </div>
        <div class="setrow" data-testid="settings-general-row-view">
          <div class="setrow__txt">
            <div class="setrow__name">默认启动视图</div>
            <div class="setrow__desc">启动后进入的模块；对应模块被停用时仍回到会话页</div>
          </div>
          <div class="setrow__chips">${HubUI.select({
            testid: "settings-general-view",
            value: p.defaultView,
            options: [
              { value: "sessions", label: "会话" },
              { value: "memory", label: "记忆" },
              { value: "skills", label: "Skills" },
              { value: "mcp", label: "MCP" },
              { value: "ops", label: "台账" },
              { value: "stats", label: "统计" },
            ],
          })}</div>
        </div>
        <div class="setrow" data-testid="settings-general-row-layout">
          <div class="setrow__txt">
            <div class="setrow__name">会话默认布局</div>
            <div class="setrow__desc">详细 = 来源分组卡片；简略 = 顶部收起为横向来源条（立即生效）</div>
          </div>
          <div class="setrow__chips">${HubUI.select({
            testid: "settings-general-layout",
            value: p.sessLayout,
            options: [
              { value: "detail", label: "详细" },
              { value: "compact", label: "简略" },
            ],
          })}</div>
        </div>
        ${prefToggle(
          "首次进入记忆页自动扫描",
          "打开记忆页时自动扫描各工具的记忆文件；关闭后需手动点「全部扫描」",
          "autoScanMemory",
          p.autoScanMemory,
          "settings-general-autoscan",
        )}
        ${prefToggle(
          "发送前端错误到台账",
          "未捕获异常 / 慢请求 / 慢渲染写入「台账 → frontend」，便于排障",
          "reportFrontendErrors",
          p.reportFrontendErrors,
          "settings-general-report",
        )}
      </div>
      <div class="setrow__acts" style="margin-top:var(--sp-3)">
        <button class="hub-btn btn-sm" id="prefs-reset" data-testid="settings-general-reset">恢复默认</button>
      </div>`;
  HubUI.hydrateSelects(box);

  const chunkSel = qs<HTMLElement>('[data-testid="settings-general-chunk"]', box);
  if (chunkSel) {
    chunkSel.addEventListener("change", () => {
      const v = Number((chunkSel as HTMLElement & { value: string }).value);
      setPrefs({ rowChunk: v });
      toastOnce("settings-prefs", "已保存：每批 " + v + " 行", "success");
    });
  }
  const pollSel = qs<HTMLElement>('[data-testid="settings-general-poll"]', box);
  if (pollSel) {
    pollSel.addEventListener("change", () => {
      const v = Number((pollSel as HTMLElement & { value: string }).value);
      setPrefs({ pollIntervalSec: v });
      toastOnce("settings-prefs", "已保存：刷新间隔 " + v + " 秒", "success");
    });
  }
  const viewSel = qs<HTMLElement>('[data-testid="settings-general-view"]', box);
  if (viewSel) {
    viewSel.addEventListener("change", () => {
      const v = (viewSel as HTMLElement & { value: string }).value;
      setPrefs({ defaultView: v as StartView });
      toastOnce("settings-prefs", "已保存：下次启动进入该视图", "success");
    });
  }
  const layoutSel = qs<HTMLElement>('[data-testid="settings-general-layout"]', box);
  if (layoutSel) {
    layoutSel.addEventListener("change", () => {
      const v = (layoutSel as HTMLElement & { value: string }).value;
      setPrefs({ sessLayout: v as SessLayout });
      toastOnce("settings-prefs", "已保存：会话布局已切换", "success");
    });
  }
  for (const btn of qsa<HTMLButtonElement>(".set-toggle[data-pref]", box)) {
    btn.onclick = () => {
      const key = btn.dataset["pref"] as "autoScanMemory" | "reportFrontendErrors";
      const next = !btn.classList.contains("is-on");
      flipToggle(btn, next);
      setPrefs({ [key]: next });
      toastOnce("settings-prefs", "已保存", "success");
    };
  }
  const reset = qs<HTMLButtonElement>("#prefs-reset", box);
  if (reset) {
    reset.onclick = () => {
      void HubUI.confirm("恢复默认设置", "列表行数、刷新间隔与本地开关都会回到默认值。", () => {
        resetPrefs();
        renderGeneral();
        toastOnce("settings-prefs", "已恢复默认", "success");
      });
    };
  }
}

/* ==================== 模块 ==================== */

async function renderModules(): Promise<void> {
  const box = pane("modules");
  if (!box) return;
  const r = await api<ModulesResponse>("/api/modules");
  const mods: ModuleEntry[] = r.data.modules ?? [];
  box.innerHTML = `
      <p class="setpane__hint">禁用后顶部导航与对应接口同时停用；数据不受影响。</p>
      <div class="setcard--list">${mods
        .map(
          (m) => `
        <div class="setrow" data-testid="settings-module-${m.id}">
          <div class="setrow__txt">
            <div class="setrow__name">${esc(m.name || MODULE_LABEL[m.id] || m.id)}</div>
            <div class="setrow__desc">${esc(m.desc || MODULE_DESC[m.id] || "")}</div>
          </div>
          <button class="set-toggle ${m.enabled ? "is-on" : ""}" data-mid="${m.id}"
                  data-testid="settings-module-toggle-${m.id}"
                  aria-label="${esc(MODULE_LABEL[m.id] ?? m.id)} ${m.enabled ? "已启用" : "已禁用"}">
            <span class="set-toggle__knob"></span>
          </button>
        </div>`,
        )
        .join("")}</div>`;
  for (const btn of qsa<HTMLButtonElement>(".set-toggle[data-mid]", box)) {
    btn.onclick = async () => {
      const mid = btn.dataset["mid"] ?? "";
      const on = !btn.classList.contains("is-on");
      flipToggle(btn, on);
      const r2 = await post<ModulesResponse & { error?: string }>(`/api/modules/${mid}/toggle`, {
        enabled: on,
      });
      if (r2.data.ok) {
        toastOnce(`mod-${mid}`, `${MODULE_LABEL[mid] ?? mid} 已${on ? "启用" : "禁用"}`, "success");
        applyModuleVisibility(r2.data.modules ?? []);
      } else {
        flipToggle(btn, !on);
        HubUI.toast(`操作失败：${r2.data.error ?? ""}`, "error");
      }
    };
  }
}

function flipToggle(btn: HTMLElement, on: boolean): void {
  btn.classList.toggle("is-on", on);
  btn.setAttribute("aria-checked", on ? "true" : "false");
  const row = btn.closest(".trow, .setrow");
  if (row instanceof HTMLElement) row.classList.toggle("is-off", !on);
}

const TOASTS: Record<string, HTMLElement | undefined> = {};
function toastOnce(key: string, msg: string, type: ToastType): void {
  const old = TOASTS[key];
  if (old?.isConnected) old.remove();
  TOASTS[key] = HubUI.toast(msg, type);
}

/* ==================== 工具 ==================== */

let ToolsBound = false;
let ToolsCache: ToolPublic[] = [];

interface PanelState {
  row: HTMLElement | null;
  tool: ToolPublic | null;
  draft: { enabled: boolean } | null;
}
const PANEL: PanelState = { row: null, tool: null, draft: null };

function toolByIdAny(tid: string): ToolPublic | null {
  return ToolsCache.find((x) => x.id === tid) ?? allTools().find((x) => x.id === tid) ?? null;
}

async function renderTools(): Promise<void> {
  const box = pane("tools");
  if (!box) return;
  const r = await api<StateResponse>("/api/state");
  const tools: ToolPublic[] = r.data.tool_list ?? [];
  box.innerHTML = `
      <div class="setpane__toph">
        <p class="setpane__hint">拖动左侧手柄或用箭头调整顺序，顺序同步到工具卡片与侧栏。内置工具不可删除；
          停用的工具停止采集，历史会话仍可查看。点击整行可展开编辑。</p>
        <span class="setall">
          <span class="setall__l">全部启用</span>
          <button class="set-toggle ${tools.length > 0 && tools.every((t) => t.enabled) ? "is-on" : ""}"
                  data-testid="settings-tool-all" id="set-tool-all" aria-label="全部启用 / 全部停用">
            <span class="set-toggle__knob"></span></button>
        </span>
      </div>
      <ol class="setcard--list" id="set-tool-list">${tools.map((t, i) => toolRowHtml(t, i, tools.length)).join("")}</ol>`;
  bindToolEdit(box, tools);
  bindToolToggle(box);
  bindReorder(box);
}

function toolRowHtml(t: ToolPublic, i: number, n: number): string {
  return `
      <li class="trow ${t.enabled ? "" : "is-off"}" data-tid="${esc(t.id)}"
          data-testid="settings-tool-${esc(t.id)}" title="${esc(t.name)}">
        <div class="trow__line">
          <span class="trow__grip" data-testid="settings-tool-grip-${esc(t.id)}" title="拖动排序"
                aria-label="拖动排序">${SVG_GRIP}</span>
          <span class="trow__n">${i + 1}</span>
          <span class="trow__chip ${toolColorCls(t)}">${esc(toolShort(t))}</span>
          <span class="trow__body">
            <span class="trow__name">${esc(t.name)}</span>
          </span>
          <span class="trow__mv">
            <button data-mv="up" ${i === 0 ? "disabled" : ""} title="上移" aria-label="上移"
                    data-testid="settings-tool-up-${esc(t.id)}">▲</button>
            <button data-mv="down" ${i === n - 1 ? "disabled" : ""} title="下移" aria-label="下移"
                    data-testid="settings-tool-down-${esc(t.id)}">▼</button>
          </span>
          <button class="trow__fold" data-testid="manage-${esc(t.id)}" data-fold="${esc(t.id)}"
                  title="展开 / 收起编辑面板" aria-label="展开编辑"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
          <span class="trow__sw" data-stop="1">
            <button class="set-toggle ${t.enabled ? "is-on" : ""}" data-tid="${esc(t.id)}"
                    data-testid="settings-tool-toggle-${esc(t.id)}"
                    aria-label="${esc(t.name)} ${t.enabled ? "已启用" : "已停用"}">
              <span class="set-toggle__knob"></span>
            </button>
          </span>
        </div>
        <div class="trow__acc"><div><div class="trow__panel" data-panel="${esc(t.id)}"></div></div></div>
      </li>`;
}

function toolPanelHtml(t: ToolPublic): string {
  const wired = t.memory_wired;
  const bus = t.mcp_config
    ? wired === true
      ? "已接入 agentmemory"
      : wired === false
        ? "未接入"
        : "无法判断（配置文件不可读）"
    : "未登记 MCP 配置";
  const canWire = !!t.mcp_config && wired === false;
  return `
      <label class="setfield">
        <span class="setfield__l">会话路径</span>
        <input class="hub-input mono" id="settool-root" data-testid="settool-root"
               value="${esc(t.root ?? "")}" placeholder="未配置" ${t.builtin ? "disabled" : ""}>
      </label>
      <div class="setfield__grid">
        <label class="setfield">
          <span class="setfield__l">Skills 目录（可选）</span>
          <input class="hub-input mono" id="settool-skills" data-testid="settool-skills"
                 value="${esc(t.skills_dir ?? "")}" placeholder="未配置">
        </label>
        <label class="setfield">
          <span class="setfield__l">MCP 配置（可选）</span>
          <input class="hub-input mono" id="settool-mcp" data-testid="settool-mcp"
                 value="${esc(t.mcp_config ?? "")}" placeholder="未配置">
        </label>
      </div>
      <p class="setpane__hint">格式随路径自动识别；填写 Skills / MCP 路径后，会自动出现在对应模块的「目标」列表中。</p>
      <div class="trow__foot">
        <div class="trow__enable">
          <span class="trow__enable-t"><b>启用采集</b>
            <span class="trow__wire">记忆总线 · ${esc(bus)}
              ${canWire ? `<button class="hub-btn btn-sm" data-wire="${esc(t.id)}" data-testid="settool-wire">接入</button>` : ""}</span></span>
          <button class="set-toggle ${t.enabled ? "is-on" : ""}" data-en="${esc(t.id)}"
                  data-testid="settool-enabled" aria-label="启用采集"><span class="set-toggle__knob"></span></button>
        </div>
        ${t.builtin ? "" : `<button class="hub-btn btn-sm hub-btn--danger" data-testid="settool-delete" data-del="${esc(t.id)}">删除</button>`}
        <button class="hub-btn btn-sm" data-testid="settool-cancel" data-cancel="${esc(t.id)}">取消</button>
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="settool-save" data-save="${esc(t.id)}" disabled>保存</button>
      </div>`;
}

function closeRows(): void {
  for (const r of qsa<HTMLElement>(".trow.is-open")) {
    r.classList.remove("is-open");
    delete r.dataset["open"];
    const p = qs<HTMLElement>(".trow__panel", r);
    if (p) p.innerHTML = "";
  }
  PANEL.row = null;
}

function openRow(row: HTMLElement, t: ToolPublic): void {
  const wasOpen = row.classList.contains("is-open");
  closeRows();
  if (wasOpen) return;
  const panel = qs<HTMLElement>(".trow__panel", row);
  if (!panel) return;
  panel.innerHTML = toolPanelHtml(t);
  row.classList.add("is-open");
  row.dataset["open"] = "1";
  PANEL.row = row;
  PANEL.tool = t;
  PANEL.draft = { enabled: t.enabled };
  for (const inp of qsa<HTMLInputElement>("#settool-root, #settool-skills, #settool-mcp", row)) {
    inp.addEventListener("input", () => syncSaveLocal(row, t));
    inp.addEventListener("keyup", () => syncSaveLocal(row, t));
  }
}

function syncSaveLocal(row: HTMLElement, t: ToolPublic): void {
  const val = (id: string): string => qs<HTMLInputElement>(`#${id}`, row)?.value ?? "";
  const enEl = qs<HTMLElement>("[data-en]", row);
  const enOn = enEl ? enEl.classList.contains("is-on") : false;
  const dirty =
    val("settool-root") !== (t.root ?? "") ||
    val("settool-skills") !== (t.skills_dir ?? "") ||
    val("settool-mcp") !== (t.mcp_config ?? "") ||
    enOn !== t.enabled;
  const save = qs<HTMLButtonElement>("[data-save]", row);
  if (save) save.disabled = !dirty;
}

function bindToolEdit(box: HTMLElement, tools: ToolPublic[]): void {
  if (ToolsBound) {
    ToolsCache = tools;
    return;
  }
  ToolsBound = true;
  ToolsCache = tools;
  box.removeEventListener("click", onToolsClick, true);
  box.addEventListener("click", onToolsClick, true);

  async function onToolsClick(e: MouseEvent): Promise<void> {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest(".trow");
    const row = rowEl instanceof HTMLElement ? rowEl : null;
    const t = row ? toolByIdAny(row.dataset["tid"] ?? "") : null;

    const fold = target.closest("[data-fold]");
    if (fold && row && t) {
      e.stopPropagation();
      openRow(row, t);
      return;
    }
    if (target.closest("[data-cancel]")) {
      e.stopPropagation();
      e.preventDefault();
      closeRows();
      return;
    }
    const wire = target.closest("[data-wire]");
    if (wire instanceof HTMLElement && t) {
      e.stopPropagation();
      e.preventDefault();
      HubUI.confirm(
        "接入记忆总线",
        `将把 <b>agentmemory</b> 写入 <code>${esc(t.mcp_config ?? "")}</code>（先自动备份原文件）。`,
        async () => {
          wire.classList.add("is-loading");
          const r = await post<{ ok: boolean; error?: string; already?: boolean }>(
            `/api/tools/${encodeURIComponent(t.id)}/wire-memory`,
            {},
          );
          wire.classList.remove("is-loading");
          if (!r.data.ok) {
            HubUI.toast(`接入失败：${r.data.error ?? ""}`, "error");
            return;
          }
          toastOnce(
            `wire-${t.id}`,
            r.data.already ? "记忆总线已接入" : "已接入记忆总线（原文件已备份）",
            "success",
          );
          const txt = wire.parentElement;
          wire.remove();
          if (txt?.firstChild) txt.firstChild.textContent = "记忆总线 · 已接入 agentmemory ";
          void appActions().loadState();
        },
        { confirmText: "接入" },
      );
      return;
    }
    const del = target.closest("[data-del]");
    if (del && t) {
      e.stopPropagation();
      e.preventDefault();
      HubUI.confirm(
        "删除工具",
        `<p>删除「${esc(t.name)}」的登记？默认保留已采集数据。</p>` +
          `<label class="tool-purge-opt"><input type="checkbox" id="tool-purge-opt" data-testid="tool-purge-opt">` +
          " 同时彻底清除已采集的会话/消息（删除前自动导出备份）</label>",
        async () => {
          const purge = !!document.querySelector("#tool-purge-opt:checked");
          const r = await send<{ ok: boolean; error?: string }>(
            `/api/tools/${encodeURIComponent(t.id)}${purge ? "?purge=1" : ""}`,
            "DELETE",
          );
          if (!r.data.ok) {
            HubUI.toast(`删除失败：${r.data.error ?? ""}`, "error");
            return;
          }
          HubUI.toast(purge ? "已彻底删除（含已采集数据）" : "已删除登记（数据保留）", "success");
          closeRows();
          await appActions().loadState();
          removeToolRow(box, t.id);
        },
        { confirmText: "删除", danger: true },
      );
      return;
    }
    const en = target.closest("[data-en]");
    if (en instanceof HTMLElement) {
      e.stopPropagation();
      e.preventDefault();
      if (PANEL.draft) {
        PANEL.draft.enabled = !PANEL.draft.enabled;
        en.classList.toggle("is-on", PANEL.draft.enabled);
        if (row && t) syncSaveLocal(row, t);
      }
      return;
    }
    const save = target.closest("[data-save]");
    if (save instanceof HTMLElement && t && row) {
      e.stopPropagation();
      e.preventDefault();
      const rootInp = qs<HTMLInputElement>("#settool-root", row);
      const skillsInp = qs<HTMLInputElement>("#settool-skills", row);
      const mcpInp = qs<HTMLInputElement>("#settool-mcp", row);
      save.classList.add("is-loading");
      const body: Record<string, unknown> = {
        skills_dir: skillsInp?.value.trim() ?? "",
        mcp_config: mcpInp?.value.trim() ?? "",
      };
      if (rootInp && !rootInp.disabled) body["root"] = rootInp.value.trim();
      if (PANEL.draft && PANEL.draft.enabled !== t.enabled) body["enabled"] = PANEL.draft.enabled;
      const r = await send<{ ok: boolean; error?: string; tool?: ToolPublic }>(
        `/api/tools/${encodeURIComponent(t.id)}`,
        "PATCH",
        body,
      );
      save.classList.remove("is-loading");
      if (!r.data.ok) {
        HubUI.toast(`保存失败：${r.data.error ?? ""}`, "error");
        return;
      }
      HubUI.toast("已保存", "success");
      closeRows();
      await appActions().loadState();
      const fresh = allTools().find((x) => x.id === t.id) ?? r.data.tool ?? t;
      syncToolRow(row, fresh);
      ToolsCache = ToolsCache.map((x) => (x.id === t.id ? { ...x, ...fresh } : x));
      return;
    }
    if (
      row &&
      target.closest(".trow__line") &&
      !target.closest("[data-stop], .trow__grip, [data-mv]") &&
      t
    )
      openRow(row, t);
  }

  for (const evt of ["input", "keyup", "change"]) {
    box.addEventListener(evt, (e) => {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        /settool-(root|skills|mcp)/u.test(t.id || "") &&
        PANEL.row &&
        PANEL.tool
      )
        syncSaveLocal(PANEL.row, PANEL.tool);
    });
  }
}

function bindToolToggle(box: HTMLElement): void {
  const patchTool = (tid: string, on: boolean) =>
    send<{ ok: boolean; error?: string }>(`/api/tools/${encodeURIComponent(tid)}`, "PATCH", {
      enabled: on,
    });
  const syncAll = (): void => {
    const all = qs<HTMLElement>("#set-tool-all", box);
    if (!all) return;
    const toggles = qsa<HTMLElement>(".set-toggle[data-tid]", box);
    all.classList.toggle(
      "is-on",
      toggles.length > 0 && toggles.every((b) => b.classList.contains("is-on")),
    );
  };
  for (const btn of qsa<HTMLButtonElement>(".set-toggle[data-tid]", box)) {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const tid = btn.dataset["tid"] ?? "";
      const on = !btn.classList.contains("is-on");
      flipToggle(btn, on);
      syncAll();
      const r = await patchTool(tid, on);
      if (r.data.ok) {
        toastOnce(`tool-${tid}`, `工具已${on ? "启用" : "禁用"}`, "success");
        void appActions().loadState();
      } else {
        flipToggle(btn, !on);
        syncAll();
        HubUI.toast(`操作失败：${r.data.error ?? ""}`, "error");
      }
    };
  }
  const all = qs<HTMLButtonElement>("#set-tool-all", box);
  if (all) {
    all.onclick = async () => {
      const on = !all.classList.contains("is-on");
      flipToggle(all, on);
      const targets = qsa<HTMLButtonElement>(".set-toggle[data-tid]", box).filter(
        (b) => b.classList.contains("is-on") !== on,
      );
      targets.forEach((b, i) => {
        setTimeout(() => flipToggle(b, on), i * 40);
      });
      const rs = await Promise.all(targets.map((b) => patchTool(b.dataset["tid"] ?? "", on)));
      const bad = rs.filter((r) => !r.data.ok).length;
      if (bad > 0) {
        HubUI.toast(`${bad} 个工具切换失败`, "error");
        await renderTools();
        return;
      }
      toastOnce(
        "tool-all",
        on ? `已全部启用（${targets.length}）` : `已全部停用（${targets.length}）`,
        "success",
      );
      void appActions().loadState();
    };
  }
}

function bindReorder(box: HTMLElement): void {
  const list = qs<HTMLElement>("#set-tool-list", box);
  if (!list) return;
  const rows = (): HTMLElement[] => qsa<HTMLElement>(".trow", list);
  const renumber = (): void => {
    rows().forEach((r, i) => {
      const n = qs<HTMLElement>(".trow__n", r);
      if (n) n.textContent = String(i + 1);
    });
  };
  const syncArrows = (): void => {
    const all = rows();
    all.forEach((r, i) => {
      const up = qs<HTMLButtonElement>('[data-mv="up"]', r);
      const down = qs<HTMLButtonElement>('[data-mv="down"]', r);
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === all.length - 1;
    });
  };
  const persist = async (): Promise<void> => {
    const ids = rows().map((row) => row.dataset["tid"] ?? "");
    const r = await post<{ ok: boolean; error?: string }>("/api/tools/reorder", { ids });
    if (!r.data.ok) {
      HubUI.toast(`排序保存失败：${r.data.error ?? ""}`, "error");
      return;
    }
    await appActions().loadState();
  };
  for (const grip of qsa<HTMLElement>(".trow__grip", list)) {
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rowEl = grip.closest(".trow");
      if (!(rowEl instanceof HTMLElement)) return;
      const row = rowEl;
      if (row.classList.contains("is-open")) return;
      e.preventDefault();
      const startY = e.clientY;
      let moved = false;
      row.classList.add("is-drag");
      const onMove = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientY - startY) < 4) return;
        moved = true;
        const all = rows();
        const target = all.find((r) => {
          const b = r.getBoundingClientRect();
          return ev.clientY >= b.top && ev.clientY <= b.bottom;
        });
        if (!target || target === row) return;
        const from = all.indexOf(row);
        const to = all.indexOf(target);
        for (const r of all) {
          r.classList.remove("is-over");
          delete r.dataset["line"];
        }
        target.classList.add("is-over");
        target.dataset["line"] = to > from ? "bottom" : "top";
        if (to > from) target.after(row);
        else target.before(row);
        renumber();
        syncArrows();
      };
      const onUp = async (): Promise<void> => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        row.classList.remove("is-drag");
        for (const r of rows()) {
          r.classList.remove("is-over");
          delete r.dataset["line"];
        }
        if (moved) await persist();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", () => void onUp());
    });
  }
  for (const btn of qsa<HTMLButtonElement>("[data-mv]", list)) {
    btn.onclick = async () => {
      const rowEl = btn.closest(".trow");
      if (!(rowEl instanceof HTMLElement)) return;
      const all = rows();
      const i = all.indexOf(rowEl);
      const to = btn.dataset["mv"] === "up" ? i - 1 : i + 1;
      if (i < 0 || to < 0 || to >= all.length) return;
      const targetRow = all[to];
      if (!targetRow) return;
      if (to < i) targetRow.before(rowEl);
      else targetRow.after(rowEl);
      renumber();
      syncArrows();
      await persist();
    };
  }
}

function syncToolRow(row: HTMLElement, t: ToolPublic): void {
  const chip = qs<HTMLElement>(".trow__chip", row);
  if (chip) {
    chip.className = `trow__chip ${toolColorCls(t)}`;
    chip.textContent = toolShort(t);
  }
  const nm = qs<HTMLElement>(".trow__name", row);
  if (nm) nm.textContent = t.name;
  const sw = qs<HTMLElement>(".set-toggle[data-tid]", row);
  if (sw) sw.classList.toggle("is-on", t.enabled);
  row.classList.toggle("is-off", !t.enabled);
}

function removeToolRow(box: HTMLElement, tid: string): void {
  const row = qs<HTMLElement>(`.trow[data-tid="${CSS.escape(tid)}"]`, box);
  if (!row) return;
  row.classList.add("is-removing");
  setTimeout(() => {
    row.remove();
    const rows = qsa<HTMLElement>(".trow", box);
    rows.forEach((r, i) => {
      const n = qs<HTMLElement>(".trow__n", r);
      if (n) n.textContent = String(i + 1);
      const up = qs<HTMLButtonElement>('[data-mv="up"]', r);
      const down = qs<HTMLButtonElement>('[data-mv="down"]', r);
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === rows.length - 1;
    });
    const all = qs<HTMLElement>("#set-tool-all", box);
    if (all) {
      all.classList.toggle(
        "is-on",
        rows.length > 0 &&
          rows.every((r) =>
            qs<HTMLElement>(".set-toggle[data-tid]", r)?.classList.contains("is-on"),
          ),
      );
    }
  }, 180);
}

/* ==================== 远程仓库 ==================== */

const REPO_MODULES: Record<string, string> = { skills: "Skills", mcp: "MCP" };

async function renderRemotes(): Promise<void> {
  const box = pane("remotes");
  if (!box) return;
  box.innerHTML = '<div class="hub-empty">加载中…</div>';
  const r = await api<{ ok: boolean; repos?: RemoteRepo[]; error?: string }>("/api/remote-repos");
  if (!r.data?.ok) {
    box.innerHTML =
      '<div class="hub-empty">读取远程仓库失败<div class="hub-empty__hint">' +
      esc(r.data?.error ?? "稍后重试") +
      "</div></div>";
    return;
  }
  const repos = r.data.repos ?? [];
  box.innerHTML = `
      <div class="setpane__toph">
        <p class="setpane__hint">远程 Git 仓库由模块共用：勾选 Skills / MCP 后，仓库会出现在对应模块的
          「远程仓库」分组；在模块里新增或编辑仓库，也会同步到这里。</p>
        <button class="hub-btn hub-btn--primary" id="remote-repo-add" data-testid="remote-repo-add">＋ 新建仓库</button>
      </div>
      ${
        repos.length > 0
          ? `<div class="setcard--list">${repos.map(repoRowHtml).join("")}</div>`
          : `
        <div class="hub-empty">还没有远程仓库<div class="hub-empty__hint">点「新建仓库」添加，或在 Skills / MCP 里添加后自动同步到这里</div></div>`
      }`;
  const add = qs<HTMLElement>("#remote-repo-add", box);
  if (add) add.onclick = () => repoDialog(null);
  for (const btn of qsa<HTMLElement>("[data-repo-edit]", box)) {
    btn.onclick = (e) => {
      e.stopPropagation();
      const repo = repos.find((x) => String(x.id) === btn.dataset["repoEdit"]);
      if (repo) repoDialog(repo);
    };
  }
}

function repoRowHtml(repo: RemoteRepo): string {
  const chips =
    (repo.modules ?? [])
      .map((m) => `<span class="hub-badge hub-badge--neutral">${esc(REPO_MODULES[m] ?? m)}</span>`)
      .join("") || '<span class="hub-badge">未关联模块</span>';
  const desc = [repo.url, repo.branch || "main", repo.subdir ? `子目录 ${repo.subdir}` : ""]
    .filter(Boolean)
    .join(" · ");
  return `
      <div class="setrow" data-testid="remote-repo-${repo.id}">
        <div class="setrow__txt">
          <div class="setrow__name">${esc(repo.name)}</div>
          <div class="setrow__desc" title="${esc(desc)}">${esc(desc)}</div>
        </div>
        <span class="setrow__chips">${chips}</span>
        <button class="hub-btn btn-sm" data-repo-edit="${repo.id}"
                data-testid="remote-repo-edit-${repo.id}">编辑</button>
      </div>`;
}

function repoDialog(repo: RemoteRepo | null): void {
  const isNew = repo === null;
  const mods = new Set<string>(repo?.modules ?? ["skills"]);
  HubUI.modal({
    title: isNew ? "新建远程仓库" : `编辑远程仓库 · ${repo.name}`,
    confirmText: isNew ? "创建" : "保存",
    bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="repo-name" data-testid="repo-name"
                 value="${esc(repo?.name ?? "")}" placeholder="my-skills"></label>
          <label>仓库地址<input class="hub-input mono" id="repo-url" data-testid="repo-url"
                 value="${esc(repo?.url ?? "")}" placeholder="https://github.com/org/repo.git"></label>
          <label>分支<input class="hub-input" id="repo-branch"
                 value="${esc(repo?.branch ?? "main")}"></label>
          <label>子目录（可选）<input class="hub-input" id="repo-subdir"
                 value="${esc(repo?.subdir ?? "")}" placeholder="skills/"></label>
          <label>凭据引用（可选）<input class="hub-input" id="repo-auth"
                 value="${esc(repo?.auth_ref ?? "")}"
                 placeholder="env:GITHUB_TOKEN 或 file:~/.secrets/token"></label>
          <label>定时拉取（分钟，0=关闭）<input class="hub-input" id="repo-poll"
                 value="${repo?.poll_min ?? 0}" inputmode="numeric"></label>
        </div>
        <div class="modpick">
          <div class="modpick__l">应用到模块</div>
          <label class="modpick__it"><input type="checkbox" id="repo-mod-skills"
                 data-testid="repo-mod-skills" ${mods.has("skills") ? "checked" : ""}> Skills</label>
          <label class="modpick__it"><input type="checkbox" id="repo-mod-mcp"
                 data-testid="repo-mod-mcp" ${mods.has("mcp") ? "checked" : ""}> MCP</label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">勾选后仓库会显示在对应模块的
          「远程仓库」分组；取消勾选会从该模块移除（已拉取的本地副本转为手动条目，不删已分发文件）。</div>`,
    onConfirm: (_value, close) => {
      const modules: string[] = [];
      const sk = byId<HTMLInputElement>("repo-mod-skills");
      const mc = byId<HTMLInputElement>("repo-mod-mcp");
      if (sk?.checked) modules.push("skills");
      if (mc?.checked) modules.push("mcp");
      if (modules.length === 0) {
        HubUI.toast("至少勾选一个模块（Skills / MCP）", "warn");
        return false;
      }
      const val = (id: string): string => byId<HTMLInputElement>(id)?.value.trim() ?? "";
      const pollRaw = Number.parseInt(val("repo-poll"), 10);
      const body = {
        name: val("repo-name"),
        url: val("repo-url"),
        branch: val("repo-branch") || "main",
        subdir: val("repo-subdir"),
        auth_ref: val("repo-auth") || null,
        poll_min: Math.max(0, Number.isNaN(pollRaw) ? 0 : pollRaw),
        modules,
      };
      if (!(body.name && body.url)) {
        HubUI.toast("名称与仓库地址必填", "warn");
        return false;
      }
      const btn = document.querySelector<HTMLElement>(".hub-overlay.is-in .hub-modal__ok");
      btn?.classList.add("is-loading");
      void (async () => {
        const res = isNew
          ? await post<{ ok: boolean; error?: string }>("/api/remote-repos", body)
          : await send<{ ok: boolean; error?: string }>(
              `/api/remote-repos/${repo.id}`,
              "PATCH",
              body,
            );
        btn?.classList.remove("is-loading");
        if (!res.data.ok) {
          HubUI.toast(`${isNew ? "创建" : "保存"}失败：${res.data.error ?? ""}`, "error");
          return;
        }
        HubUI.toast(isNew ? "已创建远程仓库" : "已保存远程仓库", "success");
        close();
        await renderRemotes();
      })();
      return false;
    },
  });
}

/* ==================== 关于 ==================== */

/* ==================== 桌面（Tauri 壳） ==================== */

const DESKTOP_ROWS: Array<{
  key: keyof DesktopSettings;
  name: string;
  desc: string;
}> = [
  {
    key: "launch_at_login",
    name: "开机启动",
    desc: "登录 macOS 后自动启动 Agent Depot（静默启动开启时只挂菜单栏）",
  },
  {
    key: "menu_bar",
    name: "菜单栏挂载",
    desc: "在菜单栏显示图标；关闭主窗口时隐藏而不是退出，点图标可再打开",
  },
  {
    key: "silent_start",
    name: "静默启动",
    desc: "启动后不弹主窗口，直接挂到菜单栏（需先开启菜单栏挂载）",
  },
  {
    key: "show_dock_icon",
    name: "显示 Dock 图标",
    desc: "窗口打开时始终显示；关闭主窗口后从 Dock 移除（需开启菜单栏挂载，点菜单栏图标恢复）",
  },
];

let DesktopBusy = false;

function desktopNote(): string {
  return '<div class="setrow"><div class="setrow__txt"><div class="setrow__desc">这些开关只在桌面客户端（Tauri 壳）内生效；浏览器打开时不可用。</div></div></div>';
}

async function renderDesktop(): Promise<void> {
  const box = pane("desktop");
  if (!box) return;
  if (!desktopAvailable()) {
    box.innerHTML = `<p class="setpane__hint">桌面客户端专属设置</p><div class="setcard--list">${desktopNote()}</div>`;
    return;
  }
  let current: DesktopSettings | null = null;
  let prof: DesktopProfile | null = null;
  try {
    const [settings, profile] = await Promise.all([getDesktopSettings(), getDesktopProfile()]);
    current = settings;
    prof = profile;
  } catch (e) {
    box.innerHTML = `<p class="setpane__hint">读取桌面设置失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
    return;
  }
  if (!current) {
    box.innerHTML = `<p class="setpane__hint">桌面客户端专属设置</p><div class="setcard--list">${desktopNote()}</div>`;
    return;
  }
  const s = current;
  const profileText = prof === "dev" ? "开发版" : prof === "release" ? "正式版" : "桌面客户端";
  const isolated = prof ? `（与${prof === "dev" ? "正式版" : "开发版"}互不共享）` : "";
  box.innerHTML = `
      <p class="setpane__hint">当前为 <b>${profileText}</b> 设置${isolated}。菜单栏与 Dock 行为立即生效；「静默启动」在下一次启动时生效。</p>
      <div class="setcard--list">${DESKTOP_ROWS.map((row) => {
        const on = s[row.key];
        const blocked = row.key === "silent_start" && !s.menu_bar;
        return `
        <div class="setrow" data-testid="settings-desktop-${row.key}">
          <div class="setrow__txt">
            <div class="setrow__name">${esc(row.name)}</div>
            <div class="setrow__desc">${esc(row.desc)}</div>
          </div>
          <button class="set-toggle ${on ? "is-on" : ""}" data-key="${row.key}"
                  data-testid="settings-desktop-toggle-${row.key}"
                  role="switch" aria-checked="${on ? "true" : "false"}"
                  aria-label="${esc(row.name)} ${on ? "已开启" : "已关闭"}"
                  ${blocked ? "disabled" : ""}>
            <span class="set-toggle__knob"></span>
          </button>
        </div>`;
      }).join("")}</div>
      <p class="setpane__hint" style="margin-top:var(--sp-3)">开机启动会写入 <span class="mono-xs">~/Library/LaunchAgents/${AUTOSTART_LABEL}.plist</span>。</p>`;

  for (const btn of qsa<HTMLButtonElement>(".set-toggle[data-key]", box)) {
    btn.onclick = async () => {
      if (DesktopBusy) return;
      const key = btn.dataset["key"] as keyof DesktopSettings;
      const next: DesktopSettings = { ...s, [key]: !s[key] };
      if (key === "menu_bar" && !next.menu_bar) next.silent_start = false;
      DesktopBusy = true;
      btn.classList.add("is-loading");
      flipToggle(btn, next[key]);
      try {
        await setDesktopSettings(next);
        await renderDesktop(); // 后端可能归一化（关菜单栏会连带关静默启动）
        toastOnce("settings-desktop", "桌面设置已保存", "success");
      } catch (e) {
        flipToggle(btn, s[key]);
        HubUI.toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        DesktopBusy = false;
        btn.classList.remove("is-loading");
      }
    };
  }
}

const AUTOSTART_LABEL = "local.planarcat.agent-depot";

function renderEnv(): void {
  const box = pane("env");
  if (!box) return;
  const eng = state.engine ?? { casr: false, agentmemory: false };
  const rows: [string, string][] = [
    ["引擎 casr", eng.casr ? "已安装（跨工具迁移可用）" : "未安装（迁移降级为只读浏览）"],
    ["记忆总线 agentmemory", eng.agentmemory ? "运行中" : "未运行"],
    ["数据目录", "~/.agent/hub/（环境变量 AGENT_HUB_DIR 可覆盖）"],
    ["服务端口", `${location.port || "80"}（环境变量 HUB_PORT，重启生效）`],
    ["隐私", "仅本地 · 无云端上传"],
    ["版本", `Agent Depot ${state.version}`],
  ];
  box.innerHTML = `
      <div class="setcard--list">${rows
        .map(
          ([k, v]) =>
            `<div class="setkv"><span class="setkv__k">${esc(k)}</span><span class="setkv__v">${esc(v)}</span></div>`,
        )
        .join("")}</div>`;
}

/* 锚点导航绑定（index.html 静态存在） */
for (const b of qsa<HTMLElement>(".setwin__item")) {
  b.onclick = () => switchPane(b.dataset["pane"] ?? "modules");
}
const closeBtn = byId<HTMLElement>("settings-close");
if (closeBtn) closeBtn.onclick = () => void closeSettings();
const overlay = byId<HTMLElement>("settings-overlay");
if (overlay) {
  overlay.addEventListener("click", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t.id === "settings-overlay") void closeSettings();
  });
}

export const SettingsCenter = { open: openSettings, close: closeSettings, refresh: render };
