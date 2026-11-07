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
    localDirs: [],                                // 本地目录池（与 Skills 页共用；默认目录不在此表）
    toolSel: null, toolItems: [], toolChecked: new Set(), _toolTgts: [],
    _tgts: [],                                    // 写入目标可多选（统一目标组件）
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
  const manualBadge = (m) => m ? '<span class="hub-badge hub-badge--manual">本地</span>' : '';
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
    // 目录先取（服务端顺带扫描同步，外部投放条目此刻才登记），条目随后读
    const dr = await api('/api/local-dirs');
    S.localDirs = dr.data.dirs || [];
    const params = new URLSearchParams({ page: S.page, per_page: S.perPage });
    if (S.srcFilter === 'manual') params.set('source', 'manual');
    else if (typeof S.srcFilter === 'number') params.set('source', S.srcFilter);
    else if (String(S.srcFilter || '').indexOf('dir:') === 0) {
      params.set('source', 'manual');
      params.set('dir', String(S.srcFilter).slice(4));
    }
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
    const right = document.querySelector('#view-mcp .nv-right');
    if (right) renderToolRight(right);
    syncPanelOpen();
  }

  function selectedRows() { return S.items.filter(it => S.selected.has(it.name)); }

  /* ============================== 左栏 ============================== */
  function renderLeft(el) {
    const srcRows = [
      { key: 'all', name: '全部', count: '' },
      { key: 'manual', name: '本地', count: '' },
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
          // 色块与副标题按 Skills 对齐：本地写「本地」，其余取来源名前 2 字（原来用条目名缩写 → 出现「?」）
          // 来源标识区分目录（2026-10-31）：链接目录内的条目显示目录名，默认库仍显示「本地」
          chipText: it.manual ? (it.dir_name ? String(it.dir_name).slice(0, 2).toUpperCase() : '本地')
                              : String(it.source_name || '').slice(0, 2).toUpperCase(),
          chipCls: it.manual ? 'chip--muted'
            : (typeof toolColorCls === 'function' ? toolColorCls(toolOf2(it.source_id)) : 'chip--accent'),
          title: it.name,
          sub: [(it.manual ? (it.dir_name || '本地') : String(it.source_name || '')), (it.command || it.url || '未配置命令')].filter(Boolean).join(' · '),
          // 行头动作（悬停显示，用户指令 2026-10-19「移到上面去，悬停显示」）：编辑 / 复制 / 删除；
          // 原行头的 [N env][stdio] 胶囊与快捷删已去掉，展开体元信息行同步移除
          extra: '<span class="mvi-acts">' + [
            { key: 'edit', label: '编辑', manualOnly: true },
            { key: 'copy', label: '复制' },
            { key: 'del', label: '删除', danger: true, manualOnly: true },
          ].map(a => `<button class="hub-btn btn-sm${a.danger ? ' hub-btn--danger' : ''}" data-acc="${a.key}"`
              + `${a.manualOnly && !it.manual ? ' disabled title="远程条目只读"' : ''}>${a.label}</button>`).join('') + '</span>',
        })).join('') || '<div class="hub-empty">没有条目<div class="hub-empty__hint">拉取源仓库或手动创建</div></div>'}
      </div>
      <div class="nv-pager" data-testid="mcp-pager">
        <button class="nv-pbtn" data-sel="all" data-testid="mcp-sel-all" title="全选本页">全选</button>
        <button class="nv-pbtn" data-sel="invert" data-testid="mcp-sel-invert" title="反选本页">反选</button>
        <button class="nv-pbtn" data-sel="none" data-testid="mcp-sel-none" title="清空选择" ${S.selected.size ? '' : 'disabled'}>清空</button>
        <span class="nv-sep"></span>
        <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? 'disabled' : ''}>‹</button>
        ${pageButtons()}
        <button class="nv-pbtn" data-p="next" ${S.page >= S.pages ? 'disabled' : ''}>›</button>
        <span class="nv-pinfo" data-testid="mcp-pinfo">已选 ${S.selected.size} · 显示 ${S.items.length} 条 · 共 ${S.total} 条</span>
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
        S._toolTgts = []; S.toolChecked = new Set();
        await refresh();
        syncPanelOpen();
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
        const noneBtn = el.querySelector('.nv-pbtn[data-sel="none"]');
        if (noneBtn) noneBtn.disabled = !S.selected.size;   // 勾选就地同步「清空」可用态（不重绘分页栏）
        renderCenter(document.querySelector('#view-mcp .nv-center'));
        renderRight(document.querySelector('#view-mcp .nv-right'));
      };
      // 行头动作（悬停显示）：编辑 / 复制 / 删除 —— 与原展开体按钮同行为
      const rowIt = S.items.find(x => x.name === row.dataset.id);
      if (rowIt) row.querySelectorAll('.mvi-acts [data-acc]').forEach(b => {
        b.onclick = async (e) => {
          e.stopPropagation();
          if (b.dataset.acc === 'edit') editDialog(rowIt.name);
          if (b.dataset.acc === 'del') deleteFlow(rowIt.name);
          if (b.dataset.acc === 'copy') {
            const rr = await api('/api/mcp/item/' + encodeURIComponent(rowIt.name));
            const cfgTxt = JSON.stringify(((rr.data || {}).config) || {}, null, 2);
            (await copyText(cfgTxt)) ? HubUI.toast('已复制配置', 'success')
              : HubUI.toast('复制失败，请手动复制', 'error');
          }
        };
      });
      row.onclick = async (e) => {
        if (e.target.type === 'checkbox' || e.target.closest('.mvi__body, .mvi-acts')) return;
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
        if (S.selected.size) S._panelOff = false;   // 全选/反选后重新弹出右侧目标面板
        renderLeft(el);
        renderCenter(document.querySelector('#view-mcp .nv-center'));
        renderRight(document.querySelector('#view-mcp .nv-right'));
        syncPanelOpen();
      };
    });
    // 外壳页脚的计数不在 renderLeft 的 DOM 内，重绘后同步一次（否则全选/反选后仍显示旧值）
    const info = document.getElementById('mp-info');
    if (info) info.textContent = `已选 ${S.selected.size} · 显示 ${S.items.length} 条 · 共 ${S.total} 条`;
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
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => r.manual).length}</b><span>本地</span></div>
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
      const r = await post('/api/mcp/distribute', { names: [...S.selected], target_ids: tids, force: true });
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
          <label>格式${HubUI.select({ id: 'mtgt-kind', value: 'mcp_json',
            options: [{ value: 'mcp_json', label: 'JSON（mcpServers 键合并）' }, { value: 'mcp_toml', label: 'TOML（Codex 托管块）' }] })}</label>
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
        <div class="nv-ddesc">该工具 MCP 配置中实际存在的 server，与本地库对齐。勾选后右侧选目标工具一键同步（同名覆盖）；工具配置保留不动。</div>
        <div class="nv-dops" data-testid="mcp-tool-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-tool-extract" ${checked.length ? '' : 'disabled'}>提取所选（${checked.length}）</button>
          <button class="hub-btn btn-sm" data-testid="mcp-tool-extract-all" ${extractable.length ? '' : 'disabled'}>提取全部可收编（${extractable.length}）</button>
        </div>
      </div>
      <div class="nv-sec"><span>条目</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">未收编 ${cnt('local_only')} · 有差异 ${cnt('diff')} · 一致 ${cnt('synced')}</span></div>
      ${items.map(it => `
        <div class="nv-deprow" data-name="${esc(it.name)}" data-testid="mcp-tool-row">
          <input type="checkbox" data-testid="mcp-tool-check" ${S.toolChecked.has(it.name) ? 'checked' : ''}>
          <span class="nv-dt">${esc(it.name)}</span>
          ${stateBadge(it.state)}
          <span class="nv-dv">${esc(it.tools.map(t => t.name).join(' · '))}</span>
        </div>`).join('') || '<div class="nv-note">该工具 MCP 配置为空、不存在或格式未知</div>'}`;
    el.querySelectorAll('[data-testid="mcp-tool-check"]').forEach(cb => {
      cb.onchange = () => {
        const name = cb.closest('[data-name]').dataset.name;
        cb.checked ? S.toolChecked.add(name) : S.toolChecked.delete(name);
        renderToolCenter(el);
        const right = document.querySelector('#view-mcp .nv-right');
        if (right) renderToolRight(right);
        syncPanelOpen();
      };
    });
    el.querySelector('[data-testid="mcp-tool-extract"]').onclick = () => extractSelected(checked.map(i => i.name));
    el.querySelector('[data-testid="mcp-tool-extract-all"]').onclick = () => extractSelected(extractable.map(i => i.name));
  }

  /** 工具视图右栏：勾选的 server + 其它工具作为同步目标（源工具自身不作为目标） */
  function renderToolRight(el) {
    const checked = (S.toolItems || []).filter(i => S.toolChecked.has(i.name));
    const n = checked.length;
    const own = S.toolSel ? S.toolSel.id : null;
    const targets = (S.targets || []).filter(t => t.tool !== own);
    const ids = new Set(targets.map(t => String(t.id)));
    S._toolTgts = (S._toolTgts || []).map(String).filter(id => ids.has(id));
    const picker = MV.targetPicker({
      prefix: 'mpt',
      emptyHint: '没有其它工具可同步，先到 设置 → 工具 接入 MCP 配置',
      items: targets.map(t => {
        const tl = (typeof TOOL_LIST !== 'undefined' ? TOOL_LIST.find(x => x.id === (t.tool || '')) : null) || null;
        return { id: t.id, name: t.tool_name || t.name,
                 dotCls: tl ? toolColorCls(tl) : 'tool-dot--local',
                 testid: `mcp-tool-target-${t.id}` };
      }),
      chosen: S._toolTgts,
      selLine: n ? `已选 <b class="mono">${n}</b> 条` : '当前：勾选左侧条目',
      selLineFn: () => (n ? `已选 <b class="mono">${n}</b> 条` : '当前：勾选左侧条目'),
      goText: `同步 ${n} 条到 …`,
      goTextFn: (set) => {
        const list = targets.filter(t => set.has(String(t.id)));
        const what = !list.length ? '…' : list.length === 1 ? (list[0].tool_name || list[0].name) : `${list.length} 个工具`;
        return `同步 ${n} 条到 ${what}`;
      },
      onChange: (xs) => { S._toolTgts = xs; },
      onGo: (xs) => syncToolToTargets(checked.map(i => i.name), xs.map(Number)),
    });
    el.innerHTML = `
      <div class="spanel__h">
        <h3>目标</h3>
        <span style="flex:1"></span>
        <button class="spanel__x" data-testid="mcp-tool-panel-close" title="收起" aria-label="收起">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      ${picker.html}
      <div class="nv-sec"><span>说明</span></div>
      <div class="nv-note">勾选左侧 server → 选目标 → 一键同步。条目先以工具配置为准收编进本地库，再写入目标；同名 server 先备份配置后覆盖。</div>`;
    el.querySelector('[data-testid="mcp-tool-panel-close"]').onclick = () => {
      S.toolChecked.clear();
      S._toolTgts = [];
      renderToolCenter(document.querySelector('#view-mcp .nv-center'));
      syncPanelOpen();
    };
    picker.bind(el);
  }

  /** 工具 → 其它工具一键同步（后端复用提取 + 写入管线） */
  async function syncToolToTargets(names, tids) {
    if (!S.toolSel) return;
    if (!names.length) { HubUI.toast('先勾选条目', 'warn'); return; }
    if (!tids.length) { HubUI.toast('先选目标工具', 'warn'); return; }
    const btn = document.querySelector('[data-testid="mpt-picker-go"]');
    if (btn) btn.classList.add('is-loading');
    const r = await post('/api/mcp/tool-sync', { tool: S.toolSel.id, names, target_ids: tids });
    if (btn) btn.classList.remove('is-loading');
    const fails = ((r.data && r.data.extracted) || []).filter(x => !x.ok);
    if (fails.length) HubUI.toast(fails.map(x => `${x.name}（${x.error || ''}）`).join('；'), 'error', 6000);
    if (!r.data || !r.data.ok) {
      HubUI.toast('同步失败：' + ((r.data && r.data.error) || ''), 'error', 5200);
      return;
    }
    notifyResults('同步到其它工具', r.data);
    await sleepMs(400);
    S.toolChecked.clear();
    S._toolTgts = [];
    await refresh({ parts: ['cards', 'rows', 'targets', 'ledger'] });
    syncPanelOpen();
  }

  function renderRight(el) {
    if (S.toolSel) return renderToolRight(el);
    const rows = S.mode === 'detail' && S._detailName ? S.items.filter(x => x.name === S._detailName)
      : S.mode === 'multi' ? selectedRows() : [];
    const title = S.mode === 'detail' ? S._detailName : S.mode === 'multi' ? `已选 ${rows.length} 条汇总` : '全部条目';
    const staleAll = S.targetsStat.reduce((a, t) => a + t.items.stale, 0);
    const missingAll = S.targetsStat.reduce((a, t) => a + t.items.missing, 0);
    // 已选目标集合做兜底校验（目标被删除后自动剔除）
    S._tgts = (S._tgts || []).filter(id => S.targetsStat.some(t => t.id === id));
    // 统一目标选择组件（用户 2026-10-20「将这个组件应用在所有模块」）：行右侧小注给每个目标的写入状态
    const picker = MV.targetPicker({
      prefix: 'mp',
      emptyHint: '先在 设置 → 工具 里接入 MCP 配置文件目标',
      items: S.targetsStat.map(t => {
        const scope = rows.length ? rows : null;
        let latest = 0, stale = 0, missing = 0;
        for (const it of (scope || allItemsCache() || [])) {
          const pt = (it.per_target || []).find(p => p.target_id === t.id);
          if (!pt) continue;
          if (pt.state === 'latest') latest++;
          else if (pt.state === 'stale') stale++;
          else missing++;
        }
        const tot = scope ? rows.length : t.items.total;
        const meta = stale ? `${stale}/${tot} 需重写` : missing ? `${missing}/${tot} 未写入` : tot ? `${latest}/${tot} 一致` : '';
        const tl = (typeof TOOL_LIST !== 'undefined' ? TOOL_LIST.find(x => x.id === (t.tool || '')) : null) || null;
        return { id: t.id, name: t.tool_name || t.name, meta,
                 dotCls: tl ? toolColorCls(tl) : 'tool-dot--local', testid: `mcp-target-${t.id}` };
      }),
      chosen: (S._tgts || []).map(String),
      selLine: rows.length ? `已选 <b>${rows.length}</b> 条` : `当前：${esc(title)}`,
      selLineFn: () => (rows.length ? `已选 <b>${rows.length}</b> 条` : `当前：${esc(title)}`),
      goText: '写入到已选目标',
      goTextFn: (set) => `写入 ${rows.length || (allItemsCache() || []).length} 条到 ${set.size} 个目标`,
      onChange: (ids) => { S._tgts = ids.map(Number); },
      onGo: (ids) => {
        const names = rows.length ? rows.map(r => r.name) : (allItemsCache() || []).map(x => x.name);
        writeMany(names, ids.map(Number));
      },
    });
    el.innerHTML = `
      <div class="spanel__h">
        <h3>目标</h3>
        <button class="spanel__x" data-testid="mcp-panel-close" title="收起" aria-label="收起">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="nv-uops">
        <!-- 批量动作按 Skills 对齐：只留一个「一键写入（落后数）」= 逐目标重写 stale（用户 2026-10-20） -->
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-inline-rewrite" ${staleAll ? '' : 'disabled'} title="只重写「该目标已写入、且本地版本更新」的条目">一键写入（${staleAll}）</button>
      </div>
      ${picker.html}
    `;
    el.querySelector('[data-testid="mcp-inline-rewrite"]').onclick = () => {
      for (const t of S.targetsStat) if (t.items.stale) inlineWrite(t.stale_names || [], t.id, false);
    };
    const mcpClose = el.querySelector('[data-testid="mcp-panel-close"]');
    if (mcpClose) mcpClose.onclick = () => { S.selected.clear(); S._detailName = null; S.mode = 'overview'; refresh(); };
    picker.bind(el);   // 选中切换 / 全选·清空 / Go 全部由组件接管（就地切类名，保住描边动效）
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

  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  /** 行内进度胶囊（与 Skills 同构）：写入中 → 完成/跳过/冲突/失败 */
  function markRows(names, text, tone) {
    (names || []).forEach(n => {
      const row = document.querySelector(`#mp-rows .mvi[data-id="${CSS.escape(String(n))}"]`);
      const head = row && row.querySelector('.mvi__head');
      if (!head) return;
      let pill = row.querySelector('.mvi__prog');
      if (!pill) {
        pill = document.createElement('span');
        pill.className = 'mvi__prog pill';
        head.insertBefore(pill, head.querySelector('.mvi__chev') || null);
      }
      pill.textContent = text;
      pill.className = 'mvi__prog pill pill--' + (tone || 'muted');
    });
  }
  const RESULT_LABEL = { ok: ['完成', 'ok'], skipped: ['跳过', 'muted'], conflict: ['冲突', 'warn'], failed: ['失败', 'err'] };
  function markResults(results) {
    (results || []).forEach(r => {
      const [text, tone] = RESULT_LABEL[r.status] || ['—', 'muted'];
      if (r.item) markRows([r.item], text, tone);
    });
  }

  /** 一次写入多个目标（统一目标组件的 Go） */
  async function writeMany(names, tids) {
    if (!names || !names.length) { HubUI.toast('没有需要写入的条目', 'info'); return; }
    if (!tids || !tids.length) { HubUI.toast('先选写入目标', 'warn'); return; }
    markRows(names, '写入中…', 'muted');
    const r = await post('/api/mcp/distribute', { names, target_ids: tids, force: true });
    const label = tids.map(id => { const t = S.targetsStat.find(x => x.id === id); return t ? (t.tool_name || t.name) : id; }).join('、');
    notifyResults(`写入 ${label}`, r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);
    await refresh({ parts: ['rows', 'targets', 'ledger'] });
  }

  async function inlineWrite(names, tid, missing) {
    let list = names;
    if (missing) {
      await primeAllCache();
      list = (_allCache || []).filter(it => (it.per_target || []).some(p => p.target_id === tid && p.state === 'missing')).map(x => x.name);
    }
    if (!list || !list.length) { HubUI.toast('没有需要写入的条目', 'info'); return; }
    const target = S.targetsStat.find(t => t.id === tid);
    markRows(list, '写入中…', 'muted');
    const r = await post('/api/mcp/distribute', { names: list, target_ids: [tid], force: true });
    notifyResults(`写入 ${target ? target.name : tid}`, r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);
    await refresh({ parts: ['rows', 'targets', 'ledger'] });   // B2：顶部卡片不重画
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
    await refresh({ parts: ['targets', 'ledger'] });   // 验证结果反映到右侧目标矩阵
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
    const parts = [`成功 ${ok}`];
    if (skipped) parts.push(`跳过 ${skipped}`);
    if (conflict) parts.push(`冲突 ${conflict}`);
    if (failed) parts.push(`失败 ${failed}`);
    HubUI.toast(`${label} · ${parts.join(' · ')}`, tone, 5200);
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

  /** MCP 条目没有"从目录导入"（技能才有）；若从旧入口/快捷键进来，给明确提示 */
  function importDialog() {
    HubUI.toast('MCP 条目请用「新建」填写命令或 URL（技能才支持从目录导入）', 'warn', 5200);
  }

  /* ============================== 目录管理 v2（列表 + 绑定状态 + 原生选择目录；与 Skills 页共用目录池） ==============================
     「创建目录」已按用户口径取消（2026-10-31「取消创建，提供【选择目录】功能」）。
     绑定（2026-10-31）：目录 ↔ 工具目标持久连接——建连即全量同步，目录内容变化由服务端
     worker 自动跟随（Plans/目录连接工具/需求拆解.md）。M1 分发仅覆盖 skills 条目；
     连接操作的主入口在 Skills 页，此处展示连接状态并支持断开。 */
  const toolNameOf = (tid) => {
    const t = (window.hubApp.state.tool_list || []).find(x => x.id === tid);
    return t ? t.name : (tid || '?');
  };

  function manageDirsDialog() {
    const defaultCount = Object.values(S.reg || {}).filter(r => r.manual && !r.dir_id).length;
    HubUI.modal({
      title: '目录管理', hasInput: false, confirmText: '完成', cancelText: null,
      bodyHTML: `
        <div class="hub-modal__sub">Skills 与 MCP 共用目录池：链接的目录原地挂进 hub（不复制），目录内条目变化实时同步。<b>连接工具</b>后，目录内全部 skills 自动同步到该工具（连接入口在 Skills 页），此处展示连接状态。</div>
        <div class="hub-dirlist" id="md-list"></div>
        <div class="hub-dirlist__foot">
          <button class="hub-btn hub-btn--primary" id="md-pick" data-testid="mcp-dir-pick">选择目录…</button>
          <span class="hub-dirlist__hint" id="md-pick-hint">弹出 macOS 文件夹选择器，选中即链接</span>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">不能链接 hub 自身目录或与已链接目录重叠 · 重名条目跳过并记入台账</div>`,
    });
    const renderList = (dirs) => {
      const host = document.getElementById('md-list');
      if (!host) return;
      const rows = [`<div class="hub-dirlist__row is-builtin">
          <span class="hub-dirlist__nm">默认目录</span>
          <span class="hub-dirlist__meta">registry/mcp · registry/skills · ${defaultCount} 条</span>
          <span class="hub-badge hub-badge--neutral">内置</span>
        </div>`];
      for (const d of (dirs || [])) {
        const chips = (d.bindings || []).map(b => {
          const cls = (typeof toolColorCls === 'function') ? toolColorCls(toolOf2(b.tool)) : '';
          return `<span class="hub-badge hub-badge--neutral" style="display:inline-flex;align-items:center;gap:4px">
              <span class="tool-dot ${cls}"></span>${esc(toolNameOf(b.tool))}${b.enabled ? '' : ' · 已暂停'}</span>`;
        }).join('');
        rows.push(`<div class="hub-dirlist__row" style="flex-wrap:wrap">
          <span class="hub-dirlist__nm">${esc(d.name)}</span>
          <span class="hub-dirlist__meta">${esc(tilde(d.path))} · ${d.counts.mcp} mcp · ${d.counts.skills} skill</span>
          <span class="hub-dirlist__binds">${chips}</span>
          <span class="hub-dirlist__ops">
            ${(d.bindings || []).map(b => `<button class="hub-btn btn-sm" data-dir-unlink="${b.id}">断开</button>`).join('')}
            <button class="hub-btn btn-sm hub-btn--danger" data-dir-del="${d.id}">移除</button>
          </span>
        </div>`);
      }
      host.innerHTML = rows.join('');
      host.querySelectorAll('[data-dir-del]').forEach(b => {
        b.onclick = () => removeDirDialog(b.dataset.dirDel, renderList);
      });
      host.querySelectorAll('[data-dir-unlink]').forEach(b => {
        b.onclick = () => unbindDialog(b.dataset.dirUnlink, renderList);
      });
    };
    renderList(S.localDirs || []);
    const pickBtn = document.getElementById('md-pick');
    pickBtn.onclick = async () => {
      pickBtn.classList.add('is-loading');
      const hint = document.getElementById('md-pick-hint');
      if (hint) hint.textContent = '等待在弹出的窗口中选择…';
      const r = await post('/api/local-dirs/pick');
      pickBtn.classList.remove('is-loading');
      if (hint) hint.textContent = '弹出 macOS 文件夹选择器，选中即链接';
      if (r.data.ok) {
        const skip = (r.data.skipped || []).length;
        HubUI.toast(`已链接 ${r.data.name} · 发现 ${r.data.added} 条${skip ? ` · 跳过重名 ${skip} 条` : ''}`, 'success', 5600);
        await refresh();
        const again = await api('/api/local-dirs');
        S.localDirs = again.data.dirs || [];
        renderList(S.localDirs);
      } else if (!r.data.canceled) {
        HubUI.toast('链接失败：' + (r.data.error || ''), 'error', 5600);
      }   // 用户取消选择器 → 静默
    };
  }

  function unbindDialog(bindingId, after) {
    const b = (S.localDirs || []).flatMap(x => x.bindings || []).find(y => String(y.id) === String(bindingId));
    if (!b) return;
    HubUI.confirm('断开连接',
      `目录 ⇄ <b>${esc(toolNameOf(b.tool))}</b>（${esc(tilde(b.target_path || ''))}）<br>断开后目录变化不再同步到该工具。`,
      async () => {
        const r = await api('/api/skills/dir-bindings/' + encodeURIComponent(bindingId), { method: 'DELETE' });
        if (r.data.ok) {
          HubUI.toast('已断开（工具内文件保留）', 'success');
          await refresh();
          if (typeof after === 'function') after(S.localDirs);
        } else HubUI.toast('断开失败：' + (r.data.error || ''), 'error', 5200);
      },
      { confirmText: '断开连接', danger: true });
  }

  function removeDirDialog(dirId, after) {
    const d = (S.localDirs || []).find(x => String(x.id) === String(dirId));
    if (!d) return;
    const n = (d.counts && (d.counts.skills + d.counts.mcp)) || 0;
    HubUI.confirm('移除目录「' + d.name + '」',
      esc(tilde(d.path)) + `<br>其中 ${n} 条条目将解除登记，<b>磁盘文件保留不动</b>；已写入工具配置的内容不受影响。`,
      async () => {
        const r = await api('/api/local-dirs/' + encodeURIComponent(dirId), { method: 'DELETE' });
        if (r.data.ok) {
          HubUI.toast(`已移除目录 ${r.data.name}（解除 ${r.data.items_unregistered} 条登记）`, 'success');
          if (S.srcFilter === 'dir:' + dirId) S.srcFilter = null;    // 正看着这个目录 → 回全部
          await refresh();
          if (typeof after === 'function') after(S.localDirs);       // 目录管理弹窗在开 → 重画列表
        } else HubUI.toast('移除失败：' + (r.data.error || ''), 'error', 5200);
      }, { confirmText: '移除目录', danger: true });
  }

  /* 目录选择字段（与 Skills 页同构）：无自定义目录时禁用（锁定默认目录） */
  function dirFieldHTML(id, testid) {
    const dirs = S.localDirs || [];
    const options = [{ value: '', label: '默认目录' },
      ...dirs.map(d => ({ value: String(d.id), label: d.name }))];
    return HubUI.select({ id, testid, value: '', options, disabled: !dirs.length });
  }
  function dirFieldVal(id) {
    const el = document.getElementById(id);
    const v = el ? String(el.value || '') : '';
    return v ? Number(v) : null;
  }

  function createDialog() {
    HubUI.modal({
      title: '手动创建 MCP 条目', hasInput: false, confirmText: '创建', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">保存为本地库条目（默认 registry/mcp/&lt;名称&gt;.json），与拉取条目同权：可写入各工具目标、可握手验证。支持直接粘贴官网 mcpServers 配置 JSON 导入。</div>
        <div class="form-grid">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
            <label>名称<input class="hub-input" id="mc-name" data-testid="mcp-new-name" placeholder="my-mcp"></label>
            <label>输入模式${HubUI.select({ id: 'mc-mode', testid: 'mcp-new-mode', value: 'form',
              options: [{ value: 'form', label: '表单' }, { value: 'json', label: 'JSON' }] })}</label>
          </div>
          <label>目录${dirFieldHTML('mc-dir', 'mcp-new-dir')}</label>
          <label id="mc-json-row" style="display:none">配置 JSON（支持 {"mcpServers":{...}} 包裹式，可多条）
            <textarea class="hub-input" id="mc-json" data-testid="mcp-new-json" rows="10" style="font-family:var(--font-mono);font-size:var(--fs-xs)" placeholder='{
  "mcpServers": {
    "my-mcp": { "command": "npx", "args": ["-y", "pkg"], "env": { "KEY": "v" } }
  }
}'></textarea></label>
          <div id="mc-form">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)">
              <label>传输${HubUI.select({ id: 'mc-type', testid: 'mcp-new-type', value: 'stdio',
                options: [{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }] })}</label>
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
            const r = await post('/api/mcp/registry/item', { name: en.name, config: en.cfg,
              dir_id: dirFieldVal('mc-dir') });
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
        const r = await post('/api/mcp/registry/item', { name, config: cfg, dir_id: dirFieldVal('mc-dir') });
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
              <label>传输${HubUI.select({ id: 'me-type', value: type,
                options: [{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'http' }] })}</label>
              <label>JSON 模式${HubUI.select({ id: 'me-mode', value: 'form', options: [{ value: 'form', label: '表单' }, { value: 'json', label: 'JSON' }] })}</label>
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
      if (r.data.ok) { HubUI.toast('已删除 ' + name + ' · 已记入台账', 'success'); S.selected.delete(name);
          await collapseRows('#mp-rows .mvi', { keys: [name] });
          await refresh({ parts: ['rows', 'ledger'] }); showDetailClose(); }
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
    if (wasOpen) {
      // 收起 = 取消选中（与会话/Skills 同口径，用户 2026-10-20）
      S.selected.delete(name);
      syncRowSel(host, name, false);
      showDetailClose(); syncPanelOpen(); return;
    }
    S.selected.add(name);                 // 展开 = 选中该条目
    syncRowSel(host, name, true);
    await showDetail(name);
    const row = [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === name);
    const it = S.items.find(x => x.name === name);
    if (row && it) openAcc(row, it);
    syncPanelOpen();
  }
  /** 就地同步某行勾选态（不重建列表） */
  function syncRowSel(host, name, on) {
    const row = [...(host || document).querySelectorAll('.mvi')].find(r => r.dataset.id === name);
    if (!row) return;
    const cb = row.querySelector('.mvi__chk');
    if (cb) cb.checked = on;
    row.classList.toggle('is-sel', on);
  }
  function openAcc(row, it) {
    row.classList.add('is-open');
    const box = row.querySelector('.mvi__accin');
    // 元信息行与行内动作已上移到行头（用户指令 2026-10-19）：展开体只剩配置 JSON
    box.innerHTML = MV.accBody({});
    const pre = box.querySelector('[data-acc-pre]');
    api('/api/mcp/item/' + encodeURIComponent(it.name)).then(r => {
      if (pre.isConnected) pre.textContent = JSON.stringify(((r.data || {}).config) || {}, null, 2);
    }).catch(() => { pre.textContent = '（加载失败）'; });
  }
  function syncPanelOpen() {
    const panel = document.querySelector('#mp-panel');
    const toolPicking = !!(S.toolSel && S.toolChecked.size);
    if (panel) panel.classList.toggle('is-in', !!(S.selected.size || S._detailName || S.mode === 'multi' || toolPicking));
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
  /** 只更新来源卡片右上角的计数（卡片节点不重建） */
  function refreshCardCounts() {
    const all = (typeof allItemsCache === 'function' && allItemsCache()) || null;
    const items = (all && all.length ? all : S.items) || [];
    document.querySelectorAll('#mp-top .tcard[data-src]').forEach(card => {
      const id = card.dataset.src;
      const badge = card.querySelector('.tcard__cnt');
      if (!badge) return;
      let n;
      if (id === 'manual') n = items.filter(it => it.manual).length;
      else if (/^\d+$/.test(id)) n = items.filter(it => it.source_id != null && String(it.source_id) === id).length;
      else n = items.filter(it => String(it.tool || '') === id).length;
      const txt = String(n || 0);
      if (badge.textContent !== txt) badge.textContent = txt;
    });
  }

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
    if (!parts.has('cards')) refreshCardCounts();                  // 卡片不重画：只把角标数字就地改掉
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
      { n: reg.filter(r => r.manual).length, label: '本地' },
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
  }

  /** 外壳统一走 MV.shell（与会话页 / 记忆同一骨架）。view 自己的容器名挂到槽位上，
      逻辑一行不改，也不用再各写一套骨架。 */
  function shellHTML(topLabel) {
    return MV.shell({ prefix: 'mp', top: '', title: topLabel, q: S.q, placeholder: '搜索条目…' })
;
  }


  /** 把左栏里的「来源区块」搬到顶部并分组成三类、补色块、填统计条、同步去向面板显隐 */
  function toolOf2(tid) {
    return ((window.hubApp && window.hubApp.state.tool_list) || []).find(t => t.id === tid) || null;
  }

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
      return x === '?' ? String(nm || id).slice(0, 2).toUpperCase() : x;
    };
    const remoteKeys = (S.sources || []).map(x => String(x.key != null ? x.key : x.id));
    // 本地目录池：默认目录 + 每个目录一张卡（与 Skills 页共用；计数取 counts.mcp）
    const dirIds = (S.localDirs || []).map(d => 'dir:' + d.id);
    const manualAll = Object.values(S.reg || {}).filter(r => r.manual);
    const srcs = [
      // 本地计数取 registry（每次刷新都重取），避免全量缓存过期后卡片角标与列表不一致
      { id: 'manual', name: '默认', short: '默认', cls: 'chip--muted',
        count: manualAll.filter(r => !r.dir_id).length },
      ...(S.localDirs || []).map(d => ({
        id: 'dir:' + d.id, name: d.name, short: shortOf('dir' + d.id, d.name),
        cls: 'chip--muted',
        count: (d.counts && d.counts.mcp) || 0,
        tag: (d.bindings || []).length
          ? '<span class="arr">→</span>' + (d.bindings || []).slice(0, 3).map(b =>
              `<span class="tool-dot ${toolColorCls(toolOf2(b.tool))}"></span>`).join('')
            + ((d.bindings || []).length > 3 ? `<span>+${d.bindings.length - 3}</span>` : '')
          : '',
        acts: [
          { key: 'dirdel', label: '移除', icon: MV.ic('trash'), title: '移除该目录（磁盘文件保留）', danger: true },
        ],
      })),
      ...(S.sources || []).map(x => {
        const key = String(x.key != null ? x.key : x.id);
        // 条目上真正可用的是 source_id（catalog_view 输出）；之前猜的 it.src/it.source 都不存在 → 卡片永远显示 0
        const n = items.filter(it => it.source_id != null && String(it.source_id) === key).length;
        // 远程来源的计数以服务端 item_count 为准：拉取后本地全量缓存可能尚未刷新
        return { id: key, name: x.name, short: shortOf(key, x.name), cls: MV.cls(key),
                 count: x.item_count != null ? x.item_count : (n || x.count || 0) };
      }),
      // 工具来源 = 工具自己的色（与会话页卡片同色），不再统一主色
      ...[...tools].map(([tid, tname]) => ({ id: tid, name: tname, short: shortOf(tid, tname),
        cls: (typeof toolColorCls === 'function' ? toolColorCls(toolOf2(tid)) : 'chip--accent'),
        count: items.filter(it => String(it.tool || '') === tid).length })),
    ];
    const counts = {}; srcs.forEach(x => { counts[x.id] = x.count; });
    const mpActive = S.toolSel ? S.toolSel.id : (S.srcFilter == null ? null : String(S.srcFilter));
    const mpTopHTML = MV.top({
      prefix: 'mp', label: 'MCP 来源', sources: srcs, counts,
      activeId: mpActive,
      groups: [
        { kind: 'local', label: '本地', desc: '默认目录 + 已链接目录；目录内条目变化实时同步',
          ids: ['manual', ...dirIds], actions: ['目录管理', '新建'] },
        { kind: 'remote', label: '远程仓库', desc: 'Git 仓库拉取，只读跟随上游', ids: remoteKeys, actions: ['添加仓库', '全部拉取'] },
        { kind: 'tool', label: '工具', desc: '从已安装工具的目录提取', ids: [...tools.keys()], actions: ['重新扫描'] },
      ],
      bulk: '<button class="hub-btn btn-sm"><span class="btn-ic">' + MV.ic('refresh') + '</span>重新扫描</button>',
      stats: typeof statsFn === 'function' ? statsFn() : [],
      hint: hint || '',
    });
    // 就地同步：来源集合 / 数量不变时只切 is-on（保住描边生长动效，2026-10-20）
    MV.syncCards(topHost, mpTopHTML, srcs.map(x => x.id + ':' + x.count).join(','), mpActive);

    // 老来源行只作数据与事件宿主（隐藏）；卡片/chip 点击统一走 pick（口径同 Skills 视图，用户指令 2026-10-19）
    const activeSrc = S.toolSel ? String(S.toolSel.id) : (S.srcFilter == null ? null : String(S.srcFilter));
    const allRow = () => left.querySelector('.nv-src-row[data-src="all"]');
    const pick = (id, fromCards) => {
      const same = activeSrc != null && String(activeSrc) === String(id);
      if (same) { const all = allRow(); if (all) all.click(); refresh(); return; }
      // 改动：点卡片只「选中来源」，不再自动进入简略布局（用户指令 2026-10-20「取消点击卡片进入简略布局」）
      const row = left.querySelector(`.nv-src-row[data-src="${id}"], .nv-src-row[data-tool="${id}"]`);
      if (row) row.click();
      else if (String(id).indexOf('dir:') === 0) S.srcFilter = id;   // 本地目录卡：直接设过滤
      refresh();
    };
    left.querySelectorAll('.nv-src-row').forEach(r => {
      const id = r.dataset.src || r.dataset.tool || '';
      const card = topHost.querySelector(`.tcard[data-src="${id}"]`);
      if (card) card.onclick = () => pick(id, true);
      r.hidden = true;
    });
    // 本地目录卡：没有旧来源行宿主可借，直接绑 pick（与 Skills 视图同口径）
    topHost.querySelectorAll('.tcard[data-src^="dir:"]').forEach(card => {
      card.onclick = () => pick(card.dataset.src, true);
    });
    // 卡片动作按钮（本地目录卡的「移除」）：必须 stopPropagation，防冒泡到卡片选中（口径同 Skills）
    topHost.querySelectorAll('.tcard[data-src] .tcard__act').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const src = btn.closest('.tcard').dataset.src;
        if (btn.dataset.act === 'dirdel') removeDirDialog(String(src).slice(4));
      };
    });
    left.querySelectorAll('.nv-h, .nv-fold, .nv-note, .nv-srcs').forEach(x => { x.hidden = true; });
    const bulkBtn = topHost.querySelector('.mv-stats__acts .hub-btn');
    if (bulkBtn) bulkBtn.onclick = () => { loadToolItems().then(() => refresh()); };
    // 可折叠头部（对齐 Skills 视图，用户指令 2026-10-19「接到其他模块」）：
    // 详细 = 分组卡片（MV.top）↔ 简略 = 64px chip 条（MV.chipBar）；布局模式与选中来源是两个独立维度
    const sideHost = root.querySelector('#mp-side');
    let hdr = root.querySelector('#mp-hdr');
    if (!hdr) {
      hdr = document.createElement('div');
      hdr.id = 'mp-hdr';
      hdr.className = 'hdr';
      if (topHost && topHost.parentElement) {
        topHost.parentElement.insertBefore(hdr, topHost);
        hdr.appendChild(topHost);                    // 卡片区（full）
      }
      const bar = document.createElement('div');     // 横向条（strip）
      bar.id = 'mp-bar';
      bar.className = 'cbar-host';
      hdr.appendChild(bar);
    }
    const barHost = hdr.querySelector('#mp-bar');
    const topHostEl = hdr.querySelector('#mp-top');
    const compact = S._layout === 'compact';
    // 详细布局时量一次完整高度并缓存（compact 时卡片区绝对定位，量不到）
    if (!compact) {
      const fullH = (hdr.querySelector('#mp-top') || {}).scrollHeight || 0;
      if (fullH) { S._fullH = fullH; hdr.style.setProperty('--hdr-full', Math.round(fullH) + 'px'); }
    } else if (S._fullH) {
      hdr.style.setProperty('--hdr-full', Math.round(S._fullH) + 'px');
    }
    // 布局切换必须"先绘制旧高度、下一帧再切类名"，否则同一帧里高度直接变成终值 → 没有过渡
    const nextLayout = compact ? 'compact' : 'detail';
    const prevLayout = hdr.dataset.layout || '';
    const applyLayout = () => {
      hdr.style.height = '';
      hdr.classList.toggle('is-compact', nextLayout === 'compact');
      hdr.dataset.layout = nextLayout;
    };
    if (!prevLayout || prevLayout === nextLayout) applyLayout();
    else {
      hdr.style.height = Math.round(hdr.getBoundingClientRect().height) + 'px';
      requestAnimationFrame(() => requestAnimationFrame(applyLayout));
    }
    if (compact) {
      { const dt = hdr.querySelector('#mp-hdrtoggle'); if (dt) dt.hidden = true; }
      if (topHostEl) topHostEl.hidden = false;      // 保持在 DOM 里：CSS 控制淡出
      if (sideHost) { sideHost.hidden = true; sideHost.innerHTML = ''; }
      barHost.hidden = false;
      // 就地同步：chip 集合 / 数量不变时只切 is-on（保住描边生长动效，2026-10-20）
      const mpBarSig = srcs.map(x => x.id + ':' + x.count).join(',')
        + '|' + remoteKeys.join(',') + '|' + [...tools.keys()].join(',');
      if (barHost.dataset.barsig !== mpBarSig) {
        barHost.dataset.barsig = mpBarSig;
        barHost.innerHTML = MV.chipBar({
          prefix: 'mp', items: srcs, activeId: activeSrc,
          groups: [
            { kind: 'local', label: '本地', ids: ['manual', ...dirIds],
              actions: ['目录管理', '新建'] },
            { kind: 'remote', label: '远程仓库', ids: remoteKeys, actions: ['添加仓库', '全部拉取'] },
            { kind: 'tool', label: '工具', ids: [...tools.keys()], actions: ['重新扫描'] },
          ],
        });
        const back = barHost.querySelector('#mp-barback');
        if (back) {
          back.title = '切换到详细布局';
          back.setAttribute('aria-label', '切换到详细布局');
          back.onclick = () => { S._layout = 'detail'; refresh(); };
        }
        barHost.querySelectorAll('.cbar__it').forEach(b => { b.onclick = () => pick(b.dataset.src, false); });
        HubUI.drawFrames(barHost);   // chip 描边路径（同会话条头，2026-10-20）
        MV.growIn(barHost);          // 新建的条里已有选中 chip 时补播动效
      } else {
        // 选中变化 → 只切类名，描边与背景从零开始播放（2026-10-20）
        const on = activeSrc == null ? null : String(activeSrc);
        barHost.querySelectorAll('.cbar__it').forEach(b => {
          b.classList.toggle('is-on', on != null && String(b.dataset.src) === on);
        });
      }
    } else {
      hdr.classList.remove('is-compact');
      // 详细布局也显示「切换布局」按钮（左上角，悬停工具区才浮现）：
      // 用户 2026-10-20「详细布局时，鼠标悬停工具区，显示切换按钮，左上角」+「取消点击卡片进入简略布局」
      MV.hdrToggle(hdr, 'mp', () => { S._layout = 'compact'; refresh(); });
      if (topHostEl) topHostEl.hidden = false;
      if (sideHost) { sideHost.hidden = true; sideHost.innerHTML = ''; }
      barHost.hidden = true;
      barHost.innerHTML = '';
      delete barHost.dataset.barsig;
    }
    wireSlots(root);
    restoreAcc();
    MV.bindGroups(root);
    MV.swap(root, S.toolSel ? 'tool:' + S.toolSel.id : 'src:' + String(S.srcFilter == null ? 'all' : S.srcFilter));
    root.querySelectorAll('[data-gact]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.gact.split(':')[1];
        if (act === '新建') createDialog();
        else if (act === '目录管理') manageDirsDialog();
        else if (act === '导入') importDialog();
        else if (act === '添加仓库') addSourceDialog();
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
