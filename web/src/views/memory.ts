/* 记忆视图（v1.0 · 对齐 Figma ModuleView）
   顶部：记忆来源卡片（各工具 + 「笔记 · 本地」）+ 批量「全部扫描」+ 统计条
   主体：来源侧栏 ｜ 条目列表（两行 + 胶囊 + 行内展开：编辑/复制/认领）｜ 写入去向面板
   口径：读取 → hub 中间体 → 写入；中间体是权威源，工具端改动标记漂移 */

import { appActions } from "../core/actions.ts";
import { api, post, send } from "../core/api.ts";
import { copyText, qs, qsa } from "../core/dom.ts";
import { esc, fmtTime } from "../core/format.ts";
import type { PickerOptions } from "../core/mv.ts";
import { MV } from "../core/mv.ts";
import { getPrefs } from "../core/prefs.ts";
import { allTools, toolColorCls } from "../core/tools.ts";
import type { MemoryItem, MemoryOverview, MemoryTool } from "../core/types/api.ts";
import { HubUI } from "../hub-ui.ts";

interface MemoryState {
  tools: MemoryTool[];
  items: MemoryItem[];
  memstore: string;
  selTool: string | null;
  expandedId: string | null;
  detail: MemoryItem | null;
  selected: Set<number>;
  q: string;
  loadedAt: number;
  firstScanDone: boolean;
  _layout?: "detail" | "compact";
  _fullH?: number;
}

interface Source {
  id: string;
  name: string;
  short: string;
  cls: string;
  off?: boolean;
  title?: string;
  count?: number;
}

interface ScanResult {
  tool: string;
  name?: string;
  imported?: number;
  drifted?: number;
  degraded?: boolean;
  error?: string | null;
}

interface ScanResponse {
  ok: boolean;
  results?: ScanResult[];
  error?: string;
}

interface DistributeResult {
  item_id: number;
  item?: string;
  status: "ok" | "skipped" | "conflict" | "failed";
  reason?: string;
}

interface DistributeResponse {
  ok: boolean;
  results?: DistributeResult[];
  error?: string;
}

const M: MemoryState = {
  tools: [],
  items: [],
  memstore: "",
  selTool: null,
  expandedId: null,
  detail: null,
  selected: new Set(),
  q: "",
  loadedAt: 0,
  firstScanDone: false,
};

const NOTES_ID = "notes";

function notesSource(): Source {
  return {
    id: NOTES_ID,
    name: "笔记 · 本地",
    short: "NB",
    cls: "chip--accent",
    title: "hub 本地笔记（hub.db + 每日 Markdown）",
  };
}

const chipCls = (tid: string): string => MV.cls(tid);
const shortOf = (tid: string): string => MV.short(tid);

function nameOf(tid: string): string {
  if (tid === NOTES_ID) return "笔记 · 本地";
  const t = M.tools.find((x) => x.id === tid) ?? allTools().find((x) => x.id === tid);
  return t?.name ?? tid;
}

const kindLabel = (it: MemoryItem): string => it.kind_label ?? it.kind;

/**
 * 作用域标签：全局 → 「全局」；项目 → 项目名。
 * 项目作用域可能是路径，也可能是工具目录 slug（-Users-...--p2-hash）→ 切段取末段。
 */
function scopeLabel(it: MemoryItem): string {
  const raw = String(it.scope ?? "");
  if (!raw || raw === "global") return "全局";
  if (raw.includes("/")) return raw.replace(/\/+$/u, "").split("/").filter(Boolean).pop() ?? raw;
  const segs = raw
    .split("--")
    .map((x) => x.replace(/^-+|-+$/gu, ""))
    .filter(Boolean)
    .filter((x) => !(/^p\d+-[0-9a-f]{6,}$/iu.test(x) || /^[0-9a-f]{8,}$/iu.test(x)));
  return (segs.pop() ?? raw).replace(/^[0-9a-f]{8,}$/iu, "") || raw;
}

const itemLabel = (it: MemoryItem): string => `${kindLabel(it)} · ${scopeLabel(it)}`;
const tilde = (p: string | null): string => String(p ?? "").replace(/^\/Users\/[^/]+/u, "~");

async function loadOverview(force: boolean): Promise<void> {
  if (!force && Date.now() - M.loadedAt < 30_000 && M.tools.length > 0) return;
  const r = await api<MemoryOverview>("/api/memory/overview");
  if (r.data?.ok) {
    M.tools = r.data.tools ?? [];
    M.items = r.data.items ?? [];
    M.memstore = r.data.memstore ?? "";
    M.loadedAt = Date.now();
  }
}

async function scanAll(btn: HTMLElement | null, root: HTMLElement): Promise<void> {
  btn?.classList.add("is-loading");
  const toastEl = HubUI.toast("正在扫描各工具记忆…", "info", 30_000);
  try {
    const r = await post<ScanResponse>("/api/memory/scan", {});
    toastEl.remove();
    if (r.data.ok) {
      const rs = r.data.results ?? [];
      const imp = rs.reduce((a, x) => a + (x.imported ?? 0), 0);
      const drf = rs.reduce((a, x) => a + (x.drifted ?? 0), 0);
      const deg = rs.filter((x) => x.degraded);
      HubUI.toast(
        `扫描完成：新增 ${imp} · 漂移 ${drf}` +
          (deg.length ? ` · ${deg.length} 个工具超时降级（点其 ⟳ 手动刷新）` : ""),
        deg.length ? "warn" : "success",
      );
    } else HubUI.toast(`扫描失败：${r.data.error ?? ""}`, "error");
  } catch {
    toastEl.remove();
  }
  M.loadedAt = 0;
  await refresh(root);
}

async function scanOne(tid: string, btn: HTMLElement, root: HTMLElement): Promise<void> {
  btn.classList.add("is-loading");
  const r = await post<ScanResponse>("/api/memory/scan", { tool: tid });
  btn.classList.remove("is-loading");
  if (r.data.ok) {
    const x: ScanResult = (r.data.results ?? [])[0] ?? { tool: tid };
    HubUI.toast(
      `${x.name ?? tid}：新增 ${x.imported ?? 0} · 漂移 ${x.drifted ?? 0}` +
        (x.degraded ? "（超时降级，数据可能不完整）" : ""),
      x.error ? "error" : x.drifted ? "warn" : "success",
    );
  } else HubUI.toast(`扫描失败：${r.data.error ?? ""}`, "error");
  M.loadedAt = 0;
  await refresh(root);
}

async function render(root: HTMLElement | null): Promise<void> {
  if (!root) return;
  await refresh(root);
}

async function refresh(root: HTMLElement): Promise<void> {
  await loadOverview(false);
  if (
    getPrefs().autoScanMemory &&
    !M.firstScanDone &&
    M.tools.length > 0 &&
    M.tools.every((t) => !t.scanned)
  ) {
    M.firstScanDone = true;
    root.innerHTML = '<div class="hub-empty">首次进入，正在自动扫描各工具记忆…</div>';
    await scanAll(null, root);
    await loadOverview(true);
  }
  renderAll(root);
}

function sources(): Source[] {
  return [
    ...M.tools.map((t) => ({
      id: t.id,
      name: t.name,
      short: shortOf(t.id),
      cls: chipCls(t.id),
      off: !t.readable,
      title:
        t.error ??
        `${t.name} · ${t.readable ? "可读" : t.has_layout ? "不可读（未找到记忆文件）" : "未探测到记忆路径"}` +
          (t.degraded ? " · 上次扫描超时，点 ⟳ 手动刷新" : ""),
    })),
    notesSource(),
  ];
}

function itemCounts(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const it of M.items) c[it.source_tool] = (c[it.source_tool] ?? 0) + 1;
  return c;
}

function visibleItems(): MemoryItem[] {
  if (M.selTool === NOTES_ID) return [];
  let list = M.items;
  if (M.selTool) list = list.filter((it) => it.source_tool === M.selTool);
  if (M.q) {
    const q = M.q.toLowerCase();
    list = list.filter(
      (it) =>
        itemLabel(it).toLowerCase().includes(q) ||
        String(it.source_path ?? "")
          .toLowerCase()
          .includes(q),
    );
  }
  return list;
}

/** 条目行展开/收起：就地切类名 + 按需填入详情体。 */
function toggleItemRow(root: HTMLElement, row: HTMLElement): void {
  const id = row.dataset["id"] ?? "";
  const openRow = qs<HTMLElement>("#mv-rows .mvi.is-open", root);
  const wasOpen = row.classList.contains("is-open");
  if (openRow && openRow !== row) {
    openRow.classList.remove("is-open");
    const b = qs<HTMLElement>(".mvi__accin", openRow);
    if (b) b.innerHTML = "";
  }
  const cb = qs<HTMLInputElement>(".mvi__chk", row);
  if (wasOpen) {
    row.classList.remove("is-open");
    M.expandedId = null;
    M.selected.delete(Number(id));
    if (cb) cb.checked = false;
    row.classList.remove("is-sel");
    renderPanel(root);
    return;
  }
  const it = M.items.find((x) => String(x.id) === id);
  const box = qs<HTMLElement>(".mvi__accin", row);
  if (box && it && !box.innerHTML.trim()) box.innerHTML = detailBody(it);
  row.classList.add("is-open");
  M.expandedId = id;
  M.selected.add(Number(id));
  if (cb) cb.checked = true;
  row.classList.add("is-sel");
  renderPanel(root);
  if (!M.detail || String(M.detail.id) !== String(it ? it.id : id)) {
    void loadDetail(root, it ? String(it.id) : id);
  }
}

function buildStats(): { n: number; label: string; tone?: "warn" }[] {
  const deployed = M.items.filter((it) => (it.deployments ?? []).length > 0).length;
  return [
    { n: M.items.length, label: "条目 · 全部来源" },
    { n: M.tools.length, label: "来源工具" },
    { n: deployed, label: "已写回" },
    {
      n: M.items.length - deployed,
      label: "未写回",
      ...(M.items.length - deployed ? { tone: "warn" as const } : {}),
    },
  ];
}

function renderAll(root: HTMLElement): void {
  const srcs = sources();
  const list = visibleItems();
  const stats = buildStats();
  const topHtml = MV.top({
    prefix: "mv",
    label: "记忆来源",
    sources: srcs,
    counts: itemCounts(),
    activeId: M.selTool,
    groups: [
      {
        kind: "local",
        label: "本地",
        desc: "hub 内可编辑（笔记 = hub.db + 每日 Markdown）",
        ids: [NOTES_ID],
        actions: [],
      },
      {
        kind: "tool",
        label: "工具",
        desc: "读取各工具记忆文件 → hub 中间体，工具端改动标记漂移",
        ids: M.tools.map((t) => t.id),
        actions: ["全部扫描"],
      },
    ],
    bulk: `<button class="hub-btn btn-sm" data-testid="memv-scan-all"><span class="btn-ic">${MV.ic("refresh")}</span>全部扫描</button>`,
    stats: stats
      .filter((s) => s.tone !== undefined || true)
      .map((s) => ({ n: s.n, label: s.label, ...(s.tone ? { tone: s.tone } : {}) })),
    hint: "读取 → hub 中间体 → 写入；中间体是权威源，工具端改动会标记漂移。项目级记忆只写回其来源工具。",
  });
  root.innerHTML = MV.shell({
    prefix: "mv",
    top: topHtml,
    title: M.selTool
      ? M.selTool === NOTES_ID
        ? "笔记 · 本地"
        : `${nameOf(M.selTool)} · 记忆条目`
      : "全部记忆条目",
    q: M.q,
    placeholder: "搜索条目 / 路径…",
  });

  HubUI.drawFrames(root);
  MV.growIn(root);
  MV.bindGroups(root);
  MV.swap(root, M.selTool ?? "all");
  for (const row of qsa<HTMLElement>("#mv-rows .mvi", root)) {
    const head = qs<HTMLElement>(".mvi__head", row);
    if (head) {
      head.onclick = (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest("input, button.mvi__chev")) return;
        toggleItemRow(root, row);
      };
    }
    const chev = qs<HTMLElement>(".mvi__chev", row);
    if (chev)
      chev.onclick = (e) => {
        e.stopPropagation();
        toggleItemRow(root, row);
      };
  }

  const scanAllBtn = qs<HTMLElement>('[data-testid="memv-scan-all"]', root);
  if (scanAllBtn) scanAllBtn.onclick = (e) => void scanAll(e.currentTarget as HTMLElement, root);
  for (const b of qsa<HTMLElement>("[data-gact]", root)) {
    b.onclick = (e) => {
      e.stopPropagation();
      if ((b.dataset["gact"] ?? "").split(":")[1] === "全部扫描") void scanAll(b, root);
    };
  }

  // 可折叠头部：详细 = 分组卡片 ↔ 简略 = 64px chip 条
  const topBox = qs<HTMLElement>("#mv-top", root);
  let hdr = qs<HTMLElement>("#mv-hdr", root);
  if (!hdr) {
    hdr = document.createElement("div");
    hdr.id = "mv-hdr";
    hdr.className = "hdr";
    if (topBox?.parentElement) {
      topBox.parentElement.insertBefore(hdr, topBox);
      hdr.appendChild(topBox);
    }
    const bar = document.createElement("div");
    bar.id = "mv-bar";
    bar.className = "cbar-host";
    hdr.appendChild(bar);
  }
  const barHost = qs<HTMLElement>("#mv-bar", hdr);
  if (barHost) {
    barHost.innerHTML = MV.chipBar({
      prefix: "mv",
      items: srcs,
      activeId: M.selTool,
      groups: [
        { kind: "local", label: "本地", ids: [NOTES_ID], actions: [] },
        { kind: "tool", label: "工具", ids: M.tools.map((t) => t.id), actions: ["全部扫描"] },
      ],
    });
    for (const b of qsa<HTMLElement>(".cbar__it", barHost)) {
      b.onclick = () => pick(root, b.dataset["src"] ?? "", false);
    }
    HubUI.drawFrames(barHost);
    const back = qs<HTMLElement>("#mv-barback", barHost);
    if (back) {
      back.title = "切换到详细布局";
      back.setAttribute("aria-label", "切换到详细布局");
      back.onclick = () => {
        M._layout = "detail";
        applyLayout(root, true);
      };
    }
  }
  if (topBox) {
    for (const c of qsa<HTMLElement>(".tcard[data-src]", topBox)) {
      c.onclick = (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest('[data-testid="memv-scan-all"]')) return;
        pick(root, c.dataset["src"] ?? "", true);
      };
    }
  }
  const side = qs<HTMLElement>("#mv-side", root);
  if (side) {
    side.hidden = true;
    side.innerHTML = "";
  }

  applyLayout(root, false);
  syncSelection(root);

  if (M.selTool === NOTES_ID) {
    renderNotes(root);
    return;
  }
  renderRows(root, list, stats);

  const q = qs<HTMLInputElement>("#mv-q", root);
  if (q) {
    let t: number | null = null;
    q.oninput = (e) => {
      if (t !== null) clearTimeout(t);
      const v = e.target instanceof HTMLInputElement ? e.target.value : "";
      t = window.setTimeout(() => {
        M.q = v.trim();
        renderAll(root);
      }, 300);
    };
  }
}

function renderRows(
  root: HTMLElement,
  list: MemoryItem[],
  _stats: { n: number; label: string }[],
): void {
  const box = qs<HTMLElement>("#mv-rows", root);
  if (!box) return;
  box.setAttribute("data-testid", "memv-list");
  box.innerHTML =
    list.length > 0
      ? list
          .map((it) =>
            MV.item({
              id: it.id,
              testid: "memv-row",
              chkTestid: "memv-check",
              sel: M.selected.has(it.id),
              open: M.expandedId === String(it.id),
              chipText: shortOf(it.source_tool),
              chipCls: chipCls(it.source_tool),
              title: itemLabel(it),
              sub: `${nameOf(it.source_tool)} · ${it.name ?? ""}`,
              extra:
                '<span class="mvi-acts">' +
                `<button class="hub-btn btn-sm" data-act="edit" data-testid="memv-row-edit">编辑</button>` +
                `<button class="hub-btn btn-sm" data-act="copy" data-testid="memv-row-copy">复制</button>` +
                `<button class="hub-btn btn-sm hub-btn--danger" data-act="del" data-testid="memv-row-del"` +
                ' title="删除 hub 中间体（不动源文件）">删除</button>' +
                "</span>",
              body: M.expandedId === String(it.id) ? detailBody(it) : "",
            }),
          )
          .join("")
      : `<div class="hub-empty">没有记忆条目<div class="hub-empty__hint">点「全部扫描」采集各工具记忆</div></div>`;

  for (const row of qsa<HTMLElement>(".mvi", box)) {
    const id = Number(row.dataset["id"]);
    const chk = qs<HTMLInputElement>(".mvi__chk", row);
    if (chk) {
      chk.onclick = (e) => {
        e.stopPropagation();
        const checked = e.target instanceof HTMLInputElement && e.target.checked;
        if (checked) M.selected.add(id);
        else M.selected.delete(id);
        row.classList.toggle("is-sel", checked);
        renderPanel(root, list);
      };
    }
    for (const b of qsa<HTMLElement>(".mvi-acts [data-act]", row)) {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset["act"];
        if (act === "del") {
          const it = M.items.find((x) => String(x.id) === String(id));
          HubUI.confirm(
            "删除记忆中间体",
            `确认删除「${esc(it ? itemLabel(it) : String(id))}」？<br>仅删除 hub 中间体与写回记录，工具侧源文件不动。`,
            async () => {
              const r = await send<{ ok: boolean; error?: string }>(
                `/api/memory/item/${encodeURIComponent(String(id))}`,
                "DELETE",
              );
              if (r.data.ok) {
                HubUI.toast("已删除", "success");
                M.selected.delete(id);
                M.expandedId = null;
                M.detail = null;
                await loadOverview(true);
                renderAll(root);
              } else HubUI.toast(`删除失败：${r.data.error ?? ""}`, "error");
            },
            { confirmText: "删除", danger: true },
          );
          return;
        }
        if (!row.classList.contains("is-open")) await toggle(root, String(id));
        const sel2 = act === "edit" ? '[data-testid="memv-edit"]' : '[data-testid="memv-copy"]';
        const target = document.querySelector<HTMLElement>(`#mv-rows ${sel2}`);
        if (target) target.click();
      };
    }
    const chev = qs<HTMLElement>(".mvi__chev", row);
    if (chev)
      chev.onclick = (e) => {
        e.stopPropagation();
        void toggle(root, String(id));
      };
    const head = qs<HTMLElement>(".mvi__head", row);
    if (head) head.onclick = () => void toggle(root, String(id));
  }
  bindDetail(root);
  const info = qs<HTMLElement>("#mv-info", root);
  if (info) {
    info.textContent = `已选 ${M.selected.size} · 显示 ${list.length} 条 · 共 ${M.selTool ? list.length : M.items.length} 条`;
  }
  const selall = qs<HTMLElement>("#mv-selall", root);
  if (selall)
    selall.onclick = () => {
      for (const i of list) M.selected.add(i.id);
      renderAll(root);
    };
  const selinv = qs<HTMLElement>("#mv-selinv", root);
  if (selinv)
    selinv.onclick = () => {
      for (const i of list) {
        if (M.selected.has(i.id)) M.selected.delete(i.id);
        else M.selected.add(i.id);
      }
      renderAll(root);
    };
  const selnone = qs<HTMLElement>("#mv-selnone", root);
  if (selnone)
    selnone.onclick = () => {
      M.selected.clear();
      renderAll(root);
    };
  renderPanel(root, list);
}

function toggle(root: HTMLElement, id: string): void {
  const row = qs<HTMLElement>(`#mv-rows .mvi[data-id="${CSS.escape(id)}"]`, root);
  if (row) {
    toggleItemRow(root, row);
    return;
  }
  M.expandedId = M.expandedId === id ? null : id;
  renderAll(root);
}

function detailBody(it: MemoryItem): string {
  const d = M.detail;
  if (!d || String(d.id) !== String(it.id))
    return '<div class="srow__load">正在读取条目内容…</div>';
  const drift = d.source_changed
    ? `<div class="memv-drift-tip">源文件在扫描后被工具端改动过（hub 内容 vs 源内容已分叉）。
           <button class="hub-btn btn-sm" data-testid="memv-adopt">以此为准 · 重新采集源内容</button></div>`
    : "";
  return `${drift}
      <div class="mvi__bar">
        <span class="mono">v${d.version} · hash ${esc((d.hash ?? "").slice(0, 12))} · ${esc(fmtTime(d.updated_at))}</span>
        <span>· 来源 ${esc(nameOf(it.source_tool))} · ${esc(tilde(d.source_path))}</span>
        <span class="mvi__acts">
          <button class="hub-btn btn-sm" data-testid="memv-edit">编辑</button>
          <button class="hub-btn btn-sm" data-testid="memv-copy">复制</button>
        </span>
      </div>
      <pre class="mvi__pre" data-testid="memv-content">${esc(d.content ?? "")}</pre>
      <div class="memv-editor__acts" style="display:none">
        <textarea class="hub-input memv-editor" data-testid="memv-editor" rows="10">${esc(d.content ?? "")}</textarea>
        <button class="hub-btn hub-btn--primary" data-testid="memv-save">保存到中间体</button>
        <span class="mono-xs">保存后可从右栏写入工具；源文件不受影响</span>
      </div>`;
}

async function loadDetail(root: HTMLElement, iid: string): Promise<void> {
  const r = await api<MemoryItem & { ok: boolean }>(`/api/memory/item/${iid}`);
  if (!r.data?.ok) {
    HubUI.toast("条目详情加载失败", "error");
    return;
  }
  M.detail = r.data;
  renderAll(root);
}

function bindDetail(root: HTMLElement): void {
  const box = qs<HTMLElement>("#mv-rows", root);
  if (!box) return;
  const edit = qs<HTMLElement>('[data-testid="memv-edit"]', box);
  if (edit) {
    edit.onclick = (e) => {
      e.stopPropagation();
      const acts = qs<HTMLElement>(".memv-editor__acts", box);
      const pre = qs<HTMLElement>('[data-testid="memv-content"]', box);
      if (acts) acts.style.display = "";
      if (pre) pre.style.display = "none";
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.style.display = "none";
    };
  }
  const copy = qs<HTMLElement>('[data-testid="memv-copy"]', box);
  if (copy) {
    copy.onclick = async (e) => {
      e.stopPropagation();
      const ok = await copyText(M.detail?.content ?? "");
      HubUI.toast(ok ? "已复制条目内容" : "复制失败", ok ? "success" : "warn");
    };
  }
  const save = qs<HTMLElement>('[data-testid="memv-save"]', box);
  if (save) {
    save.onclick = async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLElement;
      btn.classList.add("is-loading");
      const editor = qs<HTMLTextAreaElement>('[data-testid="memv-editor"]', box);
      const rr = await send<{ ok: boolean; error?: string }>(
        `/api/memory/item/${M.expandedId ?? ""}`,
        "PUT",
        { content: editor?.value ?? "" },
      );
      btn.classList.remove("is-loading");
      if (rr.data.ok) {
        HubUI.toast("已保存到中间体", "success");
        M.loadedAt = 0;
        await loadOverview(true);
        await loadDetail(root, M.expandedId ?? "");
      } else HubUI.toast(`保存失败：${rr.data.error ?? ""}`, "error");
    };
  }
  const adopt = qs<HTMLElement>('[data-testid="memv-adopt"]', box);
  if (adopt) {
    adopt.onclick = async (e) => {
      e.stopPropagation();
      const rr = await post<{ ok: boolean; error?: string }>(
        `/api/memory/item/${M.expandedId ?? ""}/adopt`,
        {},
      );
      if (rr.data.ok) {
        HubUI.toast("已认领源内容到中间体", "success");
        M.loadedAt = 0;
        await loadOverview(true);
        await loadDetail(root, M.expandedId ?? "");
      } else HubUI.toast(`认领失败：${rr.data.error ?? ""}`, "error");
    };
  }
}

/** 「笔记 · 本地」：复用会话页的 legacy 笔记视图。 */
function renderNotes(root: HTMLElement): void {
  const rows = qs<HTMLElement>("#mv-rows", root);
  if (!rows) return;
  rows.innerHTML = `
      <div class="mv-notehead">
        <span>笔记 · 本地 <span class="mono-xs">hub.db + ~/.agent/hub/memory/</span></span>
        <button class="hub-btn btn-sm" id="mv-back-notes">‹ 返回记忆分发</button>
      </div>
      <div class="mv-noteshost" id="mv-notes-host"></div>`;
  const back = qs<HTMLElement>("#mv-back-notes", root);
  if (back) back.onclick = () => pick(root, "", false);
  const host = qs<HTMLElement>("#mv-notes-host", root);
  if (host) appActions().renderMemoryView();
}

/** 右栏：写入去向（多选目标）。 */
function renderPanel(root: HTMLElement, _list?: MemoryItem[]): void {
  const panel = qs<HTMLElement>("#mv-panel", root);
  if (!panel) return;
  const n = M.selected.size;
  const show = n > 0 && M.selTool !== NOTES_ID;
  panel.classList.toggle("is-in", show);
  if (!show) return;
  const targets = M.tools.filter((t) => t.writable);
  const chosen = new Set(
    qsa<HTMLElement>(".stgt.is-on", panel).map((x) => x.dataset["target"] ?? ""),
  );
  const pickerOpts: PickerOptions = {
    prefix: "mv",
    emptyHint: "没有可写的工具，先在 设置 → 工具 里启用",
    items: targets.map((t) => ({
      id: t.id,
      name: t.name,
      dotCls: toolColorCls(t as unknown as { color: number }),
      testid: `memv-target-${t.id}`,
    })),
    chosen: [...chosen],
    selLine: `已选 <b>${n}</b> 条`,
    selLineFn: () => `已选 <b>${n}</b> 条`,
    goText: `写入 ${n} 条到 ${chosen.size || "…"} 个目标`,
    goTextFn: (set) => `写入 ${n} 条到 ${set.size} 个目标`,
    onGo: (ids) => void distributeTo(ids, false, root),
  };
  const picker = MV.targetPicker(pickerOpts);
  panel.innerHTML = `
      <div class="spanel__in">
        <div class="spanel__h">
          <h3>目标</h3>
          <button class="spanel__x" id="mv-panel-close" title="收起" aria-label="收起">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        ${picker.html}
        <p class="nv-note" style="padding:0 var(--sp-4) var(--sp-3)">不可写的工具已隐藏；项目级记忆只写回其来源工具。</p>

      </div>`;
  picker.bind(panel);
  const close = qs<HTMLElement>("#mv-panel-close", panel);
  if (close)
    close.onclick = () => {
      M.selected.clear();
      renderAll(root);
    };
}

async function distributeTo(tools: string[], force: boolean, root: HTMLElement): Promise<void> {
  const ids = [...M.selected];
  if (ids.length === 0) {
    HubUI.toast("先勾选要写入的条目", "warn");
    return;
  }
  const r = await post<DistributeResponse>("/api/memory/distribute", {
    item_ids: ids,
    tools,
    force,
  });
  if (!r.data.ok) {
    HubUI.toast(`写入失败：${r.data.error ?? ""}`, "error");
    return;
  }
  const rs = r.data.results ?? [];
  const ok = rs.filter((x) => x.status === "ok" || x.status === "skipped");
  const conflicts = rs.filter((x) => x.status === "conflict");
  const failed = rs.filter((x) => x.status === "failed");
  if (ok.length > 0)
    HubUI.toast(`已写入 ${ok.length} 条 → ${tools.map((t) => nameOf(t)).join("、")}`, "success");
  if (failed.length > 0)
    HubUI.toast(`${failed.length} 条失败：${failed[0]?.reason ?? ""}`, "error", 5600);
  if (conflicts.length > 0) {
    HubUI.confirm(
      "目标内容有冲突",
      `${conflicts.length} 条冲突：${esc(conflicts[0]?.reason ?? "")}。<br><br>` +
        "目标文件在 hub 之外被改动，覆盖前会自动备份原文件。确认以 hub 中间体为准覆盖？",
      () => void distributeTo(tools, true, root),
      { confirmText: "覆盖（先备份）", cancelText: "保留目标不动" },
    );
  }
  M.loadedAt = 0;
  await loadOverview(true);
  M.selected.clear();
  renderAll(root);
}

/** 可折叠头部：布局模式存 M._layout；animate=true 走两帧过渡。 */
function applyLayout(root: HTMLElement, animate: boolean): void {
  const hdr = qs<HTMLElement>("#mv-hdr", root);
  if (!hdr) return;
  const topBox = qs<HTMLElement>("#mv-top", hdr);
  const compact = M._layout === "compact";
  if (!compact && topBox) {
    const fullH = topBox.scrollHeight;
    if (fullH) M._fullH = fullH;
  }
  if (M._fullH) hdr.style.setProperty("--hdr-full", `${Math.round(M._fullH)}px`);
  const apply = (): void => {
    hdr.style.height = "";
    hdr.classList.toggle("is-compact", compact);
    hdr.dataset["layout"] = compact ? "compact" : "detail";
  };
  if (animate) {
    hdr.style.height = `${Math.round(hdr.getBoundingClientRect().height)}px`;
    requestAnimationFrame(() => requestAnimationFrame(apply));
  } else apply();
  if (compact) {
    const dt = qs<HTMLElement>("#mv-hdrtoggle", hdr);
    if (dt) dt.hidden = true;
  } else {
    MV.hdrToggle(hdr, "mv", () => {
      M._layout = "compact";
      applyLayout(root, true);
    });
  }
  const bar = qs<HTMLElement>("#mv-bar", hdr);
  if (bar) {
    const prevLayout = hdr.dataset["layout"] ?? "";
    bar.hidden = !compact;
    if (compact && prevLayout !== "compact") {
      HubUI.drawFrames(bar);
      MV.growIn(bar);
    }
  }
}

/** 选中态就地同步（不整页重绘，保住过渡动画）。 */
function syncSelection(root: HTMLElement | null): void {
  const host = root ?? document.getElementById("view-memory");
  if (!host) return;
  for (const c of qsa<HTMLElement>("#mv-top .tcard[data-src]", host)) {
    c.classList.toggle(
      "is-on",
      M.selTool !== null && String(c.dataset["src"]) === String(M.selTool),
    );
  }
  for (const b of qsa<HTMLElement>("#mv-bar .cbar__it", host)) {
    b.classList.toggle(
      "is-on",
      M.selTool !== null && String(b.dataset["src"]) === String(M.selTool),
    );
  }
}

function syncAfterPick(root: HTMLElement): void {
  if (M.selTool === NOTES_ID) {
    renderNotes(root);
    return;
  }
  renderRows(root, visibleItems(), buildStats());
}

/** 选中 / 取消选中：点已选中的只取消；详细布局点新卡片 = 选中；简略布局点 chip = 换选中。 */
function pick(root: HTMLElement, id: string, _fromCards: boolean): void {
  const same = M.selTool !== null && String(M.selTool) === String(id);
  M.selTool = same ? null : id || null;
  M.expandedId = null;
  M.detail = null;
  syncSelection(root);
  syncAfterPick(root);
}

export const MemoryView = { render };

// 兼容旧调用（scanOne 供外部工具类入口复用）
export { scanOne };
