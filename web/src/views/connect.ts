/* 连接画布（Skills / MCP 合并页）——三行看板 + 连线层。
   四态连线（2026-11-14 口径收敛）：绿实=全链接自动同步 / 绿虚=部分链接自动同步 /
   灰虚=已链接不自动同步 / 无连线=不画线。所有点击直接落库——原型「编辑态」的
   暂存确认层（红线 / 右下确认条）已删，见 FIGMA_OVERRIDES.md 2026-11-14 条目。
   2026-11-17 补原型缺口（依旧全部点击即落库，不引入任何暂存中间态）：
   ① 图例可点选过滤连线 ② 面板条目搜索 ③ 成对批量全跟随/全排除 + 只看排除
   ④ 未链接点条目圆点 = 建链并只跟随这一条 ⑤ 工具卡 hover 快捷接/断（断开走二次确认）
   ⑥ 上游从属线点击 = 批量暂停/恢复该通道全部连线。 */

import { api, post, send } from "../core/api.ts";
import { byId, mustById, qs, qsa } from "../core/dom.ts";
import { esc } from "../core/format.ts";
import { MV } from "../core/mv.ts";
import type { CanvasState, Channel, LaneVisual } from "../core/state-machine.ts";
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

/** 图例过滤键（原型 activeLegendFilter 口径；blocked 视觉同灰虚，归入 paused 组）。 */
type LegendFilter = "full" | "part" | "paused";

/** 画布状态：状态机契约 + 视图专有字段（目录 / 仓库用真实 API 类型）。 */
interface ConnectState extends CanvasState {
  dirs: LocalDir[];
  repos: RemoteRepo[];
  _panelShown: boolean;
  legend: LegendFilter | null /* 点图例聚焦同类线；null = 不过滤 */;
  q: string /* 面板条目搜索词 */;
  onlyEx: boolean /* 成对视图：只看被排除条目 */;
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
    panelShown: false,
    _panelShown: false,
    legend: null,
    q: "",
    onlyEx: false,
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
  function laneExcluded(dirId: DirIdLike, toolId: string, ch: Channel): Set<string> {
    return sm.laneExcluded(S, normDir(dirId), toolId, ch);
  }
  function laneMode(dirId: DirIdLike, toolId: string, ch: Channel): "copy" | "link" {
    return sm.laneMode(S, normDir(dirId), toolId, ch);
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

  const Build = "20261117-1"; /* 构建标记：DevTools 里看 .cv[data-build] 即知页面加载的是哪版 */

  function shell(): string {
    return `
      <div class="cv" data-build="${Build}">
        <div class="cv-metastrip">
          <span><b id="cv-st-all">0</b>条目 · 全部来源</span>
          <span class="muted"><b id="cv-st-local">0</b>本地</span>
          <span><b id="cv-st-remote">0</b>远程拉取</span>
          <span><b id="cv-st-deployed">0</b>已部署到工具</span>
          <span class="cv-sep"></span>
          <button class="cv-lf" data-lf="full" data-testid="cv-lf-full" title="点选：只亮「全链接」连线，再点取消"><i class="cv-lswatch is-full"></i>全链接 · 自动同步</button>
          <button class="cv-lf" data-lf="part" data-testid="cv-lf-part" title="点选：只亮「部分链接」连线，再点取消"><i class="cv-lswatch is-part"></i>部分链接 · 自动同步</button>
          <button class="cv-lf" data-lf="paused" data-testid="cv-lf-paused" title="点选：只亮灰虚线（含全部排除），再点取消"><i class="cv-lswatch is-paused"></i>已链接 · 不自动同步</button>
          <span><i class="cv-bdot off"></i>无连线 = 无链接</span>
          <span class="cv-rule">点连线 = 暂停/恢复自动同步 · 卡上 × = 断连 · ↔ = 链接 · 选中目录后展示真链路 · 类型卡多选、工具卡单选 · 点图例过滤连线</span>
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
        .join("|")
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
    /* 工具卡快捷接 / 断（原型 onQuickToggleSourceToolLink 口径）：选中目录后 hover 工具卡露出；
       每轮先清后插，随选中态与连线态刷新（断开为破坏性动作，按钮态随连线翻转） */
    qsa<HTMLElement>(".cv-quick", host).forEach((b) => {
      b.remove();
    });
    const qdid = S.selDir;
    if (qdid) {
      const dn = S.dirs.find((x) => x.id === qdid);
      qsa<HTMLElement>('.tcard[data-src^="tool:"]', host).forEach((el) => {
        const tid = (el.getAttribute("data-src") ?? "").slice(5);
        const t0 = S.tools.find((x) => x.id === tid);
        const linked = aggState(qdid, tid) !== null;
        const label = `${dn ? dn.name : qdid} → ${t0 ? t0.name : tid}`;
        el.insertAdjacentHTML(
          "beforeend",
          `<button class="cv-quick${linked ? " is-unlink" : ""}" data-quick="${linked ? "unlink" : "link"}" data-tool="${esc(tid)}"
          data-testid="cv-quick-${esc(tid)}" title="${linked ? `断开 ${esc(label)} 的全部连线（清理该工具内已同步条目）` : `链接 ${esc(label)}（双通道，复制模式）`}">${linked ? IconUnlink : IconLink}</button>`,
        );
      });
    }
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

    /* 期望的连线集合：weak = 目录底部中心 → 通道卡顶部中心（单起点，绿实线，可点批量暂停/恢复）；
       lane = 通道卡底部 → 工具卡顶部，四态。聚焦工具时只画选中者的 lane 线。 */
    const want: WantLine[] = [];
    const selDir = S.selDir;
    const selTool = S.selTool;
    /* 图例过滤（原型 activeLegendFilter 口径）：blocked 视觉同灰虚，归入 paused 组 */
    const lfMatch = (st: LaneVisual): boolean =>
      !S.legend ||
      (S.legend === "full"
        ? st === "full"
        : S.legend === "part"
          ? st === "part"
          : st === "paused" || st === "blocked");
    const dirName = S.dirs.find((x) => x.id === selDir)?.name ?? "";
    const dirEl = selDir ? el("dir:" + selDir) || el("repo:" + selDir) : null;
    if (dirEl) {
      const fromDir = pt(dirEl, "bottom");
      const anyOn = S.types.skills || S.types.mcp;
      const weakDim = !!S.legend && S.legend !== "full";
      Channels.forEach((ch) => {
        const c = el("ch:" + ch);
        if (c && !(anyOn && !S.types[ch])) {
          want.push({
            key: `w:${selDir}:${ch}`,
            cls: "cv-line cv-line--weak" + (weakDim ? " is-dim" : ""),
            solid: true,
            d: seg(fromDir, pt(c, "top")),
            title: `批量暂停 / 恢复：${dirName} → ${Ch[ch]} 的全部连线`,
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
          const toolEl = el(`tool:${t.id}`);
          if (!toolEl) return;
          want.push({
            key: laneKey(selDir, t.id, ch),
            cls: "cv-line" + (lfMatch(st) ? "" : " is-dim"),
            st,
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
    qsa<SVGElement>(".cv-lineg[data-lane], .cv-weakg[data-lane]", svg).forEach((n) => {
      const laneName = n.dataset["lane"];
      const marked = n as SVGElement & { _leaving?: boolean };
      if ((laneName !== undefined && wantKeys.has(laneName)) || marked._leaving) return;
      const isGroup = n.classList.contains("cv-lineg") || n.classList.contains("cv-weakg");
      const ghost = n.cloneNode(true) as SVGElement;
      const gvis = isGroup ? qs<SVGElement>(".cv-line", ghost) : ghost;
      if (!gvis) return;
      marked._leaving = true;
      /* 实线（绿实/从属线）收起；虚线（is-part / is-paused）无收起形态 → 淡出 */
      const solid = !(gvis.classList.contains("is-part") || gvis.classList.contains("is-paused"));
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
        /* 从属线成组：命中线 + 实线，组可点（批量暂停/恢复），title 提供可发现性 */
        return `<g class="cv-weakg" data-lane="${o.key}">
        ${o.title ? `<title>${esc(o.title)}</title>` : ""}
        <path class="cv-hit" d="${o.d}"></path>
        <path class="${o.cls} is-in" pathLength="100" d="${o.d}"></path>
      </g>`;
      }
      const extra = o.st === "full" ? " is-on is-in" : ` ${stSuffix(o.st)} is-fade`;
      return `<g class="cv-lineg" data-lane="${o.key}">
        <path class="cv-hit" d="${o.d}"></path>
        <path class="${o.cls}${extra}"${o.st === "full" ? ' pathLength="100"' : ""} data-lane="${o.key}" d="${o.d}">${o.title ? `<title>${esc(o.title)}</title>` : ""}</path>
      </g>`;
    };
    want.forEach((o) => {
      const n = o.solid
        ? svg.querySelector<Element>(`.cv-weakg[data-lane="${o.key}"]`)
        : svg.querySelector<Element>(`.cv-lineg[data-lane="${o.key}"]`);
      if (!n) {
        svg.insertAdjacentHTML("beforeend", build(o));
        return;
      }
      const vis = qs<Element>(".cv-line", n);
      if (!vis) return;
      /* 原地更新：路径/状态变了靠 CSS stroke 过渡，不重播画入 */
      if (vis.getAttribute("d") !== o.d) {
        vis.setAttribute("d", o.d);
        const rp = qs<Element>(".reveal", vis);
        if (rp) rp.setAttribute("d", o.d);
        const hit = qs<Element>(".cv-hit", n);
        if (hit) hit.setAttribute("d", o.d);
      }
      if (o.solid) return;
      const cls = o.cls + stSuffix(o.st);
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
    const q = S.q.trim().toLowerCase();
    const filtering = !!q || (S.onlyEx && !!S.selTool);
    let h = "";
    const groups: [Channel, string, string[]][] = [
      ["skills", "SKILLS", S.items.skills],
      ["mcp", "MCP", S.items.mcp],
    ];
    for (const [ch, label, items] of groups) {
      if (!S.types[ch]) continue; /* 类型卡未选中 → 该组不显示（与画布过滤同口径） */
      /* 原型 searchQuery / onlyExcluded 口径：按名称包含 + 只看排除（成对视图） */
      const shown = items.filter((n) => {
        if (q && !n.toLowerCase().includes(q)) return false;
        if (S.onlyEx && S.selTool && !laneExcluded(S.selDir, S.selTool, ch).has(n)) return false;
        return true;
      });
      h += `<div class="cv-cgroup"><span class="lab">${label}</span><span class="rule"></span><span class="n">${filtering ? `${shown.length}/${items.length}` : items.length}</span></div>`;
      h += items.length
        ? shown.length
          ? `<div class="cv-cflow">${shown.map((n) => itemRow(n, ch)).join("")}</div>`
          : `<div class="cv-restline">${q || S.onlyEx ? "无匹配条目" : "此目录没有 " + label + " 条目"}</div>`
        : `<div class="cv-restline">此目录没有 ${label} 条目</div>`;
    }
    if (!h) h = '<div class="cv-restline">两类都已关闭 —— 点上方 Skills / MCP 卡片可重新开启</div>';
    return h;
  }

  /* 只重绘条目清单：搜索输入 / 只看排除切换时不整板重建，保住输入焦点与光标 */
  function renderPanelList(): void {
    const host = byId("cv-ipitems");
    if (host) host.innerHTML = chipFlow();
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
      S.q = "";
      S.onlyEx = false; /* 面板全关：搜索词 / 只看排除一并复位 */
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
        (ch) => S.types[ch] && targetOf(selTool, ch) && laneOn(d.id, selTool, ch),
      )
        .map((ch) => {
          const cur = laneMode(d.id, selTool, ch);
          return `<div class="cv-mrow"><span class="cv-mlab">${Ch[ch]}</span>
          <span class="cv-mode" data-dir="${d.id}" data-tool="${selTool}" data-ch="${ch}">
            <button data-mode="copy" class="${cur === "copy" ? "sel" : ""}" title="把目录条目实体复制进工具目录">复制</button>
            <button data-mode="link" class="${cur === "link" ? "sel" : ""}" title="在工具目录放指向本地库的软链接，内容自动跟随">链接</button>
          </span></div>`;
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
    /* 条目工具行（原型 searchQuery / batch / onlyExcluded 口径）：目录视图只有搜索；成对视图加批量与只看排除 */
    const isPair = !!(d && selTool);
    const bar =
      d && !repo
        ? `<div class="cv-itoolbar">
        <input id="cv-q" class="hub-input cv-q" placeholder="搜索条目…" value="${esc(S.q)}" data-testid="cv-q">${
          isPair
            ? `<button class="cv-bbtn" data-batch="follow" data-testid="cv-batch-follow" title="取消全部排除，恢复全量跟随">全部跟随</button>
        <button class="cv-bbtn" data-batch="exclude" data-testid="cv-batch-exclude" title="排除全部条目（连线转灰虚，工具内文件保留）">全部排除</button>
        <button class="cv-bbtn${S.onlyEx ? " is-on" : ""}" data-onlyex data-testid="cv-onlyex" title="只显示被排除的条目">只看排除</button>`
            : ""
        }
      </div>`
        : "";
    p.innerHTML = `
      <div class="cv-iph"><b>${esc(ttl)}</b>
        <button class="cv-iph__x" id="cv-panel-x" title="收起">✕</button></div>
      <div class="cv-pstat">${stat}</div>
      ${bar}
      <div class="cv-ipitems" id="cv-ipitems">${list}</div>`;

    const x = byId("cv-panel-x");
    if (x)
      x.onclick = () => {
        S.selDir = null;
        S.selTool = null;
        S.selRepo = null;
        renderAll();
      };
    const qin = byId<HTMLInputElement>("cv-q");
    if (qin) {
      qin.oninput = () => {
        S.q = qin.value;
        renderPanelList();
      };
      if (S.q) {
        /* renderAll 重建面板后恢复搜索焦点与光标（输入态不因点圆点等操作丢失） */
        qin.focus();
        qin.setSelectionRange(qin.value.length, qin.value.length);
      }
    }
    qsa<HTMLElement>("[data-batch]", p).forEach((b) => {
      b.onclick = () => void batchItems(b.dataset["batch"] === "follow");
    });
    const ox = qs<HTMLElement>("[data-onlyex]", p);
    if (ox)
      ox.onclick = () => {
        S.onlyEx = !S.onlyEx;
        ox.classList.toggle("is-on", S.onlyEx);
        renderPanelList();
      };
    qsa<HTMLElement>(".cv-mode button", p).forEach((b) => {
      b.onclick = async () => {
        const box = b.closest<HTMLElement>(".cv-mode");
        if (!box) return;
        const dirId = Number(box.dataset["dir"] ?? "");
        const toolId = box.dataset["tool"] ?? "";
        const ch = box.dataset["ch"] as Channel | undefined;
        const mode = b.dataset["mode"];
        if (!ch || (mode !== "copy" && mode !== "link")) return;
        const bind = baseBind(dirId, toolId, ch);
        if (!bind) return;
        if (bind.mode === mode) return;
        /* 点击即落库：后端切模式并重同步 */
        b.classList.add("is-loading");
        const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", { mode });
        b.classList.remove("is-loading");
        if (r.data.ok) {
          await loadAll();
          renderAll();
          HubUI.toast("同步模式已切换", "success");
        } else HubUI.toast(r.data.error || "同步模式切换失败", "error");
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
      /* 工具卡快捷接/断（原型 onQuickToggleSourceToolLink 口径）：先于卡分支拦下，不触发选中 */
      const quick = target.closest<HTMLElement>(".cv-quick[data-tool]");
      if (quick) {
        const toolId = quick.dataset["tool"] ?? "";
        if (toolId && S.selDir)
          void quickToggleSourceTool(quick.dataset["quick"] === "unlink", toolId);
        return;
      }
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
      /* 图例点选过滤（原型 activeLegendFilter 口径）：高亮同类线，再点取消 */
      const lfBtn = target.closest<HTMLElement>("[data-lf]");
      if (lfBtn) {
        const lf = lfBtn.dataset["lf"] as LegendFilter | undefined;
        S.legend = S.legend === lf ? null : lf || null;
        renderAll();
        return;
      }
      const card = target.closest<HTMLElement>(".tcard[data-src]");
      if (card) {
        const k = card.getAttribute("data-src");
        if (!k) return;
        /* 选中目录 / 仓库 / 工具卡时清掉图例过滤（原型 handleSelectSource/ToolCard 口径）；类型卡不清 */
        if (!k.startsWith("ch:")) S.legend = null;
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
        if (act === "clean") {
          /* 破坏性动作保留一道二次确认（确认对话框 ≠ 暂存层）：断连会清理该工具内已同步条目 */
          const tool = S.tools.find((x) => x.id === toolId);
          HubUI.confirm(
            "断连",
            `将断开 ${Ch[ch as Channel]} → ${esc(tool ? tool.name : toolId)}，该工具内已同步的 ${Ch[ch as Channel]} 条目会被清理。确定？`,
            () => void applyLaneOp(+dirId, toolId, ch as Channel, "clean"),
            { danger: true },
          );
        } else {
          void applyLaneOp(+dirId, toolId, ch as Channel, act as "on" | "clean");
        }
        return;
      }
      const lane = target.closest<HTMLElement>(
        ".cv-lineg[data-lane], .cv-weakg[data-lane], .cv-line[data-lane]",
      );
      if (lane) {
        const laneKey0 = lane.dataset["lane"] ?? "";
        const [dirId = "", toolId = "", ch = ""] = laneKey0.split(":");
        /* 上游从属线（w:目录:通道）＝ 批量暂停/恢复该通道全部下游（原型 handleClickUpperEdge 口径） */
        if (toolId === "" || laneKey0.startsWith("w:")) {
          if (dirId && ch) void batchToggleChannel(Number(dirId), ch as Channel);
          return;
        }
        /* 口径（用户 2026-11-05 / 2026-11-14 收敛，点击即落库）：
           绿线(自动同步)点击 → 暂停(灰虚线，不自动同步)；
           灰虚线(已链接不自动同步)点击 → 恢复自动同步（blocked 连恢复带清空排除） */
        const st = channelState(+dirId, toolId, ch as Channel);
        if (st === "off") return;
        if (st === "paused") void applyLaneOp(+dirId, toolId, ch as Channel, "on");
        else if (st === "blocked") void applyLaneOp(+dirId, toolId, ch as Channel, "on", true);
        else void applyLaneOp(+dirId, toolId, ch as Channel, "paused");
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
          ".cv-ipanel, .cv__apply, .cv__lines, .cv__lane-ops, .hub-modal, .hub-btn, [data-lf]",
        ) &&
        (S.selDir || S.selTool || S.selRepo || S.legend)
      ) {
        S.selDir = null;
        S.selTool = null;
        S.selRepo = null;
        S.legend = null; /* 点空白退出 = 全部退出（原型 handleExitEditingMode 口径） */
        renderAll();
      }
    });
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

  async function toggleItem(item: string, toolId: string, ch: Channel): Promise<void> {
    if (!S.selDir) return;
    const bind = baseBind(S.selDir, toolId, ch);
    if (!bind) {
      /* 原型口径（点击即落库版）：未链接时点条目圆点 = 建链并只跟随这一条 */
      const tgt = targetOf(toolId, ch);
      if (!tgt) {
        HubUI.toast("该工具没有可链接的目录目标", "warn");
        return;
      }
      const r0 = await post<PullResult>("/api/skills/dir-bindings", {
        dir_id: normDir(S.selDir),
        target_ids: [tgt.id],
        mode: "copy",
      });
      const nb = baseBind(S.selDir, toolId, ch);
      if (!(r0.data.ok && nb)) {
        HubUI.toast(r0.data.error || "建链失败", "error");
        await loadAll();
        renderAll();
        return;
      }
      const others = (S.items[ch] || []).filter((n) => n !== item);
      const r1 = await send<PullResult>(`/api/skills/dir-bindings/${nb.id}`, "PATCH", {
        excluded: others,
      });
      await loadAll();
      renderAll();
      HubUI.toast(
        r1.data.ok ? `已链接，仅「${item}」跟随` : "已建链，但跟随设置未能生效",
        r1.data.ok ? "success" : "warn",
      );
      return;
    }
    const ex = laneExcluded(S.selDir, toolId, ch);
    if (ex.has(item)) ex.delete(item);
    else ex.add(item);
    /* 点击即落库：单条目排除/恢复直接 PATCH */
    const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
      excluded: [...ex],
    });
    if (r.data.ok) {
      await loadAll();
      renderAll();
    } else HubUI.toast(r.data.error || "条目跟随切换失败", "error");
  }

  /* ---------------- 点击即落库（无暂存层） ---------------- */

  /** 成对面板批量条目（原型 onStageBatchAllItems 口径，落库版）：
      follow=true 全部跟随（清空排除），false 全部排除（连线转灰虚 blocked，工具内文件保留）。 */
  async function batchItems(follow: boolean): Promise<void> {
    const did = S.selDir;
    const tid = S.selTool;
    if (!(did && tid)) return;
    let ok = true;
    let n = 0;
    for (const ch of Channels) {
      const bind = baseBind(did, tid, ch);
      if (!bind) continue;
      const names = S.items[ch] || [];
      if (!follow && names.length === 0) continue; /* 条目清单未加载，无法安全全排除 */
      const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
        excluded: follow ? [] : names.slice(),
      });
      ok = ok && r.data.ok;
      n += 1;
    }
    await loadAll();
    renderAll();
    HubUI.toast(
      n === 0
        ? "该目录与工具尚无连线"
        : ok
          ? follow
            ? "已恢复全部条目跟随"
            : "已排除全部条目"
          : "批量操作未能全部生效",
      n === 0 ? "info" : ok ? "success" : "warn",
    );
  }

  /** 上游从属线批量（原型 handleClickUpperEdge 口径，落库版）：
      该目录某通道的全部下游连线，全暂停则一键恢复，否则一键暂停；排除清单不动。 */
  async function batchToggleChannel(dirId: number, ch: Channel): Promise<void> {
    const rows = S.tools
      .filter((t) => (S.selTool ? t.id === S.selTool : true))
      .map((t) => ({ t, bind: baseBind(dirId, t.id, ch) }))
      .filter((x): x is { t: ToolRow; bind: DirBinding } => !!x.bind && !!targetOf(x.t.id, ch));
    if (!rows.length) {
      HubUI.toast("该通道还没有连线可批量切换", "info");
      return;
    }
    const enable = rows.every((x) => !x.bind.enabled); /* 全暂停 → 一键恢复；否则 → 一键暂停 */
    let ok = true;
    for (const x of rows) {
      const r = await send<PullResult>(`/api/skills/dir-bindings/${x.bind.id}`, "PATCH", {
        enabled: enable,
      });
      ok = ok && r.data.ok;
    }
    await loadAll();
    renderAll();
    const dn = S.dirs.find((d) => d.id === dirId);
    HubUI.toast(
      ok
        ? `${enable ? "已恢复" : "已暂停"} ${dn ? dn.name + " → " + Ch[ch] + " 的" : ""}${rows.length} 条连线自动同步`
        : "批量操作未能全部生效",
      ok ? "success" : "warn",
    );
  }

  /** 工具卡 hover 快捷接 / 断（原型 onQuickToggleSourceToolLink 口径，落库版）：
      link = 双通道建链并启用；unlink = 断开全部连线——破坏性，走二次确认（同线上 ×）。 */
  async function quickToggleSourceTool(unlink: boolean, toolId: string): Promise<void> {
    const did = S.selDir;
    if (!did) return;
    const t = S.tools.find((x) => x.id === toolId);
    const dn = S.dirs.find((x) => x.id === did);
    const label = `${dn ? dn.name : did} → ${t ? t.name : toolId}`;
    if (unlink) {
      const binds = Channels.map((ch) => baseBind(did, toolId, ch)).filter(
        (b): b is DirBinding => !!b,
      );
      if (!binds.length) {
        HubUI.toast("该目录与工具尚未连线", "info");
        return;
      }
      HubUI.confirm(
        "断开全部连线",
        `将断开 ${esc(label)} 的 ${binds.length} 条连线，该工具内已同步条目会被清理。确定？`,
        async () => {
          let ok = true;
          for (const b of binds) {
            const r = await send<PullResult>(`/api/skills/dir-bindings/${b.id}?clean=1`, "DELETE");
            ok = ok && r.data.ok;
          }
          await loadAll();
          renderAll();
          HubUI.toast(ok ? "已断开全部连线" : "部分连线未能断开", ok ? "success" : "error");
        },
        { danger: true },
      );
      return;
    }
    let ok = true;
    let n = 0;
    for (const ch of Channels) {
      if (!targetOf(toolId, ch)) continue;
      let bind = baseBind(did, toolId, ch);
      if (!bind) {
        const tgt = targetOf(toolId, ch);
        const r = await post<PullResult>("/api/skills/dir-bindings", {
          dir_id: did,
          target_ids: [tgt ? tgt.id : 0],
          mode: "copy",
        });
        ok = ok && r.data.ok;
        bind = baseBind(did, toolId, ch);
      }
      if (!bind) continue;
      const r2 = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
        enabled: true,
      });
      ok = ok && r2.data.ok;
      n += 1;
    }
    await loadAll();
    renderAll();
    HubUI.toast(
      n === 0
        ? "该工具没有可链接的目录目标"
        : ok
          ? `已链接 ${label} 的 ${n} 条通道`
          : "链接未能完成",
      n === 0 ? "info" : ok ? "success" : "error",
    );
  }

  /** 单条连线的直接生效：on=建连/恢复自动同步，paused=暂停，clean=断连并清理。
      clearExcluded 仅恢复 blocked 用（口径：恢复即清空排除）。 */
  async function applyLaneOp(
    dirId: DirIdLike,
    toolId: string,
    ch: Channel,
    kind: "on" | "paused" | "clean",
    clearExcluded = false,
  ): Promise<void> {
    const did = normDir(dirId);
    let bind: DirBinding | null = baseBind(did, toolId, ch);
    let ok = true;
    try {
      if (kind === "on" || kind === "paused") {
        /* 链接/恢复：无绑定先建；再设置自动同步开关 */
        const tgt = targetOf(toolId, ch);
        if (!bind && tgt) {
          const r = await post<PullResult>("/api/skills/dir-bindings", {
            dir_id: did,
            target_ids: [tgt.id],
            mode: "copy",
          });
          ok = ok && r.data.ok;
          bind = baseBind(did, toolId, ch);
        }
        if (!bind) {
          HubUI.toast("该工具没有可链接的目录目标", "error");
          return;
        }
        const r2 = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
          enabled: kind !== "paused",
        });
        ok = ok && r2.data.ok;
        if (clearExcluded) {
          const r3 = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}`, "PATCH", {
            excluded: [],
          });
          ok = ok && r3.data.ok;
        }
      } else if (kind === "clean" && bind) {
        const r = await send<PullResult>(`/api/skills/dir-bindings/${bind.id}?clean=1`, "DELETE");
        ok = ok && r.data.ok;
        bind = null;
      }
    } catch {
      ok = false;
    }
    await loadAll();
    renderAll();
    HubUI.toast(ok ? "连接变更已保存" : "连接变更未能生效", ok ? "success" : "error");
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
    /* 图例激活态（点选过滤） */
    qsa<HTMLElement>(".cv-lf").forEach((b) => {
      b.classList.toggle("is-active", S.legend === b.dataset["lf"]);
    });
  }

  function renderAll(): void {
    renderMetastrip();
    renderDirs();
    renderTypes();
    renderTools();
    renderPanel();
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
