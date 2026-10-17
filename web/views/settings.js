/* ====================================================================
   设置中心 v2：左锚点导航（模块 / 工具 / 定时调度 / 关于）+ 右内容面板。
   修改即时生效。工具是唯一例外：工具的增 / 改 / 删统一在工具弹窗里完成
   （会话页不再有编辑工具的入口），本页只做总览与启停。
   ==================================================================== */
(function () {
  'use strict';

  const SVG_GRIP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">'
    + '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>'
    + '<circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>'
    + '<circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
  const MODULE_LABEL = { sessions: '会话', memory: '记忆', skills: 'Skills', mcp: 'MCP' };
  const MODULE_DESC = {
    sessions: '多工具会话采集 / 浏览 / 迁移（lineage 勾连）',
    memory: '长期记忆（db + 每日 Markdown 日志）',
    skills: 'Skill 源拉取 / 本地编写 / 分发到各工具目录',
    mcp: 'MCP 源与手动条目 / 写入各工具配置 / 握手验证',
  };
  const PANE_TITLE = { modules: '模块', tools: '工具', env: '关于' };
  // 与左导航两行文案一致；头部副标题跟随切换
  const PANE_SUB = {
    modules: '启用或停用顶部导航模块',
    tools: '排序、启停与路径配置',
    env: '版本与存储位置',
  };
  const S = { pane: 'modules' };
  const INTERVALS = [5, 10, 15, 30, 60, 180];

  function $pane(name) { return document.querySelector(`.setpane[data-pane="${name}"]`); }

  function switchPane(name) {
    S.pane = name;
    document.querySelectorAll('.setwin__item').forEach(b =>
      b.classList.toggle('is-on', b.dataset.pane === name));
    document.querySelectorAll('.setpane').forEach(p =>
      p.classList.toggle('is-on', p.dataset.pane === name));
    document.getElementById('settings-title').textContent = PANE_TITLE[name] || name;
    const sub = document.getElementById('settings-sub');
    if (sub) sub.textContent = PANE_SUB[name] || '';
    render();
  }

  async function render() {
    const ver = document.getElementById('settings-version');
    if (ver) ver.textContent = 'Agent Depot ' + ((window.hubApp && window.hubApp.state.version) || '');
    if (S.pane === 'modules') await renderModules();
    if (S.pane === 'tools') await renderTools();
    if (S.pane === 'env') renderEnv();
  }

  async function openSettings() {
    if (typeof switchView === 'function' && !document.getElementById('settings-overlay').classList.contains('is-active')) {
      switchView('settings'); return;                 // 页面化：走导航切换
    }
    const ver = document.getElementById('settings-version');
    if (ver) ver.textContent = 'Agent Depot ' + (window.hubApp.state.version || '');
    await render();
  }
  function closeSettings() {
    if (typeof switchView === 'function') switchView('sessions');
  }

  /* ==================== 模块 ==================== */
  async function renderModules() {
    const box = $pane('modules');
    const r = await api('/api/modules');
    const mods = (r.data.modules || []);
    box.innerHTML = `
      <p class="setpane__hint">禁用后顶部导航与对应接口同时停用；数据不受影响。</p>
      <div class="setcard--list">${mods.map(m => `
        <div class="setrow" data-testid="settings-module-${m.id}">
          <div class="setrow__txt">
            <div class="setrow__name">${esc(m.name || MODULE_LABEL[m.id] || m.id)}</div>
            <div class="setrow__desc">${esc(m.desc || MODULE_DESC[m.id] || '')}</div>
          </div>
          <button class="set-toggle ${m.enabled ? 'is-on' : ''}" data-mid="${m.id}"
                  data-testid="settings-module-toggle-${m.id}"
                  aria-label="${esc(MODULE_LABEL[m.id] || m.id)} ${m.enabled ? '已启用' : '已禁用'}">
            <span class="set-toggle__knob"></span>
          </button>
        </div>`).join('')}</div>`;
    box.querySelectorAll('.set-toggle[data-mid]').forEach(btn => {
      btn.onclick = async () => {
        const mid = btn.dataset.mid;
        const on = !btn.classList.contains('is-on');
        flipToggle(btn, on);                                  // 先切换：滑块弹性过渡立即可见
        const r2 = await post(`/api/modules/${mid}/toggle`, { enabled: on });
        if (r2.data.ok) {
          toastOnce('mod-' + mid, `${MODULE_LABEL[mid] || mid} 已${on ? '启用' : '禁用'}`, 'success');
          if (window.applyModuleVisibility) window.applyModuleVisibility(r2.data.modules || []);
        } else {
          flipToggle(btn, !on);                               // 失败回滚
          HubUI.toast('操作失败：' + (r2.data.error || ''), 'error');
        }
      };
    });
  }

  /** 开关切换：只改类名（CSS 过渡负责动画），并同步行的启停态 */
  function flipToggle(btn, on) {
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    const row = btn.closest('.trow, .setrow');
    if (row) row.classList.toggle('is-off', !on);
  }
  /** 同一来源的提示只保留一条（连点开关不会堆一串 toast） */
  const TOASTS = {};
  function toastOnce(key, msg, type) {
    const old = TOASTS[key];
    if (old && old.isConnected) old.remove();
    TOASTS[key] = HubUI.toast(msg, type);
  }

  /* ==================== 工具 ====================
     稿子 2026-10-16：去掉「编辑」按钮，点击整行展开行内编辑面板（accordion）；
     内置工具的会话路径锁定；展开时禁用拖动排序（避免在输入框里选词误触发排序）。 */
  async function renderTools() {
    const box = $pane('tools');
    const r = await api('/api/state');
    const tools = (r.data.tool_list || []);
    box.innerHTML = `
      <div class="setpane__toph">
        <p class="setpane__hint">拖动左侧手柄或用箭头调整顺序，顺序同步到工具卡片与侧栏。内置工具不可删除；
          停用的工具停止采集，历史会话仍可查看。点击整行可展开编辑。</p>
        <span class="setall">
          <span class="setall__l">全部启用</span>
          <button class="set-toggle ${tools.length && tools.every(t => t.enabled) ? 'is-on' : ''}"
                  data-testid="settings-tool-all" id="set-tool-all" aria-label="全部启用 / 全部停用">
            <span class="set-toggle__knob"></span></button>
        </span>
      </div>
      <ol class="setcard--list" id="set-tool-list">${tools.map((t, i) => toolRowHTML(t, i, tools.length)).join('')}</ol>`;
    bindToolEdit(box, tools);
    bindToolToggle(box);
    bindReorder(box);
  }

  function pathsLine(t) {
    return [t.root, t.skills_dir ? 'Skills ' + t.skills_dir : '', t.mcp_config ? 'MCP ' + t.mcp_config : '']
      .filter(Boolean).join(' · ');
  }

  function toolRowHTML(t, i, n) {
    return `
      <li class="trow ${t.enabled ? '' : 'is-off'}" data-tid="${esc(t.id)}"
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
            <button data-mv="up" ${i === 0 ? 'disabled' : ''} title="上移" aria-label="上移"
                    data-testid="settings-tool-up-${esc(t.id)}">▲</button>
            <button data-mv="down" ${i === n - 1 ? 'disabled' : ''} title="下移" aria-label="下移"
                    data-testid="settings-tool-down-${esc(t.id)}">▼</button>
          </span>
          <button class="trow__fold" data-testid="manage-${esc(t.id)}" data-fold="${esc(t.id)}"
                  title="展开 / 收起编辑面板" aria-label="展开编辑">${'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>'}</button>
          <span class="trow__sw" data-stop="1">
            <button class="set-toggle ${t.enabled ? 'is-on' : ''}" data-tid="${esc(t.id)}"
                    data-testid="settings-tool-toggle-${esc(t.id)}"
                    aria-label="${esc(t.name)} ${t.enabled ? '已启用' : '已停用'}">
              <span class="set-toggle__knob"></span>
            </button>
          </span>
        </div>
        <div class="trow__acc"><div><div class="trow__panel" data-panel="${esc(t.id)}"></div></div></div>
      </li>`;
  }

  /** 行内编辑面板（展开时按当前配置现渲染，取消即丢弃草稿） */
  function toolPanelHTML(t) {
    const bus = !t.mcp_config ? '未登记 MCP 配置'
      : (t.memory_wired === true ? '已接入 agentmemory'
        : (t.memory_wired === false ? '未接入' : '无法判断（配置文件不可读）'));
    const canWire = !!t.mcp_config && t.memory_wired === false;
    return `
      <label class="setfield">
        <span class="setfield__l">会话路径</span>
        <input class="hub-input mono" id="settool-root" data-testid="settool-root"
               value="${esc(t.root || '')}" placeholder="未配置" ${t.builtin ? 'disabled' : ''}>
      </label>
      <div class="setfield__grid">
        <label class="setfield">
          <span class="setfield__l">Skills 目录（可选）</span>
          <input class="hub-input mono" id="settool-skills" data-testid="settool-skills"
                 value="${esc(t.skills_dir || '')}" placeholder="未配置">
        </label>
        <label class="setfield">
          <span class="setfield__l">MCP 配置（可选）</span>
          <input class="hub-input mono" id="settool-mcp" data-testid="settool-mcp"
                 value="${esc(t.mcp_config || '')}" placeholder="未配置">
        </label>
      </div>
      <p class="setpane__hint">格式随路径自动识别；填写 Skills / MCP 路径后，会自动出现在对应模块的「目标」列表中。</p>
      <div class="trow__foot">
        <div class="trow__enable">
          <span class="trow__enable-t"><b>启用采集</b>
            <span class="trow__wire">记忆总线 · ${esc(bus)}
              ${canWire ? `<button class="hub-btn btn-sm" data-wire="${esc(t.id)}" data-testid="settool-wire">接入</button>` : ''}</span></span>
          <button class="set-toggle ${t.enabled ? 'is-on' : ''}" data-en="${esc(t.id)}"
                  data-testid="settool-enabled" aria-label="启用采集"><span class="set-toggle__knob"></span></button>
        </div>
        ${t.builtin ? '' : `<button class="hub-btn btn-sm hub-btn--danger" data-testid="settool-delete" data-del="${esc(t.id)}">删除</button>`}
        <button class="hub-btn btn-sm" data-testid="settool-cancel" data-cancel="${esc(t.id)}">取消</button>
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="settool-save" data-save="${esc(t.id)}" disabled>保存</button>
      </div>`;
  }

  function closeRows() {
    document.querySelectorAll('.trow.is-open').forEach(r => {
      r.classList.remove('is-open');
      delete r.dataset.open;
      const p = r.querySelector('.trow__panel');
      if (p) p.innerHTML = '';
    });
    PANEL.row = null;
  }

  // 面板草稿状态（同一时间只展开一行）
  const PANEL = { row: null, tool: null, draft: null };

  function openRow(row, t) {
    const wasOpen = row.classList.contains('is-open');
    closeRows();
    if (wasOpen) return;
    row.querySelector('.trow__panel').innerHTML = toolPanelHTML(t);
    row.classList.add('is-open');
    row.dataset.open = '1';
    PANEL.row = row;
    PANEL.tool = t;
    PANEL.draft = { enabled: !!t.enabled };
    // 直接绑输入框：脏检查必须可靠（否则保存按钮一直 disabled）
    row.querySelectorAll('#settool-root, #settool-skills, #settool-mcp').forEach(inp => {
      inp.addEventListener('input', () => syncSaveLocal(row, t));
      inp.addEventListener('keyup', () => syncSaveLocal(row, t));
    });
  }

  /* 事件委托：行 / 折叠 / 取消 / 保存 / 启用采集 都在一处处理
     （避免"面板重渲染后旧处理器指向旧 DOM"这类问题） */
  let TOOLS_BOUND = false;
  let TOOLS_CACHE = [];
  function bindToolEdit(box, tools) {
    if (TOOLS_BOUND) { TOOLS_CACHE = tools || []; return; }   // 委托只挂一次
    TOOLS_BOUND = true;
    TOOLS_CACHE = tools || [];
    box.removeEventListener('click', onToolsClick, true);
    box.addEventListener('click', onToolsClick, true);
    // 用本次渲染拿到的列表查表（新登记的工具可能还没进 window.hubApp.state）
    const toolOf = (tid) => (TOOLS_CACHE || []).find(x => x.id === tid)
      || (window.hubApp.state.tool_list || []).find(x => x.id === tid);

    // 捕获阶段处理：面板内的取消/保存在这里就截断，避免任何冒泡把行再次展开
    async function onToolsClick(e) {
      const t0 = e.target;
      const fold = t0.closest('[data-fold]');
      const cancel = t0.closest('[data-cancel]');
      const save = t0.closest('[data-save]');
      const en = t0.closest('[data-en]');
      const row = t0.closest('.trow');
      const t = row && toolOf(row.dataset.tid);

      if (fold && t) { e.stopPropagation(); openRow(row, t); return; }
      if (cancel) { e.stopPropagation(); e.preventDefault(); closeRows(); return; }
      const wire = t0.closest('[data-wire]');
      if (wire && t) {                                                   // 接入记忆总线（原工具弹窗的能力迁到这里）
        e.stopPropagation(); e.preventDefault();
        HubUI.confirm('接入记忆总线',
          `将把 <b>agentmemory</b> 写入 <code>${esc(t.mcp_config || '')}</code>（先自动备份原文件）。`,
          async () => {
            wire.classList.add('is-loading');
            const r = await post('/api/tools/' + encodeURIComponent(t.id) + '/wire-memory', {});
            wire.classList.remove('is-loading');
            if (!r.data.ok) { HubUI.toast('接入失败：' + (r.data.error || ''), 'error'); return; }
            toastOnce('wire-' + t.id, r.data.already ? '记忆总线已接入' : '已接入记忆总线（原文件已备份）', 'success');
            const txt = wire.parentElement;                              // 就地更新文案（不重绘整表）
            wire.remove();
            if (txt) txt.firstChild.textContent = '记忆总线 · 已接入 agentmemory ';
            window.hubApp.loadState();
          }, { confirmText: '接入' });
        return;
      }
      const del = t0.closest('[data-del]');
      if (del && t) {
        e.stopPropagation(); e.preventDefault();
        // HubUI.confirm 的签名是 (title, bodyHTML, onConfirm, opts)
        HubUI.confirm('删除工具',
          `<p>删除「${esc(t.name)}」的登记？默认保留已采集数据。</p>`
            + `<label class="tool-purge-opt"><input type="checkbox" id="tool-purge-opt" data-testid="tool-purge-opt">`
            + ' 同时彻底清除已采集的会话/消息（删除前自动导出备份）</label>',
          async () => {
            const purge = !!document.querySelector('#tool-purge-opt:checked');
            const r = await api('/api/tools/' + encodeURIComponent(t.id) + (purge ? '?purge=1' : ''),
              { method: 'DELETE' });
            if (!r.data.ok) { HubUI.toast('删除失败：' + (r.data.error || ''), 'error'); return; }
            HubUI.toast(purge ? '已彻底删除（含已采集数据）' : '已删除登记（数据保留）', 'success');
            closeRows();
            await window.hubApp.loadState(); await renderTools();
          },
          { confirmText: '删除', danger: true });
        return;
      }
      if (en) {                                                          // 启用采集（面板内）
        e.stopPropagation(); e.preventDefault();
        PANEL.draft.enabled = !PANEL.draft.enabled;
        en.classList.toggle('is-on', PANEL.draft.enabled);
        syncSaveLocal(row, t);
        return;
      }
      if (save && t) {                                                   // 保存
        e.stopPropagation(); e.preventDefault();
        const root = row.querySelector('#settool-root');
        const skills = row.querySelector('#settool-skills');
        const mcp = row.querySelector('#settool-mcp');
        save.classList.add('is-loading');
        const body = { root: root.value.trim(), skills_dir: skills.value.trim(), mcp_config: mcp.value.trim() };
        if (PANEL.draft.enabled !== !!t.enabled) body.enabled = PANEL.draft.enabled;
        const r = await api('/api/tools/' + encodeURIComponent(t.id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        save.classList.remove('is-loading');
        if (!r.data.ok) { HubUI.toast('保存失败：' + (r.data.error || ''), 'error'); return; }
        HubUI.toast('已保存', 'success');
        closeRows();
        await window.hubApp.loadState();
        await renderTools();
        return;
      }
      if (row && t0.closest('.trow__line') && !t0.closest('[data-stop], .trow__grip, [data-mv]')) {
        openRow(row, t);                                                 // 点整行展开
      }
    }
    // 输入变化 → 脏检查
    ['input', 'keyup', 'change'].forEach(evt =>
      box.addEventListener(evt, (e) => {
        if (e.target && /settool-(root|skills|mcp)/.test(e.target.id || '')) syncSave();
      }));
    function syncSave() {
      if (!PANEL.row || !PANEL.tool) return;
      const row = PANEL.row, t = PANEL.tool;
      const v = (id) => (row.querySelector('#' + id) || {}).value || '';
      const dirty = v('settool-root') !== (t.root || '') || v('settool-skills') !== (t.skills_dir || '')
        || v('settool-mcp') !== (t.mcp_config || '') || PANEL.draft.enabled !== !!t.enabled;
      const save = row.querySelector('[data-save]');
      if (save) save.disabled = !dirty;
    }
  }

  function syncSaveLocal(row, t) {
    const v = (id) => (row.querySelector('#' + id) || {}).value || '';
    const enOn = !!(row.querySelector('[data-en]') || {}).classList &&
      row.querySelector('[data-en]').classList.contains('is-on');
    const dirty = v('settool-root') !== (t.root || '') || v('settool-skills') !== (t.skills_dir || '')
      || v('settool-mcp') !== (t.mcp_config || '') || enOn !== !!t.enabled;
    const save = row.querySelector('[data-save]');
    if (save) save.disabled = !dirty;
  }

  function bindPanel() { /* 面板通过委托处理，无需单独绑定 */ }

  /* 工具排序：指针拖动（pointerdown/move/up）+ 上下箭头微调
     为什么不用 HTML5 draggable：桌面壳是 Tauri/WKWebView，原生 dnd 拿不到可靠事件；
     为什么移动后不 renderTools()：整页重渲染会把列表滚动位置打回顶部，看起来像"没生效"。 */
  function bindReorder(box) {
    const list = box.querySelector('#set-tool-list');
    if (!list) return;
    const rows = () => [...list.querySelectorAll('.trow')];
    const renumber = () => rows().forEach((r, i) => { r.querySelector('.trow__n').textContent = i + 1; });
    const syncArrows = () => {
      const all = rows();
      all.forEach((r, i) => {
        const up = r.querySelector('[data-mv="up"]'), down = r.querySelector('[data-mv="down"]');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === all.length - 1;
      });
    };
    const persist = async () => {
      const ids = rows().map(r => r.dataset.tid);
      const r = await post('/api/tools/reorder', { ids });
      if (!r.data.ok) { HubUI.toast('排序保存失败：' + (r.data.error || ''), 'error'); return; }
      await window.hubApp.loadState();   // 会话页卡片/侧栏跟着换序；设置面板保持原样
    };
    // 拖动：手柄按下 → 指针移动过程中就地换位（实时预览）→ 松手落库
    list.querySelectorAll('.trow__grip').forEach(grip => {
      grip.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const row = grip.closest('.trow');
        if (!row) return;
        if (row.classList.contains('is-open')) return;   // 展开编辑时禁用拖动（稿子）
        e.preventDefault();
        const startY = e.clientY;
        let moved = false;
        row.classList.add('is-drag');
        const onMove = ev => {
          if (!moved && Math.abs(ev.clientY - startY) < 4) return;
          moved = true;
          const all = rows();
          const target = all.find(r => {
            const b = r.getBoundingClientRect();
            return ev.clientY >= b.top && ev.clientY <= b.bottom;
          });
          if (!target || target === row) return;
          const from = all.indexOf(row), to = all.indexOf(target);
          all.forEach(r => { r.classList.remove('is-over'); delete r.dataset.line; });
          target.classList.add('is-over');
          target.dataset.line = to > from ? 'bottom' : 'top';   // 指示线跟随方向
          if (to > from) target.after(row); else target.before(row);
          renumber(); syncArrows();
        };
        const onUp = async () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          row.classList.remove('is-drag');
          rows().forEach(r => { r.classList.remove('is-over'); delete r.dataset.line; });
          if (moved) await persist();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });
    // 箭头微调：同样只动本地 DOM
    list.querySelectorAll('[data-mv]').forEach(btn => {
      btn.onclick = async () => {
        const row = btn.closest('.trow');
        const all = rows();
        const i = all.indexOf(row);
        const to = btn.dataset.mv === 'up' ? i - 1 : i + 1;
        if (i < 0 || to < 0 || to >= all.length) return;
        if (to < i) all[to].before(row); else all[to].after(row);
        renumber(); syncArrows();
        await persist();
      };
    });
  }

  /* 启停开关（行内，不触发展开） */
  function bindToolToggle(box) {
    const patchTool = (tid, on) => api('/api/tools/' + encodeURIComponent(tid), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }),
    });
    const syncAll = () => {
      const all = box.querySelector('#set-tool-all');
      if (!all) return;
      const sw = [...box.querySelectorAll('.set-toggle[data-tid]')];
      all.classList.toggle('is-on', sw.length > 0 && sw.every(b => b.classList.contains('is-on')));
    };
    box.querySelectorAll('.set-toggle[data-tid]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const tid = btn.dataset.tid;
        const on = !btn.classList.contains('is-on');
        flipToggle(btn, on); syncAll();                       // 先动画
        const r = await patchTool(tid, on);
        if (r.data.ok) {
          toastOnce('tool-' + tid, `工具已${on ? '启用' : '禁用'}`, 'success');
          window.hubApp.loadState();                          // 卡片 / 侧栏跟着变（不重绘本表）
        } else {
          flipToggle(btn, !on); syncAll();
          HubUI.toast('操作失败：' + (r.data.error || ''), 'error');
        }
      };
    });
    // 全部启用 / 全部停用：逐行依次翻转（错开 40ms，形成波浪过渡）
    const all = box.querySelector('#set-tool-all');
    if (all) all.onclick = async () => {
      const on = !all.classList.contains('is-on');
      flipToggle(all, on);
      const targets = [...box.querySelectorAll('.set-toggle[data-tid]')]
        .filter(b => b.classList.contains('is-on') !== on);
      targets.forEach((b, i) => setTimeout(() => flipToggle(b, on), i * 40));
      const rs = await Promise.all(targets.map(b => patchTool(b.dataset.tid, on)));
      const bad = rs.filter(r => !r.data.ok).length;
      if (bad) { HubUI.toast(`${bad} 个工具切换失败`, 'error'); await renderTools(); return; }
      toastOnce('tool-all', on ? `已全部启用（${targets.length}）` : `已全部停用（${targets.length}）`, 'success');
      window.hubApp.loadState();
    };
  }


  /* ==================== 关于 ==================== */
  function renderEnv() {
    const box = $pane('env');
    const eng = window.hubApp.state.engine || {};
    const rows = [
      ['引擎 casr', eng.casr ? '已安装（跨工具迁移可用）' : '未安装（迁移降级为只读浏览）'],
      ['记忆总线 agentmemory', eng.agentmemory ? '运行中' : '未运行'],
      ['数据目录', '~/.agent/hub/（环境变量 AGENT_HUB_DIR 可覆盖）'],
      ['服务端口', (location.port || '80') + '（环境变量 HUB_PORT，重启生效）'],
      ['隐私', '仅本地 · 无云端上传'],
      ['版本', 'Agent Depot ' + (window.hubApp.state.version || '')],
    ];
    box.innerHTML = `
      <div class="setcard--list">${rows.map(([k, v]) => `
        <div class="setkv"><span class="setkv__k">${esc(k)}</span><span class="setkv__v">${esc(v)}</span></div>`).join('')}</div>`;
  }

  window.SettingsCenter = { open: openSettings, close: closeSettings, refresh: render };
  window.applyModuleVisibility = applyModuleVisibility;

  function applyModuleVisibility(mods) {
    for (const m of mods) {
      const navBtn = document.querySelector(`.mod-nav button[data-view="${m.id}"]`);
      if (navBtn) navBtn.style.display = m.enabled ? '' : 'none';
    }
  }

  /* 锚点导航绑定（IIFE 内部最后执行一次；元素在 index.html 静态存在） */
  document.querySelectorAll('.setwin__item').forEach(b => {
    b.onclick = () => switchPane(b.dataset.pane);
  });
  document.getElementById('settings-close').onclick = closeSettings;
  document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target.id === 'settings-overlay') closeSettings();
  });
})();
