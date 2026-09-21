/* ====================================================================
   Agent Session Hub · app logic
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
  const valid = new Set(state.sessions.map(s => s.sid));
  [...state.selected].forEach(sid => { if (!valid.has(sid)) state.selected.delete(sid); });
  renderAll();
}
function renderLoadError(msg) {
  document.getElementById('session-rows').innerHTML =
    '<div class="hub-empty">加载失败：' + esc(msg || '未知错误') + '<div class="hub-empty__hint">检查服务是否运行：./run.sh</div></div>';
}

function renderAll() {
  renderToolCards(); renderRows(); renderDrops(); renderLedger();
  renderMemories(); renderMigrations(); renderStatus(); renderSelCount();
}

/* ---------- tool cards ---------- */
function renderToolCards() {
  const box = document.getElementById('tool-cards');
  box.innerHTML = '';
  for (const tool of ['claude', 'codex', 'opencode']) {
    const info = state.tools[tool] || { count: 0, latest: null };
    const sched = (state.schedule || {})[tool] || { enabled: false, interval_min: 30 };
    const card = document.createElement('div');
    card.className = 'tool-card' + (state.filter === tool ? ' is-active' : '');
    card.dataset.testid = 'tool-card-' + tool;
    card.onclick = () => setFilter(tool);
    card.innerHTML = `
      <div class="tool-card__head">
        <span class="tool-dot tool-dot--${tool}"></span>
        <span class="tool-card__name">${TOOL_NAMES[tool]}</span>
        <span class="tool-card__count" data-testid="count-${tool}">${info.count}</span>
      </div>
      <div class="tool-card__meta">最近活动 <b>${fmtTime(info.latest)}</b></div>
      <div class="tool-card__acts">
        <button class="hub-btn btn-sm" data-testid="refresh-${tool}">⟳ 刷新</button>
        <span class="tool-card__sched">${sched.enabled ? '定时 ' + sched.interval_min + 'm' : ''}</span>
      </div>`;
    card.querySelector('[data-testid="refresh-' + tool + '"]').onclick = ev => {
      ev.stopPropagation(); refreshOne(tool, ev.currentTarget);
    };
    box.appendChild(card);
  }
}

/* ---------- rows ---------- */
function visibleSessions() {
  let list = state.sessions || [];
  if (state.filter !== 'all') list = list.filter(s => s.tool === state.filter);
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
    row.innerHTML = `
      <div><input type="checkbox" data-testid="row-check" ${state.selected.has(s.sid) ? 'checked' : ''}></div>
      <div class="row__title-wrap"><span class="row__title">${esc(s.title || '(无标题)')}</span>${lid ? '&nbsp;' + lid : ''}</div>
      <div class="row__msgs">${s.msg_count} msgs</div>
      <div class="row__meta">${fmtTime(s.updated_at)}<div class="src">${TOOL_NAMES[s.tool] || s.tool}</div></div>`;
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
const SCHED_SCOPES = [['all', '全部工具'], ['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['opencode', 'OpenCode']];
const INTERVALS = [5, 10, 15, 30, 60, 180];
function openSchedule() {
  const body = document.getElementById('sched-body');
  body.innerHTML = SCHED_SCOPES.map(([k, name]) => {
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
  for (const [k] of SCHED_SCOPES) {
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
    el.innerHTML = `<div class="led-item__time">${(l.ts || '').slice(11, 16)} · ${l.action}</div>
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
    el.innerHTML = `<div class="led-item__time">${(m.ts || '').slice(5, 16)} · <span style="color:var(--c-accent)">${m.lid}</span></div>
      <div class="led-item__act">${TOOL_NAMES[m.src_tool] || m.src_tool} → ${TOOL_NAMES[m.dst_tool] || m.dst_tool} · ${m.status === 'ok' ? '成功' : '失败'}</div>`;
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

/* ---------- init ---------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-all').onclick = e => refreshAll(e.currentTarget);
  document.getElementById('schedule-open').onclick = openSchedule;
  document.getElementById('sched-close').onclick = closeSchedule;
  document.getElementById('sched-save').onclick = e => saveSchedule(e.currentTarget);
  document.getElementById('sched-overlay').addEventListener('click', e => {
    if (e.target.id === 'sched-overlay') closeSchedule();
  });
  document.getElementById('search-input').oninput = () => renderRows();
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
  loadState().catch(e => renderLoadError(e.message));
  setInterval(() => loadState().catch(() => {}), 30000);
});
window.hubApp = { loadState, setFilter, openSession, migrateFlow: (t, ids) => migrateFlow(t, ids || [...state.selected]), get state() { return state; } };
