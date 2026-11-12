/* 连接画布（Skills / MCP 合并页）——三行看板 + 连线层。
   样式与交互对齐原型《连接融合-v4-编辑态》：metastrip 统计带、150 方形卡、
   绿实/绿虚/灰点连线、右上浮动条目面板（成对编辑）、线上按钮在通道卡底缘。
   分步落地口径：条目详情/批量分发后续回填；改动经右下暂存条确认生效。 */

import { api, post, send } from "../core/api.ts";
import { byId, mustById, qs, qsa } from "../core/dom.ts";
import { esc } from "../core/format.ts";
import { MV } from "../core/mv.ts";
import type {
  CanvasState,
  Channel,
  LaneVisual,
  StageKind,
  StageOp,
} from "../core/state-machine.ts";
import * as sm from "../core/state-machine.ts";
import { toolColorCls, toolShort } from "../core/tools.ts";
import type {
  DirBinding,
  ItemsResponse,
  LocalDir,
  RemoteRepo,
  SourceRow,
  StateResponse,
  TargetPublic,
} from "../core/types/api.ts";
import { HubUI } from "../hub-ui.ts";

/** 工具实体（/api/state.tool_list 投影，画布只用到 id / name / color）。 */
type ToolRow = CanvasState["tools"][number];

/** 画布状态：状态机契约 + 视图专有字段（目录 / 仓库用真实 API 类型）。 */
interface ConnectState extends CanvasState {
  dirs: LocalDir[];
  repos: RemoteRepo[];
  _panelShown: boolean;
}

/** 目录 id 归一入参（渲染层可能来自 dataset 字符串）。 */
type DirIdLike = number | string | null;

/** 拉取类接口的最小响应形状。 */
interface PullResult {
  ok: boolean;
  error?: string;
  needs_action?: boolean;
}

/** 条目列表响应（items_view 优先，兼容旧 registry 字段）。 */
interface LegacyItemsData {
  items?: unknown;
  registry?: unknown;
}

/** 连线期望项（weak = 目录→通道卡从属线；lane = 通道卡→工具卡四态线）。 */
interface WantLine {
  key: string;
  cls: string;
  d: string;
  solid?: boolean;
  st?: LaneVisual;
  staged?: boolean;
  title?: string;
}

export const ConnectView = (() => {
  const Ch = sm.CHANNEL_LABEL;
  const Channels: readonly Channel[] = ["skills", "mcp"];
  const S: ConnectState = {
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
    stage: new Map(),
    panelShown: false,
    _panelShown: false,
  };

  /* ---------------- 状态机薄适配（S 本身即 CanvasState，直接传入） ---------------- */
  /* dirId 可能是 dataset 字符串 → Number() 归一（与旧 +dirId 等价：null→0）。 */
  const normDir = (dirId: DirIdLike): number => Number(dirId);

  const laneKey = (dirId: DirIdLike, toolId: string, ch: Channel): string =>
    sm.laneKey(normDir(dirId), toolId, ch);
  const targetOf = (toolId: string, ch: Channel): TargetPublic | null => sm.targetOf(S, toolId, ch);
  const baseBind = (dirId: DirIdLike, toolId: string, ch: Channel): DirBinding | null =>
    sm.baseBind(S, normDir(dirId), toolId, ch);
  function laneOn(dirId: DirIdLike, toolId: string, ch: Channel): boolean {
    return sm.laneOn(S, normDir(dirId), toolId, ch);
  }
  function lanePaused(dirId: DirIdLike, toolId: string, ch: Channel): boolean {
    return sm.lanePaused(S, normDir(dirId), toolId, ch);
  }
  function laneState(dirId: DirIdLike, toolId: string, ch: Channel): "on" | "off" {
    return sm.laneState(S, normDir(dirId), toolId, ch);
  }
  function laneExcluded(dirId: DirIdLike, toolId: string, ch: Channel): Set<string> {
    return sm.laneExcluded(S, normDir(dirId), toolId, ch);
  }
  function laneMode(dirId: DirIdLike, toolId: string, ch: Channel): "copy" | "link" {
    return sm.laneMode(S, normDir(dirId), toolId, ch);
  }
  function setStage(dirId: DirIdLike, toolId: string, ch: Channel, patch: Partial<StageOp>): void {
    sm.setStage(S, normDir(dirId), toolId, ch, patch);
  }
  function itemOn(item: string, dirId: DirIdLike, toolId: string, ch: Channel): boolean {
    return sm.itemOn(S, item, normDir(dirId), toolId, ch);
  }
  function channelState(dirId: DirIdLike, toolId: string, ch: Channel): LaneVisual {
    return sm.channelState(S, normDir(dirId), toolId, ch);
  }
  function aggState(dirId: DirIdLike, toolId: string): LaneVisual | null {
    return sm.aggState(S, normDir(dirId), toolId);
  }

  async function loadAll(): Promise<void> {
    const [dirs, repos, skTargets, mcpTargets, binds, st] = await Promise.all([
      api<{ ok: boolean; dirs: LocalDir[] }>("/api/local-dirs"),
      api<{ ok: boolean; repos: RemoteRepo[] }>("/api/remote-repos"),
      api<{ ok: boolean; targets: TargetPublic[] }>("/api/skills/targets"),
      api<{ ok: boolean; targets: TargetPublic[] }>("/api/mcp/targets"),
      api<{ ok: boolean; bindings: DirBinding[] }>("/api/skills/dir-bindings"),
      api<StateResponse>("/api/state"),
    ]);
    S.dirs = dirs.data.dirs || [];
    S.repos = repos.data.repos || [];
    S.skTargets = skTargets.data.targets || [];
    S.mcpTargets = mcpTargets.data.targets || [];
    S.binds = binds.data.bindings || [];
    S.tools = st.data.tool_list || []; /* 工具实体列表（/api/state.tool_list） */
  }

  /** 旧 registry 字段 / 字符串条目兼容：`i.name || i` 的类型安全版。 */
  function namesOf(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((i: unknown): string => {
      if (typeof i === "string") return i;
      if (i !== null && typeof i === "object" && "name" in i) {
        const n: unknown = (i as { name?: unknown }).name;
        if (typeof n === "string" && n) return n;
      }
      return String(i);
    });
  }

  async function loadItems(): Promise<void> {
    if (!S.selDir) {
      S.items = { skills: [], mcp: [] };
      return;
    }
    const [sk, mc] = await Promise.all([
      api<ItemsResponse>("/api/skills/items?source=manual&dir=" + S.selDir),
      api<ItemsResponse>("/api/mcp/items?source=manual&dir=" + S.selDir),
    ]);
    const s0: LegacyItemsData = sk.data;
    const m0: LegacyItemsData = mc.data;
    S.items.skills = namesOf(s0.items || s0.registry);
    S.items.mcp = namesOf(m0.items || m0.registry);
  }

  /* ---------------- 线上按钮图标（纯 SVG，与卡片动作图标同语言） ---------------- */
  const IconUnlink =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const IconLink =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 8h15"/><path d="M16 5l3 3-3 3"/><path d="M20 16H5"/><path d="M8 13l-3 3 3 3"/></svg>';

  /* ---------------- 工具配色（tokens 既有变量） ---------------- */

  const DotVar: Record<string, string> = {
    claude: "var(--c-tool-claude)",
    codex: "var(--c-tool-codex)",
    opencode: "var(--c-tool-opencode)",
  };
  function toolDotCls(t: { id?: string; color?: number } | null | undefined): string {
    const id = t && t.id;
    if (id && DotVar[id]) return "tool-dot--" + id;
    return "tool-dot--p" + Math.min(12, Math.max(4, +((t && t.color) || 4)));
  }

  /* ---------------- 骨架 ---------------- */

  const Build = "20261105-4"; /* 构建标记：DevTools 里看 .cv[data-build] 即知页面加载的是哪版 */

  function shell(): string {
    return `
      <div class="cv" data-build="${Build}">
        <div class="cv-metastrip">
          <span><b id="cv-st-all">0</b>条目 · 全部来源</span>
          <span class="muted"><b id="cv-st-local">0</b>本地</span>
          <span><b id="cv-st-remote">0</b>远程拉取</span>
          <span><b id="cv-st-deployed">0</b>已部署到工具</span>
          <span class="cv-sep"></span>
          <span><i class="cv-lswatch is-full"></i>全链接 · 自动同步</span>
          <span><i class="cv-lswatch is-part"></i>部分链接 · 自动同步</span>
          <span><i class="cv-lswatch is-paused"></i>已链接 · 不自动同步</span>
          <span><i class="cv-bdot off"></i>无连线 = 无链接</span>
          <span class="cv-rule">点连线 = 暂停/恢复自动同步 · 卡上 × = 断连 · ↔ = 链接 · 选中目录后展示真链路 · 类型卡多选、工具卡单选</span>
        </div>
        <div class="cv-main">
          <div class="cv-maincol">
            <div class="cv-zone" id="cv-zone">
              <div class="cv-row cv-srcrow" id="cv-dirs"></div>
              <div class="cv-gap cv-gap--g1"></div>
              <div class="cv-row cv-typerow" id="cv-types"></div>
              <div class="cv-gap"></div>
              <div class="cv-row cv-toolsrow" id="cv-toolsrow">
                <div class="cv-grid" id="cv-tools"></div>
              </div>
              <svg class="cv__lines" id="cv-lines"></svg>
              <div class="cv__lane-ops" id="cv-lane-ops"></div>
            </div>
          </div>
          <aside class="cv-ipanel" id="cv-panel" hidden></aside>
        </div>
        <div class="cv__apply" id="cv-apply" hidden>
          <span class="cv__apply-tip">有 <b id="cv-apply-n">0</b> 项未生效的更改</span>
          <button class="hub-btn" id="cv-undo">撤销</button>
          <button class="hub-btn hub-btn--primary" id="cv-confirm">确认更改</button>
        </div>
      </div>`;
  }

  /* ---------------- 卡片 ---------------- */

  function bdot(st: LaneVisual, title: string): string {
    const cls = st === "blocked" || st === "paused" ? "off" : st;
    return `<span class="cv-bdot ${cls}" title="${esc(title)}"></span>`;
  }

  /* 目录/仓库卡 footer（MV .tcard__tag 内）：→/⇐ + 各工具跟随态圆点 */
  function srcTag(srcId: number, arr: string): string {
    const dots = S.tools
      .map((t) => ({ t, st: aggState(srcId, t.id) }))
      .filter((x): x is { t: ToolRow; st: LaneVisual } => x.st !== null)
      .map((x) =>
        bdot(
          x.st,
          `${x.t.name} · ${
            x.st === "full" ? "完整跟随" : x.st === "part" ? "部分跟随" : "该类已全部排除"
          }`,
        ),
      )
      .join("");
    return dots ? `<span class="cv-arr">${arr}</span>${dots}` : "";
  }

  function renderDirs(): void {
    const host = byId("cv-dirs");
    if (!host) return;
    const dirCount = (d: LocalDir): number => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = (r: RemoteRepo): number =>
      Object.values<SourceRow>(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    const activeId = S.selDir ? "dir:" + S.selDir : S.selRepo ? "repo:" + S.selRepo : null;
    const dimAll = !!(S.selDir || S.selRepo);
    if (host.dataset["sig"] !== rowSig() || !host.querySelector(".srcgroups")) {
      host.dataset["sig"] = rowSig();
      const sources = [
        ...S.dirs.map((d) => ({
          id: "dir:" + d.id,
          name: d.name,
          short: shortName(d.name),
          cls: "chip--accent",
          count: dirCount(d),
          title: `${d.name} · ${dirCount(d)} 条 · ${d.path}${layoutHint(d)}`,
          tag: srcTag(d.id, "\u2192"),
          off: dimAll && activeId !== "dir:" + d.id,
          acts: [
            {
              key: "dirdel",
              label: "移除",
              icon: MV.ic("trash"),
              title: "移除该目录（磁盘文件保留）",
              danger: true,
            },
          ],
        })),
        ...S.repos.map((r) => ({
          id: "repo:" + r.id,
          name: r.name,
          short: shortName(r.name),
          cls: "chip--muted",
          count: repoCount(r),
          title: `${r.name} · ${repoCount(r)} 条 · ${r.url}`,
          tag: srcTag(r.id, "\u21d0"),
          off: dimAll && activeId !== "repo:" + r.id,
          acts: [
            { key: "pull", label: "拉取", icon: MV.ic("refresh"), title: "拉取该仓库" },
            { key: "edit", label: "编辑", icon: MV.ic("edit"), title: "编辑仓库配置" },
            {
              key: "del",
              label: "移除",
              icon: MV.ic("trash"),
              title: "移除该仓库及其来源",
              danger: true,
            },
          ],
        })),
      ];
      host.innerHTML = MV.top({
        prefix: "cv",
        sources,
        counts: Object.fromEntries(sources.map((s0) => [s0.id, s0.count] as const)),
        activeId,
        groups: [
          {
            kind: "local",
            label: "本地",
            desc: "默认目录 + 已链接目录",
            actions: ["关联目录"],
            ids: S.dirs.map((d) => "dir:" + d.id),
          },
          {
            kind: "remote",
            label: "远程仓库",
            desc: "Git 仓库拉取，只读跟随上游",
            actions: ["添加仓库", "全部拉取"],
            ids: S.repos.map((r) => "repo:" + r.id),
          },
        ],
      });
    }
    applyCardStates(host, activeId, dimAll); /* 选中变化只切类：保住描边生长/底色扫入过渡 */
  }

  /* 行内重建签名：只含数据（计数 + 绑定 + 暂存）。
     选中变化不重建——走 applyCardStates/applyTypeStates 切类，保住 CSS 过渡与描边生长动画 */
  function rowSig(): string {
    const dirCount = (d: LocalDir): number => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = (r: RemoteRepo): number =>
      Object.values<SourceRow>(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    return (
      S.dirs.map((d) => d.id + ":" + dirCount(d)).join("|") +
      "#" +
      S.repos.map((r) => r.id + ":" + repoCount(r)).join("|") +
      "#" +
      S.binds
        .map((b) => b.id + ":" + (b.channels || []).join("") + ":" + (b.excluded || []).length)
        .join("|") +
      "#" +
      S.stage.size
    );
  }

  function applyCardStates(host: HTMLElement, activeId: string | null, dimAll: boolean): void {
    qsa<HTMLElement>(".tcard[data-src]", host).forEach((el) => {
      const id = el.getAttribute("data-src");
      const active = activeId !== null && id === String(activeId);
      el.classList.toggle("is-on", active);
      el.classList.toggle("is-off", !!dimAll && !active);
    });
  }

  /* 容器目录的布局提示（自动发现子 skills/mcp 文件夹）：追加在卡 title 里 */
  function layoutHint(d: LocalDir): string {
    const L = d.layout;
    if (!L) return "";
    const parts: string[] = [];
    const sk = L.skills || [];
    const mc = L.mcp || [];
    if (sk.length) parts.push(`${sk.length} 个 skills 文件夹`);
    if (mc.length) parts.push(`${mc.length} 个 mcp 文件夹`);
    return parts.length ? " · 含 " + parts.join(" / ") : "";
  }

  /* 卡片中央方块的两字缩写 */
  function shortName(name: string | null | undefined): string {
    return String(name || "")
      .slice(0, 2)
      .toUpperCase();
  }

  const TypeCards: [Channel, string, string, string][] = [
    ["skills", "SK", "Skills", "chip--accent"],
    ["mcp", "MC", "MCP", "chip--muted"],
  ];

  /* 类型卡：选中目录 = 该目录视角（计数 / 右下目录名）；未选 = 全部来源聚合 */
  function renderTypes(): void {
    const host = byId("cv-types");
    if (!host) return;
    const d = S.dirs.find((x) => x.id === S.selDir);
    const ctx = !!S.selDir;
    if (host.dataset["sig"] !== rowSig() + "#" + (d ? d.id : "") || !host.querySelector(".tcard")) {
      host.dataset["sig"] = rowSig() + "#" + (d ? d.id : "");
      host.innerHTML = `<div class="tgrid">${TypeCards.map(([ch, tag, nm, cls]) => {
        if (!d) {
          /* 未选中目录：类型卡只留本体（徽标 + 名称），不显示聚合信息 */
          return `<div class="tcard" data-src="ch:${ch}" title="${nm} · 选中目录后展示其链接态">
            <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
            <button class="tcard__open" aria-label="${nm}">
              <span class="tcard__chip ${cls}">${tag}</span>
              <span class="tcard__nm">${nm}</span>
            </button>
          </div>`;
        }
        const dots = S.tools
          .map((t) => ({ t, st: channelState(d.id, t.id, ch) }))
          .filter((x): x is { t: ToolRow; st: LaneVisual } => x.st !== "off")
          .map((x) =>
            bdot(
              x.st,
              `${x.t.name} · ${
                x.st === "full" ? "完整跟随" : x.st === "part" ? "部分跟随" : "该类已全部排除"
              }`,
            ),
          )
          .join("");
        /* 第二参数对应旧 window.MV 里缺省为 {} 的 o：画布卡不需要分组/前缀 */
        return MV.card(
          {
            id: "ch:" + ch,
            name: nm,
            short: tag,
            cls,
            count: d.counts[ch] || 0,
            title: `${nm} · 点击聚焦 / 再点取消（可多选）`,
            tag:
              `${dots ? `<span class="cv-arr">\u2192</span>${dots}` : ""}` +
              `<span class="cv-tpath">${esc(d.name)}</span>`,
          },
          { prefix: "", sources: [] },
        );
      }).join("")}</div>`;
    }
    /* 类型聚焦/降对比：聚焦属「已选目录」上下文（原型口径） */
    const anyOn = S.types.skills || S.types.mcp;
    qsa<HTMLElement>('.tcard[data-src^="ch:"]', host).forEach((el) => {
      const ch = (el.getAttribute("data-src") ?? "").slice(3) as Channel;
      el.classList.toggle("is-on", ctx && S.types[ch]);
      el.classList.toggle("is-off", ctx && anyOn && !S.types[ch]);
    });
  }

  function renderTools(): void {
    const host = byId("cv-tools");
    if (!host) return;
    if (host.dataset["sig"] !== rowSig() || !host.querySelector(".tcard")) {
      host.dataset["sig"] = rowSig();
      /* 计数 = 已装条目数（各目录跟随态条目之和），口径同原型 */
      const n = (t: ToolRow): number =>
        S.dirs.reduce(
          (a, d) =>
            a +
            Channels.reduce((s, ch) => {
              const st = channelState(d.id, t.id, ch);
              if (st === "off") return s;
              const exN = Math.min(laneExcluded(d.id, t.id, ch).size, d.counts[ch] || 0);
              return s + (d.counts[ch] || 0) - (st === "blocked" ? d.counts[ch] || 0 : exN);
            }, 0),
          0,
        );
      const homeShort = (p0: string | null | undefined): string =>
        String(p0 || "").replace(/^\/Users\/[^/]+/u, "~");
      host.innerHTML = `<div class="tgrid">${S.tools
        .map((t) => {
          const dots = S.dirs
            .map((d) => ({ d, st: aggState(d.id, t.id) }))
            .filter((x): x is { d: LocalDir; st: LaneVisual } => x.st !== null)
            .map((x) =>
              bdot(
                x.st,
                `${x.d.name} · ${
                  x.st === "full" ? "完整跟随" : x.st === "part" ? "部分跟随" : "该类已全部排除"
                }`,
              ),
            )
            .join("");
          const tgt = targetOf(t.id, "skills") || targetOf(t.id, "mcp");
          /* 第二参数对应旧 window.MV 里缺省为 {} 的 o：画布卡不需要分组/前缀 */
          return MV.card(
            {
              id: "tool:" + t.id,
              name: t.name,
              short: toolShort(t),
              cls: toolColorCls(t),
              count: n(t),
              off: !!S.selTool && S.selTool !== t.id,
              title: `${t.name} · ${tgt ? homeShort(tgt.path) : "未配置目标"} · ${n(t)} 条已装`,
              tag:
                `${dots ? `<span class="cv-arr">\u21d0</span>${dots}` : ""}` +
                `<span class="cv-tpath">${esc(tgt ? homeShort(tgt.path) : "")}</span>`,
            },
            { prefix: "", sources: [] },
          );
        })
        .join("")}</div>`;
    }
    qsa<HTMLElement>('.tcard[data-src^="tool:"]', host).forEach((el) => {
      const id = (el.getAttribute("data-src") ?? "").slice(5);
      el.classList.toggle("is-on", S.selTool === id);
      el.classList.toggle("is-off", !!S.selTool && S.selTool !== id);
    });
  }

  /* ---------------- 连线 ---------------- */

  interface LinePoint {
    x: number;
    y: number;
  }

  function drawLines(): void {
    const svg = byId("cv-lines");
    const ops = byId<HTMLElement>("cv-lane-ops");
    const zone = byId<HTMLElement>("cv-zone");
    if (!(svg && zone)) return;
    const zr = zone.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${zr.width} ${zr.height}`);
    if (ops) ops.innerHTML = "";
    const el = (k: string): Element | null => qs<Element>(`[data-src="${k}"]`, zone);
    const pt = (node: Element, edge: "top" | "bottom"): LinePoint => {
      const r = node.getBoundingClientRect();
      return { x: r.left - zr.left + r.width / 2, y: (edge === "top" ? r.top : r.bottom) - zr.top };
    };
    const seg = (a: LinePoint, b: LinePoint): string => {
      const dy = (b.y - a.y) / 2;
      return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
    };

    /* 期望的连线集合：weak = 目录底部中心 → 通道卡顶部中心（单起点，同款绿实线，无交互）；
       lane = 通道卡底部 → 工具卡顶部，四态。聚焦工具时只画选中者的 lane 线。 */
    const want: WantLine[] = [];
    const selDir = S.selDir;
    const selTool = S.selTool;
    const dirEl = selDir ? el("dir:" + selDir) || el("repo:" + selDir) : null;
    if (dirEl) {
      const fromDir = pt(dirEl, "bottom");
      const anyOn = S.types.skills || S.types.mcp;
      Channels.forEach((ch) => {
        const c = el("ch:" + ch);
        if (c && !(anyOn && !S.types[ch])) {
          want.push({
            key: `w:${selDir}:${ch}`,
            cls: "cv-line cv-line--weak",
            solid: true,
            d: seg(fromDir, pt(c, "top")),
          });
        }
      });
      const typeEl = (ch: Channel): Element | null => el("ch:" + ch);
      S.tools.forEach((t) => {
        if (selTool && t.id !== selTool) return;
        Channels.forEach((ch) => {
          const c = typeEl(ch);
          if (!(c && S.types[ch] && targetOf(t.id, ch))) return;
          const st = channelState(selDir, t.id, ch);
          if (st === "off") return; /* 无链接 = 不画线 */
          const staged = S.stage.has(laneKey(selDir, t.id, ch));
          const toolEl = el(`tool:${t.id}`);
          if (!toolEl) return;
          want.push({
            key: laneKey(selDir, t.id, ch),
            cls: "cv-line",
            st,
            staged,
            d: seg(pt(c, "bottom"), pt(toolEl, "top")),
            /* off 已在上面 return，原三元恒落到「断开」 */
            title: `断开：${Ch[ch]} ↔ ${t.name}`,
          });
        });
      });
    }

    /* 增量对账（同前）：消失 → 收起/淡出；新增 → 画入/淡入；保留 → 原地更新。
       lane 线成组渲染（g + 16px 透明命中线，原型 path.hit 口径）：g:hover 驱动加粗。
       消失动效（原型 draw-out 口径）：实线向起点收起（dashoffset 0 → -100），
       虚线无收起形态 → 原地淡出。 */
    const wantKeys = new Set(want.map((o) => o.key));
    qsa<SVGElement>(".cv-lineg[data-lane], .cv-line--weak[data-lane]", svg).forEach((n) => {
      const laneName = n.dataset["lane"];
      const marked = n as SVGElement & { _leaving?: boolean };
      if ((laneName !== undefined && wantKeys.has(laneName)) || marked._leaving) return;
      const isGroup = n.classList.contains("cv-lineg");
      const ghost = n.cloneNode(true) as SVGElement;
      const gvis = isGroup ? qs<SVGElement>(".cv-line", ghost) : ghost;
      if (!gvis) return;
      marked._leaving = true;
      const solid = isGroup ? gvis.classList.contains("is-on") : true; /* weak 从属线恒实线 */
      /* 画入动画在克隆体上会重播 → 摘除，改由内联样式接管收起过渡 */
      gvis.classList.remove("is-in");
      ghost.removeAttribute("data-lane");
      if (solid) {
        gvis.setAttribute("pathLength", "100");
        gvis.style.animation = "none";
        gvis.style.strokeDasharray = "100px";
        gvis.style.strokeDashoffset = "0px";
        gvis.style.transition = "stroke-dashoffset .26s cubic-bezier(.3,.6,.3,1)";
        void ghost.getBoundingClientRect(); /* 强制回流：让过渡从 0 起跳 */
        requestAnimationFrame(() => {
          gvis.style.strokeDashoffset = "-100px";
        });
      } else {
        gvis.classList.add("is-out"); /* 虚线无收起形态：淡出 */
      }
      svg.appendChild(ghost);
      setTimeout(() => ghost.remove(), 320);
      n.remove();
    });
    const StCls: Record<string, string> = {
      full: " is-on",
      part: " is-part",
      blocked: " is-paused",
      paused: " is-paused",
    };
    const stSuffix = (st: LaneVisual | undefined): string => (st ? (StCls[st] ?? "") : "");
    const build = (o: WantLine): string => {
      if (o.solid) {
        return `<path class="${o.cls} is-in" pathLength="100" data-lane="${o.key}" d="${o.d}"></path>`;
      }
      const extra = o.st === "full" ? " is-on is-in" : ` ${stSuffix(o.st)} is-fade`;
      return `<g class="cv-lineg" data-lane="${o.key}">
        <path class="cv-hit" d="${o.d}"></path>
        <path class="${o.cls}${extra}"${o.st === "full" ? ' pathLength="100"' : ""} data-lane="${o.key}" d="${o.d}">${o.title ? `<title>${esc(o.title)}</title>` : ""}</path>
      </g>`;
    };
    want.forEach((o) => {
      const n = o.solid
        ? svg.querySelector<Element>(`.cv-line--weak[data-lane="${o.key}"]`)
        : svg.querySelector<Element>(`.cv-lineg[data-lane="${o.key}"]`);
      if (!n) {
        svg.insertAdjacentHTML("beforeend", build(o));
        return;
      }
      const vis = o.solid ? n : qs<Element>(".cv-line", n);
      if (!vis) return;
      /* 原地更新：路径/状态变了靠 CSS stroke 过渡，不重播画入 */
      if (vis.getAttribute("d") !== o.d) {
        vis.setAttribute("d", o.d);
        const rp = qs<Element>(".reveal", vis);
        if (rp) rp.setAttribute("d", o.d);
        if (!o.solid) {
          const hit = qs<Element>(".cv-hit", n);
          if (hit) hit.setAttribute("d", o.d);
        }
      }
      if (o.solid) return;
      const cls = o.cls + stSuffix(o.st) + (o.staged ? " is-pending" : "");
      if (vis.getAttribute("class") !== cls) vis.setAttribute("class", cls);
      if (o.st === "full" && !vis.getAttribute("pathLength")) vis.setAttribute("pathLength", "100");
      if (o.st !== "full" && vis.hasAttribute("pathLength")) vis.removeAttribute("pathLength");
    });

    /* 线上按钮（原型 dellayer）：仅成对模式；位置 = 通道卡底边中心（连线起点旁）。
       真实实现无撤销窗口：off → ↔（连接），其余 → ×（断开并清理）。 */
    if (ops && selDir && selTool) {
      Channels.forEach((ch) => {
        if (!(S.types[ch] && targetOf(selTool, ch))) return;
        const c = el("ch:" + ch);
        if (!c) return;
        const cr = c.getBoundingClientRect();
        const off = channelState(selDir, selTool, ch) === "off";
        const t = S.tools.find((x) => x.id === selTool);
        const btn = document.createElement("button");
        btn.className = "cv-del-btn" + (off ? " link" : "");
        btn.innerHTML = off ? IconLink : IconUnlink; /* 纯 SVG 图标（用户口径） */
        btn.dataset["lane"] = laneKey(selDir, selTool, ch);
        btn.dataset["act"] = off ? "on" : "clean";
        btn.title = off
          ? `链接：全量同步并自动跟随（${t ? t.name : selTool} ← ${Ch[ch]}）`
          : `断连：取消这条连线（该工具内已同步的 ${Ch[ch]} 条目将被清理）`;
        /* 放在连线与卡片的交汇处：通道卡底边中心（线的出发点） */
        btn.style.left = `${cr.left - zr.left + cr.width / 2 - 14}px`;
        btn.style.top = `${cr.bottom - zr.top - 14}px`;
        ops.appendChild(btn);
      });
    }
  }

  /* ---------------- 条目面板（右上浮动，三视图） ---------------- */

  function pairStat(d: LocalDir, toolId: string): { pill: string; txt: string } {
    const t = S.tools.find((x) => x.id === toolId);
    const sts = Channels.map((ch) => ({
      ch,
      st: channelState(d.id, toolId, ch),
      tgt: !!targetOf(toolId, ch),
    }));
    const total = (d.counts.skills || 0) + (d.counts.mcp || 0);
    const on = sts.filter((x) => x.st !== "off");
    if (!on.length) {
      return {
        pill: '<span class="cv-pill">未链接</span>',
        txt: `连接后将立即把目录内 ${total} 个条目全量同步到 ${esc(t ? t.name : toolId)}，并持续跟随变化；工具内已有文件不受影响。`,
      };
    }
    const follow = on.reduce((a, x) => {
      const list = S.items[x.ch] || [];
      const ex = laneExcluded(d.id, toolId, x.ch);
      return (
        a +
        (list.length
          ? list.length - [...ex].filter((n) => list.includes(n)).length
          : d.counts[x.ch] || 0)
      );
    }, 0);
    const pausedAny = on.some((x) => x.st === "paused");
    const firstCh = on[0]?.ch ?? "skills";
    const chTxt =
      on.length < 2
        ? `仅 ${Ch[firstCh]} 通道已链接（${Ch[firstCh === "skills" ? "mcp" : "skills"]} 通道未链接）`
        : `跟随 ${follow} / 共 ${total} 条`;
    const full = on.length === 2 && on.every((x) => x.st === "full");
    const allPaused = on.every((x) => x.st === "paused");
    let pill: string;
    if (allPaused) pill = '<span class="cv-pill">已链接 · 暂停自动同步</span>';
    else if (full) pill = '<span class="cv-pill ok">全链接</span>';
    else pill = '<span class="cv-pill part">部分链接</span>';
    let txt = full
      ? `全部 ${total} 条跟随中，自动同步——目录内变化实时同步到工具。取消勾选条目即改为部分链接。`
      : `${chTxt} —— 取消勾选条目即排除（工具内保留已装文件）。`;
    if (pausedAny) txt += " 有通道暂停自动同步：点该通道的灰虚线恢复。";
    return { pill, txt };
  }

  /* 条目行：名称胶囊 + 6 个工具色点（点胶囊切当前工具，点圆点切该工具） */
  function itemRow(name: string, ch: Channel): string {
    const dots = S.tools
      .map((t) => {
        const has = !!targetOf(t.id, ch);
        const on = has && itemOn(name, S.selDir, t.id, ch);
        const sel = S.selTool === t.id;
        return `<span class="cv-tmini ${on ? "on" : ""}${sel ? " sel" : ""}"
        data-item="${esc(name)}" data-tool="${t.id}" data-ch="${ch}"
        title="${esc(t.name)}：${has ? (on ? "跟随中" + (sel ? "（当前编辑工具，外圈标示）" : "，点击切换此工具") : "未跟随" + (sel ? "（当前编辑工具）" : "，点击切换此工具")) : "该工具无对应目标"}">
        <span class="tool-dot ${toolDotCls(t)}"></span></span>`;
      })
      .join("");
    let cls = "",
      tip = `${name}：点右侧圆点切换对应工具的跟随`;
    const selTool = S.selTool;
    if (selTool) {
      const on = itemOn(name, S.selDir, selTool, ch);
      cls = on ? "on" : "off";
      const t = S.tools.find((x) => x.id === selTool);
      tip = `${name}：${on ? "跟随中，点击排除" : "未跟随，点击恢复"} ${t ? t.name : ""}（工具内文件保留）`;
    }
    return `<span class="cv-citem" data-t="${esc(name)}" data-ch="${ch}" title="${esc(tip)}">
      <span class="cv-cname ${cls}">${esc(name)}</span><span class="cv-dots">${dots}</span></span>`;
  }

  function chipFlow(): string {
    let h = "";
    const groups: [Channel, string, string[]][] = [
      ["skills", "SKILLS", S.items.skills],
      ["mcp", "MCP", S.items.mcp],
    ];
    for (const [ch, label, items] of groups) {
      if (!S.types[ch]) continue; /* 类型卡未选中 → 该组不显示（与画布过滤同口径） */
      h += `<div class="cv-cgroup"><span class="lab">${label}</span><span class="rule"></span><span class="n">${items.length}</span></div>`;
      h += items.length
        ? `<div class="cv-cflow">${items.map((n) => itemRow(n, ch)).join("")}</div>`
        : `<div class="cv-restline">此目录没有 ${label} 条目</div>`;
    }
    if (!h) h = '<div class="cv-restline">两类都已关闭 —— 点上方 Skills / MCP 卡片可重新开启</div>';
    return h;
  }

  function renderPanel(): void {
    const p = byId("cv-panel");
    if (!p) return;
    const repo = S.repos.find((r) => r.id === S.selRepo);
    const d = S.dirs.find((x) => x.id === S.selDir);
    const selTool = S.selTool;
    if (!(repo || d || selTool)) {
      p.hidden = true;
      p.innerHTML = "";
      S._panelShown = false;
      p.classList.remove("is-in", "is-pair");
      return;
    }
    p.hidden = false;
    if (!S._panelShown) {
      p.classList.add("is-in");
      S._panelShown = true;
    }
    const t = S.tools.find((x) => x.id === selTool);
    if (repo) {
      renderRepoPanel(p, repo);
      return;
    }

    let ttl: string, stat: string, list: string;
    if (d && selTool) {
      /* 成对编辑：目录 × 工具（连接/断开走画布连线与线上按钮，面板只做信息与条目跟随） */
      const ps = pairStat(d, selTool);
      ttl = `${d.name} → ${t ? t.name : selTool}`;
      const modeRows = Channels.filter(
        (ch) =>
          S.types[ch] &&
          targetOf(selTool, ch) &&
          (laneOn(d.id, selTool, ch) || S.stage.get(laneKey(d.id, selTool, ch))),
      )
        .map((ch) => {
          const cur = laneMode(d.id, selTool, ch);
          const st = S.stage.get(laneKey(d.id, selTool, ch));
          const b = baseBind(d.id, selTool, ch);
          const pending =
            st !== undefined && st.mode !== undefined && st.mode !== (b ? b.mode : "copy");
          return `<div class="cv-mrow"><span class="cv-mlab">${Ch[ch]}</span>
          <span class="cv-mode" data-dir="${d.id}" data-tool="${selTool}" data-ch="${ch}">
            <button data-mode="copy" class="${cur === "copy" ? "sel" : ""}" title="把目录条目实体复制进工具目录">复制</button>
            <button data-mode="link" class="${cur === "link" ? "sel" : ""}" title="在工具目录放指向本地库的软链接，内容自动跟随">链接</button>
          </span>${pending ? '<span class="cv-pill part">待确认</span>' : ""}</div>`;
        })
        .join("");
      stat =
        `${ps.pill}<span class="txt">${ps.txt}</span>` +
        (modeRows ? `<div class="cv-modes">${modeRows}</div>` : "");
      list = chipFlow();
    } else if (d) {
      const nTools = S.tools.filter((tt) => aggState(d.id, tt.id)).length;
      ttl = d.name;
      stat = `<span class="cv-pill ${nTools ? "ok" : ""}">${nTools ? `已链接 ${nTools} 个工具` : "未链接任何工具"}</span>
        <span class="txt">行内圆点 = 该条目对每个工具的跟随开关；点击可单条连接/排除。点工具卡可成对编辑。</span>`;
      list = chipFlow();
    } else {
      /* 仅选工具：来源列表，点击行回到成对编辑 */
      if (!selTool) return;
      const rows = S.dirs
        .map((dd) => ({ d: dd, st: aggState(dd.id, selTool) }))
        .filter((x): x is { d: LocalDir; st: LaneVisual } => x.st !== null);
      const nItems = rows.reduce((a, x) => a + (x.d.counts.skills || 0) + (x.d.counts.mcp || 0), 0);
      ttl = t ? t.name : selTool;
      stat = `<span class="cv-pill ${rows.length ? "ok" : ""}">${
        rows.length ? `接入 ${rows.length} 个来源 · ${nItems} 条` : "未接入任何目录 / 仓库"
      }</span>
        <span class="txt">选中目录后即成对编辑；连线在通道卡与工具卡之间，点击暂停 / 恢复自动同步。</span>`;
      list = rows.length
        ? rows
            .map(
              (x) =>
                `<div class="cv-brow" data-go="${x.d.id}"><span class="tool-dot ${t ? toolDotCls(t) : ""}"></span>
          <span class="nm">${esc(x.d.name)}</span>
          <span class="st ${x.st === "full" ? "ok" : "part"}">${
            x.st === "full"
              ? `完整跟随 ${(x.d.counts.skills || 0) + (x.d.counts.mcp || 0)} 条`
              : "部分跟随"
          }</span></div>`,
            )
            .join("")
        : '<div class="cv-restline">尚无连接。先点一个目录卡，再保持本工具卡选中，即可在右侧连接。</div>';
    }
    p.classList.toggle("is-pair", !!(d && selTool));
    p.innerHTML = `
      <div class="cv-iph"><b>${esc(ttl)}</b>
        <button class="cv-iph__x" id="cv-panel-x" title="收起">✕</button></div>
      <div class="cv-pstat">${stat}</div>
      <div class="cv-ipitems">${list}</div>`;

    const x = byId("cv-panel-x");
    if (x)
      x.onclick = () => {
        S.selDir = null;
        S.selTool = null;
        S.selRepo = null;
        renderAll();
      };
    qsa<HTMLElement>(".cv-mode button", p).forEach((b) => {
      b.onclick = () => {
        const box = b.closest<HTMLElement>(".cv-mode");
        if (!box) return;
        const dirId = Number(box.dataset["dir"] ?? "");
        const toolId = box.dataset["tool"] ?? "";
        const ch = box.dataset["ch"] as Channel | undefined;
        const mode = b.dataset["mode"];
        if (!ch || (mode !== "copy" && mode !== "link")) return;
        if (laneMode(dirId, toolId, ch) === mode) return;
        /* 保留暂停态：kind 取当前生效态，切模式不顺便恢复自动同步 */
        setStage(dirId, toolId, ch, {
          kind: lanePaused(dirId, toolId, ch) ? "paused" : "on",
          mode,
        });
        renderAll();
      };
    });
    qsa<HTMLElement>(".cv-brow[data-go]", p).forEach((r) => {
      r.onclick = () => {
        const go = r.dataset["go"];
        if (go === undefined) return;
        S.selDir = Number(go);
        loadItems()
          .then(renderAll)
          .catch(() => renderAll());
        renderAll();
      };
    });
  }

  function renderRepoPanel(p: HTMLElement, repo: RemoteRepo): void {
    const rows = Object.entries<SourceRow>(repo.sources || {})
      .map(
        ([kind, src]) => `
      <div class="cv-repo-row">
        <span class="cv-repo-row__kind">${kind === "mcp" ? "MCP" : "Skills"}</span>
        <span class="cv-repo-row__meta">${src.item_count || 0} 条 · ${esc(src.last_commit || "未拉取")}</span>
        <button class="hub-btn btn-sm" data-pull="${kind}:${src.id}">拉取</button>
      </div>`,
      )
      .join("");
    p.innerHTML = `
      <div class="cv-iph"><b>${esc(repo.name)}</b>
        <button class="cv-iph__x" id="cv-panel-x" title="收起">✕</button></div>
      <div class="cv-pstat"><span class="cv-pill">只读跟随上游</span>
        <span class="txt">分支 ${esc(repo.branch || "main")}${repo.subdir ? " · " + esc(repo.subdir) : ""} · ${esc(repo.url)}</span></div>
      <div class="cv-ipitems">${rows || '<div class="cv-restline">该仓库还没有启用模块</div>'}
        <div class="cv-restline">远程仓库只读跟随上游：拉取后条目进入本地库，连接工具请在左侧选本地目录操作。</div></div>`;
    const x = byId("cv-panel-x");
    if (x)
      x.onclick = () => {
        S.selRepo = null;
        renderAll();
      };
    qsa<HTMLElement>("[data-pull]", p).forEach((b) => {
      b.onclick = async () => {
        const pullKey = b.dataset["pull"] ?? "";
        const [kind = "", sid = ""] = pullKey.split(":");
        b.classList.add("is-loading");
        const r = await post<PullResult>(
          `/api/${kind === "mcp" ? "mcp" : "skills"}/sources/${sid}/pull`,
          {},
        );
        b.classList.remove("is-loading");
        HubUI.toast(
          r.data.ok ? "已拉取" : "拉取失败：" + (r.data.error ?? ""),
          r.data.ok ? "success" : "error",
        );
        await loadAll();
        renderAll();
      };
    });
  }

  /* ---------------- 组卡动作（弹窗沿用既有实现） ---------------- */

  /* 关联目录：唤起系统目录选择器，选中磁盘已有文件夹后登记为本地源 */
  async function linkDir(): Promise<void> {
    const r = await post<PullResult>("/api/local-dirs/pick", {});
    if (r.data.ok) {
      await loadAll();
      renderAll();
      HubUI.toast("已关联目录", "success");
    } else if (r.data.error) HubUI.toast(r.data.error, "error");
  }

  /* 移除本地目录登记（磁盘文件保留） */
  function removeDir(id: number): void {
    const d = S.dirs.find((x) => x.id === id);
    HubUI.confirm(
      "移除目录",
      `只移除「${esc(d ? d.name : id)}」的登记，磁盘文件不动。确定？`,
      async () => {
        const r = await send<PullResult>("/api/local-dirs/" + id, "DELETE");
        if (r.data.ok) {
          if (S.selDir === id) S.selDir = null;
          await loadAll();
          renderAll();
          HubUI.toast("目录已移除（磁盘文件保留）", "success");
        } else HubUI.toast(r.data.error || "移除失败", "error");
      },
      { danger: true },
    );
  }

  /* 拉取仓库的全部来源（skills / mcp），卡上图标转圈 */
  async function pullRepo(rid: string, btn: Element | null): Promise<void> {
    const repo = S.repos.find((r) => String(r.id) === String(rid));
    if (!repo) return;
    const card = btn ? btn.closest(".tcard") : null;
    if (card) card.classList.add("is-busy");
    const jobs = Object.entries<SourceRow>(repo.sources || {}).map(([kind, src]) =>
      post<PullResult>(`/api/${kind === "mcp" ? "mcp" : "skills"}/sources/${src.id}/pull`, {}),
    );
    const res = await Promise.all(jobs);
    if (card) card.classList.remove("is-busy");
    const ok = res.filter((r) => r.data.ok).length;
    HubUI.toast(`拉取完成：${ok}/${jobs.length} 成功`, ok === jobs.length ? "success" : "warn");
    await loadAll();
    renderAll();
  }

  /* 编辑仓库配置（名称 / 地址 / 分支） */
  function editRepo(rid: string): void {
    const repo = S.repos.find((r) => String(r.id) === String(rid));
    if (!repo) return;
    HubUI.modal({
      title: "编辑仓库",
      bodyHTML: `
        <label class="hub-field">名称<input class="hub-input" id="dlg-rname" value="${esc(repo.name)}"></label>
        <label class="hub-field">Git 地址<input class="hub-input" id="dlg-rurl" value="${esc(repo.url)}"></label>
        <label class="hub-field">分支<input class="hub-input" id="dlg-rbranch" value="${esc(repo.branch || "main")}"></label>`,
      confirmText: "保存",
      onConfirm: async (_v, close) => {
        const name = mustById<HTMLInputElement>("dlg-rname").value.trim();
        const url = mustById<HTMLInputElement>("dlg-rurl").value.trim();
        const branch = mustById<HTMLInputElement>("dlg-rbranch").value.trim() || "main";
        if (!(name && url)) {
          HubUI.toast("名称与地址必填", "error");
          return false;
        }
        const r = await send<PullResult>(`/api/remote-repos/${rid}`, "PATCH", {
          name,
          url,
          branch,
        });
        if (r.data.ok) {
          close();
          await loadAll();
          renderAll();
          HubUI.toast("仓库已更新", "success");
        } else HubUI.toast(r.data.error || "更新失败", "error");
        return true;
      },
    });
  }

  /* 移除仓库：删其全部来源（源删光后核心层顺带清掉仓库主记录） */
  function removeRepo(rid: string): void {
    const repo = S.repos.find((r) => String(r.id) === String(rid));
    if (!repo) return;
    const kinds = Object.entries<SourceRow>(repo.sources || {});
    HubUI.confirm(
      "移除仓库",
      `确认移除仓库「${esc(repo.name)}」及其 ${kinds.length} 个来源？已拉取到本地库的条目保留。`,
      async () => {
        let failed = 0;
        for (const [kind, src] of kinds) {
          const r = await send<PullResult>(
            `/api/${kind === "mcp" ? "mcp" : "skills"}/sources/${src.id}`,
            "DELETE",
          );
          if (!r.data.ok) failed += 1;
        }
        if (S.selRepo === Number(rid)) S.selRepo = null;
        await loadAll();
        renderAll();
        HubUI.toast(
          failed ? `有 ${failed} 个来源未能移除` : "仓库已移除（本地条目保留）",
          failed ? "error" : "success",
        );
      },
      { danger: true },
    );
  }

  function addRepoDialog(): void {
    HubUI.modal({
      title: "添加仓库",
      bodyHTML: `
        <label class="hub-field">名称<input class="hub-input" id="dlg-rname" placeholder="例如 team-skills"></label>
        <label class="hub-field">Git 地址<input class="hub-input" id="dlg-rurl" placeholder="https://…git"></label>
        <label class="hub-field">分支<input class="hub-input" id="dlg-rbranch" value="main"></label>`,
      confirmText: "添加",
      onConfirm: async (_v, close) => {
        const name = mustById<HTMLInputElement>("dlg-rname").value.trim();
        const url = mustById<HTMLInputElement>("dlg-rurl").value.trim();
        const branch = mustById<HTMLInputElement>("dlg-rbranch").value.trim() || "main";
        if (!(name && url)) {
          HubUI.toast("名称与地址必填", "error");
          return false;
        }
        const r = await post<PullResult>("/api/remote-repos", {
          name,
          url,
          branch,
          subdir: "",
          modules: ["skills"],
        });
        if (r.data.ok) {
          close();
          await loadAll();
          renderAll();
          HubUI.toast("仓库已添加", "success");
        } else HubUI.toast(r.data.error || "添加失败", "error");
        return true;
      },
    });
  }

  async function pullAllRepos(): Promise<void> {
    const jobs = S.repos.flatMap((r) =>
      Object.entries<SourceRow>(r.sources || {}).map(([kind, src]) =>
        post<PullResult>(`/api/${kind === "mcp" ? "mcp" : "skills"}/sources/${src.id}/pull`, {}),
      ),
    );
    if (!jobs.length) {
      HubUI.toast("还没有可拉取的仓库", "warn");
      return;
    }
    HubUI.toast(`开始拉取 ${jobs.length} 个源…`, "info");
    const res = await Promise.all(jobs);
    const ok = res.filter((r) => r.data.ok).length;
    await loadAll();
    renderAll();
    HubUI.toast(`拉取完成：${ok}/${jobs.length} 成功`, ok === jobs.length ? "success" : "warn");
  }

  /* ---------------- 交互 ---------------- */

  function bindEvents(root: HTMLElement): void {
    root.addEventListener("click", (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      /* 卡片悬停动作（拉取/编辑/移除）：须先于卡分支，且不冒泡成选中 */
      const actBtn = target.closest<HTMLElement>(".tcard[data-src] [data-act]");
      if (actBtn) {
        const srcId = actBtn.closest(".tcard")?.getAttribute("data-src") || "";
        const act = actBtn.dataset["act"];
        if (act === "dirdel") removeDir(+srcId.slice(4));
        else if (act === "pull") pullRepo(srcId.slice(5), actBtn);
        else if (act === "edit") editRepo(srcId.slice(5));
        else if (act === "del") removeRepo(srcId.slice(5));
        return;
      }
      /* 动作按钮在可折叠组面板（data-gfold）内部：必须先判按钮，否则点击被折叠分支吞掉 */
      const gact = target.closest<HTMLElement>("[data-gact]");
      if (gact) {
        const label = gact.dataset["gact"]?.split(":")[1];
        const map: Record<string, () => void | Promise<void>> = {
          关联目录: linkDir,
          添加仓库: addRepoDialog,
          全部拉取: pullAllRepos,
        };
        const fn = label === undefined ? undefined : map[label];
        if (fn) fn();
        return;
      }
      const fold = target.closest<HTMLElement>("[data-gfold]");
      if (fold) {
        fold.closest(".srcgroup")?.classList.toggle("is-closed");
        return;
      }
      const card = target.closest<HTMLElement>(".tcard[data-src]");
      if (card) {
        const k = card.getAttribute("data-src");
        if (!k) return;
        if (k.startsWith("dir:")) {
          const id = +k.slice(4);
          if (S.selDir === id) {
            S.selDir = null;
            renderAll();
            return;
          }
          S.selDir = id;
          S.selTool = null;
          S.selRepo = null;
          S.types = {
            skills: true,
            mcp: true,
          }; /* 每次进入新的目录上下文，类型卡回到双选（原型口径） */
          renderAll();
          qs<HTMLElement>(`#cv-dirs .tcard[data-src="dir:${id}"]`)?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
          loadItems()
            .then(renderAll)
            .catch(() => renderAll());
        } else if (k.startsWith("repo:")) {
          const id = +k.slice(5);
          S.selRepo = S.selRepo === id ? null : id;
          if (S.selRepo) {
            S.selDir = null;
            S.selTool = null;
          }
          renderAll();
        } else if (k.startsWith("ch:")) {
          const ch = k.slice(3) as Channel;
          S.types[ch] = !S.types[ch];
          renderAll();
        } else {
          S.selTool = S.selTool === k.slice(5) ? null : k.slice(5);
          renderAll();
          if (S.selTool) {
            qs<HTMLElement>(`#cv-tools .tcard[data-src="tool:${S.selTool}"]`)?.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            });
          }
        }
        return;
      }
      const delBtn = target.closest<HTMLElement>(".cv-del-btn");
      if (delBtn) {
        const act = delBtn.dataset["act"];
        if (!act) return; /* is-na：该工具无此通道目标，不可链接 */
        const [dirId = "", toolId = "", ch = ""] = (delBtn.dataset["lane"] ?? "").split(":");
        setStage(+dirId, toolId, ch as Channel, { kind: act as StageKind });
        renderAll();
        return;
      }
      const lane = target.closest<HTMLElement>(".cv-lineg[data-lane], .cv-line[data-lane]");
      if (lane) {
        const [dirId = "", toolId = "", ch = ""] = (lane.dataset["lane"] ?? "").split(":");
        /* 口径（用户 2026-11-05）：绿线(自动同步)点击 → 暂停(灰虚线，不自动同步)；
           灰虚线(已链接不自动同步)点击 → 全链接自动同步 = 恢复 + 清空排除 */
        const st = channelState(+dirId, toolId, ch as Channel);
        if (st === "paused" || st === "blocked")
          setStage(+dirId, toolId, ch as Channel, { kind: "on", excluded: [] });
        else setStage(+dirId, toolId, ch as Channel, { kind: "paused" });
        renderAll();
        return;
      }
      const dot = target.closest<HTMLElement>(".cv-tmini");
      if (dot && S.selDir) {
        const item = dot.dataset["item"];
        const toolId = dot.dataset["tool"];
        const ch = dot.dataset["ch"] as Channel | undefined;
        if (item !== undefined && toolId !== undefined && ch !== undefined)
          toggleItem(item, toolId, ch);
        return;
      }
      const citem = target.closest<HTMLElement>(".cv-citem");
      if (citem && S.selDir && S.selTool) {
        const item = citem.dataset["t"];
        const ch = citem.dataset["ch"] as Channel | undefined;
        if (item !== undefined && ch !== undefined) toggleItem(item, S.selTool, ch);
        return;
      }
      if (
        !target.closest(
          ".cv-ipanel, .cv__apply, .cv__lines, .cv__lane-ops, .hub-modal, .hub-btn",
        ) &&
        (S.selDir || S.selTool || S.selRepo)
      ) {
        S.selDir = null;
        S.selTool = null;
        S.selRepo = null;
        renderAll();
      }
    });
    mustById("cv-undo").onclick = () => {
      S.stage.clear();
      renderAll();
      HubUI.toast("已撤销未生效的更改", "info");
    };
    mustById("cv-confirm").onclick = applyStage;
    window.addEventListener("resize", () => drawLines());
    /* 面板开合改变主列宽、行内滚动移动卡片 —— 都不触发 resize，用 ResizeObserver / scroll 兜住（原型口径） */
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => drawLines());
      const zone = byId("cv-zone");
      const panel = byId("cv-panel");
      if (zone) ro.observe(zone);
      if (panel) ro.observe(panel);
    }
    const srcrow = byId("cv-dirs");
    const toolsrow = byId("cv-toolsrow");
    if (srcrow) srcrow.addEventListener("scroll", () => drawLines(), { passive: true });
    if (toolsrow) toolsrow.addEventListener("scroll", () => drawLines(), { passive: true });
  }

  function toggleItem(item: string, toolId: string, ch: Channel): void {
    if (!S.selDir) return;
    if (laneState(S.selDir, toolId, ch) !== "on") {
      HubUI.toast("该通道未链接——点通道卡下方 ↔ 先建立链接", "warn");
      return;
    }
    const ex = laneExcluded(S.selDir, toolId, ch);
    if (ex.has(item)) ex.delete(item);
    else ex.add(item);
    setStage(S.selDir, toolId, ch, { excluded: [...ex] });
    renderAll();
  }

  /* ---------------- 生效 ---------------- */

  async function applyStage(): Promise<void> {
    const entries = sm.stageEntries(S);
    if (!entries.length) return;
    const btn = mustById("cv-confirm");
    btn.classList.add("is-loading");
    let failed = 0;
    for (const [key, op] of entries) {
      const [dirId = "", toolId = "", ch = ""] = key.split(":");
      const tgt = targetOf(toolId, ch as Channel);
      let bind: DirBinding | null = baseBind(dirId, toolId, ch as Channel);
      try {
        if (op.kind === "on" || op.kind === "paused") {
          /* 链接/恢复：无绑定先建；再按口径设置自动同步开关 */
          if (!bind && tgt) {
            const r = await post<PullResult>("/api/skills/dir-bindings", {
              dir_id: +dirId,
              target_ids: [tgt.id],
              mode: op.mode || "copy",
            });
            if (!r.data.ok) failed += 1;
            bind = baseBind(dirId, toolId, ch as Channel);
          }
          if (!bind) {
            failed += 1;
            continue;
          }
          const r2 = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
            enabled: op.kind !== "paused",
          });
          if (!r2.data.ok) failed += 1;
          /* 暂存的同步模式（复制⇄链接）：与现值不同即 PATCH，后端切换并重同步 */
          if (op.mode && bind.mode !== op.mode) {
            const r3 = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
              mode: op.mode,
            });
            if (!r3.data.ok) failed += 1;
          }
        } else if (op.kind === "clean" && bind) {
          const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}?clean=1`, "DELETE");
          if (!r.data.ok) failed += 1;
          bind = null;
        }
        if (bind && op.excluded) {
          const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
            excluded: op.excluded,
          });
          if (!r.data.ok) failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    btn.classList.remove("is-loading");
    S.stage.clear();
    await loadAll();
    renderAll();
    HubUI.toast(
      failed ? `有 ${failed} 项未能生效` : "已生效：连接变更已保存",
      failed ? "error" : "success",
    );
  }

  /* ---------------- 渲染入口 ---------------- */

  function renderMetastrip(): void {
    const dirCount = (d: LocalDir): number => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = (r: RemoteRepo): number =>
      Object.values<SourceRow>(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    const localN = S.dirs.reduce((a, d) => a + dirCount(d), 0);
    const remoteN = S.repos.reduce((a, r) => a + repoCount(r), 0);
    /* 已部署到工具：各 (目录×工具×通道) 跟随中的条目数之和（blocked 不计） */
    const deployed = S.dirs.reduce(
      (a, d) =>
        a +
        S.tools.reduce(
          (s, t) =>
            s +
            Channels.reduce((s2, ch) => {
              const st = channelState(d.id, t.id, ch);
              if (st === "off" || st === "blocked") return s2;
              return (
                s2 +
                (d.counts[ch] || 0) -
                Math.min(laneExcluded(d.id, t.id, ch).size, d.counts[ch] || 0)
              );
            }, 0),
          0,
        ),
      0,
    );
    const set = (id: string, v: number): void => {
      const el = byId(id);
      if (el) el.textContent = String(v);
    };
    set("cv-st-all", localN + remoteN);
    set("cv-st-local", localN);
    set("cv-st-remote", remoteN);
    set("cv-st-deployed", deployed);
  }

  function renderAll(): void {
    renderMetastrip();
    renderDirs();
    renderTypes();
    renderTools();
    renderPanel();
    const bar = byId("cv-apply");
    if (bar) {
      const n = S.stage.size;
      bar.hidden = !(n > 0 && (S.selDir || S.selTool));
      const el = byId("cv-apply-n");
      if (el) el.textContent = String(n);
    }
    const view = byId("view-connect");
    if (window.HubUI && HubUI.drawFrames && view) {
      HubUI.drawFrames(view); /* 选中卡 accent 描边路径（记忆页同款） */
    }
    drawLines(); /* 同步绘制：后台标签页 rAF 会被节流，连线会消失 */
  }

  async function render(root: HTMLElement): Promise<void> {
    root.innerHTML = shell();
    console.log("[connect] build", Build);
    bindEvents(root);
    await loadAll();
    renderAll();
  }

  async function refresh(): Promise<void> {
    const root = byId("view-connect");
    if (!(root && root.querySelector(".cv"))) return;
    await loadAll();
    renderAll();
  }

  return { render, refresh, _state: S };
})();
