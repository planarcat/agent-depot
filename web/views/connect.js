/* 连接画布（Skills / MCP 合并页）——三行看板 + 连线层。
   样式与交互对齐原型《连接融合-v4-编辑态》：metastrip 统计带、150 方形卡、
   绿实/绿虚/灰点连线、右上浮动条目面板（成对编辑）、线上按钮在通道卡底缘。
   分步落地口径：条目详情/批量分发后续回填；改动经右下暂存条确认生效。 */
(() => {
  const CH = { skills: 'Skills', mcp: 'MCP' };
  const S = { dirs: [], repos: [], tools: [], skTgt: [], mcpTgt: [], binds: [],
    items: { skills: [], mcp: [] }, selDir: null, selTool: null, selRepo: null,
    types: { skills: true, mcp: true }, stage: new Map(), _panelShown: false };

  async function loadAll() {
    const [dirs, repos, skTgt, mcpTgt, binds, st] = await Promise.all([
      api('/api/local-dirs'), api('/api/remote-repos'),
      api('/api/skills/targets'), api('/api/mcp/targets'),
      api('/api/skills/dir-bindings'), api('/api/state'),
    ]);
    S.dirs = (((dirs || {}).data || {}).dirs || []);
    S.repos = (((repos || {}).data || {}).repos || []);
    S.skTgt = (((skTgt || {}).data || {}).targets || []);
    S.mcpTgt = (((mcpTgt || {}).data || {}).targets || []);
    S.binds = (((binds || {}).data || {}).bindings || []);
    S.tools = ((st || {}).data || {}).tool_list || [];   /* 工具实体列表（/api/state.tool_list） */
  }

  async function loadItems() {
    if (!S.selDir) { S.items = { skills: [], mcp: [] }; return; }
    const [sk, mc] = await Promise.all([
      api('/api/skills/items?source=manual&dir=' + S.selDir),
      api('/api/mcp/items?source=manual&dir=' + S.selDir),
    ]);
    const s0 = ((sk || {}).data || {});
    const m0 = ((mc || {}).data || {});
    S.items.skills = (s0.items || s0.registry || []).map(i => i.name || i);
    S.items.mcp = (m0.items || m0.registry || []).map(i => i.name || i);
  }

  const targetOf = (toolId, ch) =>
    (ch === 'mcp' ? S.mcpTgt : S.skTgt).find(t => t.tool === toolId) || null;

  const baseBind = (dirId, toolId, ch) => S.binds.find(b =>
    b.dir_id === +dirId && b.tool === toolId && (b.channels || []).includes(ch)) || null;

  const laneKey = (dirId, toolId, ch) => `${dirId}:${toolId}:${ch}`;

  /* 通道开关（暂存优先）：'on' | 'off' */
  function laneState(dirId, toolId, ch) {   /* 'on' = 绑定存在（含暂停） | 'off' = 无绑定 */
    return laneOn(dirId, toolId, ch) ? 'on' : 'off';
  }
  function laneOn(dirId, toolId, ch) {      /* 绑定存在（enabled 0/1 都算） */
    const st = S.stage.get(laneKey(dirId, toolId, ch));
    if (st) return st.kind === 'on' || st.kind === 'paused';
    return !!baseBind(dirId, toolId, ch);
  }
  function lanePaused(dirId, toolId, ch) {  /* 已链接但暂停自动同步 */
    const st = S.stage.get(laneKey(dirId, toolId, ch));
    if (st) return st.kind === 'paused';
    const b = baseBind(dirId, toolId, ch);
    return !!(b && !b.enabled);   /* API 序列化：SQLite 0 → JSON false */
  }

  /* 该通道下「不跟随」的条目（暂存优先） */
  function laneExcluded(dirId, toolId, ch) {
    const st = S.stage.get(laneKey(dirId, toolId, ch));
    if (st && st.excluded) return new Set(st.excluded);
    const b = baseBind(dirId, toolId, ch);
    return new Set((b && b.excluded) || []);
  }

  function setStage(dirId, toolId, ch, patch) {
    const key = laneKey(dirId, toolId, ch);
    const cur = S.stage.get(key) || {
      kind: laneOn(dirId, toolId, ch) ? 'on' : 'on',
      excluded: [...laneExcluded(dirId, toolId, ch)],
    };
    S.stage.set(key, { ...cur, ...patch });
  }

  const itemOn = (item, dirId, toolId, ch) =>
    laneState(dirId, toolId, ch) === 'on' && !laneExcluded(dirId, toolId, ch).has(item);

  /* 通道线态（原型 typeState 口径）：full | part | blocked | off。
     空类型通道开 = full；该类全部排除 = blocked（不留空连接的视觉）；部分排除 = part。
     未选中目录的卡片圆点用 excluded 总数近似（该目录条目分类不可得，选中后走精确口径）。 */
  function channelState(dirId, toolId, ch) {
    /* full | part | blocked | paused | off —— 口径（2026-11-05）：
       绿实=全链接自动同步；绿虚=部分链接自动同步；灰虚=已链接不自动同步；无连线=无链接 */
    if (!laneOn(dirId, toolId, ch)) return 'off';
    if (lanePaused(dirId, toolId, ch)) return 'paused';
    const d = S.dirs.find(x => x.id === +dirId);
    if (!d) return 'off';
    const total = d.counts[ch] || 0;
    if (!total) return 'full';
    const ex = laneExcluded(dirId, toolId, ch);
    const exact = S.selDir === +dirId && S.items[ch].length;
    const exN = exact ? [...ex].filter(n => S.items[ch].includes(n)).length : Math.min(ex.size, total);
    if (exN >= total) return 'blocked';
    return exN ? 'part' : 'full';
  }

  /* 多通道聚合成一个圆点态：full > part > blocked（都不在 = 无点） */
  function aggState(dirId, toolId) {
    const sts = ['skills', 'mcp'].map(ch => channelState(dirId, toolId, ch))
      .filter(s => s !== 'off');
    if (!sts.length) return null;
    if (sts.includes('full')) return 'full';
    if (sts.includes('part')) return 'part';
    return sts.includes('paused') ? 'paused' : 'blocked';
  }

  /* ---------------- 线上按钮图标（纯 SVG，与卡片动作图标同语言） ---------------- */
  const ICON_UNLINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 8h15"/><path d="M16 5l3 3-3 3"/><path d="M20 16H5"/><path d="M8 13l-3 3 3 3"/></svg>';

  /* ---------------- 工具配色（tokens 既有变量） ---------------- */

  const DOT_VAR = { claude: 'var(--c-tool-claude)', codex: 'var(--c-tool-codex)',
    opencode: 'var(--c-tool-opencode)' };
  function toolDotCls(t) {
    const id = t && t.id;
    if (DOT_VAR[id]) return 'tool-dot--' + id;
    return 'tool-dot--p' + Math.min(12, Math.max(4, +((t && t.color) || 4)));
  }

  /* ---------------- 骨架 ---------------- */

  const BUILD = '20261105-4';   /* 构建标记：DevTools 里看 .cv[data-build] 即知页面加载的是哪版 */

  function shell() {
    return `
      <div class="cv" data-build="${BUILD}">
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

  function bdot(st, title) {
    const cls = st === 'blocked' || st === 'paused' ? 'off' : st;
    return `<span class="cv-bdot ${cls}" title="${esc(title)}"></span>`;
  }

  /* 目录/仓库卡 footer（MV .tcard__tag 内）：→/⇐ + 各工具跟随态圆点 */
  function srcTag(srcId, arr) {
    const dots = S.tools.map(t => ({ t, st: aggState(srcId, t.id) }))
      .filter(x => x.st).map(x => bdot(x.st, `${x.t.name} · ${
        x.st === 'full' ? '完整跟随' : x.st === 'part' ? '部分跟随' : '该类已全部排除'}`)).join('');
    return dots ? `<span class="cv-arr">${arr}</span>${dots}` : '';
  }

  function renderDirs() {
    const host = document.getElementById('cv-dirs');
    if (!host) return;
    const dirCount = d => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = r => Object.values(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    const activeId = S.selDir ? 'dir:' + S.selDir : (S.selRepo ? 'repo:' + S.selRepo : null);
    const dimAll = !!(S.selDir || S.selRepo);
    if (host.dataset.sig !== rowSig() || !host.querySelector('.srcgroups')) {
      host.dataset.sig = rowSig();
      const sources = [
        ...S.dirs.map(d => ({ id: 'dir:' + d.id, name: d.name, short: shortName(d.name),
          cls: 'chip--accent', count: dirCount(d),
          title: `${d.name} · ${dirCount(d)} 条 · ${d.path}${layoutHint(d)}`,
          tag: srcTag(d.id, '\u2192'), off: dimAll && activeId !== 'dir:' + d.id,
          acts: [{ key: 'dirdel', label: '移除', icon: MV.ic('trash'),
            title: '移除该目录（磁盘文件保留）', danger: true }] })),
        ...S.repos.map(r => ({ id: 'repo:' + r.id, name: r.name, short: shortName(r.name),
          cls: 'chip--muted', count: repoCount(r),
          title: `${r.name} · ${repoCount(r)} 条 · ${r.url}`,
          tag: srcTag(r.id, '\u21d0'), off: dimAll && activeId !== 'repo:' + r.id,
          acts: [
            { key: 'pull', label: '拉取', icon: MV.ic('refresh'), title: '拉取该仓库' },
            { key: 'edit', label: '编辑', icon: MV.ic('edit'), title: '编辑仓库配置' },
            { key: 'del', label: '移除', icon: MV.ic('trash'), title: '移除该仓库及其来源', danger: true },
          ] })),
      ];
      host.innerHTML = MV.top({
        prefix: 'cv', sources,
        counts: Object.fromEntries(sources.map(s0 => [s0.id, s0.count])),
        activeId,
        groups: [
          { kind: 'local', label: '本地', desc: '默认目录 + 已链接目录',
            actions: ['关联目录'],
            ids: S.dirs.map(d => 'dir:' + d.id) },
          { kind: 'remote', label: '远程仓库', desc: 'Git 仓库拉取，只读跟随上游',
            actions: ['添加仓库', '全部拉取'],
            ids: S.repos.map(r => 'repo:' + r.id) },
        ],
      });
    }
    applyCardStates(host, activeId, dimAll);   /* 选中变化只切类：保住描边生长/底色扫入过渡 */
  }

  /* 行内重建签名：只含数据（计数 + 绑定 + 暂存）。
     选中变化不重建——走 applyCardStates/applyTypeStates 切类，保住 CSS 过渡与描边生长动画 */
  function rowSig() {
    const dirCount = d => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = r => Object.values(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    return S.dirs.map(d => d.id + ':' + dirCount(d)).join('|') + '#' +
      S.repos.map(r => r.id + ':' + repoCount(r)).join('|') + '#' +
      S.binds.map(b => b.id + ':' + (b.channels || []).join('') + ':' + ((b.excluded || []).length)).join('|') +
      '#' + S.stage.size;
  }

  function applyCardStates(host, activeId, dimAll) {
    host.querySelectorAll('.tcard[data-src]').forEach(el => {
      const id = el.getAttribute('data-src');
      const active = activeId != null && id === String(activeId);
      el.classList.toggle('is-on', active);
      el.classList.toggle('is-off', !!dimAll && !active);
    });
  }

  /* 容器目录的布局提示（自动发现子 skills/mcp 文件夹）：追加在卡 title 里 */
  function layoutHint(d) {
    const L = d && d.layout;
    if (!L) return '';
    const parts = [];
    if ((L.skills || []).length) parts.push(`${L.skills.length} 个 skills 文件夹`);
    if ((L.mcp || []).length) parts.push(`${L.mcp.length} 个 mcp 文件夹`);
    return parts.length ? ' · 含 ' + parts.join(' / ') : '';
  }

  /* 卡片中央方块的两字缩写 */
  function shortName(name) {
    return String(name || '').slice(0, 2).toUpperCase();
  }

  /* 类型卡：选中目录 = 该目录视角（计数 / 右下目录名）；未选 = 全部来源聚合 */
  function renderTypes() {
    const host = document.getElementById('cv-types');
    if (!host) return;
    const d = S.dirs.find(x => x.id === S.selDir);
    const ctx = !!S.selDir;
    if (host.dataset.sig !== rowSig() + '#' + (d ? d.id : '') || !host.querySelector('.tcard')) {
      host.dataset.sig = rowSig() + '#' + (d ? d.id : '');
      host.innerHTML = `<div class="tgrid">${[['skills', 'SK', 'Skills', 'chip--accent'],
        ['mcp', 'MC', 'MCP', 'chip--muted']].map(([ch, tag, nm, cls]) => {
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
        const dots = S.tools.map(t => ({ t, st: channelState(d.id, t.id, ch) }))
          .filter(x => x.st && x.st !== 'off')
          .map(x => bdot(x.st, `${x.t.name} · ${
            x.st === 'full' ? '完整跟随' : x.st === 'part' ? '部分跟随' : '该类已全部排除'}`)).join('');
        return MV.card({ id: 'ch:' + ch, name: nm, short: tag, cls,
          count: d.counts[ch] || 0,
          title: `${nm} · 点击聚焦 / 再点取消（可多选）`,
          tag: `${dots ? `<span class="cv-arr">\u2192</span>${dots}` : ''}` +
            `<span class="cv-tpath">${esc(d.name)}</span>` });
      }).join('')}</div>`;
    }
    /* 类型聚焦/降对比：聚焦属「已选目录」上下文（原型口径） */
    const anyOn = S.types.skills || S.types.mcp;
    host.querySelectorAll('.tcard[data-src^="ch:"]').forEach(el => {
      const ch = el.getAttribute('data-src').slice(3);
      el.classList.toggle('is-on', ctx && S.types[ch]);
      el.classList.toggle('is-off', ctx && anyOn && !S.types[ch]);
    });
  }

  function renderTools() {
    const host = document.getElementById('cv-tools');
    if (!host) return;
    if (host.dataset.sig !== rowSig() || !host.querySelector('.tcard')) {
      host.dataset.sig = rowSig();
      /* 计数 = 已装条目数（各目录跟随态条目之和），口径同原型 */
      const n = t => S.dirs.reduce((a, d) => a + ['skills', 'mcp'].reduce((s, ch) => {
        const st = channelState(d.id, t.id, ch);
        if (st === 'off') return s;
        const exN = Math.min(laneExcluded(d.id, t.id, ch).size, d.counts[ch] || 0);
        return s + (d.counts[ch] || 0) - (st === 'blocked' ? d.counts[ch] || 0 : exN);
      }, 0), 0);
      const homeShort = p0 => String(p0 || '').replace(/^\/Users\/[^/]+/, '~');
      host.innerHTML = `<div class="tgrid">${S.tools.map(t => {
        const dots = S.dirs.map(d => ({ d, st: aggState(d.id, t.id) }))
          .filter(x => x.st).map(x => bdot(x.st, `${x.d.name} · ${
            x.st === 'full' ? '完整跟随' : x.st === 'part' ? '部分跟随' : '该类已全部排除'}`)).join('');
        const tgt = targetOf(t.id, 'skills') || targetOf(t.id, 'mcp');
        return MV.card({ id: 'tool:' + t.id, name: t.name,
          short: window.toolShort ? window.toolShort(t) : shortName(t.name),
          cls: window.toolColorCls ? toolColorCls(t) : 'chip--muted', count: n(t),
          off: !!S.selTool && S.selTool !== t.id,
          title: `${t.name} · ${tgt ? homeShort(tgt.path) : '未配置目标'} · ${n(t)} 条已装`,
          tag: `${dots ? `<span class="cv-arr">\u21d0</span>${dots}` : ''}` +
            `<span class="cv-tpath">${esc(tgt ? homeShort(tgt.path) : '')}</span>` });
      }).join('')}</div>`;
    }
    host.querySelectorAll('.tcard[data-src^="tool:"]').forEach(el => {
      const id = el.getAttribute('data-src').slice(5);
      el.classList.toggle('is-on', S.selTool === id);
      el.classList.toggle('is-off', !!S.selTool && S.selTool !== id);
    });
  }

  /* ---------------- 连线 ---------------- */

  function drawLines() {
    const svg = document.getElementById('cv-lines');
    const ops = document.getElementById('cv-lane-ops');
    const zone = document.getElementById('cv-zone');
    if (!svg || !zone) return;
    const zr = zone.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${zr.width} ${zr.height}`);
    if (ops) ops.innerHTML = '';
    const el = k => zone.querySelector(`[data-src="${k}"]`);
    const pt = (node, edge) => {
      const r = node.getBoundingClientRect();
      return { x: r.left - zr.left + r.width / 2,
        y: (edge === 'top' ? r.top : r.bottom) - zr.top };
    };
    const seg = (a, b) => {
      const dy = (b.y - a.y) / 2;
      return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
    };

    /* 期望的连线集合：weak = 目录底部中心 → 通道卡顶部中心（单起点，同款绿实线，无交互）；
       lane = 通道卡底部 → 工具卡顶部，四态。聚焦工具时只画选中者的 lane 线。 */
    const want = [];
    const dirEl = S.selDir ? (el('dir:' + S.selDir) || el('repo:' + S.selDir)) : null;
    if (dirEl) {
      const fromDir = pt(dirEl, 'bottom');
      const anyOn = S.types.skills || S.types.mcp;
      ['skills', 'mcp'].forEach(ch => {
        const c = el('ch:' + ch);
        if (c && !(anyOn && !S.types[ch])) {
          want.push({ key: `w:${S.selDir}:${ch}`, cls: 'cv-line cv-line--weak',
            solid: true, d: seg(fromDir, pt(c, 'top')) });
        }
      });
      const typeEl = ch => el('ch:' + ch);
      S.tools.forEach(t => {
        if (S.selTool && t.id !== S.selTool) return;
        ['skills', 'mcp'].forEach(ch => {
          const c = typeEl(ch);
          if (!c || !S.types[ch] || !targetOf(t.id, ch)) return;
          const st = channelState(S.selDir, t.id, ch);
          if (st === 'off') return;   /* 无链接 = 不画线 */
          const staged = S.stage.has(laneKey(S.selDir, t.id, ch));
          want.push({
            key: laneKey(S.selDir, t.id, ch), cls: 'cv-line',
            st, staged, d: seg(pt(c, 'bottom'), pt(el(`tool:${t.id}`), 'top')),
            title: `${st === 'off' ? '连接' : '断开'}：${CH[ch]} ↔ ${t.name}`,
          });
        });
      });
    }

    /* 增量对账（同前）：消失 → 收起/淡出；新增 → 画入/淡入；保留 → 原地更新。
       lane 线成组渲染（g + 16px 透明命中线，原型 path.hit 口径）：g:hover 驱动加粗。
       消失动效（原型 draw-out 口径）：实线向起点收起（dashoffset 0 → -100），
       虚线无收起形态 → 原地淡出。 */
    const wantKeys = new Set(want.map(o => o.key));
    [...svg.querySelectorAll('.cv-lineg[data-lane], .cv-line--weak[data-lane]')].forEach(n => {
      if (wantKeys.has(n.dataset.lane) || n._leaving) return;
      n._leaving = true;
      const isGroup = n.classList.contains('cv-lineg');
      const ghost = n.cloneNode(true);
      const gvis = isGroup ? ghost.querySelector('.cv-line') : ghost;
      const solid = isGroup ? gvis.classList.contains('is-on') : true;   /* weak 从属线恒实线 */
      /* 画入动画在克隆体上会重播 → 摘除，改由内联样式接管收起过渡 */
      gvis.classList.remove('is-in');
      ghost.removeAttribute('data-lane');
      if (solid) {
        gvis.setAttribute('pathLength', '100');
        gvis.style.animation = 'none';
        gvis.style.strokeDasharray = '100px';
        gvis.style.strokeDashoffset = '0px';
        gvis.style.transition = 'stroke-dashoffset .26s cubic-bezier(.3,.6,.3,1)';
        ghost.getBoundingClientRect();   /* 强制回流：让过渡从 0 起跳 */
        requestAnimationFrame(() => { gvis.style.strokeDashoffset = '-100px'; });
      } else {
        gvis.classList.add('is-out');   /* 虚线无收起形态：淡出 */
      }
      svg.appendChild(ghost);
      setTimeout(() => ghost.remove(), 320);
      n.remove();
    });
    const ST_CLS = { full: ' is-on', part: ' is-part', blocked: ' is-paused', paused: ' is-paused' };
    const build = o => {
      if (o.solid) {
        return `<path class="${o.cls} is-in" pathLength="100" data-lane="${o.key}" d="${o.d}"></path>`;
      }
      const extra = o.st === 'full' ? ' is-on is-in' : ` ${ST_CLS[o.st] || ''} is-fade`;
      return `<g class="cv-lineg" data-lane="${o.key}">
        <path class="cv-hit" d="${o.d}"></path>
        <path class="${o.cls}${extra}"${o.st === 'full' ? ' pathLength="100"' : ''} data-lane="${o.key}" d="${o.d}">${o.title ? `<title>${esc(o.title)}</title>` : ''}</path>
      </g>`;
    };
    want.forEach(o => {
      let n = o.solid
        ? svg.querySelector(`.cv-line--weak[data-lane="${o.key}"]`)
        : svg.querySelector(`.cv-lineg[data-lane="${o.key}"]`);
      if (!n) {
        svg.insertAdjacentHTML('beforeend', build(o));
        return;
      }
      const vis = o.solid ? n : n.querySelector('.cv-line');
      /* 原地更新：路径/状态变了靠 CSS stroke 过渡，不重播画入 */
      if (vis.getAttribute('d') !== o.d) {
        vis.setAttribute('d', o.d);
        const rp = vis.querySelector('.reveal');
        if (rp) rp.setAttribute('d', o.d);
        if (!o.solid) n.querySelector('.cv-hit').setAttribute('d', o.d);
      }
      if (o.solid) return;
      const cls = o.cls + (ST_CLS[o.st] || '') + (o.staged ? ' is-pending' : '');
      if (vis.getAttribute('class') !== cls) vis.setAttribute('class', cls);
      if (o.st === 'full' && !vis.getAttribute('pathLength')) vis.setAttribute('pathLength', '100');
      if (o.st !== 'full' && vis.hasAttribute('pathLength')) vis.removeAttribute('pathLength');
    });

    /* 线上按钮（原型 dellayer）：仅成对模式；位置 = 通道卡底边中心（连线起点旁）。
       真实实现无撤销窗口：off → ↔（连接），其余 → ×（断开并清理）。 */
    if (ops && S.selDir && S.selTool) {
      ['skills', 'mcp'].forEach(ch => {
        if (!S.types[ch] || !targetOf(S.selTool, ch)) return;
        const c = el('ch:' + ch);
        if (!c) return;
        const cr = c.getBoundingClientRect();
        const off = channelState(S.selDir, S.selTool, ch) === 'off';
        const t = S.tools.find(x => x.id === S.selTool);
        const btn = document.createElement('button');
        btn.className = 'cv-del-btn' + (off ? ' link' : '');
        btn.innerHTML = off ? ICON_LINK : ICON_UNLINK;   /* 纯 SVG 图标（用户口径） */
        btn.dataset.lane = laneKey(S.selDir, S.selTool, ch);
        btn.dataset.act = off ? 'on' : 'clean';
        btn.title = off
          ? `链接：全量同步并自动跟随（${t ? t.name : S.selTool} ← ${CH[ch]}）`
          : `断连：取消这条连线（该工具内已同步的 ${CH[ch]} 条目将被清理）`;
        /* 放在连线与卡片的交汇处：通道卡底边中心（线的出发点） */
        btn.style.left = `${cr.left - zr.left + cr.width / 2 - 14}px`;
        btn.style.top = `${cr.bottom - zr.top - 14}px`;
        ops.appendChild(btn);
      });
    }
  }

  /* ---------------- 条目面板（右上浮动，三视图） ---------------- */

  function pairStat(d) {
    const t = S.tools.find(x => x.id === S.selTool);
    const sts = ['skills', 'mcp'].map(ch => ({ ch, st: channelState(d.id, S.selTool, ch),
      tgt: !!targetOf(S.selTool, ch) }));
    const total = (d.counts.skills || 0) + (d.counts.mcp || 0);
    const on = sts.filter(x => x.st !== 'off');
    if (!on.length) {
      return { pill: '<span class="cv-pill">未链接</span>',
        txt: `连接后将立即把目录内 ${total} 个条目全量同步到 ${esc(t ? t.name : S.selTool)}，并持续跟随变化；工具内已有文件不受影响。` };
    }
    const follow = on.reduce((a, x) => {
      const list = S.items[x.ch] || [];
      const ex = laneExcluded(d.id, S.selTool, x.ch);
      return a + (list.length ? list.length - [...ex].filter(n => list.includes(n)).length
        : (d.counts[x.ch] || 0));
    }, 0);
    const pausedAny = on.some(x => x.st === 'paused');
    const chTxt = on.length < 2
      ? `仅 ${CH[on[0].ch]} 通道已链接（${CH[on[0].ch === 'skills' ? 'mcp' : 'skills']} 通道未链接）`
      : `跟随 ${follow} / 共 ${total} 条`;
    const full = on.length === 2 && on.every(x => x.st === 'full');
    const allPaused = on.every(x => x.st === 'paused');
    let pill;
    if (allPaused) pill = '<span class="cv-pill">已链接 · 暂停自动同步</span>';
    else if (full) pill = '<span class="cv-pill ok">全链接</span>';
    else pill = '<span class="cv-pill part">部分链接</span>';
    let txt = full
      ? `全部 ${total} 条跟随中，自动同步——目录内变化实时同步到工具。取消勾选条目即改为部分链接。`
      : `${chTxt} —— 取消勾选条目即排除（工具内保留已装文件）。`;
    if (pausedAny) txt += ' 有通道暂停自动同步：点该通道的灰虚线恢复。';
    return { pill, txt };
  }

  /* 条目行：名称胶囊 + 6 个工具色点（点胶囊切当前工具，点圆点切该工具） */
  function itemRow(name, ch) {
    const dots = S.tools.map(t => {
      const has = !!targetOf(t.id, ch);
      const on = has && itemOn(name, S.selDir, t.id, ch);
      const sel = S.selTool === t.id;
      return `<span class="cv-tmini ${on ? 'on' : ''}${sel ? ' sel' : ''}"
        data-item="${esc(name)}" data-tool="${t.id}" data-ch="${ch}"
        title="${esc(t.name)}：${!has ? '该工具无对应目标' : on ? '跟随中' + (sel ? '（当前编辑工具，外圈标示）' : '，点击切换此工具') : '未跟随' + (sel ? '（当前编辑工具）' : '，点击切换此工具')}">
        <span class="tool-dot ${toolDotCls(t)}"></span></span>`;
    }).join('');
    let cls = '', tip = `${name}：点右侧圆点切换对应工具的跟随`;
    if (S.selTool) {
      const on = itemOn(name, S.selDir, S.selTool, ch);
      cls = on ? 'on' : 'off';
      const t = S.tools.find(x => x.id === S.selTool);
      tip = `${name}：${on ? '跟随中，点击排除' : '未跟随，点击恢复'} ${t ? t.name : ''}（工具内文件保留）`;
    }
    return `<span class="cv-citem" data-t="${esc(name)}" data-ch="${ch}" title="${esc(tip)}">
      <span class="cv-cname ${cls}">${esc(name)}</span><span class="cv-dots">${dots}</span></span>`;
  }

  function chipFlow() {
    let h = '';
    [['skills', 'SKILLS', S.items.skills], ['mcp', 'MCP', S.items.mcp]].forEach(([ch, label, items]) => {
      if (!S.types[ch]) return;   /* 类型卡未选中 → 该组不显示（与画布过滤同口径） */
      h += `<div class="cv-cgroup"><span class="lab">${label}</span><span class="rule"></span><span class="n">${items.length}</span></div>`;
      h += items.length
        ? `<div class="cv-cflow">${items.map(n => itemRow(n, ch)).join('')}</div>`
        : `<div class="cv-restline">此目录没有 ${label} 条目</div>`;
    });
    if (!h) h = '<div class="cv-restline">两类都已关闭 —— 点上方 Skills / MCP 卡片可重新开启</div>';
    return h;
  }

  function renderPanel() {
    const p = document.getElementById('cv-panel');
    if (!p) return;
    const repo = S.repos.find(r => r.id === S.selRepo);
    const d = S.dirs.find(x => x.id === S.selDir);
    if (!repo && !d && !S.selTool) {
      p.hidden = true; p.innerHTML = ''; S._panelShown = false;
      p.classList.remove('is-in', 'is-pair');
      return;
    }
    p.hidden = false;
    if (!S._panelShown) { p.classList.add('is-in'); S._panelShown = true; }
    const t = S.tools.find(x => x.id === S.selTool);
    if (repo) { renderRepoPanel(p, repo); return; }

    let ttl, stat, list;
    if (d && S.selTool) {
      /* 成对编辑：目录 × 工具（连接/断开走画布连线与线上按钮，面板只做信息与条目跟随） */
      const ps = pairStat(d);
      ttl = `${d.name} → ${t ? t.name : S.selTool}`;
      stat = `${ps.pill}<span class="txt">${ps.txt}</span>`;
      list = chipFlow();
    } else if (d) {
      const nTools = S.tools.filter(tt => aggState(d.id, tt.id)).length;
      ttl = d.name;
      stat = `<span class="cv-pill ${nTools ? 'ok' : ''}">${nTools ? `已链接 ${nTools} 个工具` : '未链接任何工具'}</span>
        <span class="txt">行内圆点 = 该条目对每个工具的跟随开关；点击可单条连接/排除。点工具卡可成对编辑。</span>`;
      list = chipFlow();
    } else {
      /* 仅选工具：来源列表，点击行回到成对编辑 */
      const rows = S.dirs.map(dd => ({ d: dd, st: aggState(dd.id, S.selTool) }))
        .filter(x => x.st);
      const nItems = rows.reduce((a, x) => a + (x.d.counts.skills || 0) + (x.d.counts.mcp || 0), 0);
      ttl = t ? t.name : S.selTool;
      stat = `<span class="cv-pill ${rows.length ? 'ok' : ''}">${
        rows.length ? `接入 ${rows.length} 个来源 · ${nItems} 条` : '未接入任何目录 / 仓库'}</span>
        <span class="txt">选中目录后即成对编辑；连线在通道卡与工具卡之间，点击暂停 / 恢复自动同步。</span>`;
      list = rows.length ? rows.map(x =>
        `<div class="cv-brow" data-go="${x.d.id}"><span class="tool-dot ${t ? toolDotCls(t) : ''}"></span>
          <span class="nm">${esc(x.d.name)}</span>
          <span class="st ${x.st === 'full' ? 'ok' : 'part'}">${
            x.st === 'full' ? `完整跟随 ${(x.d.counts.skills || 0) + (x.d.counts.mcp || 0)} 条`
              : '部分跟随'}</span></div>`).join('')
        : '<div class="cv-restline">尚无连接。先点一个目录卡，再保持本工具卡选中，即可在右侧连接。</div>';
    }
    p.classList.toggle('is-pair', !!(d && S.selTool));
    p.innerHTML = `
      <div class="cv-iph"><b>${esc(ttl)}</b>
        <button class="cv-iph__x" id="cv-panel-x" title="收起">✕</button></div>
      <div class="cv-pstat">${stat}</div>
      <div class="cv-ipitems">${list}</div>`;

    const x = document.getElementById('cv-panel-x');
    if (x) x.onclick = () => { S.selDir = null; S.selTool = null; S.selRepo = null; renderAll(); };
    p.querySelectorAll('.cv-brow[data-go]').forEach(r => {
      r.onclick = () => { S.selDir = +r.dataset.go; loadItems().then(renderAll).catch(() => renderAll()); renderAll(); };
    });
  }

  function renderRepoPanel(p, repo) {
    const rows = Object.entries(repo.sources || {}).map(([kind, src]) => `
      <div class="cv-repo-row">
        <span class="cv-repo-row__kind">${kind === 'mcp' ? 'MCP' : 'Skills'}</span>
        <span class="cv-repo-row__meta">${src.item_count || 0} 条 · ${esc(src.last_commit || '未拉取')}</span>
        <button class="hub-btn btn-sm" data-pull="${kind}:${src.id}">拉取</button>
      </div>`).join('');
    p.innerHTML = `
      <div class="cv-iph"><b>${esc(repo.name)}</b>
        <button class="cv-iph__x" id="cv-panel-x" title="收起">✕</button></div>
      <div class="cv-pstat"><span class="cv-pill">只读跟随上游</span>
        <span class="txt">分支 ${esc(repo.branch || 'main')}${repo.subdir ? ' · ' + esc(repo.subdir) : ''} · ${esc(repo.url)}</span></div>
      <div class="cv-ipitems">${rows || '<div class="cv-restline">该仓库还没有启用模块</div>'}
        <div class="cv-restline">远程仓库只读跟随上游：拉取后条目进入本地库，连接工具请在左侧选本地目录操作。</div></div>`;
    const x = document.getElementById('cv-panel-x');
    if (x) x.onclick = () => { S.selRepo = null; renderAll(); };
    p.querySelectorAll('[data-pull]').forEach(b => {
      b.onclick = async () => {
        const [kind, sid] = b.dataset.pull.split(':');
        b.classList.add('is-loading');
        const r = await post(`/api/${kind === 'mcp' ? 'mcp' : 'skills'}/sources/${sid}/pull`, {});
        b.classList.remove('is-loading');
        HubUI.toast(r.data && r.data.ok ? '已拉取' : ('拉取失败：' + ((r.data && r.data.error) || '')),
          r.data && r.data.ok ? 'success' : 'error');
        await loadAll();
        renderAll();
      };
    });
  }

  /* ---------------- 组卡动作（弹窗沿用既有实现） ---------------- */

  /* 关联目录：唤起系统目录选择器，选中磁盘已有文件夹后登记为本地源 */
  async function linkDir() {
    const r = await post('/api/local-dirs/pick', {});
    if (r.data && r.data.ok) {
      await loadAll(); renderAll();
      HubUI.toast('已关联目录', 'success');
    } else if (r.data && r.data.error) HubUI.toast(r.data.error, 'error');
  }

  /* 移除本地目录登记（磁盘文件保留） */
  function removeDir(id) {
    const d = S.dirs.find(x => x.id === id);
    HubUI.confirm('移除目录', `只移除「${esc(d ? d.name : id)}」的登记，磁盘文件不动。确定？`, async () => {
      const r = await api('/api/local-dirs/' + id, { method: 'DELETE' });
      if (r.data && r.data.ok) {
        if (S.selDir === id) S.selDir = null;
        await loadAll(); renderAll();
        HubUI.toast('目录已移除（磁盘文件保留）', 'success');
      } else HubUI.toast((r.data && r.data.error) || '移除失败', 'error');
    }, { danger: true });
  }

  /* 拉取仓库的全部来源（skills / mcp），卡上图标转圈 */
  async function pullRepo(rid, btn) {
    const repo = S.repos.find(r => String(r.id) === String(rid));
    if (!repo) return;
    const card = btn && btn.closest('.tcard');
    if (card) card.classList.add('is-busy');
    const jobs = Object.entries(repo.sources || {}).map(([kind, src]) =>
      post(`/api/${kind === 'mcp' ? 'mcp' : 'skills'}/sources/${src.id}/pull`, {}));
    const res = await Promise.all(jobs);
    if (card) card.classList.remove('is-busy');
    const ok = res.filter(r => r.data && r.data.ok).length;
    HubUI.toast(`拉取完成：${ok}/${jobs.length} 成功`, ok === jobs.length ? 'success' : 'warn');
    await loadAll(); renderAll();
  }

  /* 编辑仓库配置（名称 / 地址 / 分支） */
  function editRepo(rid) {
    const repo = S.repos.find(r => String(r.id) === String(rid));
    if (!repo) return;
    HubUI.modal({
      title: '编辑仓库', bodyHTML: `
        <label class="hub-field">名称<input class="hub-input" id="dlg-rname" value="${esc(repo.name)}"></label>
        <label class="hub-field">Git 地址<input class="hub-input" id="dlg-rurl" value="${esc(repo.url)}"></label>
        <label class="hub-field">分支<input class="hub-input" id="dlg-rbranch" value="${esc(repo.branch || 'main')}"></label>`,
      confirmText: '保存',
      onConfirm: async (v, close) => {
        const name = document.getElementById('dlg-rname').value.trim();
        const url = document.getElementById('dlg-rurl').value.trim();
        const branch = document.getElementById('dlg-rbranch').value.trim() || 'main';
        if (!name || !url) { HubUI.toast('名称与地址必填', 'error'); return false; }
        const r = await api('/api/remote-repos/' + rid, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, branch }),
        });
        if (r.data && r.data.ok) {
          close(); await loadAll(); renderAll(); HubUI.toast('仓库已更新', 'success');
        } else HubUI.toast((r.data && r.data.error) || '更新失败', 'error');
      },
    });
  }

  /* 移除仓库：删其全部来源（源删光后核心层顺带清掉仓库主记录） */
  function removeRepo(rid) {
    const repo = S.repos.find(r => String(r.id) === String(rid));
    if (!repo) return;
    const kinds = Object.entries(repo.sources || {});
    HubUI.confirm('移除仓库',
      `确认移除仓库「${esc(repo.name)}」及其 ${kinds.length} 个来源？已拉取到本地库的条目保留。`, async () => {
      let failed = 0;
      for (const [kind, src] of kinds) {
        const r = await api(`/api/${kind === 'mcp' ? 'mcp' : 'skills'}/sources/${src.id}`, { method: 'DELETE' });
        if (!r.data || !r.data.ok) failed += 1;
      }
      if (S.selRepo === Number(rid)) S.selRepo = null;
      await loadAll(); renderAll();
      HubUI.toast(failed ? `有 ${failed} 个来源未能移除` : '仓库已移除（本地条目保留）',
        failed ? 'error' : 'success');
    }, { danger: true });
  }

  function addRepoDialog() {
    HubUI.modal({
      title: '添加仓库', bodyHTML: `
        <label class="hub-field">名称<input class="hub-input" id="dlg-rname" placeholder="例如 team-skills"></label>
        <label class="hub-field">Git 地址<input class="hub-input" id="dlg-rurl" placeholder="https://…git"></label>
        <label class="hub-field">分支<input class="hub-input" id="dlg-rbranch" value="main"></label>`,
      confirmText: '添加',
      onConfirm: async (v, close) => {
        const name = document.getElementById('dlg-rname').value.trim();
        const url = document.getElementById('dlg-rurl').value.trim();
        const branch = document.getElementById('dlg-rbranch').value.trim() || 'main';
        if (!name || !url) { HubUI.toast('名称与地址必填', 'error'); return false; }
        const r = await post('/api/remote-repos',
          { name, url, branch, subdir: '', modules: ['skills'] });
        if (r.data && r.data.ok) {
          close(); await loadAll(); renderAll(); HubUI.toast('仓库已添加', 'success');
        } else HubUI.toast((r.data && r.data.error) || '添加失败', 'error');
      },
    });
  }

  async function pullAllRepos() {
    const jobs = [];
    S.repos.forEach(r => Object.entries(r.sources || {}).forEach(([kind, src]) => {
      jobs.push(post(`/api/${kind === 'mcp' ? 'mcp' : 'skills'}/sources/${src.id}/pull`, {}));
    }));
    if (!jobs.length) { HubUI.toast('还没有可拉取的仓库', 'warn'); return; }
    HubUI.toast(`开始拉取 ${jobs.length} 个源…`, 'info');
    const res = await Promise.all(jobs);
    const ok = res.filter(r => r.data && r.data.ok).length;
    await loadAll(); renderAll();
    HubUI.toast(`拉取完成：${ok}/${jobs.length} 成功`, ok === jobs.length ? 'success' : 'warn');
  }

  /* ---------------- 交互 ---------------- */

  function bindEvents(root) {
    root.addEventListener('click', e => {
      /* 卡片悬停动作（拉取/编辑/移除）：须先于卡分支，且不冒泡成选中 */
      const actBtn = e.target.closest('.tcard[data-src] [data-act]');
      if (actBtn) {
        const srcId = actBtn.closest('.tcard').getAttribute('data-src') || '';
        const act = actBtn.dataset.act;
        if (act === 'dirdel') removeDir(+srcId.slice(4));
        else if (act === 'pull') pullRepo(srcId.slice(5), actBtn);
        else if (act === 'edit') editRepo(srcId.slice(5));
        else if (act === 'del') removeRepo(srcId.slice(5));
        return;
      }
      /* 动作按钮在可折叠组面板（data-gfold）内部：必须先判按钮，否则点击被折叠分支吞掉 */
      const gact = e.target.closest('[data-gact]');
      if (gact) {
        const label = gact.dataset.gact.split(':')[1];
        const map = { '关联目录': linkDir,
          '添加仓库': addRepoDialog, '全部拉取': pullAllRepos };
        if (map[label]) map[label]();
        return;
      }
      const fold = e.target.closest('[data-gfold]');
      if (fold) {
        fold.closest('.srcgroup')?.classList.toggle('is-closed');
        return;
      }
      const card = e.target.closest('.tcard[data-src]');
      if (card) {
        const k = card.getAttribute('data-src');
        if (k.startsWith('dir:')) {
          const id = +k.slice(4);
          if (S.selDir === id) { S.selDir = null; renderAll(); return; }
          S.selDir = id; S.selTool = null; S.selRepo = null;
          S.types = { skills: true, mcp: true };   /* 每次进入新的目录上下文，类型卡回到双选（原型口径） */
          renderAll();
          document.querySelector(`#cv-dirs .tcard[data-src="dir:${id}"]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          loadItems().then(renderAll).catch(() => renderAll());
        } else if (k.startsWith('repo:')) {
          const id = +k.slice(5);
          S.selRepo = S.selRepo === id ? null : id;
          if (S.selRepo) { S.selDir = null; S.selTool = null; }
          renderAll();
        } else if (k.startsWith('ch:')) {
          const ch = k.slice(3);
          S.types[ch] = !S.types[ch];
          renderAll();
        } else {
          S.selTool = S.selTool === k.slice(5) ? null : k.slice(5);
          renderAll();
          if (S.selTool) {
            document.querySelector(`#cv-tools .tcard[data-src="tool:${S.selTool}"]`)
              ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
        return;
      }
      const delBtn = e.target.closest('.cv-del-btn');
      if (delBtn) {
        if (!delBtn.dataset.act) return;   /* is-na：该工具无此通道目标，不可链接 */
        const [dirId, toolId, ch] = delBtn.dataset.lane.split(':');
        setStage(+dirId, toolId, ch, { kind: delBtn.dataset.act });
        renderAll();
        return;
      }
      const lane = e.target.closest('.cv-lineg[data-lane], .cv-line[data-lane]');
      if (lane) {
        const [dirId, toolId, ch] = lane.dataset.lane.split(':');
        /* 口径（用户 2026-11-05）：绿线(自动同步)点击 → 暂停(灰虚线，不自动同步)；
           灰虚线(已链接不自动同步)点击 → 全链接自动同步 = 恢复 + 清空排除 */
        const st = channelState(+dirId, toolId, ch);
        if (st === 'paused' || st === 'blocked') setStage(+dirId, toolId, ch, { kind: 'on', excluded: [] });
        else setStage(+dirId, toolId, ch, { kind: 'paused' });
        renderAll();
        return;
      }
      const dot = e.target.closest('.cv-tmini');
      if (dot && S.selDir) { toggleItem(dot.dataset.item, dot.dataset.tool, dot.dataset.ch); return; }
      const citem = e.target.closest('.cv-citem');
      if (citem && S.selDir && S.selTool) { toggleItem(citem.dataset.t, S.selTool, citem.dataset.ch); return; }
      if (!e.target.closest('.cv-ipanel, .cv__apply, .cv__lines, .cv__lane-ops, .hub-modal, .hub-btn')) {
        if (S.selDir || S.selTool || S.selRepo) {
          S.selDir = null; S.selTool = null; S.selRepo = null; renderAll();
        }
      }
    });
    document.getElementById('cv-undo').onclick = () => {
      S.stage.clear(); renderAll();
      HubUI.toast('已撤销未生效的更改', 'info');
    };
    document.getElementById('cv-confirm').onclick = applyStage;
    window.addEventListener('resize', () => drawLines());
    /* 面板开合改变主列宽、行内滚动移动卡片 —— 都不触发 resize，用 ResizeObserver / scroll 兜住（原型口径） */
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => drawLines());
      const zone = document.getElementById('cv-zone');
      const panel = document.getElementById('cv-panel');
      if (zone) ro.observe(zone);
      if (panel) ro.observe(panel);
    }
    const srcrow = document.getElementById('cv-dirs');
    const toolsrow = document.getElementById('cv-toolsrow');
    if (srcrow) srcrow.addEventListener('scroll', () => drawLines(), { passive: true });
    if (toolsrow) toolsrow.addEventListener('scroll', () => drawLines(), { passive: true });
  }

  function toggleItem(item, toolId, ch) {
    if (!S.selDir) return;
    if (laneState(S.selDir, toolId, ch) !== 'on') {
      HubUI.toast('该通道未链接——点通道卡下方 ↔ 先建立链接', 'warn');
      return;
    }
    const ex = laneExcluded(S.selDir, toolId, ch);
    if (ex.has(item)) ex.delete(item); else ex.add(item);
    setStage(S.selDir, toolId, ch, { excluded: [...ex] });
    renderAll();
  }

  /* ---------------- 生效 ---------------- */

  async function applyStage() {
    const entries = [...S.stage.entries()];
    if (!entries.length) return;
    const btn = document.getElementById('cv-confirm');
    btn.classList.add('is-loading');
    let failed = 0;
    for (const [key, op] of entries) {
      const [dirId, toolId, ch] = key.split(':');
      const tgt = targetOf(toolId, ch);
      let bind = baseBind(dirId, toolId, ch);
      try {
        if (op.kind === 'on' || op.kind === 'paused') {
          /* 链接/恢复：无绑定先建；再按口径设置自动同步开关 */
          if (!bind && tgt) {
            const r = await post('/api/skills/dir-bindings', { dir_id: +dirId, target_ids: [tgt.id] });
            if (!r.data || !r.data.ok) failed += 1;
            bind = baseBind(dirId, toolId, ch);
          }
          if (!bind) { failed += 1; continue; }
          const r2 = await api(`/api/skills/dir-bindings/${bind.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: op.kind !== 'paused' }),
          });
          if (!r2.data || !r2.data.ok) failed += 1;
        } else if (op.kind === 'clean' && bind) {
          const r = await api(`/api/skills/dir-bindings/${bind.id}?clean=1`, { method: 'DELETE' });
          if (!r.data || !r.data.ok) failed += 1;
          bind = null;
        }
        if (bind && op.excluded) {
          const r = await api(`/api/skills/dir-bindings/${bind.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ excluded: op.excluded }),
          });
          if (!r.data || !r.data.ok) failed += 1;
        }
      } catch (err) { failed += 1; }
    }
    btn.classList.remove('is-loading');
    S.stage.clear();
    await loadAll();
    renderAll();
    HubUI.toast(failed ? `有 ${failed} 项未能生效` : '已生效：连接变更已保存',
      failed ? 'error' : 'success');
  }

  /* ---------------- 渲染入口 ---------------- */

  function renderMetastrip() {
    const dirCount = d => (d.counts.skills || 0) + (d.counts.mcp || 0);
    const repoCount = r => Object.values(r.sources || {}).reduce((a, s) => a + (s.item_count || 0), 0);
    const localN = S.dirs.reduce((a, d) => a + dirCount(d), 0);
    const remoteN = S.repos.reduce((a, r) => a + repoCount(r), 0);
    /* 已部署到工具：各 (目录×工具×通道) 跟随中的条目数之和（blocked 不计） */
    const deployed = S.dirs.reduce((a, d) => a + S.tools.reduce((s, t) => s +
      ['skills', 'mcp'].reduce((s2, ch) => {
        const st = channelState(d.id, t.id, ch);
        if (st === 'off' || st === 'blocked') return s2;
        return s2 + (d.counts[ch] || 0) - Math.min(laneExcluded(d.id, t.id, ch).size, d.counts[ch] || 0);
      }, 0), 0), 0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('cv-st-all', localN + remoteN);
    set('cv-st-local', localN);
    set('cv-st-remote', remoteN);
    set('cv-st-deployed', deployed);
  }

  function renderAll() {
    renderMetastrip();
    renderDirs(); renderTypes(); renderTools(); renderPanel();
    const bar = document.getElementById('cv-apply');
    if (bar) {
      const n = S.stage.size;
      bar.hidden = !(n > 0 && (S.selDir || S.selTool));
      const el = document.getElementById('cv-apply-n');
      if (el) el.textContent = n;
    }
    if (window.HubUI && HubUI.drawFrames) {
      HubUI.drawFrames(document.getElementById('view-connect'));   /* 选中卡 accent 描边路径（记忆页同款） */
    }
    drawLines();   /* 同步绘制：后台标签页 rAF 会被节流，连线会消失 */
  }

  async function render(root) {
    root.innerHTML = shell();
    console.log('[connect] build', BUILD);
    bindEvents(root);
    await loadAll();
    renderAll();
  }

  async function refresh() {
    const root = document.getElementById('view-connect');
    if (!root || !root.querySelector('.cv')) return;
    await loadAll();
    renderAll();
  }

  window.ConnectView = { render, refresh, _state: S };
})();
