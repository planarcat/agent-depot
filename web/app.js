/* ====================================================================
   Agent Depot · app logic
   UI 规范：所有反馈走 HubUI（toast/confirm/prompt）；所有按钮 loading 走 is-loading。
   ==================================================================== */
'use strict';

const state = {
  tools: {}, sessions: [], ledger: [], migrations: [], schedule: {},
  memories: [], engine: {}, filter: 'all', selected: new Set(), tab: 'migrate',
};
window.__hubErrors = [];
window.addEventListener('error', e => window.__hubErrors.push(String(e.message)));

const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' };
let TOOL_LIST = [];
let ADAPTER_LIST = [];
let PRESET_LIST = [];
let toolMcpFormat = null;
function syncToolMap() { for (const t of TOOL_LIST) TOOL_NAMES[t.id] = t.name; }

/* ---------- fetch helpers ---------- */
async function api(path, opts) {
  try {
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
}
function renderLoadError(msg) {
  document.getElementById('session-rows').innerHTML =
    '<div class="hub-empty">加载失败：' + esc(msg || '未知错误') + '<div class="hub-empty__hint">检查服务是否运行：./run.sh</div></div>';
}

function renderAll() {
  renderToolCards(); renderFilterSeg(); renderRows(); renderDrops(); renderLedger();
  renderMemories(); renderMigrations(); renderStatus(); renderSelCount();
}

/* ---------- tool cards ---------- */
function renderToolCards() {
  const box = document.getElementById('tool-cards');
  box.innerHTML = '';
  for (const t of TOOL_LIST) {
    const info = (state.tools || {})[t.id] || { count: 0, latest: null };
    const sched = (state.schedule || {})[t.id] || { enabled: false, interval_min: 30 };
    const card = document.createElement('div');
    card.className = 'tool-card' + (state.filter === t.id ? ' is-active' : '') + (t.enabled ? '' : ' is-off');
    card.dataset.testid = 'tool-card-' + t.id;
    card.onclick = () => setFilter(t.id);
    const warn = !t.enabled ? '已停用' : (t.root && t.root_exists === false ? '路径不可用' : '');
    card.innerHTML = `
      <div class="tool-card__head">
        <span class="tool-dot tool-dot--p${t.color || 1}"></span>
        <span class="tool-card__name">${esc(t.name)}</span>
        <span class="tool-card__count" data-testid="count-${t.id}">${info.count}</span>
      </div>
      <div class="tool-card__meta">最近活动 <b>${esc(fmtTime(info.latest))}</b>${warn ? ' · <b>' + esc(warn) + '</b>' : ''}</div>
      <div class="tool-card__acts">
        <button class="hub-btn btn-sm" data-testid="refresh-${t.id}" ${t.enabled ? '' : 'disabled'}>⟳ 刷新</button>
        <button class="hub-btn btn-sm" data-testid="manage-${t.id}">设置</button>
        <span class="tool-card__sched">${sched.enabled ? '定时 ' + sched.interval_min + 'm' : ''}</span>
      </div>`;
    card.querySelector('[data-testid="refresh-' + t.id + '"]').onclick = ev => {
      ev.stopPropagation();
      if (t.enabled) refreshOne(t.id, ev.currentTarget);
    };
    card.querySelector('[data-testid="manage-' + t.id + '"]').onclick = ev => {
      ev.stopPropagation(); openToolModal(t.id);
    };
    box.appendChild(card);
  }
}

/* ---------- filter seg（内置 + 动态自定义工具） ---------- */
let lastSegSig = '__init__';
function renderFilterSeg() {
  const seg = document.getElementById('filter-seg');
  const customs = TOOL_LIST.filter(t => !['claude', 'codex', 'opencode'].includes(t.id));
  const sig = customs.map(t => t.id).join(',');
  if (sig === lastSegSig) return;
  lastSegSig = sig;
  const on = f => state.filter === f ? ' class="is-on"' : '';
  seg.innerHTML = [
    `<button data-filter="all" data-testid="filter-all"${on('all')}>全部</button>`,
    `<button data-filter="claude" data-testid="filter-claude"${on('claude')}>Claude</button>`,
    `<button data-filter="codex" data-testid="filter-codex"${on('codex')}>Codex</button>`,
    `<button data-filter="opencode" data-testid="filter-opencode"${on('opencode')}>OpenCode</button>`,
    ...customs.map(t => `<button data-filter="${esc(t.id)}" data-testid="filter-${esc(t.id)}"${on(t.id)}>${esc(t.name)}</button>`),
    `<button data-filter="starred" data-testid="filter-starred"${on('starred')}>★ 收藏</button>`,
  ].join('');
  seg.querySelectorAll('button').forEach(b => { b.onclick = () => setFilter(b.dataset.filter); });
}

/* ---------- rows ---------- */
function visibleSessions() {
  let list = state.sessions || [];
  if (state.filter === 'starred') list = list.filter(s => s.starred);
  else if (state.filter !== 'all') list = list.filter(s => s.tool === state.filter);
  const q = (document.getElementById('search-input').value || '').trim().toLowerCase();
  if (q) list = list.filter(s =>
    (s.title || '').toLowerCase().includes(q) || (s.sid || '').toLowerCase().includes(q));
  return list;
}
function renderRows() {
  const box = document.getElementById('session-rows');
  if (!state.sessions.length) {
    box.innerHTML = '<div class="hub-empty">还没有会话数据<div class="hub-empty__hint">点击左上角「全部刷新」或工具卡上的「刷新」开始采集</div></div>';
    return;
  }
  const list = visibleSessions();
  if (!list.length) {
    box.innerHTML = '<div class="hub-empty">没有匹配的会话<div class="hub-empty__hint">调整筛选或搜索词试试</div></div>';
    return;
  }
  box.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'row' + (state.selected.has(s.sid) ? ' is-sel' : '');
    row.dataset.testid = 'row';
    row.dataset.sid = s.sid;
    row.dataset.tool = s.tool;
    row.draggable = true;
    row.ondragstart = e => {
      if (!state.selected.has(s.sid)) { state.selected.add(s.sid); }
      e.dataTransfer.setData('text/plain', [...state.selected].join(','));
      renderRows();
    };
    row.onclick = e => {
      if (e.target.type === 'checkbox') return;
      openSession(s.sid);
    };
    const lid = s.lid ? `<span class="hub-badge" data-testid="lid-badge">[hub:${s.lid}]</span>` : '';
    const star = s.starred ? '<span class="row__star" data-testid="row-star">★</span>' : '';
    row.innerHTML = `
      <div><input type="checkbox" data-testid="row-check" ${state.selected.has(s.sid) ? 'checked' : ''}></div>
      <div class="row__title-wrap">${star}<span class="row__title">${esc(s.title || '(无标题)')}</span>${lid ? '&nbsp;' + lid : ''}</div>
      <div class="row__msgs">${esc(String(s.msg_count))}</div>
      <div class="row__meta">${esc(fmtTime(s.updated_at))}<div class="src">${esc(TOOL_NAMES[s.tool] || s.tool)}</div></div>`;
    row.querySelector('input[type=checkbox]').onclick = e => {
      e.stopPropagation(); toggleSel(s.sid, e.currentTarget);
    };
    box.appendChild(row);
  }
}
function toggleSel(sid, cb) {
  cb.checked ? state.selected.add(sid) : state.selected.delete(sid);
  const row = cb.closest('.row');
  if (row) row.classList.toggle('is-sel', cb.checked);
  renderSelCount();
}
function selectAll(cb) {
  const list = visibleSessions();
  list.forEach(s => cb.checked ? state.selected.add(s.sid) : state.selected.delete(s.sid));
  renderRows(); renderSelCount();
}
function renderSelCount() {
  document.getElementById('sel-count').textContent = state.selected.size;
}
function setFilter(tool) {
  state.filter = tool;
  document.querySelectorAll('#filter-seg button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.filter === tool));
  renderToolCards(); renderRows();
}

/* ---------- migration ---------- */
function renderDrops() {
  const box = document.getElementById('drops');
  box.innerHTML = '';
  for (const tool of ['claude', 'codex', 'opencode']) {
    const el = document.createElement('div');
    el.className = 'drop';
    el.dataset.testid = 'drop-' + tool;
    el.ondragover = e => { e.preventDefault(); el.classList.add('is-hot'); };
    el.ondragleave = () => el.classList.remove('is-hot');
    el.ondrop = e => {
      e.preventDefault(); el.classList.remove('is-hot');
      const ids = (e.dataTransfer.getData('text/plain') || '').split(',').filter(Boolean);
      migrateFlow(tool, ids.length ? ids : [...state.selected]);
    };
    el.onclick = () => migrateFlow(tool, [...state.selected]);
    el.innerHTML = `<div class="drop__name">${TOOL_NAMES[tool]}</div>
      <div class="drop__meta">casr → 原生格式写回</div>`;
    box.appendChild(el);
  }
}
async function migrateFlow(target, ids) {
  if (!ids.length) { HubUI.toast('先勾选要迁移的会话，再点击目标工具卡片', 'warn'); return; }
  const byId = Object.fromEntries(state.sessions.map(s => [s.sid, s]));
  const items = ids.map(id => byId[id]).filter(s => s && s.tool !== target);
  if (!items.length) { HubUI.toast('所选会话已属于目标工具，无需迁移', 'warn'); return; }
  HubUI.confirm('迁移确认',
    `将 <b>${items.length}</b> 条会话迁移到 <b>${TOOL_NAMES[target]}</b>：<br><br>` +
    items.slice(0, 5).map(s => `· ${esc((s.title || s.sid).slice(0, 42))}（${TOOL_NAMES[s.tool]}）`).join('<br>') +
    (items.length > 5 ? `<br>…… 等共 ${items.length} 条` : '') +
    '<br><br>迁移会在目标工具生成<b>新会话副本</b>（原生文件不覆盖、源会话不动），并记录到 lineage 台账。',
    async () => { await runMigration(items, target, false); },
    { confirmText: '开始迁移' });
}
async function runMigration(items, target, force) {
  const ok = [], dup = [], err = [];
  const toastEl = HubUI.toast('迁移中… 0/' + items.length, 'info', 60000);
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const r = await post('/api/migrate', { sid: s.sid, target, force: !!force });
    if (r.data.ok) ok.push({ s, r: r.data });
    else if (r.data.duplicate) dup.push(s);
    else err.push({ s, msg: r.data.error || '未知错误' });
    const msgEl = toastEl.querySelector('.hub-toast__msg');
    if (msgEl) msgEl.textContent = `迁移中… ${i + 1}/${items.length}`;
  }
  toastEl.remove();
  if (ok.length) {
    const lids = ok.map(o => o.r.lid).filter(Boolean);
    HubUI.toast(`${ok.length} 条已迁移到 ${TOOL_NAMES[target]}` +
      (lids.length ? `（${[...new Set(lids)].join(', ')}）` : ''), 'success');
  }
  if (err.length) {
    HubUI.toast(`${err.length} 条失败：${err[0].msg.slice(0, 60)}`, 'error', 5200);
  }
  if (dup.length) {
    // fetch increment info for a richer message (single-item case gets exact delta)
    let inc = '';
    if (dup.length === 1) {
      const pv = await api('/api/sync/preview?sid=' + encodeURIComponent(dup[0].sid) + '&target=' + target);
      const s = pv.data && pv.data.sync;
      if (s && s.delta != null) {
        inc = s.delta > 0
          ? `<br><br>该会话自上次迁移后<b>新增 ${s.delta} 条消息</b>（基线 ${s.base_count} → 当前 ${s.current_count}），可「同步更新」生成修订副本。`
          : '<br><br>自上次迁移后<b>没有新消息</b>，通常无需同步。';
      }
    }
    HubUI.confirm('检测到已迁移过的会话',
      `${dup.length} 条会话此前已迁移到 ${TOOL_NAMES[target]}（同一 lineage 通道已记录，避免重复副本）。` + inc +
      '<br><br>「同步更新」会生成目标工具内的新修订副本（不覆盖旧副本、不动源会话）。',
      async () => { await runMigration(dup, target, true); },
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
  for (const t of TOOL_LIST) if (t.enabled) list.push([t.id, t.name]);
  return list;
}
const INTERVALS = [5, 10, 15, 30, 60, 180];
function openSchedule() {
  const body = document.getElementById('sched-body');
  body.innerHTML = schedScopes().map(([k, name]) => {
    const cfg = (state.schedule || {})[k] || { enabled: false, interval_min: 30 };
    return `<div class="sched__row" data-testid="sched-row-${k}">
      <span class="sched__name">${name}</span>
      <select class="sched__select" data-testid="sched-interval-${k}">
        ${INTERVALS.map(m => `<option value="${m}" ${cfg.interval_min === m ? 'selected' : ''}>每 ${m} 分钟</option>`).join('')}
      </select>
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
    const interval = parseInt(row.querySelector('select').value, 10);
    await post('/api/schedule', { tool: k, enabled, interval_min: interval });
  }
  btn.classList.remove('is-loading');
  HubUI.toast('定时任务已保存', 'success');
  closeSchedule();
  await loadState();
}

/* ---------- tools registry（v0.5.1：添加 / 设置 / 停用 / 移除） ---------- */
async function ensureAdapters() {
  if (ADAPTER_LIST.length) return;
  try {
    const ar = await api('/api/tools');
    if (ar.data && Array.isArray(ar.data.adapters)) ADAPTER_LIST = ar.data.adapters;
    if (ar.data && Array.isArray(ar.data.presets)) PRESET_LIST = ar.data.presets;
  } catch (e) { /* 降级：仍可用默认空列表 */ }
}
function adapterDef(id) { return ADAPTER_LIST.find(a => a.id === id) || {}; }
function updRootHint() {
  const a = adapterDef(document.getElementById('tool-adapter').value);
  document.getElementById('tool-root-hint').textContent =
    a.root_hint ? '路径示例：' + a.root_hint + '（绝对路径，可用 ~）' : '';
}
let toolModalMode = 'add';
let toolModalId = null;
async function openToolModal(toolId) {
  await ensureAdapters();
  toolModalMode = toolId ? 'edit' : 'add';
  toolModalId = toolId || null;
  const t = toolId ? TOOL_LIST.find(x => x.id === toolId) : null;
  document.getElementById('tool-modal-title').textContent = t ? '工具设置 · ' + t.name : '添加工具';
  document.getElementById('tool-modal-hint').textContent = t
    ? '可改名 / 停用 / 删除；Skills / MCP / 记忆集成都可在此调整。'
    : '登记后进入采集与筛选；填了 Skills / MCP 路径还会同步到对应模块的目标列表。';
  const nameEl = document.getElementById('tool-name');
  const adEl = document.getElementById('tool-adapter');
  const rootEl = document.getElementById('tool-root');
  adEl.innerHTML = ADAPTER_LIST.map(a =>
    `<option value="${esc(a.id)}">${esc(a.label || a.id)}</option>`).join('');
  nameEl.value = t ? t.name : '';
  adEl.value = t ? t.adapter : (ADAPTER_LIST[0] ? ADAPTER_LIST[0].id : 'claude');
  rootEl.value = (t && t.root) ? t.root : '';
  document.getElementById('tool-skills').value = (t && t.skills_dir) ? t.skills_dir : '';
  document.getElementById('tool-mcp').value = (t && t.mcp_config) ? t.mcp_config : '';
  toolMcpFormat = null;
  const presetRow = document.getElementById('tool-preset-row');
  const presetEl = document.getElementById('tool-preset');
  presetEl.innerHTML = '<option value="">自定义…</option>' +
    PRESET_LIST.map(pp => `<option value="${esc(pp.key)}">${esc(pp.name)}</option>`).join('');
  presetEl.value = '';
  presetRow.style.display = t ? 'none' : '';
  const isBuiltin = !!(t && t.builtin);
  adEl.disabled = !!t;
  rootEl.disabled = isBuiltin;
  document.getElementById('tool-enable-row').style.display = t ? '' : 'none';
  document.getElementById('tool-enabled').classList.toggle('is-on', t ? !!t.enabled : true);
  document.getElementById('tool-delete').style.display = (t && !t.builtin) ? '' : 'none';
  const memRow = document.getElementById('tool-mem-row');
  const memStatus = document.getElementById('tool-mem-status');
  const wireBtn = document.getElementById('tool-wire');
  if (t && t.mcp_config) {
    memRow.style.display = '';
    if (t.memory_wired === true) { memStatus.textContent = '已接入（agentmemory）'; wireBtn.style.display = 'none'; }
    else if (t.memory_wired === false) { memStatus.textContent = '未接入'; wireBtn.style.display = ''; }
    else { memStatus.textContent = '无法判断（文件不可读）'; wireBtn.style.display = 'none'; }
  } else {
    memRow.style.display = 'none';
  }
  updRootHint();
  document.getElementById('tool-overlay').classList.add('is-open');
}
function closeToolModal() { document.getElementById('tool-overlay').classList.remove('is-open'); }
async function submitTool(btn) {
  const name = document.getElementById('tool-name').value.trim();
  const adapter = document.getElementById('tool-adapter').value;
  const rootEl = document.getElementById('tool-root');
  const root = rootEl.value.trim();
  const skills = document.getElementById('tool-skills').value.trim();
  const mcp = document.getElementById('tool-mcp').value.trim();
  if (!name) { HubUI.toast('名称不能为空', 'error'); return; }
  if (!rootEl.disabled && !root) { HubUI.toast('路径不能为空', 'error'); return; }
  btn.classList.add('is-loading');
  let r;
  if (toolModalMode === 'add') {
    const body = { name, adapter, root, skills_dir: skills, mcp_config: mcp };
    if (toolMcpFormat) body.mcp_format = toolMcpFormat;
    r = await post('/api/tools', body);
  } else {
    const patch = { name, enabled: document.getElementById('tool-enabled').classList.contains('is-on'),
                    skills_dir: skills, mcp_config: mcp };
    if (!rootEl.disabled) patch.root = root;
    if (toolMcpFormat) patch.mcp_format = toolMcpFormat;
    r = await api('/api/tools/' + encodeURIComponent(toolModalId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }
  btn.classList.remove('is-loading');
  if (r.data.ok) {
    HubUI.toast(toolModalMode === 'add' ? '工具已添加' : '工具已更新', 'success');
    const tc = (r.data.targets_created || []).length;
    if (tc) HubUI.toast(`已同步 ${tc} 个分发目标（Skills / MCP）`, 'success', 4600);
    if (r.data.warning) HubUI.toast(r.data.warning, 'warn', 5600);
    closeToolModal();
    await loadState();
  } else {
    HubUI.toast((toolModalMode === 'add' ? '添加失败：' : '更新失败：') + (r.data.error || ''), 'error', 5600);
  }
}
async function deleteTool() {
  const t = TOOL_LIST.find(x => x.id === toolModalId) || {};
  const info = (state.tools || {})[toolModalId] || { count: 0 };
  HubUI.confirm('删除工具',
    `将删除「${esc(t.name || toolModalId)}」的登记（不再采集）。当前已采集 <b>${info.count}</b> 个会话。<br><br>` +
    `<label class="tool-purge-opt"><input type="checkbox" id="tool-purge-opt" data-testid="tool-purge-opt"> ` +
    `同时清除已采集的会话与消息（不可恢复；删除前自动备份为 zip）</label>` +
    `<div class="tool-hint">默认只断开登记、数据保留；内置工具不可删除（可停用）。</div>`,
    async () => {
      const purge = !!document.querySelector('#tool-purge-opt:checked');
      const r = await api('/api/tools/' + encodeURIComponent(toolModalId) + (purge ? '?purge=1' : ''),
                          { method: 'DELETE' });
      if (r.data.ok) {
        const pd = r.data.purge || {};
        let msg = '已删除工具（数据保留）';
        if (pd.purged) {
          msg = `已彻底删除：清除 ${pd.sessions} 个会话 / ${pd.messages} 条消息`;
          if (pd.backup) msg += `；备份 ${String(pd.backup).split('/').pop()}`;
        }
        HubUI.toast(msg, 'success', 6000);
        if (state.filter === toolModalId) setFilter('all');
        closeToolModal();
        await loadState();
      } else HubUI.toast('删除失败：' + (r.data.error || ''), 'error');
    }, { confirmText: '删除', danger: true });
}

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
function renderMigrations() {
  const box = document.getElementById('mig-list');
  const list = (state.migrations || []).slice(0, 10);
  if (!list.length) { box.innerHTML = '<div class="hub-empty">还没有迁移记录</div>'; return; }
  box.innerHTML = '';
  for (const m of list) {
    const el = document.createElement('div');
    el.className = 'led-item';
    el.innerHTML = `<div class="led-item__time">${esc((m.ts || '').slice(5, 16))} · <span style="color:var(--c-accent)">${esc(m.lid)}</span></div>
      <div class="led-item__act">${esc(TOOL_NAMES[m.src_tool] || m.src_tool)} → ${esc(TOOL_NAMES[m.dst_tool] || m.dst_tool)} · ${m.status === 'ok' ? '成功' : '失败'}</div>`;
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
  if (!r.data.ok || !(r.data.results || []).length) {
    panel.innerHTML = '<div class="hub-empty" style="padding:var(--sp-4)">没有消息内容匹配</div>';
    panel.style.display = '';
    return;
  }
  panel.innerHTML = r.data.results.map(x => `
    <div class="search-item" data-testid="search-item" data-sid="${esc(x.sid)}">
      <span class="search-item__tool">${esc(TOOL_NAMES[x.tool] || x.tool)}</span>
      <span class="search-item__title">${esc(x.title || x.sid.slice(0, 12))}</span>
      <span class="search-item__snip">${esc(x.snippet || '')}</span>
      <span class="search-item__hits">${x.hits}×</span>
    </div>`).join('');
  panel.style.display = '';
  panel.querySelectorAll('.search-item').forEach(el => {
    el.onclick = () => { hideSearchPanel(); openSession(el.dataset.sid); };
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

/* ---------- preview ---------- */
async function openSession(sid) {
  const r = await api('/api/session?id=' + encodeURIComponent(sid));
  if (r.status !== 200) { HubUI.toast('会话不存在或已清理', 'error'); return; }
  const s = r.data;
  document.getElementById('preview-title').textContent = s.title || '(无标题)';
  const chain = document.getElementById('preview-chain');
  let chainHTML = `${TOOL_NAMES[s.tool] || s.tool} · ${s.sid}`;
  try {
    const lin = await api('/api/lineage?tool=' + s.tool + '&sid=' + encodeURIComponent(s.sid));
    if (lin.data && lin.data.lid) {
      const hops = (lin.data.migrations || [])
        .filter(m => m.status === 'ok')
        .map(m => `${TOOL_NAMES[m.src_tool] || m.src_tool} → ${TOOL_NAMES[m.dst_tool] || m.dst_tool}`);
      chainHTML += ` · [hub:${lin.data.lid}]` + (hops.length ? ' · ' + hops.join(' · ') : '');
    }
  } catch (e) { /* lineage optional */ }
  chain.textContent = chainHTML;
  const body = document.getElementById('preview-body');
  if (!(s.messages || []).length) {
    body.innerHTML = '<div class="hub-empty">该会话暂无可显示的文本消息</div>';
  } else {
    body.innerHTML = s.messages.map(m => {
      const cls = m.role === 'assistant' ? ' msg--assistant' : (m.role === 'tool' ? ' msg--tool' : '');
      const role = (m.role || '?').toUpperCase() + (m.ts ? ' · ' + String(m.ts).slice(11, 16) : '');
      return `<div class="msg${cls}"><div class="msg__role">${esc(role)}</div>
        <div class="msg__bubble">${esc((m.content || '').slice(0, 6000))}</div></div>`;
    }).join('');
  }
  const starBtn = document.getElementById('preview-star');
  starBtn.textContent = s.starred ? '★ 已收藏' : '☆ 收藏';
  starBtn.onclick = async () => {
    const r = await post('/api/star', { sid: s.sid });
    if (r.data.ok) {
      s.starred = r.data.starred;
      starBtn.textContent = r.data.starred ? '★ 已收藏' : '☆ 收藏';
      HubUI.toast(r.data.starred ? '已收藏' : '已取消收藏', 'success');
      await loadState();
    } else HubUI.toast('收藏失败：' + (r.data.error || ''), 'error');
  };
  document.getElementById('preview-resume').onclick = async () => {
    const cmd = resumeCommand(s);
    const ok = await copyText(cmd);
    HubUI.toast(ok ? '已复制：' + cmd : '复制失败，请手动复制：' + cmd, ok ? 'success' : 'warn', 5200);
  };
  const exportBtn = document.getElementById('preview-export');
  exportBtn.onclick = async () => {
    exportBtn.classList.add('is-loading');
    const r = await api('/api/export?sid=' + encodeURIComponent(s.sid));
    exportBtn.classList.remove('is-loading');
    if (r.data.ok) {
      HubUI.toast('已导出 ' + (r.data.bytes / 1024).toFixed(1) + ' KB → ' + r.data.path, 'success', 5600);
    } else HubUI.toast('导出失败：' + (r.data.error || ''), 'error');
  };
  document.getElementById('preview-overlay').classList.add('is-open');
}
function closePreview() { document.getElementById('preview-overlay').classList.remove('is-open'); }

/* ---------- tabs ---------- */
function setTab(name) {
  state.tab = name;
  document.querySelectorAll('#side-tabs button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.tab === name));
  document.querySelectorAll('.side-panel').forEach(p =>
    p.style.display = p.dataset.panel === name ? '' : 'none');
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

/* ---------- module navigation (v0.4) ---------- */
const VIEWS = [];
function switchView(id) {
  document.querySelectorAll('.mod-nav button').forEach(b =>
    b.classList.toggle('is-on', b.dataset.view === id));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('is-active', v.id === 'view-' + id));
  const root = document.getElementById('view-' + id);
  if (id === 'skills' && window.SkillsView) SkillsView.render(root).catch(e => HubUI.toast('Skills 视图加载失败', 'error'));
  if (id === 'mcp' && window.McpView) McpView.render(root).catch(e => HubUI.toast('MCP 视图加载失败', 'error'));
  if (id === 'ops' && window.OpsView) OpsView.render(root).catch(e => HubUI.toast('台账加载失败', 'error'));
  if (id === 'memory') renderMemoryView(root);
}
function memItemsHTML(list) {
  return list.length ? list.map(m => `
    <div class="mem-item" data-testid="mv-item">
      <div class="mem-item__head">
        <span class="hub-badge hub-badge--neutral">${m.kind === 'migration-summary' ? '迁移记录' : '笔记'}</span>
        <span class="mem-item__title">${esc(m.title || '(无标题)')}</span>
        <span class="mem-item__ts">${fmtTime(m.ts)}</span>
      </div>
      <div class="mem-item__body">${esc(m.body)}</div>
    </div>`).join('') : '<div class="hub-empty">记忆区还是空的</div>';
}
function renderMemoryView(root) {
  const list = (state.memories || []);
  const hits = (q) => (q || []);
  const busTools = TOOL_LIST.filter(t => t.mcp_config);
  const busHtml = busTools.length
    ? busTools.map(t => {
        const mark = t.memory_wired === true ? '✓' : (t.memory_wired === false ? '✗' : '—');
        return `<span class="mem-bus__item" data-testid="mem-bus-item">${esc(t.name)} ${mark}</span>`;
      }).join('')
    : '<span class="tool-hint">暂无登记 MCP 配置的工具</span>';
  root.innerHTML = `
    <div class="mem-view">
      <div class="rail__h">记忆总线接入 <span class="mono-xs">（✓ 已接入 / ✗ 未接入；可在工具「设置」里一键接入）</span></div>
      <div class="mem-bus" data-testid="mem-bus">${busHtml}</div>
      <div class="rail__h">新增记忆</div>
      <div class="mem-form">
        <input class="hub-input" id="mv-title" placeholder="标题（可选）">
        <textarea class="hub-input" id="mv-body" placeholder="内容：偏好、决策、约定…" rows="3"></textarea>
        <div><button class="hub-btn hub-btn--primary" data-testid="mv-add">保存记忆</button></div>
      </div>
      <div class="rail__h">记忆列表 <span class="mono-xs">（${list.length} 条 · 存于 ~/.agent/hub/memory/ 每日日志）</span></div>
      <div class="mem-tools">
        <input class="hub-input" id="mv-q" data-testid="mv-search"
               placeholder="搜索记忆（全文，250ms 防抖）…">
        <a class="hub-btn btn-sm" data-testid="mv-export-md" href="/api/memory/export?format=md">导出 MD</a>
        <a class="hub-btn btn-sm" data-testid="mv-export-json" href="/api/memory/export?format=json">导出 JSON</a>
      </div>
      <div data-testid="mv-list">${memItemsHTML(list)}</div>
    </div>`;
  root.querySelector('[data-testid="mv-add"]').onclick = async (e) => {
    const body = root.querySelector('#mv-body').value.trim();
    if (!body) { HubUI.toast('内容不能为空', 'error'); return; }
    e.currentTarget.classList.add('is-loading');
    const r = await post('/api/memory/add', { title: root.querySelector('#mv-title').value.trim(), body, kind: 'note' });
    e.currentTarget.classList.remove('is-loading');
    if (r.data.ok) { HubUI.toast('记忆已保存', 'success'); await loadState(); renderMemoryView(root); }
    else HubUI.toast('保存失败：' + (r.data.error || ''), 'error');
  };
  let t = null;
  root.querySelector('#mv-q').oninput = (e) => {
    clearTimeout(t);
    const q = e.target.value.trim();
    t = setTimeout(async () => {
      const box = root.querySelector('[data-testid="mv-list"]');
      if (!q) { box.innerHTML = memItemsHTML(list); return; }
      const r = await api('/api/memory/search?q=' + encodeURIComponent(q));
      const res = ((r.data || {}).results) || [];
      box.innerHTML = res.length ? res.map(h => `
        <div class="mem-item" data-testid="mv-hit">
          <div class="mem-item__head">
            <span class="hub-badge hub-badge--neutral">${h.kind === 'migration-summary' ? '迁移记录' : '笔记'}</span>
            <span class="mem-item__title">${esc(h.title || '(无标题)')}</span>
            <span class="mem-item__ts">${fmtTime(h.ts)}</span>
          </div>
          <div class="mem-item__body">${esc(h.snippet || '')}</div>
        </div>`).join('') : '<div class="hub-empty">没有匹配的记忆</div>';
    }, 250);
  };
}

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-all').onclick = e => refreshAll(e.currentTarget);
  document.getElementById('schedule-open').onclick = openSchedule;
  document.getElementById('sched-close').onclick = closeSchedule;
  document.getElementById('sched-save').onclick = e => saveSchedule(e.currentTarget);
  document.getElementById('sched-overlay').addEventListener('click', e => {
    if (e.target.id === 'sched-overlay') closeSchedule();
  });
  document.getElementById('tool-add').onclick = () => openToolModal(null);
  document.getElementById('tool-close').onclick = closeToolModal;
  document.getElementById('tool-cancel').onclick = closeToolModal;
  document.getElementById('tool-save').onclick = e => submitTool(e.currentTarget);
  document.getElementById('tool-delete').onclick = () => deleteTool();
  document.getElementById('tool-adapter').onchange = updRootHint;
  document.getElementById('tool-preset').onchange = e => {
    const pp = PRESET_LIST.find(x => x.key === e.target.value);
    if (!pp) return;
    const setV = (id, v) => { document.getElementById(id).value = v || ''; };
    setV('tool-name', pp.name); setV('tool-adapter', pp.adapter); setV('tool-root', pp.root);
    setV('tool-skills', pp.skills_dir); setV('tool-mcp', pp.mcp_config);
    toolMcpFormat = pp.mcp_format || null;
    updRootHint();
  };
  document.getElementById('tool-wire').onclick = async () => {
    const t = TOOL_LIST.find(x => x.id === toolModalId) || {};
    HubUI.confirm('接入记忆总线',
      `将把 <b>agentmemory</b> 写入 <code>${esc(t.mcp_config || '')}</code>（先自动备份原文件）。`,
      async () => {
        const r = await post('/api/tools/' + encodeURIComponent(toolModalId) + '/wire-memory', {});
        if (r.data.ok) {
          HubUI.toast(r.data.already ? '记忆总线已接入' : '已接入记忆总线（原文件已备份）', 'success', 5200);
          closeToolModal();
          await loadState();
          openToolModal(toolModalId);
        } else HubUI.toast('接入失败：' + (r.data.error || ''), 'error', 5600);
      }, { confirmText: '接入' });
  };
  document.getElementById('tool-enabled').onclick = e =>
    e.currentTarget.classList.toggle('is-on');
  document.getElementById('tool-overlay').addEventListener('click', e => {
    if (e.target.id === 'tool-overlay') closeToolModal();
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
  document.getElementById('sel-all').onchange = e => selectAll(e.currentTarget);
  document.getElementById('memory-add').onclick = e => addMemory(e.currentTarget);
  document.getElementById('preview-close').onclick = closePreview;
  document.getElementById('preview-overlay').addEventListener('click', e => {
    if (e.target.id === 'preview-overlay') closePreview();
  });
  document.querySelectorAll('#side-tabs button').forEach(b => {
    b.onclick = () => setTab(b.dataset.tab);
  });
  document.querySelectorAll('#filter-seg button').forEach(b => {
    b.onclick = () => setFilter(b.dataset.filter);
  });
  setTab('migrate');
  document.querySelectorAll('.mod-nav button').forEach(b => {
    b.onclick = () => switchView(b.dataset.view);
  });
  const statsBtn = document.getElementById('stats-open');
  if (statsBtn) statsBtn.onclick = openStats;
  loadState().catch(e => renderLoadError(e.message));
  setInterval(() => loadState().catch(() => {}), 30000);
});
window.hubApp = { loadState, setFilter, openSession, switchView,
  migrateFlow: (t, ids) => migrateFlow(t, ids || [...state.selected]),
  get state() { return state; } };
