/* ====================================================================
   MCP 视图（v0.6 新布局，与 Skills 同构）
   左：来源（可折叠）+ 条目分页；中：config 详情 + CRUD（仅本地）+ 批量；
   右：工具写入目标与内联写入（无需弹窗）+ 握手验证。
   ==================================================================== */
(function () {
  'use strict';
  const S = {
    sources: [], targets: [], reg: {}, items: [], total: 0, page: 1, pages: 1, perPage: 20,
    targetsStat: [], selected: new Set(), srcFilter: null, q: '', expanded: false,
    mode: 'overview',
    toolSel: null, toolItems: [], toolChecked: new Set(),
  };
  const PAGE_SHOW = 7;

  const STATUS_LABEL = {
    'not-installed': ['未安装', 'neutral'],
    'installed': ['已安装', 'ok'],
    'update-available': ['可更新', 'warn'],
    'local-modified': ['本地修改', 'warn'],
  };
  const badge = (st) => {
    const [label, tone] = STATUS_LABEL[st] || [st, 'neutral'];
    return `<span class="hub-badge sb-status--${tone}">${label}</span>`;
  };
  const manualBadge = (m) => m ? '<span class="hub-badge hub-badge--manual">手动</span>' : '';
  const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

  // 源被移除/清理后的收尾：清掉指向该源的筛选并刷新（传给 HubUI 公共对话框）
  async function afterRemove(sid) {
    if (S.srcFilter === Number(sid)) { S.srcFilter = null; S.page = 1; }
    await refresh();
  }

  async function loadAll() {
    const [src, tgt] = await Promise.all([api('/api/mcp/sources'), api('/api/mcp/targets')]);
    S.sources = src.data.sources || [];
    S.targets = tgt.data.targets || [];
    await loadItems();
  }

  async function loadItems() {
    if (S.toolSel) return loadToolItems();
    const params = new URLSearchParams({ page: S.page, per_page: S.perPage });
    if (S.srcFilter === 'manual') params.set('source', 'manual');
    else if (typeof S.srcFilter === 'number') params.set('source', S.srcFilter);
    if (S.q) params.set('q', S.q);
    const [lv, rg] = await Promise.all([
      api('/api/mcp/items?' + params.toString()),
      api('/api/mcp/registry')]);
    const d = lv.data;
    S.items = d.items || [];
    S.total = d.total || 0; S.pages = d.pages || 1; S.page = d.page || 1;
    S.targetsStat = d.targets || [];
    S.reg = {};
    for (const r of (rg.data.items || [])) S.reg[r.name] = r;
  }

  /* ============================== 工具来源（反向提取） ============================== */
  const TOOL_STATE = {
    local_only: ['未收编', 'warn'],
    diff: ['有差异', 'err'],
    synced: ['一致', 'ok'],
  };
  const stateBadge = (st) => {
    const [label, tone] = TOOL_STATE[st] || [st, 'neutral'];
    return `<span class="hub-badge sb-status--${tone}">${label}</span>`;
  };

  async function loadToolItems() {
    // 工具来源清单：与本地库对齐三态；聚合视图（无 tool 参数）按条目去重
    const qs = S.toolSel && S.toolSel.id ? '?tool=' + encodeURIComponent(S.toolSel.id) : '';
    const r = await api('/api/mcp/tool-items' + qs);
    S.toolItems = r.data.items || [];
    S.toolChecked = new Set();
  }

  // 提取收编：以工具配置为准入库（diff 仅覆盖手动条目），完成后刷新工具视图
  async function extractSelected(names) {
    if (!S.toolSel || !names.length) return;
    const r = await post('/api/mcp/extract', { tool: S.toolSel.id, names });
    const items = r.data.items || [];
    const okN = items.filter(x => x.ok && !x.skipped).length;
    const skipN = items.filter(x => x.skipped).length;
    const fails = items.filter(x => !x.ok);
    HubUI.toast(`提取完成 · 收编 ${okN} · 跳过 ${skipN}${fails.length ? ' · 失败 ' + fails.length : ''}`,
      fails.length ? 'warn' : 'success', 5600);
    if (fails.length) HubUI.toast(fails.map(x => `${x.name}（${x.error || ''}）`).join('；'), 'error', 5600);
    await loadToolItems();
    const c = document.querySelector('#view-mcp .nv-center');
    if (c) renderCenter(c);
  }

  function selectedRows() { return S.items.filter(it => S.selected.has(it.name)); }

  /* ============================== 左栏 ============================== */
  function renderLeft(el) {
    const srcRows = [
      { key: 'all', name: '全部', count: '' },
      { key: 'manual', name: '本地 · 手动', count: '' },
      ...S.sources.map(s => ({
        key: String(s.id), name: s.name, count: s.item_count,
        dot: s.last_error ? 'var(--c-err)' : 'var(--c-accent)', sid: s.id,
      })),
    ];
    const shown = S.expanded ? srcRows : srcRows.slice(0, 5);
    el.innerHTML = `
      <div class="nv-h"><span>来源</span><button class="hub-btn btn-sm" data-testid="mcp-add-source">＋ 添加</button></div>
      <div class="nv-srcs" data-testid="mcp-sources">
        ${shown.map(sr => `
          <div class="nv-src-row ${sr.key === 'manual' && S.srcFilter === 'manual' || sr.key === 'all' && !S.srcFilter || sr.key !== 'all' && sr.key !== 'manual' && S.srcFilter === Number(sr.key) ? 'is-on' : ''}" data-src="${sr.key}">
            <span class="tool-dot ${sr.key === 'manual' ? 'tool-dot--local' : ''}" ${sr.dot ? `style="background:${sr.dot}"` : ''}></span>
            <span class="nv-sname">${esc(sr.name)}</span>
            <span class="nv-scount">${sr.count}</span>
            ${sr.sid ? `<span class="nv-acts"><button class="hub-btn btn-sm" data-testid="mcp-edit-${sr.sid}">编辑</button>
            <button class="hub-btn btn-sm" data-testid="mcp-pull-${sr.sid}">拉取</button>
            <button class="hub-btn btn-sm" data-testid="mcp-del-${sr.sid}">移除</button></span>` : ''}
          </div>`).join('')}
      </div>
      ${srcRows.length > 5 ? `<div class="nv-fold" data-testid="mcp-src-fold">${S.expanded ? '收起 ▴' : '显示全部 ' + srcRows.length + ' 个来源 ▾'}</div>` : ''}
      ${(() => {
        // 工具来源组：按 target 的 tool 去重，整行点击进入提取模式
        const seen = new Map();
        for (const t of (S.targets || [])) if (t.tool && t.tool !== 'plain' && !seen.has(t.tool)) seen.set(t.tool, t.tool_name || t.name || t.tool);
        if (!seen.size) return '';
        return `<div class="nv-h"><span>工具（提取来源）</span></div>
        <div class="nv-srcs" data-testid="mcp-tool-srcs">
          ${[...seen].map(([tid, tname]) => `
            <div class="nv-src-row ${S.toolSel && S.toolSel.id === tid ? 'is-on' : ''}" data-tool="${esc(tid)}" data-testid="mcp-tool-src">
              <span class="tool-dot tool-dot--local"></span>
              <span class="nv-sname">${esc(tname)}</span>
            </div>`).join('')}
        </div>`;
      })()}
      <div class="nv-h" style="margin-top:var(--sp-2)"><span>条目</span><span class="nv-cnt" data-testid="mcp-total">${S.total}</span></div>
      <div class="nv-filter"><input class="hub-input" data-testid="mcp-search" placeholder="搜索条目…" value="${esc(S.q)}"></div>
      <div class="nv-list" data-testid="mcp-list">
        ${S.items.map(it => MV.item({
          id: it.name, testid: 'mcp-row', chkTestid: 'mcp-check',
          sel: S.selected.has(it.name),
          chipText: MV.short(it.name), chipCls: 'chip--accent',
          title: it.name,
          sub: it.command || it.url || '',
          pillTone: 'muted', pillText: it.transport,
          meta: (it.env_keys && it.env_keys.length) ? it.env_keys.length + ' env'
                : (it.manual ? '' : String(it.source_name || '')),
          extra: it.manual
            ? '<button class="nv-qdel" data-testid="mcp-quick-del" title="删除此条目（悬停显示）">删</button>' : '',
        })).join('') || '<div class="hub-empty">没有条目<div class="hub-empty__hint">拉取源仓库或手动创建</div></div>'}
      </div>
      <div class="nv-pager" data-testid="mcp-pager">
        <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? 'disabled' : ''}>‹</button>
        ${pageButtons()}
        <button class="nv-pbtn" data-p="next" ${S.page >= S.pages ? 'disabled' : ''}>›</button>
        <button class="nv-pbtn" data-sel="all" data-testid="mcp-sel-all" title="全选本页">全选</button>
        <button class="nv-pbtn" data-sel="invert" data-testid="mcp-sel-invert" title="反选本页">反选</button>
        <button class="nv-pbtn" data-sel="none" data-testid="mcp-sel-none" title="清空选择" ${S.selected.size ? '' : 'disabled'}>清空</button>
        <span class="nv-pinfo">${S.selected.size ? `已选 ${S.selected.size} · ` : ''}每页 ${S.perPage} · 共 ${S.total} 条</span>
      </div>`;
    el.querySelector('[data-testid="mcp-add-source"]').onclick = addSourceDialog;
    el.querySelectorAll('.nv-src-row').forEach(row => {
      row.onclick = async (e) => {
        if (e.target.closest('button')) return;
        const k = row.dataset.src;
        S.toolSel = null;
        S.srcFilter = k === 'all' ? null : (k === 'manual' ? 'manual' : Number(k));
        S.page = 1; S._detailName = null; S.mode = 'overview';
        await refresh();
      };
    });
    // 工具来源行：点击进入该工具的提取模式（再点一次退出）
    el.querySelectorAll('[data-tool]').forEach(row => {
      row.onclick = async () => {
        const tid = row.dataset.tool;
        const name = (row.querySelector('.nv-sname') || {}).textContent || tid;
        if (S.toolSel && S.toolSel.id === tid) S.toolSel = null;
        else S.toolSel = { id: tid, name };
        S.srcFilter = null; S._detailName = null; S.mode = 'overview';
        await refresh();
      };
    });
    const fold = el.querySelector('[data-testid="mcp-src-fold"]');
    if (fold) fold.onclick = async () => { S.expanded = !S.expanded; await refresh({ parts: ['rows'] }); };
    el.querySelectorAll('[data-testid^="mcp-pull-"]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.testid.replace('mcp-pull-', '');
        btn.classList.add('is-loading');
        const r = await post('/api/mcp/sources/' + sid + '/pull');
        btn.classList.remove('is-loading');
        if (r.data.ok) {
          if (r.data.needs_action) { HubUI.sourceRemovedDialog('mcp', sid, r.data, { afterRemove }); return; }
          HubUI.toast(`拉取完成 · 新增 ${r.data.added.length} / 变更 ${r.data.changed.length}`,
            r.data.added.length + r.data.changed.length ? 'success' : 'info');
        }
        else HubUI.toast('拉取失败：' + (r.data.error || ''), 'error', 5200);
        await refresh();
      };
    });
    el.querySelectorAll('[data-testid^="mcp-edit-"]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        editSourceDialog(Number(btn.dataset.testid.replace('mcp-edit-', '')));
      };
    });
    el.querySelectorAll('[data-testid^="mcp-del-"]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const sid = btn.dataset.testid.replace('mcp-del-', '');
        const src = S.sources.find(s => String(s.id) === sid);
        const name = src ? src.name : sid;
        const rc = src ? (src.registry_count || 0) : 0;
        if (rc > 0) {
          HubUI.sourceRemovedForDelete('mcp', sid, name, rc, { afterRemove });
          return;
        }
        HubUI.confirm('移除源', `确认移除 MCP 源「${esc(name)}」？该源没有已拉取到本地库的条目。`, async () => {
          const r = await api('/api/mcp/sources/' + sid, { method: 'DELETE' });
          if (r.data.ok) {
            HubUI.toast('已移除源', 'success');
            if (S.srcFilter === Number(sid)) { S.srcFilter = null; S.page = 1; }
            await refresh();
          } else HubUI.toast('移除失败：' + (r.data.error || ''), 'error');
        }, { confirmText: '移除', danger: true });
      };
    });
    const search = el.querySelector('[data-testid="mcp-search"]');
    let deb;
    search.oninput = () => {
      clearTimeout(deb);
      deb = setTimeout(async () => { S.q = search.value.trim(); S.page = 1; await refresh({ parts: ['rows'] }); }, 350);
    };
    el.querySelectorAll('[data-testid="mcp-row"]').forEach(row => {
      row.querySelector('input').onclick = (e) => {
        e.stopPropagation();
        const nm = row.dataset.id;
        e.target.checked ? S.selected.add(nm) : S.selected.delete(nm);
        S.mode = S.selected.size ? 'multi' : 'overview';
        renderCenter(document.querySelector('#view-mcp .nv-center'));
        renderRight(document.querySelector('#view-mcp .nv-right'));
      };
      // 悬停快捷删除（仅手动条目显示）：不进详情直接走删除确认
      const qdel = row.querySelector('[data-testid="mcp-quick-del"]');
      if (qdel) qdel.onclick = (e) => { e.stopPropagation(); deleteFlow(row.dataset.id); };
      row.onclick = async (e) => {
        if (e.target.type === 'checkbox' || e.target.closest('.mvi__body, .nv-qdel')) return;
        await toggleAcc(row.dataset.id);
      };
    });
    el.querySelectorAll('.nv-pbtn[data-p]').forEach(b => {
      b.onclick = async () => {
        if (b.disabled) return;
        S.page = b.dataset.p === 'prev' ? S.page - 1 : b.dataset.p === 'next' ? S.page + 1 : Number(b.textContent);
        await refresh({ parts: ['rows'] });
      };
    });
    el.querySelectorAll('.nv-pbtn[data-sel]').forEach(b => {
      b.onclick = async () => {
        const names = S.items.map(x => x.name);
        if (b.dataset.sel === 'all') names.forEach(n => S.selected.add(n));
        else if (b.dataset.sel === 'invert') names.forEach(n => S.selected.has(n) ? S.selected.delete(n) : S.selected.add(n));
        else S.selected.clear();
        S.mode = S.selected.size ? 'multi' : 'overview';
        S._detailName = null;
        renderLeft(el);
        renderCenter(document.querySelector('#view-mcp .nv-center'));
        renderRight(document.querySelector('#view-mcp .nv-right'));
      };
    });
  }

  function pageButtons() {
    const nums = [];
    const start = Math.max(1, Math.min(S.page - 3, S.pages - PAGE_SHOW + 1));
    const end = Math.min(S.pages, start + PAGE_SHOW - 1);
    for (let i = start; i <= end; i++) nums.push(i);
    // 页码按钮必须带 data-p，否则 .nv-pbtn[data-p] 绑定选不中、点击无效
    return nums.map(i => `<button class="nv-pbtn ${i === S.page ? 'is-on' : ''}" data-p="${i}">${i}</button>`).join('');
  }

  function addSourceDialog() {
    HubUI.modal({
      title: '添加 MCP 源仓库', confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="msrc-name" placeholder="team-mcp"></label>
          <label>Git URL<input class="hub-input" id="msrc-url" placeholder="https://..."></label>
          <label>分支<input class="hub-input" id="msrc-branch" value="main"></label>
          <label>子目录（可选）<input class="hub-input" id="msrc-subdir" placeholder=""></label>
          <label>凭据引用（可选）<input class="hub-input" id="msrc-auth" placeholder="env:GITHUB_TOKEN"></label>
          <label>定时拉取（分钟，0=关闭）<input class="hub-input" id="msrc-poll" value="0" inputmode="numeric"></label>
        </div>`,
      onConfirm: async () => {
        const r = await post('/api/mcp/sources', {
          name: document.getElementById('msrc-name').value.trim(),
          url: document.getElementById('msrc-url').value.trim(),
          branch: document.getElementById('msrc-branch').value.trim() || 'main',
          subdir: document.getElementById('msrc-subdir').value.trim(),
          auth_ref: document.getElementById('msrc-auth').value.trim() || null,
          poll_min: Math.max(0, parseInt(document.getElementById('msrc-poll').value, 10) || 0),
        });
        if (r.data.ok) { HubUI.toast('已添加 MCP 源', 'success'); await refresh(); }
        else { HubUI.toast('添加失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  /* ============================== 中栏 ============================== */
  function renderCenter(el) {
    if (S.toolSel) return renderToolCenter(el);
    if (S.mode === 'detail' && S._detailName) renderDetail(el);
    else if (S.mode === 'multi') renderMulti(el);
    else renderOverview(el);
  }

  function renderOverview(el) {
    const staleAll = S.targetsStat.reduce((a, t) => a + t.items.stale, 0);
    const missingAll = S.targetsStat.reduce((a, t) => a + t.items.missing, 0);
    const recent = S.ledger || [];
    el.innerHTML = `
      <div class="nv-stats" data-testid="mcp-stats">
        <div class="nv-stat"><b>${S.total}</b><span>条目${S.srcFilter ? ' · 当前来源' : ' · 全部来源'}</span></div>
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => r.manual).length}</b><span>本地 · 手动</span></div>
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => !r.manual).length}</b><span>远程拉取</span></div>
        <div class="nv-stat"><b>${S.targetsStat.reduce((a, t) => a + t.items.total, 0)}</b><span>已写入工具</span></div>
        <div class="nv-stat"><b style="color:var(--c-warn)">${staleAll + missingAll}</b><span>待重写 / 未写入</span></div>
      </div>
      <div class="nv-sec nv-hide"><span>创建本地条目</span><button class="hub-btn btn-sm" data-testid="mcp-verify-selected">验证所选连接</button></div>
      <div class="nv-mkrow nv-hide"><span class="nv-mt">＋ 手动创建条目</span><span class="nv-msub">填命令或 URL，入本地库，可写入各工具配置</span><button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-create">新建</button></div>
`;

    el.querySelector('[data-testid="mcp-create"]').onclick = createDialog;
    el.querySelector('[data-testid="mcp-verify-selected"]').onclick = verifySelected;
    el.querySelectorAll('[data-tid]').forEach(btn => {
      btn.onclick = () => {
        const tid = Number(btn.dataset.tid);
        const t = S.targetsStat.find(x => x.id === tid);
        const names = btn.dataset.kind === 'stale' ? (t.stale_names || []) : null;
        inlineWrite(names, tid, btn.dataset.kind === 'missing');
      };
    });
  }

  function renderDetail(el) {
    const it = S.items.find(x => x.name === S._detailName);
    if (!it) { S.mode = 'overview'; renderOverview(el); return; }
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">${esc(it.name)} ${manualBadge(it.manual)} <span class="hub-badge hub-badge--neutral">${esc(it.transport)}</span> ${badge(it.status)}</div>
        <div class="nv-ddesc">${esc(it.target || '')} · 来源：${esc(it.source_name)}${it.env_keys.length ? ' · env ' + it.env_keys.length + ' 项（掩码显示）' : ''}</div>
        <div class="nv-dops" data-testid="mcp-detail-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-create">＋ 新建</button>
          ${it.manual ? '<button class="hub-btn btn-sm" data-testid="mcp-edit">编辑</button>' : '<button class="hub-btn btn-sm" data-testid="mcp-update-local">更新到本地</button>'}
          <button class="hub-btn btn-sm" data-testid="mcp-verify-one">验证连接</button>
          ${it.manual ? '<span class="nv-sep"></span><button class="hub-btn btn-sm hub-btn--danger" data-testid="mcp-delete">删除</button>' : ''}
        </div>
      </div>
      <div id="nv-mcp-body">${window.skeletonRows ? skeletonRows(2) : '<div class="nv-note">加载中…</div>'}</div>`;
    bindDetailOps(el, it);
    loadDetailBody(it);
  }

  async function loadDetailBody(it) {
    const body = document.getElementById('nv-mcp-body');
    if (!body) return;
    const d = (await api('/api/mcp/item/' + encodeURIComponent(it.name))).data || {};
    if (!document.getElementById('nv-mcp-body')) return;
    const cfg = d.config || {};
    const envRows = Object.entries(d.env_masked || {}).map(([k, v]) =>
      `<div class="nv-frow"><span class="mono-xs">${esc(k)}</span><span class="nv-fmeta">${esc(v)}</span></div>`).join('');
    body.innerHTML = `
      <div class="nv-sec"><span>config · registry/mcp/${esc(it.name)}.json</span></div>
      <pre class="sb-md" data-testid="mcp-config">${esc(JSON.stringify(cfg, null, 2))}</pre>
      ${envRows ? `<div class="nv-sec"><span>环境变量（掩码，原文不展示）</span></div>${envRows}` : ''}`;
  }

  function bindDetailOps(el, it) {
    el.querySelector('[data-testid="mcp-create"]').onclick = createDialog;
    const edit = el.querySelector('[data-testid="mcp-edit"]');
    if (edit) edit.onclick = () => editDialog(it.name);
    const del = el.querySelector('[data-testid="mcp-delete"]');
    if (del) del.onclick = () => deleteFlow(it.name);
    const updLocal = el.querySelector('[data-testid="mcp-update-local"]');
    if (updLocal) updLocal.onclick = async () => {
      updLocal.classList.add('is-loading');
      const r = await post('/api/mcp/registry/update', { names: [it.name] });
      updLocal.classList.remove('is-loading');
      notifyResults('更新到本地', r.data);
      await refresh();
    };
    el.querySelector('[data-testid="mcp-verify-one"]').onclick = () => verifyNames([it.name]);
  }

  function renderMulti(el) {
    const rows = selectedRows();
    const localSel = rows.filter(r => r.manual);
    const remoteSel = rows.filter(r => !r.manual);
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">已选 ${rows.length} 条 <span class="hub-badge hub-badge--neutral">本地 ${localSel.length} · 远程 ${remoteSel.length}</span></div>
        <div class="nv-ddesc">批量操作只作用于可操作的条目：删除仅限本地条目；远程条目的更新走「更新到本地」。</div>
        <div class="nv-dops" data-testid="mcp-batch-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-batch-write">批量写入全部目标（右栏）</button>
          <button class="hub-btn btn-sm" data-testid="mcp-batch-verify">批量验证连接（${rows.length}）</button>
          ${remoteSel.length ? '<button class="hub-btn btn-sm" data-testid="mcp-batch-pull-local">更新远程条目到本地（' + remoteSel.length + '）</button>' : ''}
          ${localSel.length ? '<span class="nv-sep"></span><button class="hub-btn btn-sm hub-btn--danger" data-testid="mcp-batch-delete">批量删除本地（' + localSel.length + '）</button>' : ''}
        </div>
      </div>
      <div class="nv-sec"><span>已选清单</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">${rows.length} 条</span></div>
      ${rows.map(r => `
        <div class="nv-deprow">
          <span class="nv-dt">${esc(r.name)}</span>
          <span class="nv-dv">${esc(r.source_name)} · ${esc(r.transport)}</span>
          <span class="hub-badge sb-status--${(S.reg[r.name] ? (S.reg[r.name].deployments || []).length : 0) ? 'ok' : 'neutral'}">${(S.reg[r.name] ? (S.reg[r.name].deployments || []).length : 0) ? '已写入 ' + (S.reg[r.name].deployments || []).length + ' 处' : '未写入'}</span>
          <span><button class="hub-btn btn-sm" data-un="${esc(r.name)}">取消选择</button></span>
        </div>`).join('')}`;
    el.querySelectorAll('[data-un]').forEach(b => {
      b.onclick = () => { S.selected.delete(b.dataset.un); renderCenter(el); renderRight(document.querySelector('#view-mcp .nv-right')); };
    });
    el.querySelector('[data-testid="mcp-batch-write"]').onclick = async () => {
      const tids = S.targetsStat.map(t => t.id);
      if (!tids.length) { HubUI.toast('没有目标，请先添加', 'warn'); return; }
      const r = await post('/api/mcp/distribute', { names: [...S.selected], target_ids: tids });
      notifyResults('批量写入', r.data);
      await refresh();
    };
    el.querySelector('[data-testid="mcp-batch-verify"]').onclick = () => verifyNames([...S.selected]);
    const pl = el.querySelector('[data-testid="mcp-batch-pull-local"]');
    if (pl) pl.onclick = async () => {
      pl.classList.add('is-loading');
      const r = await post('/api/mcp/registry/update', { names: remoteSel.map(x => x.name) });
      pl.classList.remove('is-loading');
      notifyResults('更新到本地', r.data);
      await refresh();
    };
    const bd = el.querySelector('[data-testid="mcp-batch-delete"]');
    if (bd) bd.onclick = () => {
      HubUI.confirm('批量删除本地条目', `将删除 ${localSel.length} 个本地条目；已写入工具配置的会连同写入内容一起移除。`, async () => {
        let okN = 0;
        for (const nm of localSel.map(x => x.name)) {
          const r = await api('/api/mcp/registry/item/' + encodeURIComponent(nm) + '?force=1', { method: 'DELETE' });
          if (r.data.ok) okN++;
        }
        HubUI.toast(`批量删除完成 · 成功 ${okN} / ${localSel.length}`, okN === localSel.length ? 'success' : 'warn', 5200);
        S.selected.clear(); S.mode = 'overview';
        await refresh();
      }, { confirmText: '确认删除', danger: true });
    };
  }

  function editSourceDialog(sid) {
    const src = S.sources.find(s => s.id === sid);
    if (!src) return;
    HubUI.modal({
      title: '编辑源 · ' + src.name, hasInput: false, confirmText: '保存', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="me-name" data-testid="mcp-edit-name" value="${esc(src.name)}"></label>
          <label>Git URL<input class="hub-input" id="me-url" data-testid="mcp-edit-url" value="${esc(src.url)}"></label>
          <label>分支<input class="hub-input" id="me-branch" value="${esc(src.branch || 'main')}"></label>
          <label>子目录（可选）<input class="hub-input" id="me-subdir" value="${esc(src.subdir || '')}"></label>
          <label>凭据引用（可选）<input class="hub-input" id="me-auth" value="${esc(src.auth_ref || '')}" placeholder="env:GITHUB_TOKEN"></label>
          <label>定时拉取（分钟，0=关闭）<input class="hub-input" id="me-poll" value="${src.poll_min || 0}" inputmode="numeric"></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">保存后立即生效；改 URL / 分支后建议点一次「拉取」同步内容。</div>`,
      onConfirm: async () => {
        const r = await api('/api/mcp/sources/' + sid, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('me-name').value.trim(),
            url: document.getElementById('me-url').value.trim(),
            branch: document.getElementById('me-branch').value.trim() || 'main',
            subdir: document.getElementById('me-subdir').value.trim(),
            auth_ref: document.getElementById('me-auth').value.trim() || null,
            poll_min: Math.max(0, parseInt(document.getElementById('me-poll').value, 10) || 0),
          }),
        });
        if (r.data.ok) { HubUI.toast('已保存源', 'success'); await refresh(); }
        else { HubUI.toast('保存失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  function addTargetDialog() {
    HubUI.modal({
      title: '添加 MCP 写入目标', confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="mtgt-name" placeholder="my-project mcp"></label>
          <label>格式<select class="hub-input" id="mtgt-kind">
            <option value="mcp_json">JSON（mcpServers 键合并）</option>
            <option value="mcp_toml">TOML（Codex 托管块）</option>
          </select></label>
          <label>配置文件路径<input class="hub-input" id="mtgt-path" placeholder="/path/to/mcp.json 或 config.toml"></label>
          <label>JSON 键名（mcp_json 时填，默认 mcpServers）<input class="hub-input" id="mtgt-fmt" placeholder="mcpServers"></label>
        </div>`,
      onConfirm: async () => {
        const kind = document.getElementById('mtgt-kind').value;
        const r = await post('/api/mcp/targets', {
          name: document.getElementById('mtgt-name').value.trim(),
          kind,
          tool: 'plain',
          path: document.getElementById('mtgt-path').value.trim(),
          format_key: kind === 'mcp_json' ? (document.getElementById('mtgt-fmt').value.trim() || 'mcpServers') : null,
        });
        if (r.data.ok) { HubUI.toast('已添加目标', 'success'); await refresh(); }
        else { HubUI.toast('添加失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  /* ============================== 右栏 ============================== */
  /* ============================== 工具来源视图（中/右栏） ============================== */
  function renderToolCenter(el) {
    const items = S.toolItems;
    const extractable = items.filter(i => i.state !== 'synced');
    const checked = items.filter(i => S.toolChecked.has(i.name));
    const cnt = (st) => items.filter(i => i.state === st).length;
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">工具来源 · ${esc(S.toolSel.name)} <span class="hub-badge hub-badge--neutral">${items.length} 条</span></div>
        <div class="nv-ddesc">该工具 MCP 配置中实际存在的 server，与本地库对齐。未收编 / 有差异可提取入库；工具配置保留不动。</div>
        <div class="nv-dops" data-testid="mcp-tool-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-tool-extract" ${checked.length ? '' : 'disabled'}>提取所选（${checked.length}）</button>
          <button class="hub-btn btn-sm" data-testid="mcp-tool-extract-all" ${extractable.length ? '' : 'disabled'}>提取全部可收编（${extractable.length}）</button>
        </div>
      </div>
      <div class="nv-sec"><span>条目</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">未收编 ${cnt('local_only')} · 有差异 ${cnt('diff')} · 一致 ${cnt('synced')}</span></div>
      ${items.map(it => `
        <div class="nv-deprow" data-name="${esc(it.name)}" data-testid="mcp-tool-row">
          <input type="checkbox" data-testid="mcp-tool-check" ${S.toolChecked.has(it.name) ? 'checked' : ''} ${it.state === 'synced' ? 'disabled' : ''}>
          <span class="nv-dt">${esc(it.name)}</span>
          ${stateBadge(it.state)}
          <span class="nv-dv">${esc(it.tools.map(t => t.name).join(' · '))}</span>
        </div>`).join('') || '<div class="nv-note">该工具 MCP 配置为空、不存在或格式未知</div>'}`;
    el.querySelectorAll('[data-testid="mcp-tool-check"]').forEach(cb => {
      cb.onchange = () => {
        const name = cb.closest('[data-name]').dataset.name;
        cb.checked ? S.toolChecked.add(name) : S.toolChecked.delete(name);
        renderToolCenter(el);
      };
    });
    el.querySelector('[data-testid="mcp-tool-extract"]').onclick = () => extractSelected(checked.map(i => i.name));
    el.querySelector('[data-testid="mcp-tool-extract-all"]').onclick = () => extractSelected(extractable.map(i => i.name));
  }

  function renderToolRight(el) {
    el.innerHTML = `
      <div class="nv-h"><span>提取说明</span></div>
      <div class="nv-note">提取 = 把工具 MCP 配置中的 server 收编进本地库（与源拉取条目同权），之后可在常规视图右栏分发给其他工具。</div>
      <div class="nv-sec"><span>状态含义</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--warn">未收编</span><span class="nv-msub">本地库没有 → 提取后入库</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--err">有差异</span><span class="nv-msub">同名不同内容 → 仅手动条目可覆盖（远程源条目走源更新）</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--ok">一致</span><span class="nv-msub">与本地库内容相同，无需处理</span></div>`;
  }

  function renderRight(el) {
    if (S.toolSel) return renderToolRight(el);
    const rows = S.mode === 'detail' && S._detailName ? S.items.filter(x => x.name === S._detailName)
      : S.mode === 'multi' ? selectedRows() : [];
    const title = S.mode === 'detail' ? S._detailName : S.mode === 'multi' ? `已选 ${rows.length} 条汇总` : '全部条目';
    const staleAll = S.targetsStat.reduce((a, t) => a + t.items.stale, 0);
    const missingAll = S.targetsStat.reduce((a, t) => a + t.items.missing, 0);
    el.innerHTML = `
      <div class="nv-h"><span>工具 · ${esc(title)}</span><button class="hub-btn btn-sm" data-testid="mcp-add-target">＋ 添加</button></div>
      <div class="nv-uops">
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-inline-rewrite" ${staleAll ? '' : 'disabled'}>一键重写过期（${staleAll}）</button>
        <button class="hub-btn btn-sm" data-testid="mcp-inline-write-missing" ${missingAll ? '' : 'disabled'}>写入缺失（${missingAll}）</button>
        <button class="hub-btn btn-sm" data-testid="mcp-inline-all" ${S.targetsStat.length ? '' : 'disabled'}>全部写入</button>
      </div>
      ${S.targetsStat.map(t => {
        const scope = rows.length ? rows : null;
        let latest = 0, stale = 0, missing = 0; const staleNames = [], missingNames = [];
        for (const it of (scope || allItemsCache() || [])) {
          const pt = (it.per_target || []).find(p => p.target_id === t.id);
          if (!pt) continue;
          if (pt.state === 'latest') latest++;
          else if (pt.state === 'stale') { stale++; staleNames.push(it.name); }
          else { missing++; missingNames.push(it.name); }
        }
        const n = scope ? rows.length : t.items.total;
        const tone = stale ? 'warn' : missing ? 'neutral' : 'ok';
        const label = stale ? `${stale}/${n} 需重写` : missing ? `${missing}/${n} 未写入` : n ? `${latest}/${n} 一致` : '暂无条目';
        return `
        <div class="nv-trow" data-testid="mcp-target-row">
          <div class="nv-th"><span class="nv-tname">${esc(t.tool_name || t.name)}</span><span class="hub-badge hub-badge--neutral">${t.kind === 'mcp_toml' ? 'TOML' : 'JSON'}</span><span class="hub-badge sb-status--${tone}">${label}</span></div>
          <div class="nv-tpath">${esc(tilde(t.path))}</div>
          ${(staleNames.length || missingNames.length) ? `
          <div class="nv-tstat"><span class="nv-tver">${esc([...staleNames, ...missingNames].slice(0, 3).join(' · '))}${staleNames.length + missingNames.length > 3 ? ' …' : ''}</span></div>` : ''}
          <div class="nv-tstat">
            <span class="nv-tver">${stale ? '写入前自动备份目标配置' : missing ? '首次写入将创建配置' : scope ? '全部一致' : (t.items.missing ? '' : '全部一致')}</span>
            <span style="flex:1"></span>
            ${stale ? `<button class="hub-btn btn-sm hub-btn--primary" data-tid="${t.id}" data-act="stale" data-testid="mcp-tgt-rewrite">重写（${stale}）</button>` : ''}
            ${missing ? `<button class="hub-btn btn-sm" data-tid="${t.id}" data-act="missing" data-testid="mcp-tgt-write">写入（${missing}）</button>` : ''}
            ${!stale && !missing && n ? '<button class="hub-btn btn-sm" disabled>已一致</button>' : ''}
          </div>
        </div>`;
      }).join('') || '<div class="hub-empty">没有 MCP 目标<div class="hub-empty__hint">点「＋ 添加」接入</div></div>'}`;
    el.querySelector('[data-testid="mcp-add-target"]').onclick = addTargetDialog;
    el.querySelector('[data-testid="mcp-inline-rewrite"]').onclick = () => {
      for (const t of S.targetsStat) if (t.items.stale) inlineWrite(t.stale_names || [], t.id, false);
    };
    el.querySelector('[data-testid="mcp-inline-write-missing"]').onclick = () => {
      for (const t of S.targetsStat) if (t.items.missing) inlineWrite(null, t.id, true);
    };
    el.querySelector('[data-testid="mcp-inline-all"]').onclick = writeAll;
    el.querySelectorAll('[data-tid]').forEach(btn => {
      btn.onclick = () => {
        const tid = Number(btn.dataset.tid);
        const t = S.targetsStat.find(x => x.id === tid);
        if (btn.dataset.act === 'stale') inlineWrite(t.stale_names || [], tid, false);
        else inlineWrite(null, tid, true);
      };
    });
  }

  let _allCache = null;
  async function primeAllCache() {
    const r = await api('/api/mcp/items?per_page=100');
    _allCache = (r.data.items || []);
  }
  function allItemsCache() { return _allCache; }

  async function inlineWrite(names, tid, missing) {
    let list = names;
    if (missing) {
      await primeAllCache();
      list = (_allCache || []).filter(it => (it.per_target || []).some(p => p.target_id === tid && p.state === 'missing')).map(x => x.name);
    }
    if (!list || !list.length) { HubUI.toast('没有需要写入的条目', 'info'); return; }
    const target = S.targetsStat.find(t => t.id === tid);
    const r = await post('/api/mcp/distribute', { names: list, target_ids: [tid] });
    notifyResults(`写入 ${target ? target.name : tid}`, r.data);
    await refresh();
  }

  async function writeAll() {
    const tids = S.targetsStat.map(t => t.id);
    if (!tids.length) { HubUI.toast('没有目标', 'warn'); return; }
    await primeAllCache();
    const names = [...new Set((_allCache || []).map(x => x.name))];
    if (!names.length) { HubUI.toast('没有条目可写入', 'info'); return; }
    const r = await post('/api/mcp/distribute', { names, target_ids: tids });
    notifyResults('全部写入', r.data);
    await refresh();
  }

  async function verifyNames(names) {
    if (!names.length) { HubUI.toast('先勾选要验证的条目', 'warn'); return; }
    for (const name of names) {
      const t = HubUI.toast(`验证中：${name}…`, 'info', 30000);
      const r = await post('/api/mcp/verify', { name });
      t.remove();
      const d = r.data || {};
      if (d.ok) {
        HubUI.toast(`✓ ${name} · ${d.server_name || '?'} ${d.server_version || ''} · ${d.tool_count != null ? d.tool_count + ' 个工具' : '已连接'} · ${d.latency_ms}ms`, 'success', 5600);
      } else {
        HubUI.toast(`✕ ${name} 连接失败：${(d.error || '').slice(0, 80)}`, 'error', 5600);
      }
    }
  }

  async function verifySelected() { await verifyNames([...S.selected]); }

  function notifyResults(label, data) {
    if (!data || !data.ok) { HubUI.toast((label || '操作') + '失败：' + ((data && data.error) || ''), 'error', 5200); return; }
    const res = data.results || [];
    const ok = res.filter(x => x.status === 'ok').length;
    const skipped = res.filter(x => x.status === 'skipped').length;
    const conflict = res.filter(x => x.status === 'conflict').length;
    const failed = res.filter(x => x.status === 'failed').length;
    const tone = failed || conflict ? 'warn' : 'success';
    HubUI.toast(`${label} · 成功 ${ok} · 跳过 ${skipped}${conflict ? ' · 冲突 ' + conflict : ''}${failed ? ' · 失败 ' + failed : ''}`, tone, 5200);
    for (const x of res) {
      if (x.status === 'conflict' || x.status === 'failed') {
        HubUI.toast(`${x.item} → ${x.target}：${x.reason || x.status}`, 'warn', 5600);
      }
    }
  }

  /* ============================== CRUD 对话框 ============================== */
  // 解析粘贴的 MCP JSON → [{name, cfg}]。支持三种形态：
  // ① 官网包裹式 {"mcpServers":{"<名>":{...}}}（可多条）② 单条 {"<名>":{command/url...}}
  // ③ 裸配置 {command/url,...}（名字取「名称」栏）
  function parseMcpJsonInput(text, fallbackName) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { error: 'JSON 解析失败：' + e.message }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '需要一个 JSON 对象' };
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
      const entries = Object.entries(obj.mcpServers).map(([name, cfg]) => ({ name, cfg: cfg || {} }));
      return entries.length ? { entries } : { error: 'mcpServers 下没有条目' };
    }
    if (obj.command || obj.url) return { entries: [{ name: fallbackName, cfg: obj }] };
    const keys = Object.keys(obj);
    if (keys.length && keys.every(k => obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])
        && (obj[k].command || obj[k].url))) {
      return { entries: keys.map(k => ({ name: k, cfg: obj[k] })) };
    }
    return { error: '无法识别的格式：需为 {"mcpServers":{...}} 包裹式、{"名称":{command/url}} 单条、或裸 {command/url} 配置' };
  }

  function createDialog() {
    HubUI.modal({
      title: '手动创建 MCP 条目', hasInput: false, confirmText: '创建', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">保存为 registry/mcp/&lt;名称&gt;.json，与拉取条目同权：可写入各工具目标、可握手验证。支持直接粘贴官网 mcpServers 配置 JSON 导入。</div>
        <div class="form-grid">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
            <label>名称<input class="hub-input" id="mc-name" data-testid="mcp-new-name" placeholder="my-mcp"></label>
            <label>输入模式<select class="hub-input" id="mc-mode" data-testid="mcp-new-mode">
              <option value="form">表单</option><option value="json">JSON</option></select></label>
          </div>
          <label id="mc-json-row" style="display:none">配置 JSON（支持 {"mcpServers":{...}} 包裹式，可多条）
            <textarea class="hub-input" id="mc-json" data-testid="mcp-new-json" rows="10" style="font-family:var(--font-mono);font-size:var(--fs-xs)" placeholder='{
  "mcpServers": {
    "my-mcp": { "command": "npx", "args": ["-y", "pkg"], "env": { "KEY": "v" } }
  }
}'></textarea></label>
          <div id="mc-form">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
              <label>传输<select class="hub-input" id="mc-type" data-testid="mcp-new-type">
                <option value="stdio">stdio</option><option value="http">http</option></select></label>
            </div>
            <label id="mc-cmd-row">命令（stdio）<input class="hub-input" id="mc-cmd" data-testid="mcp-new-cmd" placeholder="python3"></label>
            <label id="mc-args-row">参数（空格分隔）<input class="hub-input" id="mc-args" placeholder="-m pkg.mod"></label>
            <label id="mc-url-row" style="display:none">URL（http）<input class="hub-input" id="mc-url" data-testid="mcp-new-url" placeholder="https://host/mcp"></label>
            <label>环境变量（值保存后掩码显示）
              <div id="mc-envs"></div>
              <button class="hub-btn btn-sm" id="mc-env-add" type="button">＋ 添加变量</button></label>
          </div>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">校验：command 或 url 必填其一 · 键白名单 · 重名拦截 · 操作记入台账</div>`,
      onConfirm: async () => {
        // JSON 模式：解析（可多条）→ 逐条创建；表单模式：原逻辑
        if (document.getElementById('mc-mode').value === 'json') {
          const parsed = parseMcpJsonInput(document.getElementById('mc-json').value,
            document.getElementById('mc-name').value.trim());
          if (parsed.error) { HubUI.toast(parsed.error, 'error', 5600); return false; }
          const results = [];
          for (const en of parsed.entries) {
            const r = await post('/api/mcp/registry/item', { name: en.name, config: en.cfg });
            results.push({ name: en.name, ok: r.data.ok, error: r.data.error });
          }
          const okN = results.filter(x => x.ok).length;
          const fails = results.filter(x => !x.ok);
          if (okN) {
            HubUI.toast(`已导入 ${okN}/${results.length} 个条目 · 已记入台账`, 'success');
            await refresh();
            showDetail(results.find(x => x.ok).name);
          }
          if (fails.length) {
            HubUI.toast('失败：' + fails.map(x => `${x.name}（${x.error || ''}）`).join('；'), 'error', 5600);
            return false;
          }
          return true;
        }
        const cfg = collectConfig();
        if (!cfg) return false;
        const name = document.getElementById('mc-name').value.trim();
        const r = await post('/api/mcp/registry/item', { name, config: cfg });
        if (r.data.ok) { HubUI.toast('已创建 ' + name + ' · 已记入台账', 'success'); await refresh(); showDetail(name); }
        else { HubUI.toast('创建失败：' + (r.data.error || ''), 'error', 5200); return false; }
      },
    });
    document.getElementById('mc-mode').onchange = () => {
      const json = document.getElementById('mc-mode').value === 'json';
      document.getElementById('mc-json-row').style.display = json ? '' : 'none';
      document.getElementById('mc-form').style.display = json ? 'none' : '';
    };
    document.getElementById('mc-type').onchange = () => {
      const http = document.getElementById('mc-type').value === 'http';
      document.getElementById('mc-cmd-row').style.display = http ? 'none' : '';
      document.getElementById('mc-args-row').style.display = http ? 'none' : '';
      document.getElementById('mc-url-row').style.display = http ? '' : 'none';
    };
    document.getElementById('mc-env-add').onclick = () => addEnvRow('', '');
  }

  function addEnvRow(k, v) {
    const box = document.getElementById('mc-envs');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'nv-envkv';
    row.innerHTML = `<input class="hub-input nv-k" placeholder="KEY" value="${esc(k)}">
      <input class="hub-input nv-v" placeholder="value" value="${esc(v)}">
      <button class="hub-btn btn-sm" type="button">移除</button>`;
    row.querySelector('button').onclick = () => row.remove();
    box.appendChild(row);
  }

  function collectConfig() {
    const type = document.getElementById('mc-type').value;
    const cfg = { type };
    if (type === 'http') {
      cfg.url = document.getElementById('mc-url').value.trim();
      if (!cfg.url) { HubUI.toast('URL 必填', 'error'); return null; }
    } else {
      cfg.command = document.getElementById('mc-cmd').value.trim();
      cfg.args = document.getElementById('mc-args').value.trim().split(/\s+/).filter(Boolean);
      if (!cfg.command) { HubUI.toast('命令必填', 'error'); return null; }
    }
    const envs = {};
    document.querySelectorAll('#mc-envs .nv-envkv').forEach(row => {
      const k = row.querySelector('.nv-k').value.trim();
      const v = row.querySelector('.nv-v').value;
      if (k) envs[k] = v;
    });
    if (Object.keys(envs).length) cfg.env = envs;
    return cfg;
  }

  function editDialog(name) {
    api('/api/mcp/item/' + encodeURIComponent(name)).then(res => {
      const d = res.data || {};
      const cfg = d.config || {};
      const type = cfg.type || (cfg.url ? 'http' : 'stdio');
      HubUI.modal({
        title: '编辑 ' + name, hasInput: false, confirmText: '保存', cancelText: '取消',
        bodyHTML: `
          <div class="hub-modal__sub">编辑后写入各工具时才会更新目标配置；本地库历史版本可回退。</div>
          <div class="form-grid">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
              <label>传输<select class="hub-input" id="me-type">
                <option value="stdio" ${type === 'stdio' ? 'selected' : ''}>stdio</option>
                <option value="http" ${type === 'http' ? 'selected' : ''}>http</option></select></label>
              <label>JSON 模式<select class="hub-input" id="me-mode"><option value="form">表单</option><option value="json">JSON</option></select></label>
            </div>
            <div id="me-form">
              <label id="me-cmd-row">命令<input class="hub-input" id="me-cmd" value="${esc(cfg.command || '')}"></label>
              <label id="me-args-row">参数（空格分隔）<input class="hub-input" id="me-args" value="${esc((cfg.args || []).join(' '))}"></label>
              <label id="me-url-row" style="display:${type === 'http' ? '' : 'none'}">URL<input class="hub-input" id="me-url" value="${esc(cfg.url || '')}"></label>
              <label>环境变量<div id="me-envs"></div><button class="hub-btn btn-sm" id="me-env-add" type="button">＋ 添加变量</button></label>
            </div>
            <div id="me-json" style="display:none">
              <label>config（JSON）<textarea class="hub-input" id="me-json-body" rows="10" style="font-family:var(--font-mono);font-size:var(--fs-xs)"></textarea></label>
            </div>
          </div>`,
        onConfirm: async () => {
          let cfg2;
          if (document.getElementById('me-mode').value === 'json') {
            try { cfg2 = JSON.parse(document.getElementById('me-json-body').value); }
            catch (e) { HubUI.toast('JSON 解析失败：' + e.message, 'error'); return false; }
          } else {
            cfg2 = { type: document.getElementById('me-type').value };
            if (cfg2.type === 'http') cfg2.url = document.getElementById('me-url').value.trim();
            else {
              cfg2.command = document.getElementById('me-cmd').value.trim();
              cfg2.args = document.getElementById('me-args').value.trim().split(/\s+/).filter(Boolean);
            }
            const envs = {};
            document.querySelectorAll('#me-envs .nv-envkv').forEach(row => {
              const k = row.querySelector('.nv-k').value.trim();
              const v = row.querySelector('.nv-v').value;
              if (k) envs[k] = v;
            });
            if (Object.keys(envs).length) cfg2.env = envs;
          }
          const r = await api('/api/mcp/registry/item/' + encodeURIComponent(name), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: cfg2 }),
          });
          if (r.data.ok) { HubUI.toast('已保存 · 已记入台账', 'success'); await refresh(); showDetail(name); }
          else { HubUI.toast('保存失败：' + (r.data.error || ''), 'error', 5200); return false; }
        },
      });
      const typeSel = document.getElementById('me-type');
      const syncRows = () => {
        const http = typeSel.value === 'http';
        document.getElementById('me-cmd-row').style.display = http ? 'none' : '';
        document.getElementById('me-args-row').style.display = http ? 'none' : '';
        document.getElementById('me-url-row').style.display = http ? '' : 'none';
      };
      typeSel.onchange = syncRows;
      document.getElementById('me-mode').onchange = () => {
        const json = document.getElementById('me-mode').value === 'json';
        document.getElementById('me-form').style.display = json ? 'none' : '';
        document.getElementById('me-json').style.display = json ? '' : 'none';
        if (json) document.getElementById('me-json-body').value = JSON.stringify(currentEditCfg(cfg), null, 2);
      };
      for (const [k, v] of Object.entries(d.env_masked || {})) addEditEnvRow(k, v);
      document.getElementById('me-env-add').onclick = () => addEditEnvRow('', '');
    });
  }

  function currentEditCfg(cfg) {
    return cfg;
  }

  function addEditEnvRow(k, v) {
    const box = document.getElementById('me-envs');
    if (!box) return;
    const row = document.createElement('div');
    row.className = 'nv-envkv';
    row.innerHTML = `<input class="hub-input nv-k" placeholder="KEY" value="${esc(k)}">
      <input class="hub-input nv-v" placeholder="${k ? '（掩码，输入新值替换）' : 'value'}" value="">
      <button class="hub-btn btn-sm" type="button">移除</button>`;
    row.querySelector('button').onclick = () => row.remove();
    box.appendChild(row);
  }

  function deleteFlow(name) {
    HubUI.confirm('删除 ' + name, '将删除该本地条目；已写入工具配置的会连同写入内容一起移除（先备份）。', async () => {
      const r = await api('/api/mcp/registry/item/' + encodeURIComponent(name) + '?force=1', { method: 'DELETE' });
      if (r.data.ok) { HubUI.toast('已删除 ' + name + ' · 已记入台账', 'success'); S.selected.delete(name); await refresh(); showDetailClose(); }
      else HubUI.toast('删除失败：' + (r.data.error || ''), 'error', 5200);
    }, { confirmText: '确认删除', danger: true });
  }

  function showDetailClose() { S.mode = 'overview'; S._detailName = null; renderCenter(document.querySelector('#view-mcp .nv-center')); renderRight(document.querySelector('#view-mcp .nv-right')); }

  /* ---- 行内展开（稿子 ModuleView：点行展开 meta·来源 + 编辑/复制/删除 + 配置 JSON 预览）---- */
  async function toggleAcc(name) {
    const host = document.getElementById('mp-rows') || document;
    const wasOpen = S._detailName === name;
    host.querySelectorAll('.mvi.is-open').forEach(r => {
      r.classList.remove('is-open');
      const b = r.querySelector('.mvi__accin'); if (b) b.innerHTML = '';
    });
    if (wasOpen) { showDetailClose(); syncPanelOpen(); return; }
    await showDetail(name);
    const row = [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === name);
    const it = S.items.find(x => x.name === name);
    if (row && it) openAcc(row, it);
    syncPanelOpen();
  }
  function openAcc(row, it) {
    row.classList.add('is-open');
    const box = row.querySelector('.mvi__accin');
    box.innerHTML = MV.accBody({
      meta: [it.transport, (it.env_keys || []).length ? (it.env_keys.length + ' env') : ''].filter(Boolean).join(' · '),
      source: it.manual ? '本地库' : (it.source_name || ''),
      actions: [
        { key: 'edit', label: '编辑', disabled: !it.manual, title: it.manual ? '' : '远程条目只读' },
        { key: 'copy', label: '复制' },
        { key: 'del', label: '删除', disabled: !it.manual, title: it.manual ? '' : '远程条目随源同步，不能单独删除' },
      ],
    });
    const pre = box.querySelector('[data-acc-pre]');
    api('/api/mcp/item/' + encodeURIComponent(it.name)).then(r => {
      if (pre.isConnected) pre.textContent = JSON.stringify(((r.data || {}).config) || {}, null, 2);
    }).catch(() => { pre.textContent = '（加载失败）'; });
    box.querySelectorAll('[data-acc]').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.acc === 'edit') editDialog(it.name);
        if (b.dataset.acc === 'del') deleteFlow(it.name);
        if (b.dataset.acc === 'copy') {
          try { await navigator.clipboard.writeText(pre.textContent || ''); HubUI.toast('已复制配置', 'success'); }
          catch (err) { HubUI.toast('复制失败：' + err.message, 'error'); }
        }
      };
    });
  }
  function syncPanelOpen() {
    const panel = document.querySelector('#mp-panel');
    if (panel) panel.classList.toggle('is-in', !!(S.selected.size || S._detailName || S.mode === 'multi'));
  }
  function restoreAcc() {
    if (!S._detailName) return;
    const host = document.getElementById('mp-rows');
    const row = host && [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === S._detailName);
    const it = S.items.find(x => x.name === S._detailName);
    if (row && it && !row.classList.contains('is-open')) openAcc(row, it);
  }

  async function showDetail(name) {
    S.mode = 'detail'; S._detailName = name;
    const el = document.querySelector('#view-mcp .nv-center');
    if (el) renderDetail(el);
    const it = S.items.find(x => x.name === name);
    renderRight(document.querySelector('#view-mcp .nv-right'));
    if (it) await loadDetailBody(it);
  }

  /* ============================== 公共 ============================== */
  function snapshotUI() {
    const rows = document.getElementById('mp-rows');
    const a = document.activeElement;
    return { scroll: rows ? rows.scrollTop : 0,
             focusId: a && a.id ? a.id : null,
             caret: (a && a.selectionStart != null) ? a.selectionStart : null };
  }
  function restoreUI(s) {
    const rows = document.getElementById('mp-rows');
    if (rows && s.scroll) rows.scrollTop = s.scroll;
    if (s.focusId) {
      const el = document.getElementById(s.focusId);
      if (el && document.activeElement !== el) {
        el.focus();
        try { if (s.caret != null) el.setSelectionRange(s.caret, s.caret); } catch (e) { /* ignore */ }
      }
    }
  }

  /** 同 Skills：parts 控制重画范围（默认全画）——rows / cards / targets / ledger */
  async function refresh(opts) {
    const parts = new Set((opts && opts.parts) || ['ledger', 'cards', 'rows', 'targets']);
    const snap = snapshotUI();
    if (parts.has('ledger')) {
      try { S.ledger = ((await api('/api/ops?module=mcp&limit=5')).data.items || []); } catch (e) { /* ignore */ }
    }
    await loadAll();
    if (parts.has('rows') || parts.has('cards')) {
      renderLeft(document.querySelector('#view-mcp .nv-left'));
      restoreAcc();                        // 只重画列表时也要把展开态找回来（原来挂在 syncShell 里）
    }
    renderCenter(document.querySelector('#view-mcp .nv-center'));   // 隐藏宿主：概览统计卡 / 创建区（testid 依赖）
    if (parts.has('cards')) syncShell(mcpStats, '勾选条目 → 右侧选择目标写入；写入前会自动备份目标配置。');
    if (parts.has('targets')) renderRight(document.querySelector('#view-mcp .nv-right'));
    restoreUI(snap);
  }

  function mcpStats() {
    const sum = (k) => (S.targetsStat || []).reduce((a, t) => a + ((t.items && t.items[k]) || 0), 0);
    const pend = sum('stale') + sum('missing');
    const reg = Object.values(S.reg || {});
    return [
      { n: S.total || 0, label: `条目${S.srcFilter ? ' · 当前来源' : ' · 全部来源'}` },
      { n: reg.filter(r => r.manual).length, label: '本地 · 手动' },
      { n: reg.filter(r => !r.manual).length, label: '远程拉取' },
      { n: sum('total'), label: '已写入工具' },
      { n: pend, label: '待重写 / 未写入', tone: pend ? 'warn' : '' },
    ];
  }

  /* ---------- v1.0 版式适配层：外壳换成"顶部来源卡片 + 中栏条目 + 滑出去向" ---------- */
  /** 把 MV.shell 的槽位接到 view 原有逻辑上（搜索 / 分页 / 全选 / 标题） */
  function mountSlots(root) {
    const rows = root.querySelector('#mp-rows');
    if (rows) rows.classList.add('nv-list', 'nv-left');          // view 的条目列表就渲染在这里
    if (!root.querySelector('.nv-center')) {
      const host = document.createElement('main');                // 统计/创建区等：保留为隐藏宿主
      host.className = 'nv-center'; host.hidden = true;
      root.appendChild(host);
    }
    const panel = root.querySelector('#mp-panel');
    if (panel) panel.innerHTML = '<div class="spanel__in"><aside class="nv-right"></aside></div>';
  }
  function wireSlots(root) {
    const q = root.querySelector('#mp-q');
    const legacyQ = root.querySelector('#mp-rows [data-testid="mcp-search"]');
    if (q && legacyQ) {
      if (q.value !== legacyQ.value) q.value = legacyQ.value;
      q.oninput = () => { legacyQ.value = q.value; legacyQ.dispatchEvent(new Event('input', { bubbles: true })); };
    }
    const pgAt = (sel) => root.querySelector(`#mp-rows .nv-pager ${sel}`);
    const wire = (id, sel) => {
      const b = root.querySelector(id); const l = pgAt(sel);
      if (b && l) { b.disabled = l.disabled; b.onclick = () => l.click(); }
    };
    wire('#mp-selall', '[data-sel="all"]');
    wire('#mp-selinv', '[data-sel="invert"]');
    wire('#mp-selnone', '[data-sel="none"]');
    const info = root.querySelector('#mp-info'); const li = pgAt('.nv-pinfo');
    if (info && li) info.textContent = li.textContent;
    const t = root.querySelector('#mp-title');
    // 稿子：标题只随"当前来源"变（展开某条不改标题）
    if (t) t.textContent = (S.mode === 'multi' ? `已选 ${S.selected.size} 条`
        : (activeSrcName() ? `${activeSrcName()} · MCP 服务` : '全部 MCP 服务'));
    const c = root.querySelector('#mp-count');
    if (c) c.textContent = `· ${S.items.length} / ${S.total}`;
  }

  /** 外壳统一走 MV.shell（与会话页 / 记忆同一骨架）。view 自己的容器名挂到槽位上，
      逻辑一行不改，也不用再各写一套骨架。 */
  function shellHTML(topLabel) {
    return MV.shell({ prefix: 'mp', top: '', title: topLabel, q: S.q, placeholder: '搜索条目…' })
;
  }


  /** 把左栏里的「来源区块」搬到顶部并分组成三类、补色块、填统计条、同步去向面板显隐 */
  function activeSrcName() {
    if (S.toolSel) return S.toolSel.name || S.toolSel.id;
    if (S.srcFilter === 'manual') return '本地库';
    if (S.srcFilter != null) {
      const x = (S.sources || []).find(v => String(v.key != null ? v.key : v.id) === String(S.srcFilter));
      if (x) return x.name;
    }
    return '';
  }

  function syncShell(statsFn, hint) {
    const root = document.getElementById('view-mcp');
    const topHost = root.querySelector('#mp-top');
    const left = root.querySelector('.nv-left');
    if (!topHost || !left) return;

    // ---- 来源分组：走 MV.top（与记忆 / Skills 共用同一套 markup：分组头 / 卡片 / 统计条 / 提示语）----
    const all = (typeof allItemsCache === 'function' && allItemsCache()) || null;
    const items = (all && all.length ? all : S.items) || [];    // 计数用全量，避免被搜索框过滤
    const tools = new Map();
    for (const t of (S.targets || [])) {
      if (t.tool && t.tool !== 'plain' && !tools.has(t.tool)) tools.set(t.tool, t.tool_name || t.name || t.tool);
    }
    const shortOf = (id, nm) => {
      const x = MV.short(String(id).replace(/[^A-Za-z0-9]/g, ''));
      return x === '?' ? String(nm || id).slice(0, 2) : x;
    };
    const remoteKeys = (S.sources || []).map(x => String(x.key != null ? x.key : x.id));
    const srcs = [
      { id: 'manual', name: '本地·手动', short: 'LO', cls: 'chip--muted',
        count: items.filter(it => it.manual).length },
      ...(S.sources || []).map(x => {
        const key = String(x.key != null ? x.key : x.id);
        // 条目上真正可用的是 source_id（catalog_view 输出）；之前猜的 it.src/it.source 都不存在 → 卡片永远显示 0
        const n = items.filter(it => it.source_id != null && String(it.source_id) === key).length;
        return { id: key, name: x.name, short: shortOf(key, x.name), cls: MV.cls(key), count: n || x.count || 0 };
      }),
      ...[...tools].map(([tid, tname]) => ({ id: tid, name: tname, short: shortOf(tid, tname), cls: 'chip--accent',
        count: items.filter(it => String(it.tool || '') === tid).length })),
    ];
    const counts = {}; srcs.forEach(x => { counts[x.id] = x.count; });
    topHost.innerHTML = MV.top({
      prefix: 'mp', label: 'MCP 来源', sources: srcs, counts,
      activeId: S.toolSel ? S.toolSel.id : (S.srcFilter == null ? null : String(S.srcFilter)),
      groups: [
        { kind: 'local', label: '本地', desc: '手动创建或导入，hub 内可编辑', ids: ['manual'], actions: ['新建', '导入'] },
        { kind: 'remote', label: '远程仓库', desc: 'Git 仓库拉取，只读跟随上游', ids: remoteKeys, actions: ['添加仓库', '全部拉取'] },
        { kind: 'tool', label: '工具', desc: '从已安装工具的目录提取', ids: [...tools.keys()], actions: ['重新扫描'] },
      ],
      bulk: '<button class="hub-btn btn-sm"><span class="btn-ic">' + MV.ic('refresh') + '</span>重新扫描</button>',
      stats: typeof statsFn === 'function' ? statsFn() : [],
      hint: hint || '',
    });

    // 老来源行只作数据与事件宿主（隐藏）：点卡片 = 点老行 → 原有筛选 / 提取逻辑原样跑
    left.querySelectorAll('.nv-src-row').forEach(r => {
      const id = r.dataset.src || r.dataset.tool || '';
      const card = topHost.querySelector(`.tcard[data-src="${id}"]`);
      if (card) card.onclick = () => r.click();
      r.hidden = true;
    });
    // 已选中的卡片再点一次 = 取消筛选（等价于点「全部」，因为「全部」老行已隐藏）
    topHost.querySelectorAll('.tcard.is-on').forEach(c => {
      c.onclick = () => { const all = left.querySelector('.nv-src-row[data-src="all"]'); if (all) all.click(); };
    });
    left.querySelectorAll('.nv-h, .nv-fold, .nv-note, .nv-srcs').forEach(x => { x.hidden = true; });
    const bulkBtn = topHost.querySelector('.mv-stats__acts .hub-btn');
    if (bulkBtn) bulkBtn.onclick = () => { loadToolItems().then(() => refresh()); };
    // 稿子 ModuleView：未选来源 → 顶部卡片组 + 统计行；选中来源 → 收起它们，左侧出现分组栏
    // （ToolSidebar：本地 / 远程仓库 / 工具 分组 + 返回 + 计数）
    const activeSrc = S.toolSel ? String(S.toolSel.id) : (S.srcFilter == null ? null : String(S.srcFilter));
    const sideHost = root.querySelector('#mp-side');
    if (activeSrc) {
      if (topHost) topHost.hidden = true;
      if (sideHost) {
        sideHost.hidden = false;
        sideHost.innerHTML = MV.side({
          prefix: 'mp', items: srcs, counts, activeId: activeSrc,
          groups: [
            { label: '本地', ids: ['manual'] },
            { label: '远程仓库', ids: remoteKeys },
            { label: '工具', ids: [...tools.keys()] },
          ],
        });
        const back = sideHost.querySelector('#mp-back');
        if (back) back.onclick = () => { const all = left.querySelector('.nv-src-row[data-src="all"]'); if (all) all.click(); };
        sideHost.querySelectorAll('.sside__it').forEach(b => {
          b.onclick = () => {
            const r = left.querySelector(`.nv-src-row[data-src="${b.dataset.src}"], .nv-src-row[data-tool="${b.dataset.src}"]`);
            if (r) r.click();
          };
        });
      }
    } else {
      if (topHost) topHost.hidden = false;
      if (sideHost) { sideHost.hidden = true; sideHost.innerHTML = ''; }
    }
    wireSlots(root);
    restoreAcc();
    MV.bindGroups(root);
    MV.swap(root, S.toolSel ? 'tool:' + S.toolSel.id : 'src:' + String(S.srcFilter == null ? 'all' : S.srcFilter));
    root.querySelectorAll('[data-gact]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.gact.split(':')[1];
        if (act === '添加仓库') addSourceDialog();
        else if (act === '重新扫描') { loadToolItems().then(() => refresh()); }
        else if (act === '全部拉取') {
          const ids = (S.sources || []).map(x => String(x.id));
          if (!ids.length) { HubUI.toast('还没有远程仓库', 'warn'); return; }
          ids.reduce((p, id) => p.then(() => (typeof pullSource === 'function' ? pullSource(id, null) : null)), Promise.resolve());
        }
      };
    });
    const panel = root.querySelector('#mp-panel');
    if (panel) panel.classList.toggle('is-in', !!(S.selected.size || S._detailName || S.mode === 'multi'));
  }

  window.McpView = {
    async render(root) {
      root.innerHTML = shellHTML('MCP 来源');
      mountSlots(root);
      S.mode = 'overview'; S.selected = new Set(); S._detailName = null; S.srcFilter = null; S.page = 1; S.q = '';
      S.toolSel = null; S.toolChecked = new Set();
      await primeAllCache();
      await refresh();
    },
    refresh,
  };
})();
