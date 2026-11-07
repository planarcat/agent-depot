/* ====================================================================
   Agent Depot · app logic
   UI 规范：所有反馈走 HubUI（toast/confirm/prompt）；所有按钮 loading 走 is-loading。
   ==================================================================== */
'use strict';

const state = {
  tools: {}, sessions: [], ledger: [], migrations: [], schedule: {},
  memories: [], engine: {}, filter: 'all', selected: new Set(), tab: 'migrate',
  // 会话视图（v0.8 手风琴布局）：工具聚焦 / 迁移面板 / 展开项 / 详情缓存
  _toolFocus: null, _panelOff: false, _migTargets: [],   // 迁移目标支持多选（用户 2026-10-20「多选」）
  _sessLayout: 'detail', _sessFullH: 0, _sessAnim: false,
  _detailCache: {}, _animateOpen: null,
};
window.__hubErrors = [];
window.addEventListener('error', e => window.__hubErrors.push(String(e.message)));
// Tauri 壳外（浏览器）⌘R/F5 由浏览器自带；壳内已由原生菜单接管。此处仅兜底：
// 壳内若菜单事件未达（旧版本 App），⌘R 也能刷新。
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    window.location.reload();
  } else if (e.key === 'F5') {
    e.preventDefault();
    window.location.reload();
  }
});

const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' };
let TOOL_LIST = [];
function syncToolMap() { for (const t of TOOL_LIST) TOOL_NAMES[t.id] = t.name; }

/* ---------- fetch helpers ---------- */
async function api(path, opts) {
  try {
    if (opts && opts.method && opts.method !== 'GET') LIVE.lastWrite = Date.now();
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: { error: '网络错误：' + e.message } };
  }
}
const post = (path, body) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/* ---------- state ---------- */
async function loadState() {
  const r = await api('/api/state');
  if (r.status !== 200) { renderLoadError(r.data.error); return; }
  Object.assign(state, r.data);
  TOOL_LIST = state.tool_list || [];
  syncToolMap();
  const valid = new Set(state.sessions.map(s => s.sid));
  [...state.selected].forEach(sid => { if (!valid.has(sid)) state.selected.delete(sid); });
  renderAll();
  // 模块可见性：/api/modules 状态驱动导航显隐（禁用模块隐藏入口）
  api('/api/modules').then(mr => {
    if (mr.data.ok && window.applyModuleVisibility) {
      window.applyModuleVisibility(mr.data.modules || []);
      const cur = document.querySelector('.mod-nav button.is-on');
      if (cur) syncNavIndicator(cur.dataset.view);
    }
  }).catch(() => {});
}
function renderLoadError(msg) {
  document.getElementById('session-rows').innerHTML =
    '<div class="hub-empty">加载失败：' + esc(msg || '未知错误') + '<div class="hub-empty__hint">检查服务是否运行：./run.sh</div></div>';
}


/* ====================================================================
   v1.0 模块统一版式助手（记忆 / Skills / MCP 共用，对齐 Figma ModuleView.tsx）
   外壳完全复用会话页：.sess-tools 卡片区 + .sside 侧栏 + .slist 列表 + .spanel 去向面板
   ==================================================================== */
window.MV = (function () {
  const SVG_CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const pill = (tone, text) => `<span class="pill pill--${tone || 'muted'}">${esc(text)}</span>`;
  // 工具 id → 短名/色块类（工具表在 window.hubApp.state.tool_list；'notes'/'local'/'remote' 是虚拟来源）
  const toolOf = (id) => ((window.hubApp && window.hubApp.state.tool_list) || []).find(t => t.id === id) || {};
  const VIRTUAL = { notes: ['NB', 'chip--accent'], local: ['LO', 'chip--accent'], remote: ['RM', 'chip--muted'],
    all: ['全', 'chip--accent'], manual: ['手动', 'chip--muted'] };   // 手动来源的短名用中文（原来 LO 看不出含义）
  const short = (id) => (VIRTUAL[id] ? VIRTUAL[id][0] : toolShort(toolOf(id)));
  const cls = (id) => (VIRTUAL[id] ? VIRTUAL[id][1] : toolColorCls(toolOf(id)));
  const chip = (short, cls) => `<span class="mvi__src ${cls || 'chip--muted'}">${esc(short || '')}</span>`;

  /** 线性图标（1.8 线宽，跟稿子一套）：按钮里用 <span class="btn-ic">…</span> 包住 */
  const ICONS = {
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11A8.5 8.5 0 1 0 12 20.5"/>'
      + '<path d="M20.5 4v7h-7"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l4-4 4 4M8 16l4 4 4-4M4 12h16"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>'
      + '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'
      + '<path d="M10 11v6M14 11v6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/>'
      + '<path d="M16 16l4.5 4.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/>'
      + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33'
      + ' 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06'
      + 'a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9'
      + 'a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3V3'
      + 'a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06'
      + 'A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };
  const ic = (name) => ICONS[name] || '';

  const GKIND = {
    local: { tint: 'var(--c-accent)', icon: '<path d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4"/>' },
    remote: { tint: 'var(--c-tool-p8)', icon: '<path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>' },
    tool: { tint: 'var(--c-tool-p5)', icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/>' },
  };
  /** 卡片左上角的"数量 + 动作"排：数量永远在，动作 hover 才出（Figma 2026-10-17） */
  function cardHead(s, o, count) {
    const cntTid = o.cntTestid || (o.prefix ? `${o.prefix}-cnt-${s.id}` : '');
    // 数量标签：**一直显示**（没有条目就显示 0）。恒为 28×28 正方形（用户指令 2026-10-19），
    // 分档：1~2 位原字号；3~5 位 is-n3/n4/n5 收字号收字距；≥6 位（十万级）方块放不下精确数，
    // 改用语义符号 ∞ 代表「更多」，精确数保留在 title 悬浮提示（不丢信息）。
    const n = (count === 0 || count) ? String(count) : '0';
    const tip = `${n} 个条目`;
    const big = n.length >= 6;
    const shown = big ? '∞' : n;
    const lenCls = big ? '' : (n.length >= 5 ? ' is-n5' : n.length === 4 ? ' is-n4' : n.length === 3 ? ' is-n3' : '');
    // 1) 数量标签初始显示（没条目显示 0）
    // 2) 远仓的 拉取/编辑/删除 初始不显示
    // 3) 悬停远仓：数量隐藏、三个按钮出现（数量与拉取同一格，交叉淡入，不产生位移）
    const pull = (s.acts || []).find(a => a.key === 'pull');
    const others = (s.acts || []).filter(a => a.key !== 'pull').map(a =>
      `<button class="tcard__act ${a.danger ? 'is-danger' : ''}" data-act="${esc(a.key)}"
        ${a.testid ? `data-testid="${esc(a.testid)}"` : ''} title="${esc(a.title || a.label)}"
        aria-label="${esc(a.title || a.label)}">${a.icon || esc(a.label)}</button>`).join('');
    const first = pull
      ? `<button class="tcard__pull" data-act="pull" title="拉取（${esc(n)} 个条目）" aria-label="拉取">
           <span class="tcard__cnt mono${lenCls}" ${cntTid ? `data-testid="${esc(cntTid)}"` : ''}>${esc(shown)}</span>
           <span class="tcard__pullic">${pull.icon || ''}</span>
         </button>`
      : `<span class="tcard__cnt mono${lenCls}" title="${esc(tip)}" ${cntTid ? `data-testid="${esc(cntTid)}"` : ''}>${esc(shown)}</span>`;
    return `<span class="tcard__acts${pull ? ' has-acts' : ''}">${first}${others}</span>`;
  }

  /** 唯一的来源卡片组件：会话页工具卡 / 记忆来源 / Skills 来源 / MCP 来源都是它 */
  function cardHTML(s, o) {
    o = o || {};
    const active = o.activeId != null && String(o.activeId) === String(s.id);
    const count = s.count != null ? s.count : (o.counts ? o.counts[s.id] : '');
    return `
      <div class="tcard ${active ? 'is-on' : ''} ${s.off ? 'is-off' : ''}"
           data-src="${esc(s.id)}" title="${esc(s.title || s.name)}"
           ${o.prefix ? `data-testid="${esc(o.prefix)}-card-${esc(s.id)}"` : ''}>
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        ${cardHead(s, o, count)}
        <button class="tcard__open" aria-label="${esc(s.name)}">
          <span class="tcard__chip ${s.cls || 'chip--muted'}">${esc(s.short || '')}</span>
          <span class="tcard__nm">${esc(s.name)}</span>
        </button>
        ${s.tag ? `<span class="tcard__tag">${s.tag}</span>` : ''}
      </div>`;
  }
  /** 顶部来源卡片 + 批量按钮 + 统计条 + hint；给 groups 时按来源类型分会话（本地/远程仓库/工具） */
  function top(o) {
    if (o.groups && o.groups.length) {
      // 稿子 SourceGroups（2026-10-16 更新）：每个分组是"左侧信息面板 180px + 右侧卡片区"，
      // 整体横向滚动；点信息面板可折叠卡片区（collapse-x：grid-template-columns 0fr ↔ 1fr）
      const panels = o.groups.map(g => {
        const list = (o.sources || []).filter(s => g.ids.indexOf(s.id) >= 0);
        if (!list.length) return '';
        const total = list.reduce((n, s) => n + ((o.counts && o.counts[s.id]) || 0), 0);
        const k = GKIND[g.kind] || GKIND.tool;
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
              <div class="srcgroup__d" title="${esc(g.desc || '')}">${esc(g.desc || '')}</div>
              <div class="srcgroup__acts">${(g.actions || []).map(a =>
                `<button class="hub-btn btn-sm" data-gact="${esc(g.kind)}:${esc(a)}">${esc(a)}</button>`).join('')}</div>
            </div>
            <div class="srcgroup__body">
              <div>
                <div class="srcgroup__grid">${list.map(x => cardHTML(x, o)).join('')}</div>
              </div>
            </div>
          </div>`;
      }).join('');
      const n = (o.sources || []).length;
      return `
        <div class="srcgroups" data-testid="${esc(o.prefix)}-sources">${panels}</div>
        <div class="mv-stats">${(o.stats || []).map(x => `<span class="mv-stat ${x.tone === 'warn' ? 'is-warn' : ''}">`
          + `<b>${esc(String(x.n))}</b><span>${esc(x.label)}</span></span>`).join('')}`
        + `${o.bulk ? `<span class="mv-stats__acts">${o.bulk}</span>` : ''}`
        + `${o.hint ? `<span class="mv-hint" title="${esc(o.hint)}">${esc(o.hint)}</span>` : ''}</div>`;
    }
    // 改动：卡片里补一层像素级描边帧（<svg class="stgt-frame">）。原因：选中动效统一为「描边生长 + 背景扫入」，
    // 卡片此前只切 border-color，与迁移目标行 / 条头 chip 的观感不一致（2026-10-20）
    const cards = (o.sources || []).map(s => `
      <div class="tcard ${o.activeId === s.id ? 'is-on' : ''} ${s.off ? 'is-off' : ''}"
           data-src="${esc(s.id)}" title="${esc(s.title || s.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        ${cardHead(s, o, o.counts && o.counts[s.id] != null ? o.counts[s.id] : 0)}
        <button class="tcard__open" aria-label="${esc(s.name)}">
          <span class="tcard__chip ${s.cls || 'chip--muted'}">${esc(s.short || '')}</span>
          <span class="tcard__nm">${esc(s.name)}</span>
        </button>
      </div>`).join('');
    return `
      ${o.bulk ? `<div class="mv-top__h"><span class="mv-top__acts">${o.bulk}</span></div>` : ''}
      <div class="tgrid" data-testid="${esc(o.prefix)}-sources">${cards}</div>
      <div class="mv-stats">${(o.stats || []).map(x => `<span class="mv-stat ${x.tone === 'warn' ? 'is-warn' : ''}">`
        + `<b>${esc(String(x.n))}</b><span>${esc(x.label)}</span></span>`).join('')}`
      + `${o.hint ? `<span class="mv-hint" title="${esc(o.hint)}">${esc(o.hint)}</span>` : ''}</div>`;
  }

  /**
   * 卡片区就地同步：签名（来源 id + 数量）不变时只切 is-on，不重建 DOM。
   * 原因：重建出来的节点天生就带 is-on，CSS 过渡没有起点，「描边生长 + 背景扫入」放不出来（2026-10-20）
   * 返回 true = 走了就地分支（调用方不必再绑一次事件）。
   */
  function syncCards(host, html, sig, activeId) {
    if (!host) return false;
    if (host.dataset.cardsig === sig) {
      const on = activeId == null ? null : String(activeId);
      host.querySelectorAll('.tcard[data-src]').forEach(c => {
        c.classList.toggle('is-on', on != null && String(c.dataset.src) === on);
      });
      return true;
    }
    host.dataset.cardsig = sig;
    host.innerHTML = html;
    HubUI.drawFrames(host);        // 像素级描边路径 + 尺寸随动
    growIn(host);                  // 重建出来的卡片刻补播一次选中动效
    return false;
  }

  /**
   * 统一「目标选择」组件（用户指令 2026-10-20「将这个组件应用在所有模块」）：
   *   灰底说明行（已选 N 条 / 当前：…）
   *   多选行：色点 + 名称 +（可选右侧小注）+ 方形勾
   *   底部：[全选 | 清空] + 主按钮
   * o = { prefix, items:[{id,name,dotCls,meta,testid}], chosen:[id], selLine, selLineFn(set),
   *       goText, goTextFn(set), onChange(ids), onGo(ids) }
   * 返回 { html, bind(host) }：html 拼进面板骨架，bind 负责就地切类名/文案（不重建 DOM，保住描边动效）。
   */
  function targetPicker(o) {
    const items = o.items || [];
    const chosen = new Set((o.chosen || []).map(String));
    const rows = items.map(it => `
      <li><button class="stgt ${chosen.has(String(it.id)) ? 'is-on' : ''}" data-target="${esc(String(it.id))}"
          ${it.testid ? `data-testid="${esc(it.testid)}"` : ''} aria-pressed="${chosen.has(String(it.id)) ? 'true' : 'false'}"
          title="${esc(it.title || it.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        <span class="stgt__dot ${it.dotCls || 'tool-dot--local'}"></span>
        <span class="stgt__txt">
          <span class="stgt__nm">${esc(it.name)}</span>
          ${it.sub ? `<span class="stgt__sub">${esc(it.sub)}</span>` : ''}
        </span>
        ${it.meta ? `<span class="stgt__radio-note">${esc(it.meta)}</span>` : ''}
        <span class="stgt__radio"></span>
      </button></li>`).join('');
    const html = `
      <div class="spanel__sel" data-testid="${esc(o.prefix)}-picker-sel">${o.selLine || ''}</div>
      <ul class="spanel__targets is-multi" data-testid="${esc(o.prefix)}-picker-targets">
        ${rows || `<li class="stgt__none">没有可选的目标：${esc(o.emptyHint || '先在 设置 → 工具 里接入目标目录')}</li>`}
      </ul>
      ${o.extraHTML || ''}
      <div class="spanel__go">
        <button class="hub-btn btn-sm spanel__quick" data-testid="${esc(o.prefix)}-picker-quick" ${items.length ? '' : 'disabled'}>全选</button>
        <button class="spanel__gobtn" data-testid="${esc(o.prefix)}-picker-go" ${chosen.size ? '' : 'disabled'}>${esc(o.goText || '')}</button>
      </div>`;

    function bind(host) {
      if (!host) return;
      const sel = host.querySelector(`[data-testid="${o.prefix}-picker-sel"]`);
      const quick = host.querySelector(`[data-testid="${o.prefix}-picker-quick"]`);
      const go = host.querySelector(`[data-testid="${o.prefix}-picker-go"]`);
      const set = new Set((o.chosen || []).map(String));
      const allOn = () => items.length > 0 && items.every(i => set.has(String(i.id)));
      const sync = () => {
        host.querySelectorAll('.spanel__targets .stgt').forEach(b => {
          const on = set.has(String(b.dataset.target));
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        if (quick) quick.textContent = allOn() ? '清空' : '全选';
        if (sel && o.selLineFn) sel.innerHTML = o.selLineFn(set);
        if (go) {
          go.disabled = !set.size;
          if (o.goTextFn) go.textContent = o.goTextFn(set);
        }
        if (o.onChange) o.onChange([...set]);
      };
      host.querySelectorAll('.spanel__targets .stgt').forEach(b => {
        b.onclick = () => {
          const id = String(b.dataset.target);
          if (set.has(id)) set.delete(id); else set.add(id);
          sync();
        };
      });
      if (quick) quick.onclick = () => {
        const all = allOn();
        set.clear();
        if (!all) items.forEach(i => set.add(String(i.id)));
        sync();
      };
      if (go) go.onclick = () => { if (set.size && o.onGo) o.onGo([...set]); };
      sync();
      HubUI.drawFrames(host);
    }
    return { html, bind };
  }

  /**
   * 详细布局左上角的「切换为简略布局」按钮（默认隐形，鼠标进入工具区才浮现）。
   * 用户指令 2026-10-20：「详细布局时，鼠标悬停工具区，显示切换按钮，左上角」
   * ＋「取消点击卡片进入简略布局」→ 布局切换收敛到这一枚按钮。
   */
  function hdrToggle(hdr, prefix, onToggle) {
    if (!hdr) return null;
    let b = hdr.querySelector(`#${prefix}-hdrtoggle`);
    if (!b) {
      b = document.createElement('button');
      b.id = `${prefix}-hdrtoggle`;
      b.className = 'hdr__toggle';
      b.innerHTML = ic('layout');
      hdr.appendChild(b);
    }
    b.title = '切换到简略布局';
    b.setAttribute('aria-label', '切换到简略布局');
    b.hidden = false;
    b.onclick = onToggle;
    return b;
  }

  /**
   * 新渲染出来的块里已有 is-on 时，补播一次选中动效。
   * 原因：新建节点天生带 is-on，CSS 过渡没有起点，「描边生长 + 背景扫入」不会发生（2026-10-20）
   */
  function growIn(root) {
    const on = root && root.querySelector('.is-on');
    if (!on) return;
    on.classList.remove('is-on');
    void on.getBoundingClientRect();   // 强制样式结算：把「未选中」记成过渡起点（同步，不受后续渲染打断）
    on.classList.add('is-on');         // 同一帧恢复，过渡从起点播到终点
  }

  /** 分组折叠：点左侧信息面板切换（按钮点击不触发）；幂等，可反复调用 */
  function bindGroups(root) {
    if (!root) return;
    root.querySelectorAll('[data-gfold]').forEach(side => {
      if (side.dataset.gfoldBound) return;
      side.dataset.gfoldBound = '1';
      const toggle = () => side.closest('.srcgroup').classList.toggle('is-closed');
      side.onclick = (e) => { if (e.target.closest('button')) return; toggle(); };
      side.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    });
  }

  /** 内容区过渡：仅在"当前来源/工具"发生变化时重播一次 fadeX（同源刷新不闪） */
  function swap(root, key, hostSel) {
    const host = hostSel ? root.querySelector(hostSel)
      : (root.querySelector('.slist .nv-list') || root.querySelector('.nv-list'));
    if (!host) return;
    const k = String(key == null ? 'all' : key);
    if (host.dataset.mvKey === k) return;                 // 键记在宿主上，便于一个页面多处过渡
    host.dataset.mvKey = k;
    host.classList.remove('mv-swap');
    void host.offsetWidth;               // 强制重排，让动画能重播
    host.classList.add('mv-swap');
  }

  /** 侧边栏（选中某个来源后出现；返回全部 + 来源切换 + 额外动作） */
  function side(o) {
    const wrap = (t) => `
      <button class="sside__it ${t.id === o.activeId ? 'is-on' : ''} ${t.off ? 'is-off' : ''}"
              data-src="${esc(t.id)}" title="${esc(t.title || t.name)}">
        <span class="sside__chip ${t.cls || 'chip--muted'}">${esc(t.short || '')}</span>
        <span class="sside__nm">${esc(t.name)}</span>
        <span class="sside__n">${t.count != null && t.count !== 0 ? t.count : ''}</span>
      </button>`;
    let body;
    if (o.groups && o.groups.length) {
      body = o.groups.map(g => {
        const list = (o.items || []).filter(t => g.ids.indexOf(t.id) >= 0);
        if (!list.length) return '';
        return `<div class="sside__grp">${esc(g.label || '')}</div>` + list.map(wrap).join('');
      }).join('');
    } else {
      body = (o.items || []).map(wrap).join('');
    }
    return `<button class="sside__back" id="${esc(o.prefix)}-back" title="返回全部来源">‹</button>`
      + body + (o.extra || '');
  }

  /**
   * 横向来源条（Figma 2026-10-17 重构）：点卡片选中来源后，卡片区收成一条 chip 栏——
   * 分组标题（本地/远程仓库/工具）+ 该组的动作按钮 + 该组来源 chip（色块 + 名称 + 数量），
   * 末尾一个「⇅」返回卡片网格。
   */
  function chipBar(o) {
    const groups = o.groups || [];
    const items = o.items || [];
    const chip = (t) => `
      <button class="cbar__it ${t.id === o.activeId ? 'is-on' : ''}" data-src="${esc(t.id)}"
              title="${esc(t.title || t.name)}">
        <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
        <span class="cbar__ic ${t.cls || 'chip--muted'}">${esc(t.short || '')}</span>
        <span class="cbar__nm">${esc(t.name)}</span>
        <span class="cbar__n mono">${t.count != null ? t.count : 0}</span>
      </button>`;
    return `<div class="cbar">
      <button class="cbar__back" id="${esc(o.prefix)}-barback" title="切换到详细布局" aria-label="切换到详细布局">${ic('layout')}</button>
      ${groups.map(gr => {
        const list = items.filter(t => gr.ids.indexOf(t.id) >= 0);
        return `<span class="cbar__grp">
          <span class="cbar__label">${esc(gr.label || '')}</span>
          ${(gr.actions || []).map(a => `<button class="hub-btn btn-sm" data-gact="${esc(gr.kind)}:${esc(a)}">${esc(a)}</button>`).join('')}
          ${list.map(chip).join('')}
        </span>`;
      }).join('')}
    </div>`;
  }

  /** 条目行（两行 + 胶囊 + 折叠箭头 + 行内展开体） */
  /**
   * 唯一的条目行组件（记忆 / Skills / MCP / 会话共用，用户 2026-10-20「组件：使用同一套组件」）。
   * variant='session' 时输出 .srow* 类名（会话的历史类名与既有事件绑定保持不变），结构、间距、勾选框、箭头完全同源。
   * o = { id, testid, chkTestid, sel, open, chipText, chipCls, title, sub, extra, body, attrs, variant }
   */
  function item(o) {
    const c = (suf) => 'mvi' + suf;
    const main = `<span class="mvi__main">
            <span class="mvi__title" title="${esc(o.titleTitle || o.title)}">${esc(o.title)}</span>
            <span class="mvi__sub" title="${esc(o.sub || '')}">${esc(o.sub || '')}</span>
          </span>`;
    return `
      <div class="${c('')} ${o.open ? 'is-open' : ''} ${o.sel ? 'is-sel' : ''}${o.chipText ? ' has-chip' : ''}" data-id="${esc(o.id)}"
           ${o.testid ? `data-testid="${esc(o.testid)}"` : ''} ${o.attrs || ''}>
        <div class="${c('__head')}">
          <input type="checkbox" class="${c('__chk')}" ${o.sel ? 'checked' : ''}
                 ${o.chkTestid ? `data-testid="${esc(o.chkTestid)}"` : ''} aria-label="勾选">
          ${o.chipText ? chip(o.chipText, o.chipCls) : ''}
          ${main}
          ${o.meta && !o.open ? `<span class="${c('__meta')}">${esc(o.meta)}</span>` : ''}
          ${o.pillText ? pill(o.pillTone, o.pillText) : ''}
          ${o.extra || ''}
          <button class="${c('__chev')}" title="${o.open ? '收起' : '展开'}">${SVG_CHEV}</button>
        </div>
        <div class="${c('__acc')}"><div class="${c('__accin')}">${o.open ? (o.body || '<div class="srow__load">加载中…</div>') : ''}</div></div>
      </div>`;
  }

  /** 条目行内展开体（稿子 ModuleView accordion）：头部 meta · 来源 + 动作按钮，下方内容预览 */
  function accBody(o) {
    const acts = (o.actions || []).map(a => `<button class="hub-btn btn-sm" data-acc="${esc(a.key)}"
      ${a.testid ? `data-testid="${esc(a.testid)}"` : ''} ${a.disabled ? 'disabled' : ''}
      ${a.title ? `title="${esc(a.title)}"` : ''}>${esc(a.label)}</button>`).join('');
    // 元信息行：meta 与 source 都为空时整行省略（MCP 条目元信息已上移行头，2026-10-19）
    const bh = (o.meta || o.source)
      ? `<div class="mvi__bh"><span class="mono">${esc(o.meta || '')}</span>`
        + `<span>· 来源 ${esc(o.source || '')}</span><span class="mvi__bacts">${acts}</span></div>`
      : '';
    return `<div class="mvi__body">${bh}
      <pre class="mvi__pre" data-acc-pre>${esc(o.text || '加载中…')}</pre></div>`;
  }

  /** 最近台账（从 /api/state.ledger 里挑与本模块相关的几条） */
  function recentLedger(keywords, n) {
    const rows = (window.hubApp && window.hubApp.state.ledger) || [];
    const hit = rows.filter(l => keywords.some(k => String(l.action || '').includes(k)));
    return hit.slice(0, n || 5).map(l => {
      let name = '';
      try {
        const d = JSON.parse(l.detail || '{}');
        name = d.item_name || d.name || d.sid || d.tool || (d.tools || []).join(',') || '';
      } catch (e) { name = String(l.detail || '').slice(0, 40); }
      const failed = /fail|error|冲突/.test(String(l.detail || ''));
      return { time: String(l.ts || '').slice(5, 16).replace('T', ' '),
               op: (l.action || '') + (failed ? ' · failed' : ''), name, bad: failed };
    });
  }
  function ledger(rows) {
    if (!rows || !rows.length) return '<div class="nv-note">暂无记录</div>';
    return rows.map(l => `<div class="mv-ledger__row">
      <div class="mv-ledger__t">${esc(l.time)} · <span class="mv-ledger__op ${l.bad ? 'is-bad' : ''}">${esc(l.op)}</span></div>
      <div class="mv-ledger__n">${esc(l.name || '')}</div></div>`).join('');
  }

  /** 整体骨架：顶部（调用方填）+ 主体三栏容器（返回容器 id 供逐块渲染） */
  function shell(o) {
    return `
      <div class="mv-shell">
        <section class="sess-tools" id="${esc(o.prefix)}-top">${o.top || ''}</section>
        <div class="sess__main">
          <aside class="sside" id="${esc(o.prefix)}-side" hidden></aside>
          <section class="slist" id="${esc(o.prefix)}-col">
            <div class="slist__search"><label class="ssearch">
              <span class="ssearch__ic">${ic('search')}</span>
              <input id="${esc(o.prefix)}-q" placeholder="${esc(o.placeholder || '搜索…')}" value="${esc(o.q || '')}">
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
  return { pill, chip, ic, head: cardHead, chipBar, syncCards, growIn, hdrToggle, targetPicker, bindGroups, accBody, card: cardHTML, chev: () => SVG_CHEV, short, cls, top, side, item, ledger,
    recentLedger, shell, swap };
})();

function renderAll() {
  renderToolGrid(); renderFilterSeg(); renderRows();
  renderStatus(); renderSelCount(); renderPanel();
}

/* ---------- tool rows（右栏：工具列表 + 迁移目标） ---------- */
/* ---------- 工具卡片网格（会话视图顶部） ---------- */
const TOOL_CARD_W = 128;      // 卡片宽（= --tcard，稿子 ToolGrid/ToolCard 一致）
// 口径 B（2026-10-14 定稿）：停用 = 在所有界面隐藏（含其历史会话）。
// 与设置页文案「禁用的工具在所有界面隐藏」一致：卡片 / 侧栏 / 列表 / 迁移目标同口径，
// 一律只认启用且有会话根目录的工具；重新启用即恢复可见。
function sessionTools() { return TOOL_LIST.filter(t => t.enabled && t.root); }
function toolById(id) { return TOOL_LIST.find(t => t.id === id) || null; }
function toolColorCls(t) { return 'tool-dot--p' + ((t && t.color) || 1); }
const TOOL_SHORT = {
  claude: 'CC', codex: 'CX', opencode: 'OC', workbuddy: 'WB', zcode: 'ZC',
  autoclaw: 'AC', 'trae-cn': 'TR', agents: 'AG', 'pi-agent': 'PI', cursor: 'CU',
};
// 卡片/侧栏的短名色块：预设优先，未知工具取名称首字母
function toolShort(t) {
  if (!t) return '··';
  if (TOOL_SHORT[t.id]) return TOOL_SHORT[t.id];
  const w = String(t.name || '').split(/[\s\-_/]+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : String(t.name || '?').slice(0, 2)).toUpperCase();
}
// 卡片不再展示会话计数（用户反馈：数字与列表重复、工具停用时常为 0）——
// 计数改写进 aria-label；隐藏节点保留供读屏与 E2E 断言（工具视图列表头已显示 N / 总数）
function toolCardHTML(t) {
  const info = (state.tools || {})[t.id] || { count: 0, latest: null };
  const warn = !t.enabled ? '已停用' : (t.root_exists === false ? '路径不可用' : '');
  const title = [t.name, warn, t.root, '最近活动 ' + fmtTime(info.latest)].filter(Boolean).join(' · ');
  // 对齐 Figma ToolCard：方形卡片 + 右上角计数 + 居中 色块/名称；路径等信息进 title 提示。
  // 卡片上不放 ⟳/→ 按钮（2026-10-14 按注解去掉，太丑）：单工具采集走侧栏 ⟳、迁移走迁移面板或把会话拖到卡片上
  return `
    <div class="tcard ${state.filter === t.id ? 'is-on' : ''} ${t.enabled ? '' : 'is-off'}"
         data-testid="tool-card-${esc(t.id)}" data-tool="${esc(t.id)}" data-testid-drop="drop-${esc(t.id)}"
         title="${esc(title)}">
      <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>
      ${window.MV.head({ id: t.id }, { cntTestid: 'count-' + t.id, hasActs: false }, info.count)}
      <button class="tcard__open" data-testid="tool-open-${esc(t.id)}"
              aria-label="进入 ${esc(t.name)} 的会话视图（${info.count} 条会话）">
        <span class="tcard__chip ${toolColorCls(t)}">${esc(toolShort(t))}</span>
        <span class="tcard__nm">${esc(t.name)}</span>
      </button>
    </div>`;
}
function renderToolGrid() {
  const box = document.getElementById('tool-cards');
  if (!box) return;
  const list = sessionTools();
  const counts = state.tools || {};
  const total = list.reduce((n, t) => n + ((counts[t.id] || {}).count || 0), 0);
  // 选中切换走就地类名同步（不重建卡片），保住「描边生长 + 背景扫入」动效（2026-10-20）
  const sig = list.map(t => `${t.id}:${(counts[t.id] || {}).count || 0}`).join(',');
  if (box.dataset.sig === sig) {
    box.querySelectorAll('.tcard').forEach(c => c.classList.toggle('is-on', c.dataset.tool === state.filter));
    renderSessBar(); applySessLayout(false);
    return;
  }
  box.dataset.sig = sig;
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
      <div class="srcgroup__body"><div><div class="srcgroup__grid">${list.map(toolCardHTML).join('')}</div></div></div>
    </div>`;
  box.querySelectorAll('.tcard').forEach(bindToolCard);
  HubUI.drawFrames(box);   // 像素级描边路径构建 + 尺寸随动（ResizeObserver 在助手内）
  MV.bindGroups(document.getElementById('view-sessions'));
  renderSessBar();
  applySessLayout(false);
}
function bindToolCard(card) {
  const tid = card.dataset.tool;
  const open = card.querySelector('.tcard__open');
  if (open) open.onclick = () => enterTool(tid);
  // 卡片本身是迁移落点（拖会话行到卡片上）；ondragover 必须 preventDefault，drop 才会触发
  card.ondragover = e => { e.preventDefault(); card.classList.add('is-hot'); };
  card.ondragleave = () => card.classList.remove('is-hot');
  card.ondrop = e => {
    e.preventDefault(); card.classList.remove('is-hot');
    const ids = (e.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean);
    migrateConfirmInline(tid, ids.length ? ids : [...state.selected]);
  };
}

/* ---------- 顶部布局切换（对齐 记忆/Skills/MCP；用户指令 2026-10-19「会话也接入」） ---------- */
function focusTool() { return state._toolFocus ? toolById(state._toolFocus) : null; }
/** 简略条内容：全部工具 chip + 当前工具的 ⟳ 单工具采集（判据 testid：focus-refresh） */
function renderSessBar() {
  const bar = document.getElementById('sess-bar');
  if (!bar) return;
  const list = sessionTools();
  const counts = state.tools || {};
  const focus = focusTool();
  // 内容未变只同步选中类名，保住 chip 描边动效（2026-10-20）
  // 签名只含「chip 集合 + 数量」：选中变化本身就是要就地切类名的情形，
  // 若把 focus 放进来，切换工具就会重建整条 → 新节点天生带 is-on，描边动效没有起点（2026-10-20 修）
  const sig = list.map(t => `${t.id}:${(counts[t.id] || {}).count || 0}`).join(',')
    + (focus ? '|r' : '');       // 只区分「有无刷新按钮」，仍不含具体工具 id（换工具要走就地切类名）
  if (bar.dataset.sig === sig) {
    bar.querySelectorAll('.cbar__it').forEach(b => b.classList.toggle('is-on', b.dataset.src === state._toolFocus));
    // 重新绑定刷新按钮（换工具时早期返回，闭包里 focus 可能还是上一个工具）
    const rb0 = bar.querySelector('[data-testid="focus-refresh"]');
    if (rb0 && focus) rb0.onclick = ev => refreshOne(focus.id, ev.currentTarget);
    return;
  }
  bar.dataset.sig = sig;
  bar.innerHTML = MV.chipBar({
    prefix: 'sess',
    items: list.map(t => ({ id: t.id, name: t.name, short: toolShort(t), cls: toolColorCls(t),
      count: (counts[t.id] || {}).count || 0 })),
    activeId: state._toolFocus,
    groups: [{ kind: 'tool', label: '工具', ids: list.map(t => t.id), actions: [] }],
  });
  HubUI.drawFrames(bar);   // 像素级描边路径构建 + 尺寸随动（ResizeObserver 在助手内）
  MV.growIn(bar);          // 首次进入简略布局时补播选中动效
  if (focus) {
    bar.querySelector('.cbar').insertAdjacentHTML('beforeend',
      `<button class="hub-btn btn-sm" data-testid="focus-refresh" title="刷新当前工具">⟳</button>`);
    const rb = bar.querySelector('[data-testid="focus-refresh"]');
    if (rb) rb.onclick = ev => refreshOne(focus.id, ev.currentTarget);
  }
  bar.querySelectorAll('.cbar__it').forEach(b => { b.onclick = () => sessPick(b.dataset.src, false); });
  const back = bar.querySelector('#sess-barback');
  if (back) back.onclick = () => { state._sessLayout = 'detail'; state._sessAnim = true; renderAll(); };
}
/** 布局落地：animate=true 时走两帧过渡（高度钉→下一帧切类名）；renderAll 里恒为 false（幂等即时） */
function applySessLayout(animate) {
  const hdr = document.getElementById('sess-hdr');
  if (!hdr) return;
  const top = document.getElementById('sess-top');
  const compact = state._sessLayout === 'compact';
  if (!compact) {
    const fullH = top ? top.scrollHeight : 0;
    if (fullH) state._sessFullH = fullH;          // compact 时卡片区绝对定位量不到，提前缓存
  }
  if (state._sessFullH) hdr.style.setProperty('--hdr-full', Math.round(state._sessFullH) + 'px');
  const apply = () => {
    hdr.style.height = '';
    hdr.classList.toggle('is-compact', compact);
    hdr.dataset.layout = compact ? 'compact' : 'detail';
  };
  const wantAnim = animate || state._sessAnim;
  state._sessAnim = false;
  const prev = hdr.dataset.layout || '';
  const next = compact ? 'compact' : 'detail';
  if (!wantAnim || !prev || prev === next) apply();
  else {
    hdr.style.height = Math.round(hdr.getBoundingClientRect().height) + 'px';
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }
  if (compact) { const dt = hdr.querySelector('#sess-hdrtoggle'); if (dt) dt.hidden = true; }
  else MV.hdrToggle(hdr, 'sess', () => { state._sessLayout = 'compact'; state._sessAnim = true; renderAll(); });
  const bar = document.getElementById('sess-bar');
  if (bar) {
    bar.hidden = !compact;
    // 条在详细布局里是 display:none，量不到尺寸 → 描边路径建不出来；显示之后补建并补播一次选中动效
    if (compact && prev !== next) { HubUI.drawFrames(bar); MV.growIn(bar); }
  }
}
// 详细卡片点击（fromCards=true）与简略 chip 点击共用：点已选 = 只取消，布局不变；点新工具 = 选中（卡片路径同时收合成条）
function sessPick(id, fromCards) {
  const same = state._toolFocus === id;
  if (same) { state._toolFocus = null; state.filter = 'all'; }
  else {
    state._toolFocus = id; state.filter = id;
    // 改动：点工具卡片只「进入该工具的会话筛选」，不再自动收合成简略布局
    //（用户指令 2026-10-20「取消点击卡片进入简略布局」）
  }
  state._sessDetail = null;
  state._panelOff = false;
  state.selected.clear();      // 换工具=换作用域：已选随之清空，避免"已选 N 条但列表里一条没勾"
  renderAll();
}
// 兼容旧入口名：卡片打开按钮仍走这里
function enterTool(id) { sessPick(id, true); }

/* ---------- filter seg（内置 + 自定义工具，全部按注册表动态生成） ---------- */
let lastSegSig = '__init__';
const FILTER_SHORT = {
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode',
  workbuddy: 'WorkBuddy', zcode: 'ZCode', autoclaw: 'AutoClaw', 'trae-cn': 'Trae',
  agents: 'Agents', 'pi-agent': 'Pi', cursor: 'Cursor',
};
// 工具筛选不再用 chips（2026-10-14 按注解去掉）：点工具卡片或侧栏进入该工具视图，
// 列表头只保留「全部 / ★ 星标」。
function renderFilterSeg() {
  const seg = document.getElementById('filter-seg');
  if (!seg) return;
  // 口径 B：停用/已移除的工具不该继续筛 → 选中态回退「全部」，避免页签消失后悬空
  if (state.filter !== 'all' && state.filter !== 'starred') {
    const act = TOOL_LIST.find(t => t.id === state.filter);
    if (!act || !act.enabled) state.filter = 'all';
  }
  if (lastSegSig !== 'bound') {
    lastSegSig = 'bound';
    seg.querySelectorAll('button').forEach(b => { b.onclick = () => setFilter(b.dataset.filter); });
  }
  // 「★ 星标」在底部选择栏（用户指令 2026-10-19「星标筛选放到下面」）：toggle 语义，再点回「全部」
  const star = document.getElementById('star-toggle');
  if (star && !star.dataset.bound) {
    star.dataset.bound = '1';
    star.onclick = () => setFilter(state.filter === 'starred' ? 'all' : 'starred');
  }
  syncFilterSegActive();
}
function syncFilterSegActive() {
  document.querySelectorAll('#filter-seg button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.filter === state.filter));
  const star = document.getElementById('star-toggle');
  if (star) star.classList.toggle('is-on', state.filter === 'starred');
}

/* ---------- rows ---------- */
// 会话可见域 = 启用工具的会话（口径 B）；筛选 / 搜索都在这个域内做
function scopedSessions() {
  const allowed = new Set(sessionTools().map(t => t.id));
  return (state.sessions || []).filter(s => allowed.has(s.tool));
}
function visibleSessions() {
  let list = scopedSessions();
  if (state.filter === 'starred') list = list.filter(s => s.starred);
  else if (state.filter !== 'all') list = list.filter(s => s.tool === state.filter);
  const q = (document.getElementById('search-input').value || '').trim().toLowerCase();
  if (q) list = list.filter(s =>
    (s.title || '').toLowerCase().includes(q) || (s.sid || '').toLowerCase().includes(q));
  return list;
}
function renderRows() {
  renderSessStats();
  // 切换工具卡时内容列重播 fadeX（稿子 App.tsx：<div key={activeToolId ?? 'all'} className="a-fadeX">）
  // key 不变时（搜索 / 勾选 / 星标过滤等）不重播，避免无意义闪烁。
  const sessRoot = document.getElementById('view-sessions');
  if (sessRoot && window.MV) {
    window.MV.swap(sessRoot, state._toolFocus || 'all', '#session-rows');
  }
  // 选中集合收敛到可见域（启用工具的会话）：避免"已选 1 条"却列表全空（2026-10-14 用户实测）
  const scopedIds = new Set(scopedSessions().map(s => s.sid));
  [...state.selected].forEach(sid => { if (!scopedIds.has(sid)) state.selected.delete(sid); });
  const box = document.getElementById('session-rows');
  const all = scopedSessions();
  if (!all.length) {
    box.innerHTML = (state.sessions || []).length > 0
      ? '<div class="hub-empty">当前没有启用工具的会话</div>'
      : '<div class="hub-empty">还没有会话数据<div class="hub-empty__hint">点右上角「全部刷新」开始采集</div></div>';
    renderSessPager();
    return;
  }
  const list = visibleSessions();
  if (!list.length) {
    box.innerHTML = '<div class="hub-empty">没有匹配的会话<div class="hub-empty__hint">调整筛选或搜索词试试</div></div>';
    renderSessPager();
    return;
  }
  const showTool = !state._toolFocus;
  box.innerHTML = list.map(s => {
    const open = state._sessDetail === s.sid;
    const anim = open && state._animateOpen === s.sid;   // 本次新展开：先渲染收起态，下一帧再展开
    const sel = state.selected.has(s.sid);
    const t = toolById(s.tool);
    const lid = s.lid ? `<span class="hub-badge" data-testid="lid-badge">[hub:${s.lid}]</span>` : '';
    // 会话行也用统一条目组件（variant='session' 保留 .srow* 类名与既有事件绑定）：
    // 去掉右侧「N 条 · 时间」元信息、胶囊；悬停动作按 Skills 对齐（收藏 / 复制命令 / 导出）
    const acts = `<span class="mvi-acts">`
      + `<button class="hub-btn btn-sm${s.starred ? ' is-on' : ''}" data-act="star" data-testid="row-star" title="${s.starred ? '取消收藏' : '收藏'}">${s.starred ? '已收藏' : '收藏'}</button>`
      + `<button class="hub-btn btn-sm" data-act="copy" data-testid="row-copy" title="复制 resume 命令">复制</button>`
      + `<button class="hub-btn btn-sm" data-act="export" data-testid="row-export" title="导出 Markdown">导出</button>`
      + `</span>`;
    return MV.item({
      id: s.sid,
      testid: 'row',
      chkTestid: 'row-check',
      sel, open: open && !anim,
      attrs: `data-sid="${esc(s.sid)}" data-msgs="${esc(String(s.msg_count == null ? '' : s.msg_count))}" data-tool="${esc(s.tool)}" draggable="true"${anim ? ' data-anim="1"' : ''}`,
      chipText: showTool ? toolShort(t) : '',
      chipCls: showTool ? toolColorCls(t) : '',
      chipTitle: showTool ? (t ? t.name : s.tool) : '',
      title: s.title || '(无标题)',
      // 副标题按 Skills 的「来源 · 描述」形态：这里用 工具名 · 更新时间（原右侧的 N 条·时间 已去掉）
      sub: `${(t ? t.name : s.tool)} · ${fmtTime(s.updated_at)}`,
      extra: `${acts}${lid}`,
      body: open ? detailHTML(s.sid) : '',
    });
  }).join('');
  box.querySelectorAll('[data-testid="row"]').forEach(row => {
    const sid = row.dataset.sid;
    row.querySelector('input[type=checkbox]').onclick = e => {
      e.stopPropagation();
      e.target.checked ? state.selected.add(sid) : state.selected.delete(sid);
      row.classList.toggle('is-sel', e.target.checked);
      state._panelOff = false;
      renderSelCount();
    };
    row.querySelectorAll('.mvi-acts [data-act]').forEach(b => {
      b.onclick = async e => {
        e.stopPropagation();
        if (b.dataset.act === 'star') {
          const rr = await post('/api/star', { sid });
          if (!rr.data.ok) { HubUI.toast('收藏失败：' + (rr.data.error || ''), 'error'); return; }
          const sm = (state.sessions || []).find(x => x.sid === sid);
          if (sm) sm.starred = rr.data.starred;
          const dd = state._detailCache[sid];
          if (dd) dd.starred = rr.data.starred;
          HubUI.toast(rr.data.starred ? '已收藏' : '已取消收藏', 'success');
          renderRows();
          return;
        }
        if (b.dataset.act === 'copy') {
          try { await navigator.clipboard.writeText(`casr resume ${sid}`); HubUI.toast('已复制 resume 命令', 'success'); }
          catch { HubUI.toast('复制失败（剪贴板被限制）', 'warn'); }
        } else {
          openSession(sid).then(() => document.getElementById('sess-export')?.click());
        }
      };
    });
    // 箭头是唯一的"收起"入口（行头点击改成幂等打开后）：已展开 → 收起，否则 → 展开
    row.querySelector('.mvi__chev').onclick = e => {
      e.stopPropagation();
      if (state._sessDetail === sid) closeSession(sid); else openSession(sid);
    };
    // 点击整行 = 展开 / 收起（就地切换，不重画整表）
    // 行内按钮（勾选 / 收藏 / 折叠箭头 / 详情里的操作）一律不触发展开切换
    row.onclick = (e) => { if (e.target.closest('button, input, a')) return; toggleSession(sid); };
    // 点详情内容任意处 = **不收起**（用户指令 2026-10-19「点击正文不收起」）：内容区用于阅读/选择，
    // 误点不打断；收起只走行头点击或行尾箭头
    const accin = row.querySelector('.mvi__accin');
    if (accin) accin.onclick = (e) => { e.stopPropagation(); };
    row.ondragstart = e => {
      if (!state.selected.has(sid)) { state.selected.add(sid); state._panelOff = false; renderSelCount(); }
      e.dataTransfer.setData('text/plain', [...state.selected].join(','));
    };
  });
  // 本帧标记为“新展开”的行：下一帧补 is-open，让 grid-template-rows 过渡真正跑一次
  if (state._animateOpen) {
    state._animateOpen = null;
    requestAnimationFrame(() => box.querySelectorAll('[data-anim="1"]').forEach(r => r.classList.add('is-open')));
  }
  bindDetailHandlers();
  renderSessPager();
  renderSelCount();
}
function toggleSel(sid, cb) {
  cb.checked ? state.selected.add(sid) : state.selected.delete(sid);
  const row = cb.closest('.row');
  if (row) row.classList.toggle('is-sel', cb.checked);
  renderSelCount(); renderSessPager();
}
function selectAll(cb) {
  const list = visibleSessions();
  list.forEach(s => cb.checked ? state.selected.add(s.sid) : state.selected.delete(s.sid));
  renderRows(); renderSelCount();
}
function sessSelAll() {
  visibleSessions().forEach(s => state.selected.add(s.sid));
  renderRows(); renderSelCount();
}
function sessSelInvert() {
  visibleSessions().forEach(s => state.selected.has(s.sid) ? state.selected.delete(s.sid) : state.selected.add(s.sid));
  renderRows(); renderSelCount();
}
function sessSelNone() {
  state.selected.clear();
  renderRows(); renderSelCount();
}
function renderSessPager() {
  // 兜底：已选集必须 ⊆ 当前作用域（切工具 / 数据刷新 / 搜索过滤后都可能残留）
  { const ids = new Set(scopedSessions().map(s => s.sid));
    [...state.selected].forEach(sid => { if (!ids.has(sid)) state.selected.delete(sid); }); }
  const info = document.getElementById('sess-pinfo');
  // 页脚只留这一处计数（2026-10-14：左侧那个「已选 N 条」与之重复，已删）
  if (info) info.innerHTML = `已选 <b id="sel-count" data-testid="sel-count">${state.selected.size}</b>`
    + ` · 显示 ${visibleSessions().length} 条 · 共 ${scopedSessions().length} 条`;   // 会话口径：已选 N · 显示 M · 共 K
  const none = document.getElementById('sess-sel-none');
  if (none) none.disabled = !state.selected.size;
}
function renderSessStats() {
  const box = document.getElementById('sess-stats');
  if (!box) return;
  const list = state.sessions || [];
  const tools = new Set(list.map(s => s.tool)).size;
  const migrated = list.filter(s => s.lid).length;
  const starred = list.filter(s => s.starred).length;
  const msgs = list.reduce((a, s) => a + (s.msg_count || 0), 0);
  box.innerHTML = `
    <div class="nv-stat"><b>${list.length}</b><span>会话${state.filter !== 'all' ? ' · 当前筛选' : ''}</span></div>
    <div class="nv-stat"><b>${tools}</b><span>已接入工具</span></div>
    <div class="nv-stat"><b>${msgs}</b><span>消息总量</span></div>
    <div class="nv-stat"><b>${migrated}</b><span>迁移勾连（lineage）</span></div>
    <div class="nv-stat"><b>${starred}</b><span>★ 收藏</span></div>`;
}
function renderSelCount() {
  const noneBtn = document.getElementById('sess-sel-none');
  if (noneBtn) noneBtn.disabled = !state.selected.size;
  renderSessPager();
  renderPanel();
}
function setFilter(tool) {
  state.filter = tool;
  state.selected.clear();      // 换筛选作用域：清空已选，保持"勾选集合 ⊆ 当前可见列表"
  state._sessDetail = null;
  // 切到别的工具/全部 → 退出工具视图（顶部恢复详细网格）；进入工具视图走 enterTool
  if (state._toolFocus && state._toolFocus !== tool) state._toolFocus = null;
  renderToolGrid(); syncFilterSegActive();
  renderRows();
}

/* ---------- 迁移目标面板（展开会话或勾选后从右侧滑出） ---------- */
// 可选目标：有会话根路径的工具，排除当前聚焦工具与会话原属工具
function panelTargets() {
  const sids = state.selected.size ? [...state.selected] : (state._sessDetail ? [state._sessDetail] : []);
  const srcTools = new Set(sids
    .map(sid => ((state.sessions || []).find(x => x.sid === sid) || {}).tool)
    .filter(Boolean));
  // 迁移目标 = 启用且有会话根目录的工具（与卡片/列表同口径）
  return sessionTools().filter(t => t.id !== state._toolFocus && !srcTools.has(t.id));
}
function renderPanel() {
  const panel = document.getElementById('sess-panel');
  const host = document.getElementById('sess-panel-in');
  if (!panel || !host) return;
  const n = state.selected.size || (state._sessDetail ? 1 : 0);
  const show = !state._panelOff && n > 0;
  panel.classList.toggle('is-in', show);
  if (!show) return;
  const d = state._detailCache[state._sessDetail];
  const targets = panelTargets();
  // 已被移除的工具自动退出选中集合
  state._migTargets = state._migTargets.filter(id => targets.some(t => t.id === id));
  const selNow = () => (state.selected.size
    ? `已选 <b class="mono">${state.selected.size}</b> 条`
    : `当前：${esc((d && (d.title || d.sid)) || '—')}`);
  // 统一目标选择组件（用户 2026-10-20「目标选择：按 skills 对齐」）
  const picker = MV.targetPicker({
    prefix: 'sess',
    items: targets.map(t => ({ id: t.id, name: t.name, dotCls: toolColorCls(t), testid: `sess-target-${t.id}` })),
    chosen: (state._migTargets || []).map(String),
    selLine: selNow(),
    selLineFn: () => selNow(),
    goText: '迁移',
    goTextFn: (set) => {
      const list = targets.filter(t => set.has(String(t.id)));
      const what = !list.length ? '…' : list.length === 1 ? list[0].name : `${list.length} 个工具`;
      return `迁移 ${n} 条到 ${what}`;
    },
    onChange: (ids) => { state._migTargets = ids.map(Number); },
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
  const closeBtn = host.querySelector('#sess-panel-close');
  if (closeBtn) closeBtn.onclick = closePanel;
}
function closePanel() { state._panelOff = true; renderPanel(); }

/* ---------- migration（工具卡片与迁移面板即迁移目标；确认条内联在面板内） ---------- */
/**
 * 迁移确认条（内联在目标面板里，替代弹窗）。targets 可以是单个工具 id 或 id 数组。
 * 底部台账已按用户指令 2026-10-20 去掉 → 确认条直接挂在面板底部（.spanel__in 末尾）。
 */
function migrateConfirmInline(targets, ids) {
  if (!ids.length) { HubUI.toast('先勾选要迁移的会话，或展开一条会话', 'warn'); return; }
  const tlist = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  if (!tlist.length) return;
  // 确认条插在目标面板内 → 先把面板展开并记下目标，保证用户看得见
  state._panelOff = false; state._migTargets = tlist; renderPanel();
  const byId = Object.fromEntries(state.sessions.map(s => [s.sid, s]));
  const items = ids.map(id => byId[id]).filter(s => s && !tlist.includes(s.tool));
  if (!items.length) { HubUI.toast('所选会话已属于目标工具，无需迁移', 'warn'); return; }
  const tNames = tlist.map(t => (toolById(t) || {}).name || TOOL_NAMES[t] || t).join('、');
  const old = document.getElementById('mig-confirm');
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.className = 'nv-migconfirm';
  bar.id = 'mig-confirm';
  bar.innerHTML = `
    <div class="nv-migconfirm__txt">迁移 <b>${items.length}</b> 条 → <b>${esc(tNames)}</b>${items.length <= 3 ? '<br>' + items.map(s => esc((s.title || s.sid).slice(0, 30))).join('<br>') : `<br>${esc((items[0].title || items[0].sid).slice(0, 30))} 等`}
    <span class="mono-xs">生成新副本，源不动，入 lineage</span></div>
    <div class="nv-migconfirm__acts">
      <button class="hub-btn btn-sm" data-act="cancel">取消</button>
      <button class="hub-btn btn-sm hub-btn--primary" data-act="go">开始迁移</button>
    </div>`;
  bar.querySelector('[data-act="cancel"]').onclick = () => bar.remove();
  bar.querySelector('[data-act="go"]').onclick = async (e) => {
    bar.remove();
    e.currentTarget.classList.add('is-loading');
    await runMigration(items, tlist, false);
  };
  const anchor = document.getElementById('sess-panel-in');
  (anchor || document.body).appendChild(bar);
  bar.scrollIntoView({ block: 'nearest' });
}
function renderDrops() { /* no-op：迁移入口为工具卡片/迁移面板，由 renderToolGrid 与 renderPanel 渲染 */ }

async function runMigration(items, targets, force) {
  // 多选：targets 可以是单个 id 或 id 数组；逐「目标 × 会话」发起迁移（后端一次只认一个 target）
  const tlist = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  const target = tlist[0];                       // 兼容下方「同步更新」单目标重入
  const ok = [], dup = [], err = [];
  const total = tlist.length * items.length;
  let done = 0;
  const toastEl = HubUI.toast('迁移中… 0/' + total, 'info', 60000);
  for (const tg of tlist) {
    for (const s of items) {
      if (s.tool === tg) { done++; continue; }   // 已经是该工具，跳过
      const r = await post('/api/migrate', { sid: s.sid, target: tg, force: !!force });
      if (r.data.ok) ok.push({ s, r: r.data, tg });
      else if (r.data.duplicate) dup.push({ s, tg });
      else err.push({ s, msg: r.data.error || ('迁移失败（HTTP ' + r.status + '，引擎 casr）') });
      done++;
      const msgEl = toastEl.querySelector('.hub-toast__msg');
      if (msgEl) msgEl.textContent = `迁移中… ${done}/${total}`;
    }
  }
  toastEl.remove();
  if (ok.length) {
    const lids = ok.map(o => o.r.lid).filter(Boolean);
    const tnames = [...new Set(ok.map(o => TOOL_NAMES[o.tg] || o.tg))].join('、');
    HubUI.toast(`${ok.length} 条已迁移到 ${tnames}` +
      (lids.length ? `（${[...new Set(lids)].join(', ')}）` : ''), 'success');
  }
  if (err.length) {
    HubUI.toast(`${err.length} 条失败：${err[0].msg.slice(0, 60)}`, 'error', 5200);
  }
  if (dup.length) {
    // fetch increment info for a richer message (single-item case gets exact delta)
    let inc = '';
    const dupItems = dup.map(d => d.s);
    if (dup.length === 1) {
      const d0 = dup[0];
      const pv = await api('/api/sync/preview?sid=' + encodeURIComponent(d0.s.sid) + '&target=' + d0.tg);
      const s = pv.data && pv.data.sync;
      if (s && s.delta != null) {
        inc = s.delta > 0
          ? `<br><br>该会话自上次迁移后<b>新增 ${s.delta} 条消息</b>（基线 ${s.base_count} → 当前 ${s.current_count}），可「同步更新」生成修订副本。`
          : '<br><br>自上次迁移后<b>没有新消息</b>，通常无需同步。';
      }
    }
    const dupTargets = [...new Set(dup.map(d => d.tg))];
    HubUI.confirm('检测到已迁移过的会话',
      `${dup.length} 条会话此前已迁移到 ${dupTargets.map(t => TOOL_NAMES[t] || t).join('、')}（同一 lineage 通道已记录，避免重复副本）。` + inc +
      '<br><br>「同步更新」会生成目标工具内的新修订副本（不覆盖旧副本、不动源会话）。',
      async () => { await runMigration(dupItems, dupTargets, true); },
      { confirmText: '同步更新', cancelText: '忽略跳过' });
  }
  state.selected.clear();
  await loadState();
}

/* ---------- refresh ---------- */
async function refreshAll(btn) {
  btn.classList.add('is-loading');
  const r = await post('/api/refresh');
  btn.classList.remove('is-loading');
  if (r.data.ok) {
    const sum = (r.data.results || []).map(x =>
      `${TOOL_NAMES[x.tool] || x.tool} +${x.error ? 'err' : x.new_messages}`).join(' · ');
    HubUI.toast('全量刷新完成：' + sum, 'success');
  } else {
    HubUI.toast('刷新失败：' + (r.data.error || '未知错误'), 'error');
  }
  await loadState();
}
async function refreshOne(tool, btn) {
  btn.classList.add('is-loading');
  const r = await post('/api/refresh', { tool });
  btn.classList.remove('is-loading');
  if (r.data.ok) {
    const s = (r.data.results || [])[0] || {};
    HubUI.toast(`${TOOL_NAMES[tool]} 刷新完成 · 新增 ${s.error ? '失败' : s.new_messages} 条消息`,
      s.error ? 'error' : 'success');
  } else {
    HubUI.toast('刷新失败：' + (r.data.error || ''), 'error');
  }
  await loadState();
}

/* ---------- schedule ---------- */
function schedScopes() {
  const list = [['all', '全部工具']];
  // 定时扫描针对会话采集：无会话根路径（root 为空）的工具不列
  for (const t of TOOL_LIST) if (t.enabled && t.root) list.push([t.id, t.name]);
  return list;
}
const INTERVALS = [5, 10, 15, 30, 60, 180];
function openSchedule() {
  const body = document.getElementById('sched-body');
  body.innerHTML = schedScopes().map(([k, name]) => {
    const cfg = (state.schedule || {})[k] || { enabled: false, interval_min: 30 };
    return `<div class="sched__row" data-testid="sched-row-${k}">
      <span class="sched__name">${name}</span>
      ${HubUI.select({ testid: 'sched-interval-' + k, value: cfg.interval_min,
        options: INTERVALS.map(m => ({ value: m, label: '每 ' + m + ' 分钟' })) })}
      <span class="switch ${cfg.enabled ? 'is-on' : ''}" data-testid="sched-toggle-${k}">
        <span class="switch__track"></span></span>
    </div>`;
  }).join('');
  body.querySelectorAll('.switch').forEach(sw => {
    sw.onclick = () => sw.classList.toggle('is-on');
  });
  document.getElementById('sched-overlay').classList.add('is-open');
}
function closeSchedule() { document.getElementById('sched-overlay').classList.remove('is-open'); }
async function saveSchedule(btn) {
  btn.classList.add('is-loading');
  for (const [k] of schedScopes()) {
    const row = document.querySelector(`[data-testid="sched-row-${k}"]`);
    const enabled = row.querySelector('.switch').classList.contains('is-on');
    const interval = parseInt(row.querySelector('.hub-select').value, 10);
    await post('/api/schedule', { tool: k, enabled, interval_min: interval });
  }
  btn.classList.remove('is-loading');
  HubUI.toast('定时任务已保存', 'success');
  closeSchedule();
  await loadState();
}

/* ---------- tools registry ----------
   2026-10-16：去掉「添加工具」能力（用户指令）；工具弹窗随之删除。
   编辑 / 启停 / 删除 / 接入记忆总线 统一在「设置 → 工具」的行内面板（web/views/settings.js）。
   后端 POST /api/tools 仍在（测试夹具与内置工具初始化用），前端不再暴露入口。 */

/* ---------- memory ---------- */
function renderMemories() {
  const box = document.getElementById('memory-list');
  const list = state.memories || [];
  if (!list.length) {
    box.innerHTML = '<div class="hub-empty">记忆区还是空的<div class="hub-empty__hint">迁移会话会自动写入摘要；也可以手动添加</div></div>';
    return;
  }
  box.innerHTML = '';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'mem-item';
    el.dataset.testid = 'memory-item';
    const kindName = { note: '笔记', 'migration-summary': '迁移记录' }[m.kind] || m.kind;
    el.innerHTML = `
      <div class="mem-item__head">
        <span class="hub-badge hub-badge--neutral">${kindName}</span>
        <span class="mem-item__title">${esc(m.title || '(无标题)')}</span>
        <span class="mem-item__ts">${fmtTime(m.ts)}</span>
      </div>
      <div class="mem-item__body">${esc(m.body)}</div>
      <div class="mem-item__acts"><button class="hub-btn btn-sm" data-testid="memory-delete">删除</button></div>`;
    el.querySelector('[data-testid="memory-delete"]').onclick = async () => {
      HubUI.confirm('删除记忆', '确认删除这条记忆？<br>（仅删除 hub 记忆，不影响任何原生会话）', async () => {
        const r = await post('/api/memory/delete', { id: m.id });
        if (r.data.ok) { HubUI.toast('已删除', 'success'); await loadState(); }
        else HubUI.toast('删除失败：' + (r.data.error || ''), 'error');
      }, { confirmText: '删除', danger: true });
    };
    box.appendChild(el);
  }
}
async function addMemory(btn) {
  const title = document.getElementById('memory-title').value.trim();
  const body = document.getElementById('memory-body').value.trim();
  if (!body) { HubUI.toast('内容不能为空', 'error'); return; }
  btn.classList.add('is-loading');
  const r = await post('/api/memory/add', { title, body, kind: 'note' });
  btn.classList.remove('is-loading');
  if (r.data.ok) {
    HubUI.toast('记忆已保存', 'success');
    document.getElementById('memory-title').value = '';
    document.getElementById('memory-body').value = '';
    await loadState();
  } else {
    HubUI.toast('保存失败：' + (r.data.error || ''), 'error');
  }
}

/* ---------- ledger / migrations ---------- */
function renderLedger() {
  const box = document.getElementById('ledger-list');
  const list = (state.ledger || []).slice(0, 15);
  if (!list.length) { box.innerHTML = '<div class="hub-empty">暂无操作记录</div>'; return; }
  box.innerHTML = '';
  for (const l of list) {
    let detail = '';
    try {
      const d = JSON.parse(l.detail);
      if (l.action.startsWith('refresh')) detail = (d.results || []).map(x => `${x.tool} +${x.error ? 'err' : x.new_messages}`).join(' · ');
      else if (l.action === 'migrate') detail = `${d.from} → ${d.to} · ${d.ok ? '成功' : '失败'}${d.lid ? ' · ' + d.lid : ''}`;
      else if (l.action === 'config') detail = `配置更新：${d.schedule || ''}`;
      else detail = typeof l.detail === 'string' ? l.detail.slice(0, 80) : '';
    } catch { detail = (l.detail || '').slice(0, 80); }
    const el = document.createElement('div');
    el.className = 'led-item';
    el.innerHTML = `<div class="led-item__time">${esc((l.ts || '').slice(11, 16))} · ${esc(l.action)}</div>
      <div class="led-item__act">${esc(detail)}</div>`;
    box.appendChild(el);
  }
}

/* ---------- status ---------- */
function renderStatus() {
  const eng = document.getElementById('engine-badge');
  eng.textContent = state.engine && state.engine.casr ? '引擎 casr · 已连接' : '引擎 casr · 未安装（只读模式）';
  const schedOn = Object.values(state.schedule || {}).filter(s => s.enabled).length;
  document.getElementById('status-sched').textContent = `定时调度：${schedOn ? schedOn + ' 个范围已启用' : '未启用'}`;
  document.getElementById('status-mem').textContent = `记忆 ${(state.memories || []).length} 条`;
  const am = document.getElementById('status-am');
  if (am) {
    am.textContent = state.engine && state.engine.agentmemory
      ? '记忆总线 agentmemory · 运行中 (:3113)'
      : '记忆总线 agentmemory · 未运行';
  }
}

/* ---------- content search (v0.3) ---------- */
let lastSearchSid = null;
async function runContentSearch(q) {
  const r = await api('/api/search?q=' + encodeURIComponent(q));
  const panel = document.getElementById('search-panel');
  const allowed = new Set(sessionTools().map(t => t.id));   // 口径 B：只搜可见域
  const hits = (r.data.results || []).filter(x => allowed.has(x.tool));
  if (!r.data.ok || !hits.length) {
    panel.innerHTML = '<div class="hub-empty" style="padding:var(--sp-4)">没有消息内容匹配</div>';
    panel.style.display = '';
    return;
  }
  panel.innerHTML = hits.map(x => `
    <div class="search-item" data-testid="search-item" data-sid="${esc(x.sid)}">
      <span class="search-item__tool">${esc(TOOL_NAMES[x.tool] || x.tool)}</span>
      <span class="search-item__title">${esc(x.title || x.sid.slice(0, 12))}</span>
      <span class="search-item__snip">${esc(x.snippet || '')}</span>
      <span class="search-item__hits">${x.hits}×</span>
    </div>`).join('');
  panel.style.display = '';
  panel.querySelectorAll('.search-item').forEach(el => {
    el.onclick = () => { hideSearchPanel(); openSessionFull(el.dataset.sid); };
  });
}
function hideSearchPanel() {
  const panel = document.getElementById('search-panel');
  if (panel) panel.style.display = 'none';
}

/* ---------- preview actions (v0.3) ---------- */
function resumeCommand(s) {
  if (s.tool === 'claude') return 'claude --resume ' + s.sid;
  if (s.tool === 'codex') return 'codex resume ' + s.sid;
  if (s.tool === 'opencode') return 'cd "' + (s.cwd || '') + '" && opencode   # 在会话列表中选择 ' + s.sid.slice(0, 12);
  return '# 在 ' + TOOL_NAMES[s.tool] + ' 中继续会话 ' + s.sid.slice(0, 12) + (s.cwd ? '（目录：' + s.cwd + '）' : '');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      return true;
    } catch (e2) { return false; }
  }
}

/* ---------- 会话详情（v0.8：列表行内联手风琴；同时镜像到 preview-* 节点供兼容） ---------- */
const SVG_CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/* 附件图标（线性，1.8 线宽，与模块图标同一套） */
const ATT_ICONS = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="m21 15-4.5-4.5L9 18"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6v5H9z"/><path d="M9 16h6"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 6 3-6 3z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

/** 文件大小 → 人话（0 不显示）。 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** 有附件时去掉扫描器留下的 [file] / [image] 占位行，避免和预览重复。 */
function stripAttPlaceholders(text, atts) {
  const t = String(text || '');
  if (!atts || !atts.length) return t;
  return t.split('\n').filter(line => !/^\[(file|image)\b/.test(line.trim()))
    .join('\n').replace(/^\s*\n+/, '').trim();
}

/** 一条消息的附件：图片直接大图预览，其余给文件行（点击弹窗或下载）。 */
function attsHTML(m) {
  const list = m.attachments || [];
  if (!list.length) return '';
  return '<div class="msg__atts">' + list.map(a => {
    const kind = a.kind || 'file';
    const name = a.name || '附件';
    const attrs = `data-att-url="${esc(a.url || '')}" data-att-dl="${esc(a.download || a.url || '')}"`
      + ` data-att-kind="${esc(kind)}" data-att-mime="${esc(a.mime || '')}" data-att-name="${esc(name)}"`;
    if (kind === 'image') {
      return `<button type="button" class="msg__att msg__att--img" ${attrs} aria-label="查看图片 ${esc(name)}">`
        + `<img src="${esc(a.url || '')}" alt="${esc(name)}" loading="lazy"></button>`;
    }
    if (kind === 'folder') {
      return `<div class="msg__att msg__file is-disabled"><span class="msg__att-ic">${ATT_ICONS.folder}</span>`
        + `<span class="msg__att-nm">${esc(name)}</span><span class="msg__att-sz">文件夹</span></div>`;
    }
    const size = fmtBytes(a.size);
    return `<button type="button" class="msg__att msg__file" ${attrs} aria-label="打开 ${esc(name)}">`
      + `<span class="msg__att-ic">${ATT_ICONS[kind] || ATT_ICONS.file}</span>`
      + `<span class="msg__att-nm">${esc(name)}</span>`
      + (size ? `<span class="msg__att-sz">${esc(size)}</span>` : '') + '</button>';
  }).join('') + '</div>';
}

/** 附件预览：图片 / 文本 / PDF / 音视频分别走弹窗，其它直接下载。 */
function openAttachment(ds) {
  const kind = ds.attKind || 'file';
  const name = ds.attName || '附件';
  const url = ds.attUrl;
  const dl = ds.attDl || url;
  if (!url) return;
  const download = () => {
    const a = document.createElement('a');
    a.href = dl; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  };
  if (kind === 'folder') { HubUI.toast('文件夹无法预览', 'info'); return; }
  if (kind === 'image') {
    HubUI.modal({
      title: name,
      bodyHTML: `<img class="att-view att-view--img" src="${esc(url)}" alt="${esc(name)}">`,
      confirmText: '下载', cancelText: '关闭', wide: true,
      onConfirm: () => { download(); return false; },
    });
    return;
  }
  if (kind === 'text') {
    const m = HubUI.modal({
      title: name, bodyHTML: '<div class="att-loading">正在读取…</div>',
      confirmText: '关闭', cancelText: null, wide: true,
    });
    fetch(url).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(text => {
      const body = m.overlay.querySelector('.hub-modal__body');
      const pre = document.createElement('pre');
      pre.className = 'att-view att-view--text';
      pre.textContent = text.length > 200000
        ? text.slice(0, 200000) + '\n\n…（内容过长，已截断；完整文件请下载）' : text;
      body.innerHTML = '';
      body.appendChild(pre);
    }).catch(() => {
      m.overlay.querySelector('.hub-modal__body').textContent = '读取失败：文件可能已删除或无法访问';
    });
    return;
  }
  if (kind === 'pdf') {
    HubUI.modal({
      title: name,
      bodyHTML: `<iframe class="att-view att-view--pdf" src="${esc(url)}" title="${esc(name)}"></iframe>`,
      confirmText: '下载', cancelText: '关闭', wide: true,
      onConfirm: () => { download(); return false; },
    });
    return;
  }
  if (kind === 'audio' || kind === 'video') {
    const tag = kind === 'audio' ? 'audio' : 'video';
    HubUI.modal({
      title: name,
      bodyHTML: `<${tag} class="att-view att-view--media" controls src="${esc(url)}"></${tag}>`,
      confirmText: '下载', cancelText: '关闭',
      onConfirm: () => { download(); return false; },
    });
    return;
  }
  download();
}

// 附件点击统一走**捕获阶段**委托：详情内容区会 stopPropagation（防误点收起），
// 冒泡阶段收不到，必须在捕获阶段先接住。
document.addEventListener('click', e => {
  const el = e.target.closest('[data-att-url]');
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openAttachment(el.dataset);
}, true);

// 拉取会话详情（消息 + lineage 链）写入缓存；重复打开命中缓存不再请求
async function loadSessionDetail(sid) {
  const r = await api('/api/session?id=' + encodeURIComponent(sid));
  if (r.status !== 200) { state._detailCache[sid] = null; HubUI.toast('会话不存在或已清理', 'error'); return; }
  const s = r.data;
  let chainHTML = `${TOOL_NAMES[s.tool] || s.tool} · ${s.sid}`;
  try {
    const lin = await api('/api/lineage?tool=' + s.tool + '&sid=' + encodeURIComponent(s.sid));
    if (lin.data && lin.data.lid) {
      const hops = (lin.data.migrations || [])
        .filter(m => m.status === 'ok')
        .map(m => `${TOOL_NAMES[m.src_tool] || m.src_tool} → ${TOOL_NAMES[m.dst_tool] || m.dst_tool}`);
      chainHTML += ` · [hub:${lin.data.lid}]` + (hops.length ? ' · ' + hops.join(' · ') : '');
    }
  } catch (e) { /* lineage 可选：失败不影响详情展示 */ }
  const messagesHTML = !(s.messages || []).length
    ? '<div class="hub-empty">该会话暂无可显示的文本消息</div>'
    : s.messages.map(m => {
        const cls = m.role === 'assistant' ? ' msg--assistant' : (m.role === 'tool' ? ' msg--tool' : '');
        const role = (m.role || '?').toUpperCase() + (m.ts ? ' · ' + String(m.ts).slice(11, 16) : '');
        const text = stripAttPlaceholders(m.content || '', m.attachments);
        const bubble = text ? `<div class="msg__bubble">${esc(text.slice(0, 6000))}</div>` : '';
        return `<div class="msg${cls}"><div class="msg__role">${esc(role)}</div>${bubble}${attsHTML(m)}</div>`;
      }).join('');
  state._detailCache[sid] = {
    sid: s.sid, tool: s.tool, title: s.title, starred: s.starred,
    chain: chainHTML, messagesHTML, resume: resumeCommand(s),
  };
}

// 手风琴内容：未缓存 → 占位；缓存为 null → 已清理
function detailHTML(sid) {
  const d = state._detailCache[sid];
  if (d === undefined) return '<div class="srow__load">正在读取会话详情…</div>';
  if (d === null) return '<div class="srow__load">会话不存在或已清理</div>';
  return `
    <div class="dhead">
      <div class="dtitle" data-testid="sess-detail-title">${d.starred ? '<span class="dstar">★</span>' : ''}${esc(d.title || '(无标题)')}</div>
      <div class="dchain" id="sess-detail-chain">${esc(d.chain)}</div>
      <div class="dops">
        <button class="hub-btn btn-sm" id="sess-star">${d.starred ? '★ 已收藏' : '☆ 收藏'}</button>
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
async function openSessionFull(sid) {
  state._sessDetail = sid;
  state._animateOpen = sid;
  state._panelOff = false;
  // 展开即选中（用户指令 2026-10-20：收起时取消选中）
  state.selected.add(sid);
  renderSelCount();
  renderRows();
  renderPanel();
  if (state._detailCache[sid] === undefined) {
    await loadSessionDetail(sid);
    renderRows();
    renderPanel();
  }
}

/** 打开某会话详情：优先就地把展开体填进当前行（不重画列表） */
async function openSession(sid) {
  const row = document.querySelector(`#session-rows .mvi[data-sid="${CSS.escape(sid)}"]`);
  state._sessDetail = sid;
  state._panelOff = false;
  // 展开即选中（用户指令 2026-10-20：收起时取消选中）；勾选框跟着变
  state.selected.add(sid);
  if (row) { const cb = row.querySelector('[data-testid="row-check"]'); if (cb) cb.checked = true; }
  renderSelCount();
  if (state._detailCache[sid] === undefined) {
    if (row && !row.classList.contains('is-open')) {
      // 先展开 + 占位，再异步填内容（用户立刻看到高度过渡，而不是等网络）
      const acc = row.querySelector('.mvi__accin');
      if (acc) acc.innerHTML = '<div class="srow__load">加载中…</div>';
      row.classList.remove('is-open'); void row.offsetWidth; row.classList.add('is-open');
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
function fillDetailInPlace(row, sid) {
  if (!row) { renderRows(); renderPanel(); return; }
  const acc = row.querySelector('.mvi__accin');
  if (acc) acc.innerHTML = detailHTML(sid);
  row.classList.remove('is-open');
  void row.offsetWidth;                 // 重启动画：grid-template-rows 0fr → 1fr
  row.classList.add('is-open');
  const chev = row.querySelector('.mvi__chev');
  if (chev) chev.title = '收起';
}

/** 收起：只去掉类名，让高度过渡把它收回去（不重画） */
function closeSession(sid) {
  const row = document.querySelector(`#session-rows .mvi[data-sid="${CSS.escape(sid)}"]`);
  state._sessDetail = null;
  state._panelOff = false;
  // 收起即取消选中（用户指令 2026-10-20）
  state.selected.delete(sid);
  if (row) { const cb = row.querySelector('[data-testid="row-check"]'); if (cb) cb.checked = false; }
  renderSelCount();
  if (row) {
    row.classList.remove('is-open');
    const chev = row.querySelector('.mvi__chev');
    if (chev) chev.title = '展开';
  }
  renderPanel();
}

/**
 * 点会话行头：展开 / 收起（toggle）。
 * 改动：2026-10-20 一度改成"幂等打开"（为迁就 E2E 的时序假设），用户随即要求改回
 * ——「为什么点击不会收起了？」。现恢复 toggle：已展开再点 = 收起（同时取消勾选）。
 */
function toggleSession(sid) {
  if (state._sessDetail === sid) return closeSession(sid);
  return openSession(sid);
}

// 绑定当前展开行的操作按钮（收藏 / resume / 导出），并同步预览镜像节点
function bindDetailHandlers() {
  const sid = state._sessDetail;
  const d = sid ? state._detailCache[sid] : null;
  if (!d) return;
  const starBtn = document.getElementById('sess-star');
  if (starBtn) starBtn.onclick = async () => {
    const rr = await post('/api/star', { sid });
    if (!rr.data.ok) { HubUI.toast('收藏失败：' + (rr.data.error || ''), 'error'); return; }
    d.starred = rr.data.starred;
    const s = (state.sessions || []).find(x => x.sid === sid);
    if (s) s.starred = rr.data.starred;
    HubUI.toast(rr.data.starred ? '已收藏' : '已取消收藏', 'success');
    renderRows();
  };
  const resBtn = document.getElementById('sess-resume');
  if (resBtn) resBtn.onclick = async () => {
    const ok = await copyText(d.resume);
    HubUI.toast(ok ? '已复制：' + d.resume : '复制失败，请手动复制：' + d.resume, ok ? 'success' : 'warn', 5200);
  };
  const expBtn = document.getElementById('sess-export');
  if (expBtn) expBtn.onclick = async () => {
    expBtn.classList.add('is-loading');
    const rr = await api('/api/export?sid=' + encodeURIComponent(sid));
    expBtn.classList.remove('is-loading');
    if (rr.data.ok) HubUI.toast('已导出 ' + (rr.data.bytes / 1024).toFixed(1) + ' KB → ' + rr.data.path, 'success', 5600);
    else HubUI.toast('导出失败：' + (rr.data.error || ''), 'error');
  };
  mirrorPreview(d);
}
// preview-* 覆盖层已不再弹出（详情改列表内联），节点保留并同步，旧调用仍可用
function mirrorPreview(d) {
  const pt = document.getElementById('preview-title');
  if (!pt) return;
  pt.textContent = d.title || '(无标题)';
  document.getElementById('preview-chain').textContent = d.chain;
  document.getElementById('preview-body').innerHTML = d.messagesHTML;
  const starBtn = document.getElementById('preview-star');
  starBtn.textContent = d.starred ? '★ 已收藏' : '☆ 收藏';
  starBtn.onclick = async () => {
    const rr = await post('/api/star', { sid: d.sid });
    if (rr.data.ok) {
      d.starred = rr.data.starred;
      HubUI.toast(rr.data.starred ? '已收藏' : '已取消收藏', 'success');
      renderRows();
    } else HubUI.toast('收藏失败：' + (rr.data.error || ''), 'error');
  };
  document.getElementById('preview-resume').onclick = async () => {
    const ok = await copyText(d.resume);
    HubUI.toast(ok ? '已复制：' + d.resume : '复制失败，请手动复制：' + d.resume, ok ? 'success' : 'warn', 5200);
  };
  const exportBtn = document.getElementById('preview-export');
  exportBtn.onclick = async () => {
    exportBtn.classList.add('is-loading');
    const rr = await api('/api/export?sid=' + encodeURIComponent(d.sid));
    exportBtn.classList.remove('is-loading');
    if (rr.data.ok) HubUI.toast('已导出 ' + (rr.data.bytes / 1024).toFixed(1) + ' KB → ' + rr.data.path, 'success', 5600);
    else HubUI.toast('导出失败：' + (rr.data.error || ''), 'error');
  };
}
function closePreview() { document.getElementById('preview-overlay').classList.remove('is-open'); }

/* ---------- tabs（v0.6 起侧栏仅迁移联动，无 tab；保留空实现兼容旧调用） ---------- */
function setTab(name) {
  state.tab = name;
}

/* ---------- utils ---------- */
function fmtTime(t) {
  if (!t) return '—';
  if (String(t).includes('T')) {
    const d = new Date(t);
    if (!isNaN(d)) return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return String(t).slice(5, 16);
}
function esc(s) {
  return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- v0.4: session stats (S1) ---------- */
async function openStats() {
  const r = await api('/api/stats');
  const st = (r.data || {}).stats;
  if (!st) { HubUI.toast('统计加载失败', 'error'); return; }
  const row = (label, n, max) => `
    <div class="stat-row"><span class="stat-label" title="${esc(label)}">${esc(label)}</span>
      <span class="stat-track"><span class="stat-bar" style="width:${Math.max(3, Math.round(n / Math.max(1, max) * 100))}%"></span></span>
      <span class="stat-n">${n}</span></div>`;
  const maxTool = Math.max(...st.by_tool.map(x => x.sessions), 1);
  const maxDay = Math.max(...st.by_day.map(x => x.sessions), 1);
  const maxProj = Math.max(...st.by_project.map(x => x.sessions), 1);
  HubUI.modal({
    title: '会话统计（S1）', confirmText: '批量导出全部（zip）', cancelText: '关闭',
    bodyHTML: `
      <div class="stats-wrap">
        <div class="stats-totals">
          <div><b>${st.totals.sessions}</b><span>会话</span></div>
          <div><b>${st.totals.messages}</b><span>消息</span></div>
          <div><b>${st.totals.starred}</b><span>收藏</span></div>
          <div><b>${st.totals.migrations}</b><span>迁移</span></div>
        </div>
        <div class="rail__h">按工具</div>
        ${st.by_tool.map(x => row(TOOL_NAMES[x.tool] || x.tool, x.sessions, maxTool)).join('')}
        <div class="rail__h">按天（近 14 天）</div>
        ${st.by_day.map(x => row(x.day, x.sessions, maxDay)).join('')}
        <div class="rail__h">按项目（Top 10）</div>
        ${st.by_project.map(x => row(x.project.replace(/^\/Users\/[^/]+/, '~'), x.sessions, maxProj)).join('')}
      </div>`,
    onConfirm: async () => {
      const r2 = await post('/api/export/batch', {});
      if (r2.data.ok) HubUI.toast(`已导出 ${r2.data.count} 个会话 → ${r2.data.path}`, 'success', 6400);
      else HubUI.toast('批量导出失败：' + (r2.data.error || ''), 'error');
    },
  });
}

/** 骨架屏：列表首次加载时占位（3 行），避免"一行灰字 → 整块内容"的跳变 */
function skeletonRows(n) {
  return `<div class="ske">${Array.from({ length: n || 3 }, () => '<div class="ske__row"><span class="ske__a"></span><span class="ske__b"></span></div>').join('')}</div>`;
}
window.skeletonRows = skeletonRows;

/* ====================================================================
   即时刷新（SSE）：磁盘变动 → 后端推 → 前端只刷新受影响的那一块
   后端 hub/watcher.py：kqueue（macOS/BSD，stdlib）/ watchdog（若装了）/
   manifest 兜底，合并抖动后经 /api/events 推送 {rev, scopes, full}。
   自身写入（POST/PATCH/DELETE）后端立刻 broadcast，不等 watcher。
   断线或环境不支持 EventSource 时，退回自适应轮询（可见 3s / 后台 60s）。
   ==================================================================== */
const LIVE = { es: null, pollTimer: null, lastRev: 0, mode: 'idle', events: 0 };

function activeViewId() {
  const v = document.querySelector('.view.is-active');
  return v ? v.id.replace(/^view-/, '') : 'sessions';
}

/** 只刷新当前可见模块（其它模块等切过去时自然重渲染） */
async function refreshView(id) {
  const root = document.getElementById('view-' + id);
  if (!root) return;
  if (id === 'connect' && window.ConnectView) await ConnectView.refresh();
  else if (id === 'skills' && window.SkillsView) await SkillsView.refresh({ parts: ['rows', 'targets', 'ledger'] });
  else if (id === 'mcp' && window.McpView) await McpView.refresh({ parts: ['rows', 'targets', 'ledger'] });
  else if (id === 'ops' && window.OpsView) await OpsView.render(root);
  else if (id === 'memory' && window.MemoryView) await MemoryView.render(root);
  if (id === 'sessions') renderAll();
}

function markLive(mode, ev) {
  LIVE.mode = mode;
  document.body.dataset.live = mode;
  const dot = document.getElementById('live-dot');
  if (!dot) return;
  const st = (state && state.watch) || {};
  const scope = ev && ev.scopes ? ev.scopes.join(',') : '';
  dot.dataset.mode = mode;
  dot.textContent = mode === 'sse' ? `即时 · ${st.backend || 'watch'}`
    : `轮询 · ${mode.replace(/^poll:/, '')}`;
  if (scope) dot.title = `磁盘变动即时刷新（${scope}）· 后端 ${st.backend || 'watch'} · rev ${(state && state.rev) || 0}`;
  dot.hidden = false;
}

/** 删除行：先把高度收起（180ms），再让调用方刷新列表——避免"行瞬间消失、下面整体跳" */
function collapseRows(list, opts) {
  const { sel, keys } = opts || {};
  const rows = [...document.querySelectorAll(list)]
    .filter(r => (keys ? keys.indexOf(r.dataset.id) >= 0 : (sel ? sel(r) : true)));
  if (!rows.length) return Promise.resolve(0);
  rows.forEach(r => r.classList.add('is-removing'));
  return new Promise(res => setTimeout(() => {
    rows.forEach(r => r.remove());          // 先从 DOM 拿掉，刷新时不会再占位
    res(rows.length);
  }, 180));
}
window.collapseRows = collapseRows;

/** 闪一下：讲清"这里刚变过"（1.2s 淡出，不改变布局） */
function flash(el) {
  if (!el || !el.classList) return;
  el.classList.remove('is-flash');
  void el.offsetWidth;                 // 重启动画
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1300);
}

/** 记录一组元素的 key（用于刷新后判断"哪些是新的"） */
function keySet(sel, attr) {
  const out = new Set();
  document.querySelectorAll(sel).forEach(e => { const v = e.dataset[attr]; if (v) out.add(v); });
  return out;
}

/** 刷新后：新出现的行 + 受影响来源的卡片 一起闪一下 */
function flashChanges(ev, before) {
  const scopes = (ev && ev.scopes) || [];
  // 1) 来源卡片：tool:<id> / memory:<id> → 对应卡片
  scopes.forEach(sc => {
    const [kind, id] = String(sc).split(':');
    if (!id) return;
    if (sc === 'memory:hub') {           // hub 中间体：没有对应卡片 → 让记忆列表整块闪一下
      flash(document.querySelector('#mv-rows'));
      return;
    }
    document.querySelectorAll(`.tcard[data-src="${CSS.escape(id)}"], [data-testid="tool-card-${CSS.escape(id)}"]`)
      .forEach(flash);
  });
  // 2) 新出现的行（会话 / 模块条目）
  if (before && before.rows instanceof Map) {
    // 按"数据层面的变化"判断：会话是新出现的，或消息数变了（DOM 会整块重建，不能靠节点比对）
    document.querySelectorAll('#session-rows .mvi[data-sid]').forEach(r => {
      const prev = before.rows.get(r.dataset.sid);      // undefined = 新会话
      const now = r.dataset.msgs != null ? Number(r.dataset.msgs) : null;
      if (prev === undefined || (now != null && prev !== now)) flash(r);
    });
  }
  if (before && before.items) {
    document.querySelectorAll('#sk-rows .mvi[data-id], #mp-rows .mvi[data-id], #mv-rows .mvi[data-id]')
      .forEach(r => { if (!before.items.has(r.dataset.id)) flash(r); });
  }
}

function applyLiveUpdate(ev) {
  LIVE.events += 1;
  // 安静窗口：自己刚写过 / 用户刚点过（弹窗流程、列表操作）→ UI 已自己刷新过，
  // 这时再推一次"外部刷新"会把用户/测试正在进行的操作打断。
  const quiet = (Date.now() - (LIVE.lastWrite || 0)) < 900
             || (Date.now() - (LIVE.lastInput || 0)) < 1500;
  // 注意：这些遮罩在 DOM 里常态存在，必须按"可见"判断（否则永远 busy，事件全被吞掉）
  const busy = [...document.querySelectorAll('.hub-modal, .setwin, .preview-overlay.is-open')]
    .some(el => el.offsetParent !== null);
  if (busy) return;
  const scopes = ev.scopes || [];
  const full = !!ev.full;
  const active = activeViewId();
  // 抓"刷新前"的 key，用于刷新后高亮新出现的行
  const before = { rows: new Map((state.sessions || []).map(x => [x.sid, x.msg_count])),
                   items: keySet('#sk-rows .mvi[data-id], #mp-rows .mvi[data-id], #mv-rows .mvi[data-id]', 'id') };
  // 外壳（台账 / 工具 / 会话计数）总是跟着变
  loadState().then(() => { renderAll(); flashChanges(ev, before); markLive(LIVE.mode, ev); }).catch(() => {});
  if (quiet) return;
  const toolDirty = scopes.some(s => s.indexOf('tool:') === 0);
  const memDirty = scopes.some(s => s.indexOf('memory:') === 0);
  // 本地目录 / 本地库：外部改 SKILL.md、registry 文件或链接目录内容 → 刷 Skills/MCP 视图
  // （读取时会顺带扫描同步，SSE 只负责叫醒前端来读）
  const regDirty = scopes.some(s => s === 'hub:registry' || s === 'hub:sources'
    || s === 'hub:localdirs');
  let target = null;
  if (full || scopes.indexOf('hub') >= 0) target = active;
  else if (active === 'memory' && memDirty) target = 'memory';
  else if (active === 'connect' && (toolDirty || memDirty || regDirty)) target = 'connect';
  else if (active === 'skills' && (toolDirty || memDirty || regDirty)) target = 'skills';
  else if (active === 'mcp' && (toolDirty || regDirty)) target = 'mcp';
  else if (active === 'ops') target = 'ops';
  if (target) refreshView(target).then(() => flashChanges(ev, before)).catch(() => {});
}

function startFallbackPolling(reason) {
  if (LIVE.pollTimer) return;
  const tick = () => {
    const hidden = document.visibilityState === 'hidden';
    loadState().then(() => { renderAll(); if (LIVE.mode.indexOf('poll:') === 0) markLive(LIVE.mode); })
      .catch(() => {});
    LIVE.pollTimer = setTimeout(tick, hidden ? 60000 : 3000);
  };
  LIVE.mode = 'poll:' + reason;
  LIVE.pollTimer = setTimeout(tick, 3000);
  markLive(LIVE.mode);
}

function stopFallbackPolling() {
  if (LIVE.pollTimer) { clearTimeout(LIVE.pollTimer); LIVE.pollTimer = null; }
}

function startLiveUpdates() {
  // 记录用户最近一次交互：用于"别在用户操作途中推外部刷新"
  ['click', 'keydown', 'input'].forEach(t =>
    document.addEventListener(t, () => { LIVE.lastInput = Date.now(); }, true));
  if (!window.EventSource) { startFallbackPolling('no-sse'); return; }
  const connect = () => {
    let es;
    try { es = new EventSource('/api/events'); } catch (e) { startFallbackPolling('es-error'); return; }
    LIVE.es = es;
    es.addEventListener('hello', (e) => {
      let d = {};
      try { d = JSON.parse(e.data || '{}'); } catch (_) {}
      const changed = (d.rev || 0) > (state.rev || 0);
      LIVE.lastRev = d.rev || 0;
      stopFallbackPolling();
      markLive('sse');
      if (changed) applyLiveUpdate({ scopes: ['hub'], full: true });   // 断线期间的变更一次补齐
    });
    es.addEventListener('change', (e) => {
      let d = {};
      try { d = JSON.parse(e.data || '{}'); } catch (_) {}
      if (d.rev && d.rev <= LIVE.lastRev) return;                      // 去重（自己写入的 bump 也在内）
      LIVE.lastRev = d.rev || LIVE.lastRev;
      applyLiveUpdate(d);
    });
    es.addEventListener('ping', () => {});
    es.onopen = () => { stopFallbackPolling(); markLive('sse'); };
    es.onerror = () => { startFallbackPolling('sse-down'); };           // EventSource 会自己重连
  };
  connect();
}

/* ---------- module navigation (v0.4) ---------- */
const VIEWS = [];
const SYS_PAGES = { schedule: 'sched-overlay' };   // 设置已改为普通页面（view），见 SETTINGS_VIEW
const SETTINGS_VIEW = 'settings-overlay';
let LAST_VIEW = 'sessions';
const MOUNTED = new Set();          // 已渲染过的视图：再切回来只静默刷新，不重建

/** 记住 / 还原容器内各滚动区的位置（静默刷新后不跳回顶部） */
function snapshotScroll(el) {
  const box = {};
  el.querySelectorAll('.nv-list, #session-rows, [id$="-rows"]').forEach(n => { if (n.id) box[n.id] = n.scrollTop; });
  box.__win = el.querySelector('.nv-center') ? el.querySelector('.nv-center').scrollTop : 0;
  return box;
}
function restoreScroll(el, box) {
  el.querySelectorAll('.nv-list, #session-rows, [id$="-rows"]').forEach(n => {
    if (n.id && box[n.id] != null) n.scrollTop = box[n.id];
  });
  const c = el.querySelector('.nv-center');
  if (c && box.__win) c.scrollTop = box.__win;
}

/** 准备视图内容：首次挂载才 render；再次进入只静默刷新（数据可能已被 SSE 更新） */
async function mountView(id, el) {
  const first = !MOUNTED.has(id);
  MOUNTED.add(id);
  const box = first ? null : snapshotScroll(el);
  try {
    if (id === 'connect' && window.ConnectView) {
      if (first) await ConnectView.render(el);
      else await ConnectView.refresh();
    } else if (id === 'skills' && window.SkillsView) {
      if (first) await SkillsView.render(el);
      else await SkillsView.refresh({ parts: ['rows', 'targets', 'ledger'] });
    } else if (id === 'mcp' && window.McpView) {
      if (first) await McpView.render(el);
      else await McpView.refresh({ parts: ['rows', 'targets', 'ledger'] });
    } else if (id === 'ops' && window.OpsView) {
      await OpsView.render(el);
    } else if (id === 'stats' && window.StatsView) {
      await StatsView.render(el);
    } else if (id === 'memory') {
      if (window.MemoryView) await MemoryView.render(el); else renderMemoryView(el);
    } else if (id === 'settings') {
      if (window.SettingsCenter) await SettingsCenter.refresh();
    } else if (id === 'sessions') {
      if (first) renderAll();
    }
  } catch (e) {
    HubUI.toast('视图加载失败：' + (e && e.message || ''), 'error');
  }
  if (box) restoreScroll(el, box);
}

/** 导航选中态：文字高亮 + 滑动块跟随 */
function syncNavIndicator(id) {
  const nav = document.getElementById('mod-nav');
  const ind = nav && nav.querySelector('.mod-nav__ind');
  const btn = nav && [...nav.querySelectorAll('button')].find(b => b.dataset.view === id && !b.hidden);
  nav && nav.querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.view === id));
  if (!ind) return;
  if (!btn) { ind.classList.remove('is-on'); return; }
  ind.style.left = btn.offsetLeft + 'px';
  ind.style.width = btn.offsetWidth + 'px';
  ind.classList.add('is-on');
}
window.addEventListener('resize', () => {
  const cur = document.querySelector('.mod-nav button.is-on');
  if (cur) syncNavIndicator(cur.dataset.view);
});
function closeSysPages(except) {
  Object.entries(SYS_PAGES).forEach(([k, ov]) => {
    if (k === except) return;
    const el = document.getElementById(ov);
    if (el) el.classList.remove('is-open', 'is-page');
  });
}
function openSysPage(id) {
  const ov = document.getElementById(SYS_PAGES[id]);
  if (!ov) return;
  closeSysPages(id);
  ov.classList.add('is-open', 'is-page');
  document.querySelectorAll('.mod-nav button').forEach(b => b.classList.toggle('is-on', b.dataset.view === id));
  if (id === 'schedule' && !ov.dataset.loaded) { ov.dataset.loaded = '1'; openSchedule(); }
}
function sysPageOpen(id) {
  const ov = document.getElementById(SYS_PAGES[id]);
  return !!(ov && ov.classList.contains('is-open'));
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  Object.keys(SYS_PAGES).forEach(id => { if (sysPageOpen(id)) switchView(LAST_VIEW); });
});
async function switchView(id) {
  if (SYS_PAGES[id]) return openSysPage(id);          // 定时任务等"整页 overlay"（暂时隐藏）
  closeSysPages(null);
  if (id !== 'settings') LAST_VIEW = id;
  const target = id === 'settings' ? SETTINGS_VIEW : 'view-' + id;
  const next = document.getElementById(target);
  if (!next) return;
  if (next.classList.contains('is-active')) {
    await mountView(id, next);          // 再点当前页签 = 轻刷新（并复位该页内部状态）
    syncNavIndicator(id);
    return;
  }

  // ① 先把内容准备好（首次挂载 / 已挂载则静默刷新），再让它进场 —— 不再"空壳淡入 → 内容跳出"
  await mountView(id, next);

  // ② 旧视图淡出 120ms，与新视图进场重叠（不再有硬切/空白帧）
  document.querySelectorAll('.view.is-active').forEach(prev => {
    if (prev === next) return;
    prev.classList.add('is-leaving');
    setTimeout(() => {
      prev.classList.remove('is-active', 'is-leaving');
      if (prev.id === SETTINGS_VIEW) prev.classList.remove('is-open');   // 旧判据：关闭后不得留 is-open
    }, 130);
  });
  next.classList.remove('is-leaving');
  next.classList.toggle('is-open', id === 'settings');   // 设置页兼容旧判据
  next.classList.add('is-active');
  syncNavIndicator(id);
}

/**
 * 「笔记 · 本地」子视图：与四个模块同一套条目/列表观感（用户 2026-10-20「你没改记忆吗？」）。
 * 结构：统计行 → 搜索/导出行 → 行内新建条 → 统一条目行（MV.item）+ 展开体（内容 / 删除）。
 * 数据仍走 /api/memory/add | /api/memory/search | /api/memory/delete。
 */
function memItemsHTML(list, openId) {
  if (!list.length) return '<div class="hub-empty">记忆区还是空的</div>';
  return list.map(m => {
    const kindName = m.kind === 'migration-summary' ? '迁移记录' : '笔记';
    const excerpt = String(m.body || '').replace(/\s+/g, ' ').slice(0, 90);
    return MV.item({
      id: m.id || ('n-' + Math.random().toString(36).slice(2)),
      testid: 'mv-item',
      chkTestid: 'mv-note-check',
      sel: state.selected.has(m.id),
      open: String(openId) === String(m.id),
      chipText: m.kind === 'migration-summary' ? '迁' : '笔记',
      chipCls: 'chip--muted',
      title: m.title || '(无标题)',
      sub: `${kindName} · ${fmtTime(m.ts)} · ${excerpt}`,
      extra: `<span class="mvi-acts"><button class="hub-btn btn-sm hub-btn--danger" data-note-del="${esc(String(m.id || ''))}">删除</button></span>`,
      body: `<pre class="mvi__pre" style="margin:0">${esc(m.body || '')}</pre>`,
    });
  }).join('');
}
/** 删除一条 hub 记忆（笔记视图的悬停删除与展开体删除共用） */
function delNote(root, id) {
  HubUI.confirm('删除记忆', '确认删除这条记忆？<br>（仅删除 hub 记忆，不影响任何原生会话）', async () => {
    const r = await post('/api/memory/delete', { id: Number(id) || id });
    if (r.data.ok) { HubUI.toast('已删除', 'success'); await loadState(); renderMemoryView(root); }
    else HubUI.toast('删除失败：' + (r.data.error || ''), 'error');
  }, { confirmText: '删除', danger: true });
}
const MEM_VIEW = { sel: null, q: '', open: null };
function renderMemoryView(root) {
  const list = (state.memories || []).filter(m => !MEM_VIEW.q
    || String(m.title || '').toLowerCase().includes(MEM_VIEW.q.toLowerCase())
    || String(m.body || '').toLowerCase().includes(MEM_VIEW.q.toLowerCase()));
  const all = state.memories || [];
  const busTools = TOOL_LIST.filter(t => t.mcp_config && t.enabled);
  const wired = busTools.filter(t => t.memory_wired === true).length;
  root.innerHTML = `
    <div class="nv-stats" data-testid="mv-stats">
      <div class="nv-stat"><b>${all.length}</b><span>记忆总条数</span></div>
      <div class="nv-stat"><b>${all.filter(m => m.kind === 'note').length}</b><span>笔记</span></div>
      <div class="nv-stat"><b>${all.filter(m => m.kind === 'migration-summary').length}</b><span>迁移记录</span></div>
      <div class="nv-stat"><b>${wired}/${busTools.length}</b><span>记忆总线已接入</span></div>
    </div>
    <div class="slist__search" style="padding:var(--sp-2) 0">
      <div class="ssearch"><span class="ssearch__ic">${MV.ic('search')}</span>
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
    <div class="nv-list" data-testid="mv-list">${memItemsHTML(list, MEM_VIEW.open)}</div>`;
  root.querySelector('[data-testid="mv-add"]').onclick = async (e) => {
    const btn = e.currentTarget;
    const body = root.querySelector('#mv-body').value.trim();
    if (!body) { HubUI.toast('内容不能为空', 'error'); return; }
    btn.classList.add('is-loading');
    const r = await post('/api/memory/add', { title: root.querySelector('#mv-title').value.trim(), body, kind: 'note' });
    btn.classList.remove('is-loading');
    if (r.data.ok) { HubUI.toast('记忆已保存', 'success'); await loadState(); renderMemoryView(root); }
    else HubUI.toast('保存失败：' + (r.data.error || ''), 'error');
  };
  let t = null;
  root.querySelector('#mv-q').oninput = (e) => {
    clearTimeout(t);
    MEM_VIEW.q = e.target.value.trim();
    t = setTimeout(() => renderMemoryView(root), 250);
  };
  // 条目行：点行头就地展开 / 收起（不重建列表）；展开即选中
  root.querySelectorAll('[data-testid="mv-list"] .mvi').forEach(row => {
    const id = row.dataset.id;
    const setOpen = (on) => {
      row.classList.toggle('is-open', on);
      MEM_VIEW.open = on ? id : null;
      const cb = row.querySelector('.mvi__chk');
      if (cb) cb.checked = on;
      row.classList.toggle('is-sel', on);
      // 展开体：首次展开时注入正文（与其它模块的"展开即出内容"一致）
      const acc = row.querySelector('.mvi__accin');
      if (on && acc && !acc.innerHTML.trim()) {
        const m = (state.memories || []).find(x => String(x.id) === String(id));
        acc.innerHTML = `<div class="nv-dops"><button class="hub-btn btn-sm hub-btn--danger" id="mv-detail-del">删除</button></div>`
          + `<pre class="mvi__pre">${esc((m && m.body) || '')}</pre>`;
        const d2 = acc.querySelector('#mv-detail-del');
        if (d2) d2.onclick = (ev) => { ev.stopPropagation(); delNote(root, id); };
      }
    };
    // 行任意处点击都展开（与其它模块一致）；按钮/勾选框不触发
    row.onclick = (e) => {
      if (e.target.closest('input, button')) return;
      setOpen(!row.classList.contains('is-open'));
    };

    row.querySelector('.mvi__chev').onclick = (e) => { e.stopPropagation(); setOpen(!row.classList.contains('is-open')); };
    const cb = row.querySelector('.mvi__chk');
    if (cb) cb.onclick = (e) => { e.stopPropagation(); setOpen(e.target.checked); };
    const del = row.querySelector('[data-note-del]');
    if (del) del.onclick = (e) => { e.stopPropagation(); delNote(root, del.dataset.noteDel); };
  });
  HubUI.drawFrames(root);
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-all').onclick = e => refreshAll(e.currentTarget);
  // 设置 / 统计 / 定时任务 已是顶栏导航项，统一由 switchView 处理（见 openSysPage）

  document.getElementById('sched-close').onclick = closeSchedule;
  document.getElementById('sched-save').onclick = e => saveSchedule(e.currentTarget);
  document.getElementById('sched-overlay').addEventListener('click', e => {
    if (e.target.id === 'sched-overlay') closeSchedule();
  });
  let searchTimer = null;
  document.getElementById('search-input').oninput = e => {
    renderRows();
    clearTimeout(searchTimer);
    const q = e.currentTarget.value.trim();
    if (q.length < 2) { hideSearchPanel(); return; }
    searchTimer = setTimeout(() => runContentSearch(q), 250);
  };
  document.addEventListener('click', e => {
    const panel = document.getElementById('search-panel');
    if (panel && panel.style.display !== 'none' &&
        !panel.contains(e.target) && e.target.id !== 'search-input') hideSearchPanel();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideSearchPanel(); });
  // sel-all 复选框随列表头移除，改为分页器上的全选按钮（sess-sel-all）
  const legacySelAll = document.getElementById('sel-all');
  if (legacySelAll) legacySelAll.onchange = e => selectAll(e.currentTarget);
  // 记忆新增已并入记忆视图（mv-add）；侧栏旧入口已移除
  document.getElementById('preview-close').onclick = closePreview;
  document.getElementById('preview-overlay').addEventListener('click', e => {
    if (e.target.id === 'preview-overlay') closePreview();
  });
  document.querySelectorAll('#filter-seg button').forEach(b => {
    b.onclick = () => setFilter(b.dataset.filter);
  });
  const selAllBtn = document.getElementById('sess-sel-all');
  if (selAllBtn) selAllBtn.onclick = sessSelAll;
  const selInvBtn = document.getElementById('sess-sel-invert');
  if (selInvBtn) selInvBtn.onclick = sessSelInvert;
  const selNoneBtn = document.getElementById('sess-sel-none');
  if (selNoneBtn) selNoneBtn.onclick = sessSelNone;
  document.querySelectorAll('.mod-nav button').forEach(b => {
    b.onclick = () => {
      // 定时任务：沿用原来的直接开面板（openSchedule 自己负责渲染 + is-open），
      // 只额外同步导航高亮；不经过视图切换的异步流程。
      if (b.dataset.view === 'schedule') {
        document.querySelectorAll('.mod-nav button').forEach(x => x.classList.toggle('is-on', x === b));
        syncNavIndicator('schedule');
        return openSchedule();
      }
      switchView(b.dataset.view);
    };
  });

  loadState().then(() => {
    markLive('sse');
    MOUNTED.add('sessions');           // 首屏已渲染过
    syncNavIndicator('sessions');
  }).catch(e => renderLoadError(e.message));
  startLiveUpdates();            // 即时刷新（SSE）；断开时自动退回轮询
});
window.hubApp = { loadState, setFilter, openSession, switchView,
  LIVE, applyLiveUpdate, startLiveUpdates,
  migrateFlow: (t, ids) => migrateConfirmInline(t, ids || [...state.selected]),
  get state() { return state; } };
