/* ====================================================================
   记忆视图（v1.0 · 对齐 Figma ModuleView）
   顶部：记忆来源卡片（各工具 + 「笔记 · 本地」）+ 批量「全部扫描」+ 统计条
   主体：来源侧栏 ｜ 条目列表（两行 + 胶囊 + 行内展开：编辑/复制/认领）｜ 写入去向面板
   口径：读取 → hub 中间体 → 写入；中间体是权威源，工具端改动标记漂移
   ==================================================================== */
(function () {
  'use strict';
  const M = {
    tools: [], items: [], memstore: '',
    selTool: null,          // 选中的来源 id（工具 id 或 'notes'）
    expandedId: null, detail: null,
    selected: new Set(),    // 勾选待写入的条目 id
    q: '', loadedAt: 0, firstScanDone: false,
  };
  const NOTES_ID = 'notes';
  const notesSource = () => ({ id: NOTES_ID, name: '笔记 · 本地', short: 'NB', cls: 'chip--accent',
    title: 'hub 本地笔记（hub.db + 每日 Markdown）' });
  const chipCls = (tid) => MV.cls(tid);
  const shortOf = (tid) => MV.short(tid);
  const nameOf = (tid) => {
    if (tid === NOTES_ID) return '笔记 · 本地';
    const t = M.tools.find(x => x.id === tid)
      || ((window.hubApp.state.tool_list) || []).find(x => x.id === tid) || {};
    return t.name || tid;
  };
  const kindLabel = (it) => it.kind_label || it.kind;
  const scopeLabel = (it) => it.scope === 'global' ? '全局' : trunc22(it.scope);
  const itemLabel = (it) => `${kindLabel(it)} · ${scopeLabel(it)}`;
  function trunc22(s) { s = String(s || ''); return s.length > 22 ? s.slice(0, 22) + '…' : s; }
  const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

  async function loadOverview(force) {
    if (!force && Date.now() - M.loadedAt < 30000 && M.tools.length) return;
    const r = await api('/api/memory/overview');
    if (r.data && r.data.ok) {
      M.tools = r.data.tools || [];
      M.items = r.data.items || [];
      M.memstore = r.data.memstore || '';
      M.loadedAt = Date.now();
    }
  }

  /* ---------- 扫描（自动优先，手动兜底） ---------- */
  async function scanAll(btn, root) {
    if (btn) btn.classList.add('is-loading');
    const toastEl = HubUI.toast('正在扫描各工具记忆…', 'info', 30000);
    try {
      const r = await post('/api/memory/scan', {});
      toastEl.remove();
      if (r.data.ok) {
        const rs = r.data.results || [];
        const imp = rs.reduce((a, x) => a + (x.imported || 0), 0);
        const drf = rs.reduce((a, x) => a + (x.drifted || 0), 0);
        const deg = rs.filter(x => x.degraded);
        HubUI.toast(`扫描完成：新增 ${imp} · 漂移 ${drf}`
          + (deg.length ? ` · ${deg.length} 个工具超时降级（点其 ⟳ 手动刷新）` : ''),
          deg.length ? 'warn' : 'success');
      } else HubUI.toast('扫描失败：' + (r.data.error || ''), 'error');
    } catch (e) { toastEl.remove(); }
    M.loadedAt = 0;
    await refresh(root);
  }
  async function scanOne(tid, btn, root) {
    btn.classList.add('is-loading');
    const r = await post('/api/memory/scan', { tool: tid });
    btn.classList.remove('is-loading');
    if (r.data.ok) {
      const x = (r.data.results || [])[0] || {};
      HubUI.toast(`${x.name || tid}：新增 ${x.imported || 0} · 漂移 ${x.drifted || 0}`
        + (x.degraded ? '（超时降级，数据可能不完整）' : ''), x.error ? 'error' : (x.drifted ? 'warn' : 'success'));
    } else HubUI.toast('扫描失败：' + (r.data.error || ''), 'error');
    M.loadedAt = 0;
    await refresh(root);
  }

  /* ---------- 渲染 ---------- */
  async function render(root) {
    await refresh(root);
  }

  async function refresh(root) {
    await loadOverview(false);
    if (!M.firstScanDone && M.tools.length && M.tools.every(t => !t.scanned)) {
      M.firstScanDone = true;
      root.innerHTML = '<div class="hub-empty">首次进入，正在自动扫描各工具记忆…</div>';
      await scanAll(null, root);
      await loadOverview(true);
    }
    renderAll(root);
  }

  function sources() {
    return [
      ...M.tools.map(t => ({
        id: t.id, name: t.name, short: shortOf(t.id), cls: chipCls(t.id),
        off: !t.readable,
        title: t.error || `${t.name} · ${t.readable ? '可读' : (t.has_layout ? '不可读（未找到记忆文件）' : '未探测到记忆路径')}`
          + (t.degraded ? ' · 上次扫描超时，点 ⟳ 手动刷新' : ''),
      })),
      notesSource(),
    ];
  }
  function counts() {
    const c = {};
    M.items.forEach(it => { c[it.source_tool] = (c[it.source_tool] || 0) + 1; });
    return c;
  }
  function visibleItems() {
    if (M.selTool === NOTES_ID) return [];
    let list = M.items;
    if (M.selTool) list = list.filter(it => it.source_tool === M.selTool);
    if (M.q) {
      const q = M.q.toLowerCase();
      list = list.filter(it => itemLabel(it).toLowerCase().includes(q)
        || String(it.source_path || '').toLowerCase().includes(q));
    }
    return list;
  }

  /** 条目行展开/收起：就地切类名 + 按需填入详情体（不重画整表） */
  function toggleItemRow(root, row) {
    const id = row.dataset.id;
    const openRow = root.querySelector('#mv-rows .mvi.is-open');
    const wasOpen = row.classList.contains('is-open');
    if (openRow && openRow !== row) {
      openRow.classList.remove('is-open');
      const b = openRow.querySelector('.mvi__accin'); if (b) b.innerHTML = '';
    }
    if (wasOpen) { row.classList.remove('is-open'); M.expandedId = null; return; }
    const it = M.items.find(x => x.id === id);
    const box = row.querySelector('.mvi__accin');
    if (box && it && !box.innerHTML.trim()) box.innerHTML = detailBody(it);
    row.classList.add('is-open');
    M.expandedId = id;
  }

  function renderAll(root) {
    const srcs = sources();
    const list = visibleItems();
    const deployed = M.items.filter(it => (it.deployments || []).length).length;
    const stats = [
      { n: M.items.length, label: '条目 · 全部来源' },
      { n: M.tools.length, label: '来源工具' },
      { n: deployed, label: '已写回' },
      { n: M.items.length - deployed, label: '未写回', tone: M.items.length - deployed ? 'warn' : '' },
    ];
    const top = MV.top({
      prefix: 'mv', label: '记忆来源', sources: srcs, counts: counts(), activeId: M.selTool,
      groups: [
        { kind: 'local', label: '本地', desc: 'hub 内可编辑（笔记 = hub.db + 每日 Markdown）', ids: [NOTES_ID], actions: [] },
        { kind: 'tool', label: '工具', desc: '读取各工具记忆文件 → hub 中间体，工具端改动标记漂移',
          ids: M.tools.map(t => t.id), actions: ['全部扫描'] },
      ],
      bulk: `<button class="hub-btn btn-sm" data-testid="memv-scan-all"><span class="btn-ic">${MV.ic('refresh')}</span>全部扫描</button>`,
      stats, hint: '读取 → hub 中间体 → 写入；中间体是权威源，工具端改动会标记漂移。项目级记忆只写回其来源工具。',
    });
    root.innerHTML = MV.shell({
      prefix: 'mv', top,
      title: M.selTool ? (M.selTool === NOTES_ID ? '笔记 · 本地' : `${nameOf(M.selTool)} · 记忆条目`) : '全部记忆条目',
      q: M.q, placeholder: '搜索条目 / 路径…',
    });

    MV.bindGroups(root);
    MV.swap(root, M.selTool || 'all');
    // 条目行：点行就地展开 / 收起（不整块重绘；保持滚动与搜索焦点）
    root.querySelectorAll('#mv-rows .mvi').forEach(row => {
      row.querySelector('.mvi__head').onclick = (e) => {
        if (e.target.closest('input, button.mvi__chev')) return;
        toggleItemRow(root, row);
      };
      const chev = row.querySelector('.mvi__chev');
      if (chev) chev.onclick = (e) => { e.stopPropagation(); toggleItemRow(root, row); };
    });

    // 来源切换（卡片 + 侧栏）
    root.querySelectorAll('.tcard[data-src], .sside__it[data-src]').forEach(el => {
      el.onclick = (e) => {
        if (e.target.closest('[data-testid="memv-scan-all"]')) return;
        pick(root, el.dataset.src);
      };
    });
    root.querySelector('[data-testid="memv-scan-all"]').onclick = e => scanAll(e.currentTarget, root);
    root.querySelectorAll('[data-gact]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); if (b.dataset.gact.split(':')[1] === '全部扫描') scanAll(b, root); };
    });

    // 侧栏（选中来源后出现）：返回全部 + 来源切换 + 单工具扫描
    const topBox = root.querySelector('#mv-top');
    if (topBox) topBox.hidden = !!M.selTool;
    const side = root.querySelector('#mv-side');
    const others = srcs.filter(s => s.id !== M.selTool);
    side.hidden = !M.selTool;
    if (M.selTool) {
      side.innerHTML = MV.side({ prefix: 'mv', items: others, activeId: M.selTool, counts: counts(),
        extra: `<div class="sside__acts">
          <button data-testid="memv-rescan-${esc(M.selTool)}" title="扫描此来源">⟳</button></div>` });
      side.querySelector('#mv-back').onclick = () => pick(root, null);
      side.querySelectorAll('.sside__it').forEach(b => { b.onclick = () => pick(root, b.dataset.src); });
      const rb = side.querySelector(`[data-testid="memv-rescan-${esc(M.selTool)}"]`);
      if (rb && M.selTool !== NOTES_ID) rb.onclick = e => scanOne(M.selTool, e.currentTarget, root);
      else if (rb) rb.style.display = 'none';
    }

    if (M.selTool === NOTES_ID) { renderNotes(root); return; }
    renderRows(root, list, stats);

    root.querySelector('#mv-q').oninput = (() => {
      let t = null;
      return (e) => {
        clearTimeout(t);
        t = setTimeout(() => { M.q = e.target.value.trim(); renderAll(root); }, 300);
      };
    })();
  }

  /* 中栏：条目（两行 + 胶囊 + 行内展开）+ 底部分页 */
  function renderRows(root, list, stats) {
    const box = root.querySelector('#mv-rows');
    box.setAttribute('data-testid', 'memv-list');
    box.innerHTML = list.length
      ? list.map(it => MV.item({
          id: it.id, testid: 'memv-row', chkTestid: 'memv-check',
          sel: M.selected.has(it.id), open: M.expandedId === it.id,
          chipText: shortOf(it.source_tool), chipCls: chipCls(it.source_tool),
          title: itemLabel(it),
          sub: `来源 ${nameOf(it.source_tool)} · ${(it.deployments || []).length
                ? '已写回 ' + (it.deployments || []).map(d => nameOf(d.tool)).join(', ') : '未写回'}`,
          meta: it.name || '',
          pillTone: it.status === 'drifted' ? 'warn' : 'ok',
          pillText: it.status === 'drifted' ? '源已改动' : '已同步',
          body: M.expandedId === it.id ? detailBody(it) : '',
        })).join('')
      : `<div class="hub-empty">没有记忆条目<div class="hub-empty__hint">点「全部扫描」采集各工具记忆</div></div>`;

    box.querySelectorAll('.mvi').forEach(row => {
      const id = Number(row.dataset.id);
      row.querySelector('.mvi__chk').onclick = e => {
        e.stopPropagation();
        e.target.checked ? M.selected.add(id) : M.selected.delete(id);
        row.classList.toggle('is-sel', e.target.checked);
        renderPanel(root, list);
      };
      row.querySelector('.mvi__chev').onclick = e => { e.stopPropagation(); toggle(root, id); };
      row.querySelector('.mvi__head').onclick = () => toggle(root, id);
    });
    bindDetail(root);
    root.querySelector('#mv-count').textContent = String(list.length);
    root.querySelector('#mv-info').textContent =
      `已选 ${M.selected.size} · 显示 ${list.length} 条 · 共 ${M.selTool ? list.length : M.items.length} 条`;
    root.querySelector('#mv-selall').onclick = () => { list.forEach(i => M.selected.add(i.id)); renderAll(root); };
    root.querySelector('#mv-selinv').onclick = () => {
      list.forEach(i => M.selected.has(i.id) ? M.selected.delete(i.id) : M.selected.add(i.id)); renderAll(root);
    };
    root.querySelector('#mv-selnone').onclick = () => { M.selected.clear(); renderAll(root); };
    renderPanel(root, list);
  }

  function toggle(root, id) {
    // 就地切换（旧实现是整块 renderAll，会连带重绘顶栏与列表）
    const row = root.querySelector(`#mv-rows .mvi[data-id="${CSS.escape(String(id))}"]`);
    if (row) return toggleItemRow(root, row);
    M.expandedId = M.expandedId === id ? null : id;
    renderAll(root);
  }

  function detailBody(it) {
    const d = M.detail;
    if (!d) return '<div class="srow__load">正在读取条目内容…</div>';
    const drift = d.source_changed
      ? `<div class="memv-drift-tip">源文件在扫描后被工具端改动过（hub 内容 vs 源内容已分叉）。
           <button class="hub-btn btn-sm" data-testid="memv-adopt">以此为准 · 重新采集源内容</button></div>`
      : '';
    return `${drift}
      <div class="mvi__bar">
        <span class="mono">v${d.version} · hash ${esc((d.hash || '').slice(0, 12))} · ${esc(fmtTime(d.updated_at))}</span>
        <span>· 来源 ${esc(nameOf(it.source_tool))} · ${esc(tilde(d.source_path))}</span>
        <span class="mvi__acts">
          <button class="hub-btn btn-sm" data-testid="memv-edit">编辑</button>
          <button class="hub-btn btn-sm" data-testid="memv-copy">复制</button>
        </span>
      </div>
      <pre class="mvi__pre" data-testid="memv-content">${esc(d.content || '')}</pre>
      <div class="memv-editor__acts" style="display:none">
        <textarea class="hub-input memv-editor" data-testid="memv-editor" rows="10">${esc(d.content || '')}</textarea>
        <button class="hub-btn hub-btn--primary" data-testid="memv-save">保存到中间体</button>
        <span class="mono-xs">保存后可从右栏写入工具；源文件不受影响</span>
      </div>`;
  }

  async function loadDetail(root, iid) {
    const r = await api('/api/memory/item/' + iid);
    if (!r.data || !r.data.ok) { HubUI.toast('条目详情加载失败', 'error'); return; }
    M.detail = r.data;
    renderAll(root);
  }

  function bindDetail(root) {
    const box = root.querySelector('#mv-rows');
    const edit = box.querySelector('[data-testid="memv-edit"]');
    if (edit) edit.onclick = (e) => {
      e.stopPropagation();
      const acts = box.querySelector('.memv-editor__acts');
      const pre = box.querySelector('[data-testid="memv-content"]');
      acts.style.display = '';
      pre.style.display = 'none';
      e.currentTarget.style.display = 'none';
    };
    const copy = box.querySelector('[data-testid="memv-copy"]');
    if (copy) copy.onclick = async (e) => {
      e.stopPropagation();
      const ok = await copyText(M.detail ? M.detail.content || '' : '');
      HubUI.toast(ok ? '已复制条目内容' : '复制失败', ok ? 'success' : 'warn');
    };
    const save = box.querySelector('[data-testid="memv-save"]');
    if (save) save.onclick = async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.classList.add('is-loading');
      const rr = await api('/api/memory/item/' + M.expandedId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: box.querySelector('[data-testid="memv-editor"]').value }),
      });
      btn.classList.remove('is-loading');
      if (rr.data.ok) {
        HubUI.toast('已保存到中间体', 'success');
        M.loadedAt = 0;
        await loadOverview(true);
        await loadDetail(root, M.expandedId);
      } else HubUI.toast('保存失败：' + (rr.data.error || ''), 'error');
    };
    const adopt = box.querySelector('[data-testid="memv-adopt"]');
    if (adopt) adopt.onclick = async (e) => {
      e.stopPropagation();
      const rr = await post('/api/memory/item/' + M.expandedId + '/adopt', {});
      if (rr.data.ok) {
        HubUI.toast('已认领源内容到中间体', 'success');
        M.loadedAt = 0;
        await loadOverview(true);
        await loadDetail(root, M.expandedId);
      } else HubUI.toast('认领失败：' + (rr.data.error || ''), 'error');
    };
  }

  /* 「笔记 · 本地」：保留原 hub 记忆视图（mv-* testid 都在它里面），外面加一条返回 */
  function renderNotes(root) {
    root.innerHTML = `
      <div class="mv-notehead">
        <span>笔记 · 本地 <span class="mono-xs">hub.db + ~/.agent/hub/memory/</span></span>
        <button class="hub-btn btn-sm" id="mv-back-notes">‹ 返回记忆分发</button>
      </div>
      <div class="mv-noteshost" id="mv-notes-host"></div>`;
    root.querySelector('#mv-back-notes').onclick = () => pick(root, null);
    renderMemoryView(root.querySelector('#mv-notes-host'));   // app.js 里的 legacy hub 记忆视图
  }

  /* 右栏：写入去向（多选目标 + 台账） */
  function renderPanel(root, list) {
    const panel = root.querySelector('#mv-panel');
    if (!panel) return;
    const n = M.selected.size;
    const show = n > 0 && M.selTool !== NOTES_ID;
    panel.classList.toggle('is-in', show);
    if (!show) return;
    const targets = M.tools.filter(t => t.writable);
    const chosen = new Set([...panel.querySelectorAll('.stgt.is-on')].map(x => x.dataset.target));
    panel.innerHTML = `
      <div class="spanel__in">
        <div class="spanel__h"><h3>写入去向</h3>
          <button class="spanel__x" id="mv-panel-close" title="收起">×</button></div>
        <div class="spanel__sel">已选 <b>${n}</b> 条 · 可多选目标</div>
        <ul class="spanel__targets" data-testid="memv-targets">${targets.length ? targets.map(t => `
          <li><button class="stgt ${chosen.has(t.id) ? 'is-on' : ''}" data-target="${esc(t.id)}"
                     data-testid="memv-target-${esc(t.id)}">
            <span class="stgt__dot ${toolColorCls(t)}"></span>
            <span class="stgt__nm">${esc(t.name)}</span>
            <span class="stgt__radio"></span>
          </button></li>`).join('') : '<li class="stgt__none">没有可写的工具</li>'}</ul>
        <div class="spanel__go">
          <button class="spanel__gobtn" id="mv-go" ${targets.length ? '' : 'disabled'}>
            写入 ${n} 条到 ${chosen.size || '…'} 个目标</button>
          <p class="nv-note" style="padding:var(--sp-2) 0 0">不可写的工具已隐藏；项目级记忆只写回其来源工具。</p>
        </div>
        <div class="spanel__lin">
          <h4>最近台账</h4>${MV.ledger(MV.recentLedger(['memory', 'item', 'distribute', 'adopt', 'scan'], 5))}
        </div>
      </div>`;
    panel.querySelectorAll('.stgt').forEach(b => {
      b.onclick = () => { b.classList.toggle('is-on'); renderPanel(root, list); };
    });
    panel.querySelector('#mv-panel-close').onclick = () => { M.selected.clear(); renderAll(root); };
    const go = panel.querySelector('#mv-go');
    if (go) go.onclick = () => {
      const tools = [...panel.querySelectorAll('.stgt.is-on')].map(x => x.dataset.target);
      if (!tools.length) { HubUI.toast('先在右侧选一个或多个写入目标', 'warn'); return; }
      distributeTo(tools, false, root);
    };
  }

  async function distributeTo(tools, force, root) {
    const ids = [...M.selected];
    if (!ids.length) { HubUI.toast('先勾选要写入的条目', 'warn'); return; }
    const r = await post('/api/memory/distribute', { item_ids: ids, tools, force: !!force });
    if (!r.data.ok) { HubUI.toast('写入失败：' + (r.data.error || ''), 'error'); return; }
    const rs = r.data.results || [];
    const ok = rs.filter(x => x.status === 'ok' || x.status === 'skipped');
    const conflicts = rs.filter(x => x.status === 'conflict');
    const failed = rs.filter(x => x.status === 'failed');
    if (ok.length) HubUI.toast(`已写入 ${ok.length} 条 → ${tools.map(t => nameOf(t)).join('、')}`, 'success');
    if (failed.length) HubUI.toast(`${failed.length} 条失败：${failed[0].reason || ''}`, 'error', 5600);
    if (conflicts.length) {
      HubUI.confirm('目标内容有冲突',
        `${conflicts.length} 条冲突：${esc(conflicts[0].reason || '')}。<br><br>`
        + '目标文件在 hub 之外被改动，覆盖前会自动备份原文件。确认以 hub 中间体为准覆盖？',
        () => distributeTo(tools, true, root),
        { confirmText: '覆盖（先备份）', cancelText: '保留目标不动' });
    }
    M.loadedAt = 0;
    await loadOverview(true);
    M.selected.clear();
    renderAll(root);
  }

  function pick(root, id) {
    M.selTool = (M.selTool === id) ? null : id;
    M.expandedId = null; M.detail = null;
    renderAll(root);
  }

  window.MemoryView = { render };
})();
