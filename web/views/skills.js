/* ====================================================================
   Skills 视图（v0.6 新布局）
   左：来源（可折叠）+ 条目分页；中：内容信息 + CRUD（仅本地）+ 批量；
   右：工具与内联更新（更新/安装/全部更新直接在基础界面完成，无弹窗）。
   ==================================================================== */
(function () {
  'use strict';
  const S = {
    sources: [], targets: [], reg: {}, items: [], total: 0, page: 1, pages: 1, perPage: 20,
    targetsStat: [], selected: new Set(), srcFilter: null, q: '', detail: null,
    expanded: false, mode: 'overview',
    localDirs: [],                                // 本地目录池（Skills/MCP 共用；id=1 起，默认目录不在此表）
    toolSel: null, toolItems: [], toolChecked: new Set(), _toolTgts: [],
    distMode: 'copy',                             // 写入方式：copy=直接复制 / link=软链接
    _tgts: [],                                    // 安装目标可多选（用户 2026-10-20「我要的多选呢」）
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

  async function loadAll() {
    const [src, tgt] = await Promise.all([api('/api/skills/sources'), api('/api/skills/targets')]);
    S.sources = src.data.sources || [];
    S.targets = tgt.data.targets || [];
    // 条目与工具角标并行取：角标来自 tool-items 聚合，刷新后不再恒为 0
    await Promise.all([loadItems(), primeToolCounts()]);
  }

  async function loadItems() {
    if (S.toolSel) return loadToolItems();
    // 目录先取：服务端读 GET /api/local-dirs 时会顺带扫描同步（外部投放的条目此刻才登记进库），
    // 条目必须在其后读，否则新登记要等下一次刷新才可见
    const dr = await api('/api/local-dirs');
    S.localDirs = dr.data.dirs || [];
    const params = new URLSearchParams({ page: S.page, per_page: S.perPage });
    if (S.srcFilter === 'manual') params.set('source', 'manual');
    else if (typeof S.srcFilter === 'number') params.set('source', S.srcFilter);
    else if (String(S.srcFilter || '').indexOf('dir:') === 0) {
      params.set('source', 'manual');             // 本地目录卡 = 手动条目再按目录过滤
      params.set('dir', String(S.srcFilter).slice(4));
    }
    if (S.q) params.set('q', S.q);
    const [lv, rg] = await Promise.all([
      api('/api/skills/items?' + params.toString()),
      api('/api/skills/registry')]);
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
    const r = await api('/api/skills/tool-items' + qs);
    S.toolItems = r.data.items || [];
    S.toolChecked = new Set();
  }

  // 提取收编：以工具内容为准入库（diff 先备份本地库），完成后刷新工具视图
  async function extractSelected(names) {
    if (!S.toolSel || !names.length) return;
    const r = await post('/api/skills/extract', { tool: S.toolSel.id, names });
    const items = r.data.items || [];
    const okN = items.filter(x => x.ok && !x.skipped).length;
    const skipN = items.filter(x => x.skipped).length;
    const fails = items.filter(x => !x.ok);
    HubUI.toast(`提取完成 · 收编 ${okN} · 跳过 ${skipN}${fails.length ? ' · 失败 ' + fails.length : ''}`,
      fails.length ? 'warn' : 'success', 5600);
    if (fails.length) HubUI.toast(fails.map(x => `${x.name}（${x.error || ''}）`).join('；'), 'error', 5600);
    await loadToolItems();
    const c = document.querySelector('#view-skills .nv-center');
    if (c) renderCenter(c);
    const right = document.querySelector('#view-skills .nv-right');
    if (right) renderToolRight(right);
    syncPanelOpen();
  }

  function selectedRows() { return S.items.filter(it => S.selected.has(it.name)); }

  /* ============================== 左栏 ============================== */
  function renderLeft(el) {
    const manualCount = S.total && S.srcFilter === 'manual'
      ? S.total : (S._manualTotal != null ? S._manualTotal : '');
    const srcRows = [
      { key: 'all', name: '全部', count: '', dot: 'var(--c-accent)' },
      { key: 'manual', name: '本地', count: manualCount, dot: '', local: true },
      ...S.sources.map(s => ({
        key: String(s.id), name: s.name, count: s.item_count,
        dot: s.last_error ? 'var(--c-err)' : 'var(--c-accent)',
        err: s.last_error, sid: s.id,
      })),
    ];
    const shown = S.expanded ? srcRows : srcRows.slice(0, 5);
    el.innerHTML = `
      <div class="nv-h"><span>来源</span><button class="hub-btn btn-sm" data-testid="skills-add-source">＋ 添加</button></div>
      <div class="nv-srcs" data-testid="skills-sources">
        ${shown.map(sr => `
          <div class="nv-src-row ${sr.key === 'manual' && S.srcFilter === 'manual' || sr.key === 'all' && !S.srcFilter || sr.key !== 'all' && sr.key !== 'manual' && S.srcFilter === Number(sr.key) ? 'is-on' : ''}" data-src="${sr.key}">
            <span class="tool-dot ${sr.local ? 'tool-dot--local' : ''}" ${sr.dot ? `style="background:${sr.dot}"` : ''}></span>
            <span class="nv-sname">${esc(sr.name)}</span>
            ${sr.err ? '' : `<span class="nv-scount">${sr.count}</span>`}
            ${sr.sid ? `<span class="nv-acts"><button class="hub-btn btn-sm" data-testid="skills-edit-${sr.sid}">编辑</button>
            <button class="hub-btn btn-sm" data-testid="skills-pull-${sr.sid}">拉取</button>
            <button class="hub-btn btn-sm" data-testid="skills-del-${sr.sid}">移除</button></span>` : ''}
          </div>`).join('')}
      </div>
      ${srcRows.length > 5 ? `<div class="nv-fold" data-testid="skills-src-fold">${S.expanded ? '收起 ▴' : '显示全部 ' + srcRows.length + ' 个来源 ▾'}</div>` : ''}
      ${(() => {
        // 工具来源组：取「启用且有 skills 目录」的工具（与顶部卡片同一口径），整行点击进入提取模式
        const list = toolSources();
        if (!list.length) return '';
        return `<div class="nv-h"><span>工具（提取来源）</span></div>
        <div class="nv-srcs" data-testid="skills-tool-srcs">
          ${list.map(t => `
            <div class="nv-src-row ${S.toolSel && S.toolSel.id === t.id ? 'is-on' : ''}" data-tool="${esc(t.id)}" data-testid="skills-tool-src">
              <span class="tool-dot tool-dot--local"></span>
              <span class="nv-sname">${esc(t.name)}</span>
            </div>`).join('')}
        </div>`;
      })()}
      <div class="nv-h" style="margin-top:var(--sp-2)"><span>条目</span><span class="nv-cnt" data-testid="skills-total">${S.total}</span></div>
      <div class="nv-filter"><input class="hub-input" data-testid="skills-search" placeholder="搜索条目…" value="${esc(S.q)}"></div>
      <div class="nv-list" data-testid="skills-list">
        ${S.items.map(it => MV.item({
          id: it.name, testid: 'skills-row', chkTestid: 'skills-check',
          sel: S.selected.has(it.name),
          // 来源标识区分目录（2026-10-31）：链接目录内的条目显示目录名，默认库仍显示「本地」
          chipText: it.manual ? (it.dir_name ? String(it.dir_name).slice(0, 2).toUpperCase() : '本地')
                              : String(it.source_name || '').slice(0, 2).toUpperCase(),
          chipCls: it.manual ? 'chip--muted'
            : (typeof toolColorCls === 'function' ? toolColorCls(it.source_id != null ? { color: (S.sources || []).find(x => String(x.key != null ? x.key : x.id) === String(it.source_id)) && (S.sources || []).find(x => String(x.key != null ? x.key : x.id) === String(it.source_id)).color } : null) : 'chip--accent'),
          title: it.name,
          // 来源并入左侧副标题行（用户指令 2026-10-20：元信息不再挂行右侧）
          sub: (it.manual ? (it.dir_name || '本地') : String(it.source_name || '')) + ' · ' + (it.description || ''),
          // 行头动作（悬停显示，对齐 MCP 条目行，用户指令 2026-10-19）：编辑 / 复制 / 删除
          extra: '<span class="mvi-acts">' + [
            { key: 'edit', label: '编辑', manualOnly: true },
            { key: 'copy', label: '复制' },
            { key: 'del', label: '删除', danger: true, manualOnly: true },
          ].map(a => `<button class="hub-btn btn-sm${a.danger ? ' hub-btn--danger' : ''}" data-acc="${a.key}"`
              + `${a.manualOnly && !it.manual ? ' disabled title="远程条目只读（改源仓库后拉取）"' : ''}>${a.label}</button>`).join('') + '</span>',
        })).join('') || '<div class="hub-empty">没有条目<div class="hub-empty__hint">拉取源仓库或手动新建</div></div>'}
      </div>
      <div class="nv-pager" data-testid="skills-pager">
        <button class="nv-pbtn" data-sel="all" data-testid="skills-sel-all" title="全选本页">全选</button>
        <button class="nv-pbtn" data-sel="invert" data-testid="skills-sel-invert" title="反选本页">反选</button>
        <button class="nv-pbtn" data-sel="none" data-testid="skills-sel-none" title="清空选择" ${S.selected.size ? '' : 'disabled'}>清空</button>
        <span class="nv-sep"></span>
        <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? 'disabled' : ''}>‹</button>
        ${pageButtons()}
        <button class="nv-pbtn" data-p="next" ${S.page >= S.pages ? 'disabled' : ''}>›</button>
        <span class="nv-pinfo" data-testid="skills-pinfo">已选 ${S.selected.size} · 显示 ${S.items.length} 条 · 共 ${S.total} 条</span>
      </div>`;
    el.querySelector('[data-testid="skills-add-source"]').onclick = addSourceDialog;
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
    // 工具来源行：点击进入该工具的提取模式
    el.querySelectorAll('[data-tool]').forEach(row => {
      row.onclick = async () => {
        const tid = row.dataset.tool;
        const name = (row.querySelector('.nv-sname') || {}).textContent || tid;
        if (S.toolSel && S.toolSel.id === tid) S.toolSel = null;
        else S.toolSel = { id: tid, name };
        S.srcFilter = null; S._detailName = null; S.mode = 'overview';
        S._toolTgts = []; S.toolChecked = new Set(); S._panelOff = false;
        await refresh();
        syncPanelOpen();
      };
    });
    const fold = el.querySelector('[data-testid="skills-src-fold"]');
    if (fold) fold.onclick = async () => { S.expanded = !S.expanded; await refresh({ parts: ['rows'] }); };
    el.querySelectorAll('[data-testid^="skills-pull-"]').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sid = btn.dataset.testid.replace('skills-pull-', '');
        await pullSource(sid, btn);
      };
    });
    el.querySelectorAll('[data-testid^="skills-edit-"]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        editSourceDialog(Number(btn.dataset.testid.replace('skills-edit-', '')));
      };
    });
    el.querySelectorAll('[data-testid^="skills-del-"]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        delSourceDialog(btn.dataset.testid.replace('skills-del-', ''));
      };
    });
    const search = el.querySelector('[data-testid="skills-search"]');
    let deb;
    search.oninput = () => {
      clearTimeout(deb);
      deb = setTimeout(async () => { S.q = search.value.trim(); S.page = 1; await refresh({ parts: ['rows'] }); }, 350);
    };
    el.querySelectorAll('[data-testid="skills-row"]').forEach(row => {
      row.querySelector('input').onclick = (e) => {
        e.stopPropagation();
        const nm = row.dataset.id;
        e.target.checked ? S.selected.add(nm) : S.selected.delete(nm);
        S.mode = S.selected.size ? 'multi' : 'overview';
        S._panelOff = false;   // 新的勾选动作重新打开右栏（× 收起后不再常闭）
        renderCenter(document.querySelector('#view-skills .nv-center'));
        renderRight(document.querySelector('#view-skills .nv-right'));
        syncPanelOpen();
      };
      // 行头动作（悬停显示）：编辑 / 复制 / 删除 —— 与原展开体按钮同行为（对齐 MCP 条目行）
      const rowIt = S.items.find(x => x.name === row.dataset.id);
      if (rowIt) row.querySelectorAll('.mvi-acts [data-acc]').forEach(b => {
        b.onclick = async (e) => {
          e.stopPropagation();
          if (b.dataset.acc === 'edit') editDialog(rowIt.name);
          if (b.dataset.acc === 'del') deleteFlow(rowIt.name, () => showDetailClose());
          if (b.dataset.acc === 'copy') {
            const rr = await api('/api/skills/item/' + encodeURIComponent(rowIt.name));
            const md = ((rr.data || {}).skill_md || '（未找到 SKILL.md）');
            (await copyText(md)) ? HubUI.toast('已复制 SKILL.md', 'success')
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
        renderCenter(document.querySelector('#view-skills .nv-center'));
        renderRight(document.querySelector('#view-skills .nv-right'));
        syncPanelOpen();
      };
    });
    // 外壳页脚的计数不在 renderLeft 的 DOM 内，重绘后同步一次（否则全选/反选后仍显示旧值）
    const info = document.getElementById('sk-info');
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

  /**
   * 本地缓存同步：远端仓库改了、但本机连不上 github（拉取报 443）时，
   * 只要你在这个仓库里手动 pull 过，这里就能在不联网的情况下把新提交同步进索引。
   * 幂等且很快（缓存与索引一致时后端直接返回 unchanged）。
   */
  async function syncLocalIfStale() {
    for (const src of (S.sources || [])) {
      const sid = src.key != null ? src.key : src.id;
      try {
        const r = await post(`/api/skills/sources/${sid}/sync-local`, {});
        const d = r.data || {};
        if (d.ok && !d.unchanged) {
          const n = (d.added || []).length, m = (d.changed || []).length, k = (d.removed || []).length;
          if (n + m + k) {
            HubUI.toast(`已从本地缓存同步「${src.name}」：新增 ${n} / 变更 ${m} / 移除 ${k}（未联网）`, 'success', 6400);
          }
        } else if (!d.ok && /缓存|失败/.test(d.error || '')) {
          HubUI.toast(`本地缓存同步失败（${src.name}）：${(d.error || '').slice(0, 60)}`, 'warn', 5200);
        }
      } catch (e) { /* 单个源失败不影响其它 */ }
    }
  }

  /** 行内进度胶囊：批量操作时把每条的状态就地标出来（写入中 → 完成/跳过/冲突/失败） */
  function markRows(names, text, tone) {
    (names || []).forEach(n => {
      const row = document.querySelector(`#sk-rows .mvi[data-id="${CSS.escape(String(n))}"]`);
      if (!row) return;
      const head = row.querySelector('.mvi__head');
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

  /** 高亮一批条目行（拉取/更新后告诉用户"这几条是新的/变了的"） */
  function flashNames(names) {
    (names || []).forEach(n => {
      const row = document.querySelector(`#sk-rows .mvi[data-id="${CSS.escape(String(n))}"]`);
      if (row && typeof flash === 'function') flash(row);
    });
  }

  async function pullSource(sid, btn) {
    if (btn) btn.classList.add('is-loading');
    const r = await post('/api/skills/sources/' + sid + '/pull');
    if (btn) btn.classList.remove('is-loading');
    if (r.data.ok) {
      if (r.data.needs_action) { HubUI.sourceRemovedDialog('skills', sid, r.data, { afterRemove }); return; }
      const d = r.data;
      HubUI.toast(`拉取完成 · 新增 ${d.added.length} / 变更 ${d.changed.length} / 移除 ${d.removed.length}`,
        d.added.length + d.changed.length ? 'success' : 'info');
      await primeAllCache();                             // 拉取后全量缓存失效：先刷新再重绘卡片计数
      await refresh();                                   // 拉取会改来源/条目/目标，全刷
      flashNames([...(d.added || []), ...(d.changed || [])]);   // 结束后高亮变化项
      return;
    }
    HubUI.toast('拉取失败：' + (r.data.error || ''), 'error', 5200);
    await refresh();
  }

  // 源被移除/清理后的收尾：清掉指向该源的筛选并刷新（传给 HubUI 公共对话框）
  async function afterRemove(sid) {
    if (S.srcFilter === Number(sid)) { S.srcFilter = null; S.page = 1; }
    await refresh();
  }

  function delSourceDialog(sid) {
    // 移除源：本地库有该源条目时给三选（删除 / 转为本地 / 取消）；否则普通确认
    const src = S.sources.find(s => String(s.id) === sid);
    const name = src ? src.name : sid;
    const rc = src ? (src.registry_count || 0) : 0;
    if (rc > 0) {
      HubUI.sourceRemovedForDelete('skills', sid, name, rc, { afterRemove });
      return;
    }
    HubUI.confirm('移除源', `确认移除源「${esc(name)}」？该源没有已拉取到本地库的条目。`, async () => {
      const r = await api('/api/skills/sources/' + sid, { method: 'DELETE' });
      if (r.data.ok) {
        HubUI.toast('已移除源', 'success');
        if (S.srcFilter === Number(sid)) { S.srcFilter = null; S.page = 1; }
        await refresh();
      } else HubUI.toast('移除失败：' + (r.data.error || ''), 'error');
    }, { confirmText: '移除', danger: true });
  }

  function editSourceDialog(sid) {
    const src = S.sources.find(s => s.id === sid);
    if (!src) return;
    HubUI.modal({
      title: '编辑源 · ' + src.name, hasInput: false, confirmText: '保存', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="se-name" data-testid="skills-edit-name" value="${esc(src.name)}"></label>
          <label>Git URL<input class="hub-input" id="se-url" data-testid="skills-edit-url" value="${esc(src.url)}"></label>
          <label>分支<input class="hub-input" id="se-branch" value="${esc(src.branch || 'main')}"></label>
          <label>子目录（可选）<input class="hub-input" id="se-subdir" value="${esc(src.subdir || '')}"></label>
          <label>凭据引用（可选）<input class="hub-input" id="se-auth" value="${esc(src.auth_ref || '')}" placeholder="env:GITHUB_TOKEN 或 file:~/.secrets/token"></label>
          <label>定时拉取（分钟，0=关闭）<input class="hub-input" id="se-poll" value="${src.poll_min || 0}" inputmode="numeric"></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">保存后立即生效；改 URL / 分支后建议点一次「拉取」同步内容。</div>`,
      onConfirm: async () => {
        const body = {
          name: document.getElementById('se-name').value.trim(),
          url: document.getElementById('se-url').value.trim(),
          branch: document.getElementById('se-branch').value.trim() || 'main',
          subdir: document.getElementById('se-subdir').value.trim(),
          auth_ref: document.getElementById('se-auth').value.trim() || null,
          poll_min: Math.max(0, parseInt(document.getElementById('se-poll').value, 10) || 0),
        };
        const r = await api('/api/skills/sources/' + sid, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (r.data.ok) { HubUI.toast('已保存源', 'success'); await refresh(); }
        else { HubUI.toast('保存失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  function addSourceDialog() {
    HubUI.modal({
      title: '添加 Skills 源仓库', hasInput: false, confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="src-name" placeholder="my-skills"></label>
          <label>Git URL<input class="hub-input" id="src-url" placeholder="https://github.com/org/repo.git"></label>
          <label>分支<input class="hub-input" id="src-branch" value="main"></label>
          <label>子目录（可选）<input class="hub-input" id="src-subdir" placeholder="skills/"></label>
          <label>凭据引用（可选）<input class="hub-input" id="src-auth" placeholder="env:GITHUB_TOKEN 或 file:~/.secrets/token"></label>
          <label>定时拉取（分钟，0=关闭）<input class="hub-input" id="src-poll" value="0" inputmode="numeric"></label>
        </div>`,
      onConfirm: async () => {
        const body = {
          name: document.getElementById('src-name').value.trim(),
          url: document.getElementById('src-url').value.trim(),
          branch: document.getElementById('src-branch').value.trim() || 'main',
          subdir: document.getElementById('src-subdir').value.trim(),
          auth_ref: document.getElementById('src-auth').value.trim() || null,
          poll_min: Math.max(0, parseInt(document.getElementById('src-poll').value, 10) || 0),
        };
        const r = await post('/api/skills/sources', body);
        if (r.data.ok) { HubUI.toast('已添加源', 'success'); await refresh(); }
        else { HubUI.toast('添加失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  function addTargetDialog() {
    HubUI.modal({
      title: '添加分发目标', confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="tgt-name" placeholder="my-project skills"></label>
          <label>工具${HubUI.select({ id: 'tgt-tool', value: TOOL_LIST.length ? TOOL_LIST[0].id : 'plain',
            options: [...TOOL_LIST.map(t => ({ value: t.id, label: t.name })), { value: 'plain', label: '通用 (.agents)' }] })}</label>
          <label>目标目录（skills 将写入其下的 &lt;name&gt;/）<input class="hub-input" id="tgt-path" placeholder="/path/to/repo/.claude/skills"></label>
        </div>`,
      onConfirm: async () => {
        const r = await post('/api/skills/targets', {
          name: document.getElementById('tgt-name').value.trim(),
          kind: 'skills_dir',
          tool: document.getElementById('tgt-tool').value,
          path: document.getElementById('tgt-path').value.trim(),
        });
        if (r.data.ok) { HubUI.toast('已添加目标', 'success'); await refresh(); }
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
    const staleTargets = S.targetsStat.filter(t => t.items.stale > 0 || t.items.missing > 0);
    const focusRows = [];
    for (const t of staleTargets) {
      if (t.items.stale) focusRows.push({ kind: 'stale', t });
      if (t.items.missing && t.items.total) focusRows.push({ kind: 'missing', t });
    }
    const focus = focusRows.slice(0, 4);
    const recent = S.ledger || [];
    el.innerHTML = `
      <div class="nv-stats" data-testid="skills-stats">
        <div class="nv-stat"><b>${S.total}</b><span>条目${S.srcFilter ? ' · 当前来源' : ' · 全部来源'}</span></div>
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => r.manual).length}</b><span>本地</span></div>
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => !r.manual).length}</b><span>远程拉取</span></div>
        <div class="nv-stat"><b>${S.targetsStat.reduce((a, t) => a + t.items.total, 0)}</b><span>已部署到工具</span></div>
        <div class="nv-stat"><b style="color:var(--c-warn)">${S.targetsStat.reduce((a, t) => a + t.items.stale + t.items.missing, 0)}</b><span>待更新 / 待安装</span></div>
      </div>
      <div class="nv-sec nv-hide"><span>创建本地条目</span></div>
      <div class="nv-mkrow nv-hide"><span class="nv-mt">＋ 新建 Skill</span><span class="nv-msub">填写名称与 SKILL.md，入本地库</span><button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-create">新建</button></div>
      <div class="nv-mkrow nv-hide"><span class="nv-mt">⇩ 从本地目录导入</span><span class="nv-msub">复制现有目录为手动条目，原目录只读</span><button class="hub-btn btn-sm" data-testid="skills-import">导入</button></div>
`;

    el.querySelectorAll('[data-kind]').forEach(btn => {
      btn.onclick = () => inlineUpdate({
        names: btn.dataset.kind === 'stale' ? (S.targetsStat.find(t => t.id === Number(btn.dataset.tid)).stale_names || [])
               : null, tid: Number(btn.dataset.tid), installAll: btn.dataset.kind !== 'stale',
      });
    });
    const updAll = el.querySelector('[data-testid="skills-update-all"]');
    if (updAll) updAll.onclick = updateAllToTargets;
    el.querySelector('[data-testid="skills-create"]').onclick = createDialog;
    el.querySelector('[data-testid="skills-import"]').onclick = importDialog;
  }

  function renderDetail(el) {
    const it = S.items.find(x => x.name === S._detailName);
    const reg = S.reg[S._detailName] || {};
    if (!it) { S.mode = 'overview'; renderOverview(el); return; }
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">${esc(it.name)} ${manualBadge(it.manual)} ${badge(it.status)}</div>
        <div class="nv-ddesc">${esc(it.description || '（无描述）')} · 来源：${esc(it.source_name)}${it.manual ? ' · 无版本快照' : ' · v' + esc(String(it.version || '').slice(0, 12))}</div>
        <div class="nv-dops" data-testid="skills-detail-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-create">＋ 新建</button>
          ${it.manual ? `
            <button class="hub-btn btn-sm" data-testid="skills-edit">编辑</button>
            <button class="hub-btn btn-sm" data-testid="skills-reimport">重新导入</button>` : `
            <button class="hub-btn btn-sm" data-testid="skills-update-local">更新到本地</button>`}
          ${it.manual ? '<span class="nv-sep"></span><button class="hub-btn btn-sm hub-btn--danger" data-testid="skills-delete">删除</button>' : ''}
          ${!it.manual ? '<button class="hub-btn btn-sm" data-testid="skills-diff">与源对比</button>' : ''}
        </div>
      </div>
      <div id="nv-skill-body">${window.skeletonRows ? skeletonRows(2) : '<div class="nv-note">加载中…</div>'}</div>`;
    bindDetailOps(el, it, reg);
    loadDetailBody(it, reg);
  }

  async function loadDetailBody(it, reg) {
    const body = document.getElementById('nv-skill-body');
    if (!body) return;
    let d = {};
    try { d = (await api('/api/skills/item/' + encodeURIComponent(it.name))).data || {}; } catch { d = {}; }
    if (!document.getElementById('nv-skill-body')) return;
    const deps = reg.deployments || [];
    body.innerHTML = `
      <div class="nv-sec"><span>SKILL.md</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">${(d.files || []).length} 文件</span></div>
      <pre class="sb-md">${esc((d.skill_md || '（未找到 SKILL.md）').slice(0, 6000))}</pre>
      ${(d.files || []).length > 1 ? `
      <div class="nv-sec"><span>文件</span></div>
      ${(d.files || []).filter(f => f !== 'SKILL.md').map(f => `<div class="nv-frow"><span class="mono-xs">${esc(f)}</span></div>`).join('')}` : ''}
      ${!it.manual ? `
      <div class="nv-sec"><span>与源对比</span></div>
      <pre class="sb-diff" data-testid="skills-diff" id="nv-diff">加载中…</pre>` : ''}`;
    if (!it.manual) {
      api('/api/skills/diff?name=' + encodeURIComponent(it.name)).then(r => {
        const el = document.getElementById('nv-diff');
        if (el) el.textContent = (r.data && r.data.diff) || '（无差异）';
      });
    }
  }

  function bindDetailOps(el, it, reg) {
    el.querySelector('[data-testid="skills-create"]').onclick = createDialog;
    const edit = el.querySelector('[data-testid="skills-edit"]');
    if (edit) edit.onclick = () => editDialog(it.name);
    const reimp = el.querySelector('[data-testid="skills-reimport"]');
    if (reimp) reimp.onclick = () => reimportDialog(it.name);
    const del = el.querySelector('[data-testid="skills-delete"]');
    if (del) del.onclick = () => deleteFlow(it.name, () => showDetailClose());
    const updLocal = el.querySelector('[data-testid="skills-update-local"]');
    if (updLocal) updLocal.onclick = async () => {
      updLocal.classList.add('is-loading');
      const r = await post('/api/skills/registry/update', { names: [it.name] });
      updLocal.classList.remove('is-loading');
      notifyResults('更新到本地', r.data);
      await refresh();
      if (r.data.ok) { showDetail(it.name); flashNames([it.name]); }
    };
    const diff = el.querySelector('[data-testid="skills-diff"]');
    if (diff) diff.onclick = () => {};
  }

  function renderMulti(el) {
    const rows = selectedRows();
    const localSel = rows.filter(r => r.manual);
    const remoteSel = rows.filter(r => !r.manual);
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">已选 ${rows.length} 条 <span class="hub-badge hub-badge--neutral">本地 ${localSel.length} · 远程 ${remoteSel.length}</span></div>
        <div class="nv-ddesc">批量操作只作用于可操作的条目：删除仅限本地条目；远程条目的更新走「更新到本地」。</div>
        <div class="nv-dops" data-testid="skills-batch-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-batch-update">批量更新到工具（右栏）</button>
          <button class="hub-btn btn-sm" data-testid="skills-create">＋ 新建</button>
          ${remoteSel.length ? '<button class="hub-btn btn-sm" data-testid="skills-batch-pull-local">更新远程条目到本地（' + remoteSel.length + '）</button>' : ''}
          ${localSel.length ? '<span class="nv-sep"></span><button class="hub-btn btn-sm hub-btn--danger" data-testid="skills-batch-delete">批量删除本地（' + localSel.length + '）</button>' : ''}
        </div>
      </div>
      <div class="nv-sec"><span>已选清单</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">${rows.length} 条</span></div>
      ${rows.map(r => `
        <div class="nv-deprow">
          <span class="nv-dt">${esc(r.name)}</span>
          <span class="nv-dv">${esc(r.source_name)}${r.manual ? '' : ' · v' + esc(String(r.version || '').slice(0, 8))}</span>
          <span class="hub-badge sb-status--${(S.reg[r.name] ? (S.reg[r.name].deployments || []).length : 0) ? 'ok' : 'neutral'}">${(S.reg[r.name] ? (S.reg[r.name].deployments || []).length : 0) ? '已部署 ' + (S.reg[r.name].deployments || []).length + ' 处' : '未部署'}</span>
          <span><button class="hub-btn btn-sm" data-un="${esc(r.name)}">取消选择</button></span>
        </div>`).join('')}`;
    el.querySelectorAll('[data-un]').forEach(b => {
      b.onclick = () => { S.selected.delete(b.dataset.un); renderCenter(el); renderRight(document.querySelector('#view-skills .nv-right')); };
    });
    el.querySelector('[data-testid="skills-batch-update"]').onclick = () => batchUpdate();
    el.querySelector('[data-testid="skills-create"]').onclick = createDialog;
    const pl = el.querySelector('[data-testid="skills-batch-pull-local"]');
    if (pl) pl.onclick = async () => {
      pl.classList.add('is-loading');
      const r = await post('/api/skills/registry/update', { names: remoteSel.map(x => x.name) });
      pl.classList.remove('is-loading');
      notifyResults('更新到本地', r.data);
      await refresh();
      flashNames(remoteSel.map(x => x.name));
    };
    const bd = el.querySelector('[data-testid="skills-batch-delete"]');
    if (bd) bd.onclick = () => {
      HubUI.confirm('批量删除本地条目', `将删除 ${localSel.length} 个本地条目；已部署的会连同目标内文件一起删除（先备份）。`, async () => {
        const results = [];
        for (const nm of localSel.map(x => x.name)) {
          const r = await api('/api/skills/registry/item/' + encodeURIComponent(nm) + '?force=1', { method: 'DELETE' });
          results.push({ item: nm, status: r.data.ok ? 'ok' : 'failed', reason: r.data.error });
        }
        const okN = results.filter(x => x.status === 'ok').length;
        HubUI.toast(`批量删除完成 · 成功 ${okN} / 失败 ${results.length - okN}`, results.length - okN ? 'warn' : 'success', 5200);
        S.selected.clear(); S.mode = 'overview';
        await refresh();
      }, { confirmText: '确认删除', danger: true });
    };
  }

  /* ============================== 工具来源视图（中/右栏） ============================== */
  function renderToolCenter(el) {
    const items = S.toolItems;
    const extractable = items.filter(i => i.state !== 'synced');
    const checked = items.filter(i => S.toolChecked.has(i.name));
    const cnt = (st) => items.filter(i => i.state === st).length;
    el.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle">工具来源 · ${esc(S.toolSel.name)} <span class="hub-badge hub-badge--neutral">${items.length} 条</span></div>
        <div class="nv-ddesc">该工具 skills 目录中实际存在的条目，与本地库对齐。勾选后右侧选目标工具一键同步（同名覆盖）；工具内文件保留不动。</div>
        <div class="nv-dops" data-testid="skills-tool-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-tool-extract" ${checked.length ? '' : 'disabled'}>提取所选（${checked.length}）</button>
          <button class="hub-btn btn-sm" data-testid="skills-tool-extract-all" ${extractable.length ? '' : 'disabled'}>提取全部可收编（${extractable.length}）</button>
        </div>
      </div>
      <div class="nv-sec"><span>条目</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">未收编 ${cnt('local_only')} · 有差异 ${cnt('diff')} · 一致 ${cnt('synced')}</span></div>
      ${items.map(it => `
        <div class="nv-deprow" data-name="${esc(it.name)}" data-testid="skills-tool-row">
          <input type="checkbox" data-testid="skills-tool-check" ${S.toolChecked.has(it.name) ? 'checked' : ''}>
          <span class="nv-dt">${esc(it.name)}</span>
          ${stateBadge(it.state)}
          <span class="nv-dv">${esc(it.tools.map(t => t.name).join(' · '))}</span>
        </div>`).join('') || '<div class="nv-note">该工具 skills 目录为空或不存在</div>'}`;
    el.querySelectorAll('[data-testid="skills-tool-check"]').forEach(cb => {
      cb.onchange = () => {
        const name = cb.closest('[data-name]').dataset.name;
        cb.checked ? S.toolChecked.add(name) : S.toolChecked.delete(name);
        if (cb.checked) S._panelOff = false;   // 新的勾选动作重新打开右栏
        renderToolCenter(el);
        const right = document.querySelector('#view-skills .nv-right');
        if (right) renderToolRight(right);
        syncPanelOpen();
      };
    });
    el.querySelector('[data-testid="skills-tool-extract"]').onclick = () => extractSelected(checked.map(i => i.name));
    el.querySelector('[data-testid="skills-tool-extract-all"]').onclick = () => extractSelected(extractable.map(i => i.name));
  }

  /** 工具视图右栏：勾选的条目 + 其它工具作为同步目标（源工具自身不作为目标） */
  function renderToolRight(el) {
    const checked = (S.toolItems || []).filter(i => S.toolChecked.has(i.name));
    const n = checked.length;
    const own = S.toolSel ? S.toolSel.id : null;
    const targets = (S.targets || []).filter(t => {
      const ids = Array.isArray(t.tool_ids) && t.tool_ids.length ? t.tool_ids : [t.tool];
      return !ids.includes(own);
    });
    const ids = new Set(targets.map(t => String(t.id)));
    S._toolTgts = (S._toolTgts || []).map(String).filter(id => ids.has(id));
    const picker = MV.targetPicker({
      prefix: 'skt',
      emptyHint: '没有其它工具可同步，先到 设置 → 工具 接入 Skills 目录',
      items: targets.map(t => {
        const tl = TOOL_LIST.find(x => x.id === (t.tool || '')) || null;
        const aliases = t.tool_names || [];
        const others = aliases.filter(n => n !== (t.tool_name || t.name));
        return { id: t.id, name: t.tool_name || t.name,
                 sub: others.join(' / '),
                 title: aliases.length ? aliases.join(' / ') : (t.tool_name || t.name),
                 dotCls: tl ? toolColorCls(tl) : 'tool-dot--local',
                 testid: `skills-tool-target-${t.id}` };
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
      extraHTML: distModeHTML('skt'),
    });
    el.innerHTML = `
      <div class="spanel__h">
        <h3>目标</h3>
        <span style="flex:1"></span>
        <button class="spanel__x" data-testid="skills-tool-panel-close" title="收起" aria-label="收起">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      ${picker.html}
      <div class="nv-sec"><span>说明</span></div>
      <div class="nv-note">勾选左侧条目 → 选目标 → 一键同步。条目先以工具内容为准收编进本地库，再写入目标；同名内容先备份后覆盖。</div>`;
    el.querySelector('[data-testid="skills-tool-panel-close"]').onclick = () => {
      S._panelOff = true;
      syncPanelOpen();
    };
    picker.bind(el);
    bindDistMode(el);
  }

  /** 工具 → 其它工具一键同步（后端复用提取 + 分发管线） */
  async function syncToolToTargets(names, tids) {
    if (!S.toolSel) return;
    if (!names.length) { HubUI.toast('先勾选条目', 'warn'); return; }
    if (!tids.length) { HubUI.toast('先选目标工具', 'warn'); return; }
    const btn = document.querySelector('[data-testid="skt-picker-go"]');
    if (btn) btn.classList.add('is-loading');
    const r = await post('/api/skills/tool-sync', { tool: S.toolSel.id, names, target_ids: tids, mode: S.distMode });
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

  /* ============================== 右栏 ============================== */
  /** 当前已选目标（顺序跟随列表） */
  function pickedTargets() {
    const set = new Set(S._tgts || []);
    return S.targetsStat.filter(t => set.has(t.id));
  }
  /** 「已选」行内容：统一与会话一致（已选 N 条 / 当前：…），不带模块名 */
  function selBarHTML(n) {
    return n ? `已选 <b class="mono">${n}</b> 条` : `当前：${esc(S._detailName || '全部条目')}`;
  }

  /** 写入方式切换：直接复制 / 软链接（后端保证同名只保留一种表示）。 */
  function distModeHTML(prefix) {
    const pressed = (m) => (S.distMode === m ? 'true' : 'false');
    return `
      <div class="spanel__mode" data-testid="${prefix}-dist-mode">
        <div class="spanel__modetop">
          <span class="spanel__modelbl">写入方式</span>
          <span class="spanel__modehint">同名只保留一种</span>
        </div>
        <div class="spanel__modebtns">
          <button class="hub-btn btn-sm ${S.distMode === 'copy' ? 'is-on' : ''}"
            data-mode="copy" data-testid="${prefix}-mode-copy" aria-pressed="${pressed('copy')}"
            title="把技能文件复制进目标目录，目标可独立修改">
            <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>直接复制
          </button>
          <button class="hub-btn btn-sm ${S.distMode === 'link' ? 'is-on' : ''}"
            data-mode="link" data-testid="${prefix}-mode-link" aria-pressed="${pressed('link')}"
            title="在目标目录创建指向本地库的软链接，内容跟随本地库">
            <svg class="stgt-frame" aria-hidden="true"><path class="fr-up" pathLength="1"/><path class="fr-dn" pathLength="1"/></svg>软链接
          </button>
        </div>
      </div>`;
  }

  /** 绑定方式切换：两个面板（主列表 / 工具来源）共享同一个 S.distMode。 */
  function bindDistMode(host) {
    if (!host) return;
    host.querySelectorAll('.spanel__mode [data-mode]').forEach(b => {
      b.onclick = () => {
        S.distMode = b.dataset.mode === 'link' ? 'link' : 'copy';
        document.querySelectorAll('#view-skills .spanel__mode [data-mode]').forEach(x => {
          const on = x.dataset.mode === S.distMode;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
    });
    HubUI.drawFrames(host);   // 与目标行 / 来源卡片同一套描边生长帧
  }

  function renderRight(el) {
    if (S.toolSel) return renderToolRight(el);
    const rows = S.mode === 'detail' && S._detailName ? S.items.filter(x => x.name === S._detailName)
      : S.mode === 'multi' ? selectedRows() : [];
    const n = rows.length;
    const staleAll = S.targetsStat.reduce((a, t) => a + t.items.stale, 0);
    const missingAll = S.targetsStat.reduce((a, t) => a + t.items.missing, 0);
    // 右栏对齐会话「迁移目标」面板（用户指令 2026-10-19）：安装目标头 + 当前框 + 单选目标行 + Go + lineage；
    // 批量维护动作（一键更新/安装缺失/全部更新）与「＋ 添加」保留；行悬停高亮走 .hub-hoverlayer（通用）
    const targets = S.targetsStat;
    // 已被移除的目标自动退出选中集合
    S._tgts = (S._tgts || []).filter(id => targets.some(t => t.id === id));
    const tgts = pickedTargets();          // 已选目标（多选）
    // 统一目标选择组件（用户 2026-10-20「将这个组件应用在所有模块」）
    const picker = MV.targetPicker({
      prefix: 'sk',
      emptyHint: '当前没有 skills_dir 目标，先在 设置 → 工具 里接入',
      items: targets.map(t => {
        const tl = TOOL_LIST.find(x => x.id === (t.tool || '')) || null;
        const aliases = t.tool_names || [];
        const others = aliases.filter(n => n !== (t.tool_name || t.name));
        return { id: t.id, name: t.tool_name || t.name,
                 sub: others.join(' / '),
                 title: aliases.length ? aliases.join(' / ') : (t.tool_name || t.name),
                 dotCls: tl ? toolColorCls(tl) : 'tool-dot--local',
                 testid: `skills-target-${t.id}` };
      }),
      chosen: (S._tgts || []).map(String),
      selLine: selBarHTML(n),
      selLineFn: () => selBarHTML(n),
      goText: `安装 ${n} 条到 ${tgts.length ? (tgts.length === 1 ? (tgts[0].tool_name || tgts[0].name) : tgts.length + ' 个工具') : '…'}`,
      goTextFn: (set) => {
        const list = S.targetsStat.filter(t => set.has(String(t.id)));
        const what = !list.length ? '…' : list.length === 1 ? (list[0].tool_name || list[0].name) : `${list.length} 个工具`;
        return `安装 ${n} 条到 ${what}`;
      },
      onChange: (ids) => { S._tgts = ids.map(Number); },
      onGo: (ids) => distributeTo({ names: rows.map(r => r.name), tids: ids.map(Number) }),
      extraHTML: distModeHTML('skills'),
    });
    el.innerHTML = `
      <div class="spanel__h">
        <h3>目标</h3>
        <span style="flex:1"></span>
        <button class="spanel__x" data-testid="skills-panel-close" title="收起" aria-label="收起">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="nv-uops">
        <!-- 批量动作只留「一键更新（落后数）」；「全部重写」按用户指令 2026-10-20「去掉」已移除 -->
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-inline-update" ${staleAll ? '' : 'disabled'} title="只更新「该工具已装过、且本地版本更新的」条目；没装过的请用目标右侧的「补装缺失」">一键更新（${staleAll}）</button>
      </div>
      ${picker.html}
`;
    el.querySelector('[data-testid="skills-panel-close"]').onclick = () => { S._panelOff = true; syncPanelOpen(); };
    el.querySelector('[data-testid="skills-inline-update"]').onclick = () => {
      if (!staleAll) return;
      updateOutdated();
    };
    picker.bind(el);   // 选中切换 / 全选·清空 / Go 全部由组件接管（就地切类名，保住描边动效）
    bindDistMode(el);
    // 注意：这里**不要**再调 syncShell —— 右栏每次重画都顺手重画顶部卡片，
    // 会让"只刷新列表/右栏"的局部更新白做（顶部卡片节点被换掉）。壳由 refresh({parts:['cards']}) 负责。
  }
  function renderSkillsLin() {
    const list = (S.ledger || []).slice(0, 5);
    if (!list.length) return '<div class="hub-empty">还没有安装记录</div>';
    return list.map(l => {
      let name = '';
      try { const d = JSON.parse(l.detail || '{}'); name = (d.names || []).join(' · ') || d.item_name || ''; } catch (err) { name = ''; }
      const bad = /fail|error|冲突/.test(String(l.detail || ''));
      return `<div class="led-item">
        <div class="led-item__time">${esc(String(l.ts || '').slice(5, 16))} · <span style="color:var(--c-accent)">${esc(l.action || '')}</span></div>
        <div class="led-item__act">${esc(name || '(无详情)')}${bad ? ' · 失败' : ''}</div></div>`;
    }).join('');
  }

  let _allCache = null;
  let _toolCounts = {};                 // 工具 id → 目录里实际存在的条目数（角标取数）
  async function primeAllCache() {
    const r = await api('/api/skills/items?per_page=100');
    _allCache = (r.data.items || []);
  }
  function allItemsCache() { return _allCache; }

  /** 工具来源卡片角标：取 /api/skills/tool-items 的聚合结果（按条目 tools 列表计）
   *  原先用条目上的 it.tool 过滤，但条目根本没有该字段 → 角标恒为 0（2026-10-28 修） */
  async function primeToolCounts() {
    try {
      const r = await api('/api/skills/tool-items');
      const counts = {};
      for (const it of (r.data.items || [])) {
        for (const t of (it.tools || [])) counts[t.id] = (counts[t.id] || 0) + 1;
      }
      _toolCounts = counts;
    } catch (e) { /* 计数失败不影响主流程 */ }
  }

  /** 可作为「工具来源」的工具：启用且有 skills 目录（路径为空即不出现） */
  function toolSources() {
    return ((window.hubApp && window.hubApp.state.tool_list) || [])
      .filter(t => t.enabled !== false && String(t.skills_dir || '').trim())
      .map(t => ({ id: t.id, name: t.name }));
  }

  function staleNamesFor(tid) {
    return (S.targetsStat.find(t => t.id === tid) || {}).stale_names || [];
  }

  /** 分发到多个目标（/api/skills/distribute 支持 target_ids 数组）：行内进度 + 结果回写 */
  async function distributeTo({ names, tids, label }) {
    if (!names || !names.length) { HubUI.toast('没有需要写入的条目', 'info'); return; }
    if (!tids || !tids.length) { HubUI.toast('先选安装目标', 'warn'); return; }
    markRows(names, '写入中…', 'muted');
    const r = await post('/api/skills/distribute', { names, target_ids: tids, force: true, mode: S.distMode });
    const names_ = tids.map(id => { const t = S.targetsStat.find(x => x.id === id); return t ? (t.tool_name || t.name) : id; });
    notifyResults(label || `写入 ${names_.join('、')}`, r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);                                        // 让"完成/跳过"看得见再刷新
    await refresh({ parts: ['rows', 'targets', 'ledger'] });   // 顶部卡片不重画
  }

  async function inlineUpdate({ names, tid, installAll }) {
    const target = S.targetsStat.find(t => t.id === tid);
    let list = names;
    if (installAll) list = await missingFor(tid);
    if (!list || !list.length) { HubUI.toast('没有需要更新的条目', 'info'); return; }
    markRows(list, '写入中…', 'muted');                       // 长任务：先给行内进度
    const r = await post('/api/skills/distribute', { names: list, target_ids: [tid], force: true, mode: S.distMode });
    notifyResults(`写入 ${target ? target.name : tid}`, r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);                                        // 让"完成/跳过"看得见再刷新
    await refresh({ parts: ['rows', 'targets', 'ledger'] });   // B2：顶部卡片不重画
  }

  /**
   * 一键更新：逐个工具看「它已经装过的条目」里哪些落后于本地/远仓缓存版本，只更新这些。
   * 口径（用户 2026-10-20）：本地有 A/B/C，但某工具之前只装过 A → 该工具的更新数 = 1（只有 A）。
   * 没装过的不算更新（那是「补装缺失」，各自的 missing 计数，用目标行的次级入口）。
   */
  async function updateOutdated() {
    if (!S.targetsStat.length) { HubUI.toast('没有目标', 'warn'); return; }
    let touched = 0;
    for (const t of S.targetsStat) {
      const names = t.stale_names || [];            // 只有「已装但落后」才算更新数
      if (!names.length) continue;
      await inlineUpdate({ names, tid: t.id });     // 顺带给出行内进度与结果
      touched += names.length;
    }
    if (!touched) HubUI.toast('没有需要更新的条目', 'info');
  }

  async function missingFor(tid) {
    await primeAllCache();
    const out = [];
    for (const it of (_allCache || [])) {
      const pt = (it.per_target || []).find(p => p.target_id === tid);
      if (pt && pt.state === 'missing') out.push(it.name);
    }
    return out;
  }


  async function updateAllToTargets() {
    const tids = S.targetsStat.map(t => t.id);
    if (!tids.length) { HubUI.toast('没有目标', 'warn'); return; }
    await primeAllCache();
    const names = [...new Set((_allCache || []).map(x => x.name))];
    if (!names.length) { HubUI.toast('没有条目可更新', 'info'); return; }
    markRows(names, '更新中…', 'muted');
    const r = await post('/api/skills/distribute', { names, target_ids: tids, force: true, mode: S.distMode });
    notifyResults('全部更新', r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);
    await refresh({ parts: ['rows', 'targets', 'ledger'] });
  }

  async function batchUpdate() {
    const names = [...S.selected];
    if (!names.length) { HubUI.toast('先勾选条目', 'warn'); return; }
    const tids = S.targetsStat.map(t => t.id);
    if (!tids.length) { HubUI.toast('没有目标，请先添加', 'warn'); return; }
    markRows(names, '分发中…', 'muted');
    const r = await post('/api/skills/distribute', { names, target_ids: tids, force: true, mode: S.distMode });
    notifyResults('批量分发', r.data);
    markResults(r.data && r.data.results);
    await sleepMs(500);
    await refresh({ parts: ['rows', 'targets', 'ledger'] });
  }

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
        HubUI.toast(`${x.item} → ${x.target}：${x.reason || x.status}`, tone === 'warn' ? 'warn' : 'info', 5600);
      }
    }
  }

  /* ============================== CRUD 对话框 ============================== */
  const TEMPLATE = `---\nname: NAME\ndescription: \n---\n\n# NAME\n\n在这里描述这个 skill 的用途、输入输出与工作流程。\n`;

  /* 目录选择字段（新建/导入共用）：无自定义目录时禁用（锁定默认目录，用户口径）；
     目录的落盘路径提示跟随所选值实时更新。 */
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
  function bindDirHint(id, hintId, verb) {
    const el = document.getElementById(id);
    const hint = document.getElementById(hintId);
    if (!el || !hint) return;
    const upd = () => {
      const d = (S.localDirs || []).find(x => String(x.id) === String(el.value));
      hint.textContent = `${verb} ${d ? tilde(d.path) : 'registry/skills'}/<名称>/ · 与现有条目重名将拦截 · 操作记入台账`;
    };
    upd();
    el.onchange = upd;
  }

  function createDialog() {
    HubUI.modal({
      title: '新建 Skill', hasInput: false, confirmText: '创建', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">手动编写的条目与远程拉取同库同权：保存后进入本地库，可分发到任意目标、记入台账。</div>
        <div class="form-grid">
          <label>名称<input class="hub-input" id="ms-name" data-testid="skills-new-name" placeholder="my-skill"></label>
          <label>目录${dirFieldHTML('ms-dir', 'skills-new-dir')}</label>
          <label>描述<input class="hub-input" id="ms-desc" data-testid="skills-new-desc" placeholder="一句话说明用途（写入 SKILL.md frontmatter）"></label>
          <label>SKILL.md（预填模板，可直接改写）
            <textarea class="hub-input" id="ms-body" data-testid="skills-new-body" rows="9" style="font-family:var(--font-mono);font-size:var(--fs-xs)">${esc(TEMPLATE.split('NAME').join('my-skill'))}</textarea></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)" id="ms-dir-hint"></div>`,
      onConfirm: async () => {
        const name = document.getElementById('ms-name').value.trim();
        const desc = document.getElementById('ms-desc').value.trim();
        let body = document.getElementById('ms-body').value;
        const r = await post('/api/skills/registry/item', {
          name, description: desc,
          files: { 'SKILL.md': body },
          dir_id: dirFieldVal('ms-dir'),
        });
        if (r.data.ok) { HubUI.toast('已创建 ' + name + ' · 已记入台账', 'success'); await refresh({ parts: ['rows', 'ledger'] }); showDetail(name); }
        else { HubUI.toast('创建失败：' + (r.data.error || ''), 'error', 5200); return false; }
      },
    });
    bindDirHint('ms-dir', 'ms-dir-hint', '保存后写入');
  }

  function editDialog(name) {
    api('/api/skills/item/' + encodeURIComponent(name)).then(res => {
      const d = res.data || {};
      HubUI.modal({
        title: '编辑 ' + name, hasInput: false, confirmText: '保存', cancelText: '取消',
        bodyHTML: `
          <div class="form-grid">
            <label>SKILL.md
              <textarea class="hub-input" id="me-body" data-testid="skills-edit-body" rows="12" style="font-family:var(--font-mono);font-size:var(--fs-xs)">${esc(d.skill_md || '')}</textarea></label>
          </div>
          <div class="hub-modal__sub" style="color:var(--c-ink-4)">保存前自动备份当前版本（可回退）· 记入台账</div>`,
        onConfirm: async () => {
          const body = document.getElementById('me-body').value;
          const r = await api('/api/skills/registry/item/' + encodeURIComponent(name), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { 'SKILL.md': body } }),
          });
          if (r.data.ok) { HubUI.toast('已保存 · 已记入台账', 'success'); await refresh({ parts: ['rows', 'ledger'] }); showDetail(name); }
          else { HubUI.toast('保存失败：' + (r.data.error || ''), 'error', 5200); return false; }
        },
      });
    });
  }

  function importDialog() {
    HubUI.modal({
      title: '从本地目录导入', hasInput: false, confirmText: '导入', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">复制现有目录（含子目录）进入本地库，作为手动条目管理；原目录只读，不做任何改动。</div>
        <div class="form-grid">
          <label>目录路径（支持 ~）<input class="hub-input" id="mi-path" data-testid="skills-import-path" placeholder="~/skills/my-skill"></label>
          <label>目录${dirFieldHTML('mi-dir', 'skills-import-dir')}</label>
          <label>名称（默认取目录名）<input class="hub-input" id="mi-name" data-testid="skills-import-name" placeholder="留空 = 目录名"></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)" id="mi-dir-hint"></div>`,
      onConfirm: async () => {
        const r = await post('/api/skills/registry/import', {
          path: document.getElementById('mi-path').value.trim(),
          name: document.getElementById('mi-name').value.trim() || null,
          dir_id: dirFieldVal('mi-dir'),
        });
        if (r.data.ok) {
          HubUI.toast(`已导入 ${r.data.name} · ${r.data.files} 个文件 · 已记入台账`, 'success');
          await refresh({ parts: ['rows', 'ledger'] }); showDetail(r.data.name);
        } else {
          const msg = r.data.error || '';
          if (msg.includes('同名手动条目')) {
            HubUI.confirm('同名条目已存在', esc(msg) + '<br>用目录内容覆盖它？（当前版本会先备份）', async () => {
              const r2 = await post('/api/skills/registry/import', {
                path: document.getElementById('mi-path') ? document.getElementById('mi-path').value.trim() : '',
                name: document.getElementById('mi-name') ? document.getElementById('mi-name').value.trim() || null : null,
                dir_id: dirFieldVal('mi-dir'),
                overwrite: true,
              });
              if (r2.data.ok) { HubUI.toast(`已覆盖导入 ${r2.data.name}`, 'success'); await refresh({ parts: ['rows', 'ledger'] }); showDetail(r2.data.name); }
              else HubUI.toast('导入失败：' + (r2.data.error || ''), 'error', 5200);
            }, { confirmText: '覆盖导入', danger: true });
            return false;
          }
          HubUI.toast('导入失败：' + msg, 'error', 5200);
          return false;
        }
      },
    });
    bindDirHint('mi-dir', 'mi-dir-hint', '复制到');
  }

  /* ============================== 目录管理 v2（列表 + 工具绑定 + 原生选择目录） ==============================
     「创建目录」已按用户口径取消（2026-10-31「取消创建，提供【选择目录】功能」）。
     绑定（2026-10-31）：目录 ↔ 工具目标持久连接——建连即全量同步，目录内容变化由
     服务端 worker 自动跟随（ Plans/目录连接工具/需求拆解.md）。 */
  const toolNameOf = (tid) => {
    const t = (window.hubApp.state.tool_list || []).find(x => x.id === tid);
    return t ? t.name : (tid || '?');
  };

  function manageDirsDialog() {
    const defaultCount = Object.values(S.reg || {}).filter(r => r.manual && !r.dir_id).length;
    HubUI.modal({
      title: '目录管理', hasInput: false, confirmText: '完成', cancelText: null,
      bodyHTML: `
        <div class="hub-modal__sub">Skills 与 MCP 共用目录池：链接的目录原地挂进 hub（不复制），目录内条目变化实时同步。<b>连接工具</b>后，目录内全部 skills 立即同步到该工具，且变化自动跟随。</div>
        <div class="hub-dirlist" id="md-list"></div>
        <div class="hub-dirlist__foot">
          <button class="hub-btn hub-btn--primary" id="md-pick" data-testid="skills-dir-pick">选择目录…</button>
          <span class="hub-dirlist__hint" id="md-pick-hint">弹出 macOS 文件夹选择器，选中即链接</span>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">不能链接 hub 自身目录或与已链接目录重叠 · 重名条目跳过并记入台账</div>`,
    });
    const renderList = (dirs) => {
      const host = document.getElementById('md-list');
      if (!host) return;
      const rows = [`<div class="hub-dirlist__row is-builtin">
          <span class="hub-dirlist__nm">默认目录</span>
          <span class="hub-dirlist__meta">registry/skills · registry/mcp · ${defaultCount} 条</span>
          <span class="hub-badge hub-badge--neutral">内置</span>
        </div>`];
      for (const d of (dirs || [])) {
        const chips = (d.bindings || []).map(b => {
          const nm = toolNameOf(b.tool);
          const cls = (typeof toolColorCls === 'function') ? toolColorCls(toolOf2(b.tool)) : '';
          return `<span class="hub-badge hub-badge--neutral" style="display:inline-flex;align-items:center;gap:4px">
              <span class="tool-dot ${cls}"></span>${esc(nm)}${b.enabled ? '' : ' · 已暂停'}</span>`;
        }).join('');
        rows.push(`<div class="hub-dirlist__row" style="flex-wrap:wrap">
          <span class="hub-dirlist__nm">${esc(d.name)}</span>
          <span class="hub-dirlist__meta">${esc(tilde(d.path))} · ${d.counts.skills} skill · ${d.counts.mcp} mcp</span>
          <span class="hub-dirlist__binds">${chips}</span>
          <span class="hub-dirlist__ops">
            <button class="hub-btn btn-sm hub-btn--primary" data-dir-connect="${d.id}">连接工具…</button>
            ${(d.bindings || []).map(b => `
              <button class="hub-btn btn-sm" data-dir-toggle="${b.id}">${b.enabled ? '暂停' : '恢复'}</button>
              <button class="hub-btn btn-sm" data-dir-unlink="${b.id}">断开</button>`).join('')}
            <button class="hub-btn btn-sm hub-btn--danger" data-dir-del="${d.id}">移除</button>
          </span>
        </div>`);
      }
      host.innerHTML = rows.join('');
      host.querySelectorAll('[data-dir-del]').forEach(b => {
        b.onclick = () => removeDirDialog(b.dataset.dirDel, renderList);
      });
      host.querySelectorAll('[data-dir-connect]').forEach(b => {
        b.onclick = () => {
          const d = (S.localDirs || []).find(x => String(x.id) === b.dataset.dirConnect);
          if (d) connectDirDialog(d, renderList);
        };
      });
      host.querySelectorAll('[data-dir-toggle]').forEach(b => {
        b.onclick = async () => {
          const cur = (S.localDirs || []).flatMap(x => x.bindings || []).find(y => String(y.id) === b.dataset.dirToggle);
          const r = await api('/api/skills/dir-bindings/' + encodeURIComponent(b.dataset.dirToggle),
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: !(cur && cur.enabled) }) });
          if (r.data.ok) { await refresh(); renderList(S.localDirs); }
          else HubUI.toast('操作失败：' + (r.data.error || ''), 'error', 5200);
        };
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

  /* 连接工具：勾选目标目录（多选）→ 建连并立即全量同步 */
  function connectDirDialog(d, after) {
    const already = new Set((d.bindings || []).map(b => String(b.target_id)));
    const targets = (S.targets || []).filter(t => t.kind === 'skills_dir');
    const byPath = {};
    targets.forEach(t => { (byPath[t.path] = byPath[t.path] || []).push(t.tool_name || t.name); });
    const n = (d.counts && d.counts.skills) || 0;
    HubUI.modal({
      title: `连接工具 · ${d.name}（${n} 个 skill）`, hasInput: false,
      confirmText: '连接并同步', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">建立连接后：目录内全部 skills 立即同步到所选工具；此后目录内容变化（外部改 / hub 内改 / 增删）<b>自动跟随</b>，全程记入台账。</div>
        <div class="hub-modal__sub" style="margin-bottom:var(--sp-2)">同步到（勾选目标目录）</div>
        <div class="hub-targets" id="cd-targets">
          ${targets.map(t => {
            const share = (byPath[t.path] || []).filter(x => x !== (t.tool_name || t.name));
            const bound = already.has(String(t.id));
            return `<button type="button" class="hub-tgt${bound ? ' is-bound' : ''}" data-tid="${t.id}" ${bound ? 'disabled' : ''}>
              <span class="hub-tgt__chk">✓</span>
              <span class="tool-dot ${toolColorCls(toolOf2(t.tool))}"></span>
              <span class="hub-tgt__nm">${esc(t.tool_name || t.name)}</span>
              <span class="hub-tgt__path">${esc(tilde(t.path))}</span>
              ${bound ? '<span class="hub-badge hub-badge--neutral">已连接</span>'
                      : (share.length ? `<span class="hub-badge" style="color:var(--c-warn);background:var(--c-warn-soft)">共享 · ${esc(share.join('/'))} 同目录</span>` : '')}
            </button>`;
          }).join('') || '<div class="hub-dirlist__empty">没有可选的工具目标（先在 设置 → 工具 里配置 skills 目录）</div>'}
        </div>
        <div class="hub-frow"><label>同名冲突</label>
          <span class="hub-seg" id="cd-conflict" data-value="skip">
            <button type="button" class="is-on" data-v="skip">跳过并报告</button>
            <button type="button" data-v="force">覆盖（先备份）</button></span>
          <span class="note">目标里已有、但不是 hub 落的内容 → 默认停手保护</span></div>`,
      onConfirm: async () => {
        const sel = [...document.querySelectorAll('#cd-targets .hub-tgt.is-on:not(.is-bound)')]
          .map(x => Number(x.dataset.tid));
        if (!sel.length) { HubUI.toast('请先勾选要连接的工具', 'warn'); return false; }
        const force = document.getElementById('cd-conflict').dataset.value === 'force';
        const r = await post('/api/skills/dir-bindings', { dir_id: d.id, target_ids: sel, force });
        if (r.data.ok) {
          for (const x of (r.data.results || [])) {
            if (x.ok) HubUI.toast(`${d.name} → ${x.target}：${x.added} 新增 · ${x.updated} 更新` +
              `${x.conflicts ? ` · ${x.conflicts} 冲突跳过` : ''}`, 'success', 5600);
            else HubUI.toast(`${x.target || ''} 连接失败：${x.error || ''}`, 'error', 5600);
          }
          await refresh();
          const again = await api('/api/local-dirs');
          S.localDirs = again.data.dirs || [];
          if (typeof after === 'function') after(S.localDirs);
        } else { HubUI.toast('连接失败：' + (r.data.error || ''), 'error', 5600); return false; }
      },
    });
    document.querySelectorAll('#cd-targets .hub-tgt:not(.is-bound)').forEach(el => {
      el.onclick = () => el.classList.toggle('is-on');
    });
    document.querySelectorAll('#cd-conflict button').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#cd-conflict button').forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on');
        document.getElementById('cd-conflict').dataset.value = b.dataset.v;
      };
    });
  }

  /* 断开绑定：默认保留工具内文件；可选清理受管内容 */
  function unbindDialog(bindingId, after) {
    const b = (S.localDirs || []).flatMap(x => x.bindings || []).find(y => String(y.id) === String(bindingId));
    if (!b) return;
    HubUI.confirm('断开连接',
      `目录 ⇄ <b>${esc(toolNameOf(b.tool))}</b>（${esc(tilde(b.target_path || ''))}）<br>断开后目录变化不再同步到该工具。`,
      async () => {
        const clean = document.getElementById('ub-clean') && document.getElementById('ub-clean').checked;
        const r = await api('/api/skills/dir-bindings/' + encodeURIComponent(bindingId) +
          (clean ? '?clean=1' : ''), { method: 'DELETE' });
        if (r.data.ok) {
          HubUI.toast(clean ? `已断开并清理 ${r.data.cleaned} 个受管目录` : '已断开（工具内文件保留）', 'success');
          await refresh();
          if (typeof after === 'function') after(S.localDirs);
        } else HubUI.toast('断开失败：' + (r.data.error || ''), 'error', 5200);
      },
      { confirmText: '断开连接', danger: true,
        bodyExtra: '<label style="display:flex;gap:var(--sp-2);align-items:center;font-size:var(--fs-body);margin-top:var(--sp-2)">' +
          '<input type="checkbox" id="ub-clean"> 同时清理该工具内的受管文件（只删 hub 落过的）</label>' });
  }

  /* 断开绑定：默认保留工具内文件；可选清理受管内容 */
  function unbindDialog(bindingId, after) {
    const b = (S.localDirs || []).flatMap(x => x.bindings || []).find(y => String(y.id) === String(bindingId));
    if (!b) return;
    HubUI.confirm('断开连接',
      `目录 ⇄ <b>${esc(toolNameOf(b.tool))}</b>（${esc(tilde(b.target_path || ''))}）<br>断开后目录变化不再同步到该工具。` +
      '<label style="display:flex;gap:var(--sp-2);align-items:center;font-size:var(--fs-body);margin-top:var(--sp-3)">' +
      '<input type="checkbox" id="ub-clean"> 同时清理该工具内的受管文件（只删 hub 落过的）</label>',
      async () => {
        const clean = !!(document.getElementById('ub-clean') && document.getElementById('ub-clean').checked);
        const r = await api('/api/skills/dir-bindings/' + encodeURIComponent(bindingId) +
          (clean ? '?clean=1' : ''), { method: 'DELETE' });
        if (r.data.ok) {
          HubUI.toast(clean ? `已断开并清理 ${r.data.cleaned} 个受管目录` : '已断开（工具内文件保留）', 'success');
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
      esc(tilde(d.path)) + `<br>其中 ${n} 条条目将解除登记，<b>磁盘文件保留不动</b>；已分发到目标的文件不受影响。`,
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

  function reimportDialog(name) {
    HubUI.modal({
      title: '重新导入 ' + name, hasInput: false, confirmText: '覆盖导入', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">用本地目录的最新内容覆盖该条目（当前版本先备份）。</div>
        <div class="form-grid"><label>目录路径（支持 ~）<input class="hub-input" id="mr-path" data-testid="skills-reimport-path" placeholder="~/skills/${esc(name)}"></label></div>`,
      onConfirm: async () => {
        const r = await post('/api/skills/registry/import', {
          path: document.getElementById('mr-path').value.trim(), name, overwrite: true,
        });
        if (r.data.ok) { HubUI.toast(`已覆盖导入 ${name}`, 'success'); await refresh({ parts: ['rows', 'ledger'] }); showDetail(name); }
        else { HubUI.toast('导入失败：' + (r.data.error || ''), 'error', 5200); return false; }
      },
    });
  }

  function deleteFlow(name, after) {
    HubUI.confirm('删除 ' + name, '将删除该本地条目；已部署的会连同目标内文件一起删除（先备份）。', async () => {
      const r = await api('/api/skills/registry/item/' + encodeURIComponent(name) + '?force=1', { method: 'DELETE' });
      if (r.data.ok) {
        HubUI.toast('已删除 ' + name + ' · 已记入台账', 'success');
        S.selected.delete(name);
        await collapseRows('#sk-rows .mvi', { keys: [name] });   // 先收起该行，再刷新列表
        await refresh({ parts: ['rows', 'ledger'] });
        if (after) after();
      }
      else HubUI.toast('删除失败：' + (r.data.error || ''), 'error', 5200);
    }, { confirmText: '确认删除', danger: true });
  }

  function showDetailClose() { S.mode = 'overview'; S._detailName = null; renderCenter(document.querySelector('#view-skills .nv-center')); renderRight(document.querySelector('#view-skills .nv-right')); }

  /* ---- 行内展开（稿子 ModuleView：点行展开 meta·来源 + 编辑/复制/删除 + SKILL.md 预览）---- */
  async function toggleAcc(name) {
    const host = document.getElementById('sk-rows') || document;
    const wasOpen = S._detailName === name;
    host.querySelectorAll('.mvi.is-open').forEach(r => {
      r.classList.remove('is-open');
      const b = r.querySelector('.mvi__accin'); if (b) b.innerHTML = '';
    });
    if (wasOpen) {
      // 收起 = 取消选中（与会话行同口径，用户 2026-10-20）
      S.selected.delete(name);
      syncRowSel(host, name, false);
      showDetailClose(); syncPanelOpen(); return;
    }
    // 展开 = 选中该条目
    S.selected.add(name);
    syncRowSel(host, name, true);
    await showDetail(name);                          // 右侧「部署目标」面板跟随当前条目
    const row = [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === name);
    const it = S.items.find(x => x.name === name);
    if (row && it) openAcc(row, it);
    syncPanelOpen();
  }
  /** 就地同步某行的勾选态（不重建列表） */
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
    // 元信息行与行内动作已上移到行头（对齐 MCP 条目行，2026-10-19）：展开体只剩 SKILL.md 预览
    box.innerHTML = MV.accBody({});
    const pre = box.querySelector('[data-acc-pre]');
    api('/api/skills/item/' + encodeURIComponent(it.name)).then(r => {
      if (pre.isConnected) pre.textContent = ((r.data || {}).skill_md || '（未找到 SKILL.md）').slice(0, 6000);
    }).catch(() => { pre.textContent = '（加载失败）'; });
  }
  function syncPanelOpen() {
    const panel = document.querySelector('#sk-panel');
    const toolPicking = !!(S.toolSel && S.toolChecked.size);
    if (panel) panel.classList.toggle('is-in',
      !!(S.selected.size || S._detailName || S.mode === 'multi' || toolPicking) && !S._panelOff);
  }
  /** 列表重渲染后恢复展开态 */
  function restoreAcc() {
    if (!S._detailName) return;
    const host = document.getElementById('sk-rows');
    const row = host && [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === S._detailName);
    const it = S.items.find(x => x.name === S._detailName);
    if (row && it && !row.classList.contains('is-open')) openAcc(row, it);
  }

  async function showDetail(name) {
    S.mode = 'detail'; S._detailName = name;
    S.page = S.page || 1;
    // 确保详情条目在当前列表（可能被过滤掉）：不强制翻页，直接按现有 items 渲染
    const el = document.querySelector('#view-skills .nv-center');
    if (el) renderDetail(el);
    const reg = S.reg[name] || {};
    const it = S.items.find(x => x.name === name);
    renderRight(document.querySelector('#view-skills .nv-right'));
    // detail body 需要 reg.deployments/per_target
    if (it) { await loadDetailBody(it, it); }
  }

  /* ============================== 公共 ============================== */
  /** UI 快照：刷新前后保住滚动 / 焦点与光标（展开态由 S._detailName + restoreAcc 负责） */
  /** 只更新来源卡片右上角的计数（卡片节点不重建） */
  function refreshCardCounts() {
    const all = (typeof allItemsCache === 'function' && allItemsCache()) || null;
    const items = (all && all.length ? all : S.items) || [];
    document.querySelectorAll('#sk-top .tcard[data-src]').forEach(card => {
      const id = card.dataset.src;
      const badge = card.querySelector('.tcard__cnt');
      if (!badge) return;
      let n;
      if (id === 'manual') n = items.filter(it => it.manual).length;
      else if (/^\d+$/.test(id)) n = items.filter(it => it.source_id != null && String(it.source_id) === id).length;
      else n = _toolCounts[id] || 0;                  // 工具：取 tool-items 聚合计数
      const txt = String(n || 0);
      if (badge.textContent !== txt) badge.textContent = txt;
    });
  }

  function snapshotUI() {
    const rows = document.getElementById('sk-rows');
    const a = document.activeElement;
    return {
      scroll: rows ? rows.scrollTop : 0,
      focusId: a && a.id ? a.id : null,
      caret: (a && a.selectionStart != null) ? a.selectionStart : null,
    };
  }
  function restoreUI(s) {
    const rows = document.getElementById('sk-rows');
    if (rows && s.scroll) rows.scrollTop = s.scroll;
    if (s.focusId) {
      const el = document.getElementById(s.focusId);
      if (el && document.activeElement !== el) {
        el.focus();
        try { if (s.caret != null) el.setSelectionRange(s.caret, s.caret); } catch (e) { /* number 输入框等不支持 */ }
      }
    }
  }

  /**
   * 刷新视图。`parts` 控制**重画哪些区域**（默认全画，行为与旧版一致）：
   *   rows    列表（来源行 + 条目行，挂在 #sk-rows）
   *   cards   顶部来源卡片 + 统计条（syncShell）
   *   targets 右侧「部署目标」面板
   *   ledger  最近台账
   * 只传 ['rows'] 时，右侧面板不闪、台账不动、焦点/滚动/展开态全保留。
   */
  async function refresh(opts) {
    const parts = new Set((opts && opts.parts) || ['ledger', 'cards', 'rows', 'targets']);
    const snap = snapshotUI();
    if (parts.has('ledger')) {
      try { S.ledger = ((await api('/api/ops?module=skills&limit=5')).data.items || []); } catch (e) { /* 台账失败不影响主流程 */ }
    }
    await loadAll();
    if (parts.has('rows') || parts.has('cards')) {
      renderLeft(document.querySelector('#view-skills .nv-left'));
      restoreAcc();                        // 只重画列表时也要把展开态找回来（原来挂在 syncShell 里）
    }
    renderCenter(document.querySelector('#view-skills .nv-center'));   // 隐藏宿主：概览统计卡 / 创建区（testid 依赖）
    if (!parts.has('cards')) refreshCardCounts();                  // 卡片不重画：只把角标数字就地改掉
    if (parts.has('cards')) syncShell(skillsStats, '勾选条目 → 右侧选择目标安装；安装 / 更新前会自动备份目标目录。');
    if (parts.has('targets')) renderRight(document.querySelector('#view-skills .nv-right'));
    restoreUI(snap);
  }

  function skillsStats() {
    const sum = (k) => (S.targetsStat || []).reduce((a, t) => a + ((t.items && t.items[k]) || 0), 0);
    const pend = sum('stale') + sum('missing');
    const reg = Object.values(S.reg || {});
    return [
      { n: S.total || 0, label: `条目${S.srcFilter ? ' · 当前来源' : ' · 全部来源'}` },
      { n: reg.filter(r => r.manual).length, label: '本地' },
      { n: reg.filter(r => !r.manual).length, label: '远程拉取' },
      { n: sum('total'), label: '已部署到工具' },
      { n: pend, label: '待更新 / 待安装', tone: pend ? 'warn' : '' },
    ];
  }

  /* ---------- v1.0 版式适配层：外壳换成"顶部来源卡片 + 中栏条目 + 滑出去向" ---------- */
  /** 把 MV.shell 的槽位接到 view 原有逻辑上（搜索 / 分页 / 全选 / 标题） */
  function mountSlots(root) {
    const rows = root.querySelector('#sk-rows');
    if (rows) rows.classList.add('nv-list', 'nv-left');          // view 的条目列表就渲染在这里
    if (!root.querySelector('.nv-center')) {
      const host = document.createElement('main');                // 统计/创建区等：保留为隐藏宿主
      host.className = 'nv-center'; host.hidden = true;
      root.appendChild(host);
    }
    const panel = root.querySelector('#sk-panel');
    if (panel) panel.innerHTML = '<div class="spanel__in"><aside class="nv-right"></aside></div>';
  }
  function wireSlots(root) {
    const q = root.querySelector('#sk-q');
    const legacyQ = root.querySelector('#sk-rows [data-testid="skills-search"]');
    if (q && legacyQ) {
      if (q.value !== legacyQ.value) q.value = legacyQ.value;
      q.oninput = () => { legacyQ.value = q.value; legacyQ.dispatchEvent(new Event('input', { bubbles: true })); };
    }
    const pgAt = (sel) => root.querySelector(`#sk-rows .nv-pager ${sel}`);
    const wire = (id, sel) => {
      const b = root.querySelector(id); const l = pgAt(sel);
      if (b && l) { b.disabled = l.disabled; b.onclick = () => l.click(); }
    };
    wire('#sk-selall', '[data-sel="all"]');
    wire('#sk-selinv', '[data-sel="invert"]');
    wire('#sk-selnone', '[data-sel="none"]');
    const info = root.querySelector('#sk-info'); const li = pgAt('.nv-pinfo');
    if (info && li) info.textContent = li.textContent;
  }

  /** 外壳统一走 MV.shell（与会话页 / 记忆同一骨架）。view 自己的容器名挂到槽位上，
      逻辑一行不改，也不用再各写一套骨架。 */
  function shellHTML(topLabel) {
    return MV.shell({ prefix: 'sk', top: '', title: topLabel, q: S.q, placeholder: '搜索条目…' })
;
  }


  /** 把左栏里的「来源区块」搬到顶部并分组成三类、补色块、填统计条、同步去向面板显隐 */
  function toolOf2(tid) {
    return ((window.hubApp && window.hubApp.state.tool_list) || []).find(t => t.id === tid) || null;
  }

  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

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
    const root = document.getElementById('view-skills');
    const topHost = root.querySelector('#sk-top');
    const left = root.querySelector('.nv-left');
    if (!topHost || !left) return;

    // ---- 来源分组：走 MV.top（与记忆共用同一套 markup：分组头 / 卡片 / 统计条 / 提示语）----
    const all = (typeof allItemsCache === 'function' && allItemsCache()) || null;
    const items = (all && all.length ? all : S.items) || [];    // 计数用全量，避免被搜索框过滤
    // 工具来源 = 启用且有 skills 目录的工具；同一目录（如 ~/.agents/skills）可对应多张卡（用户 2026-10-28）
    const tools = new Map(toolSources().map(t => [t.id, t.name]));
    const shortOf = (id, nm) => {
      const x = MV.short(String(id).replace(/[^A-Za-z0-9]/g, ''));
      return x === '?' ? String(nm || id).slice(0, 2).toUpperCase() : x;
    };
    const remoteKeys = (S.sources || []).map(x => String(x.key != null ? x.key : x.id));
    // 本地目录池：默认目录（registry/skills，不在 local_dirs 表）+ 每个目录一张卡；
    // 目录卡计数取服务端 counts.skills（GET /api/local-dirs 读取时已顺带扫描同步）
    const dirIds = (S.localDirs || []).map(d => 'dir:' + d.id);
    const manualAll = Object.values(S.reg || {}).filter(r => r.manual);
    const srcs = [
      // 本地计数取 registry（每次刷新都重取），避免全量缓存过期后卡片角标与列表不一致
      { id: 'manual', name: '默认', short: '默认', cls: 'chip--muted',
        count: manualAll.filter(r => !r.dir_id).length },
      ...(S.localDirs || []).map(d => ({
        id: 'dir:' + d.id, name: d.name, short: shortOf('dir' + d.id, d.name),
        cls: 'chip--muted',
        count: (d.counts && d.counts.skills) || 0,
        // 连接标记（目录 ↔ 工具 绑定）：→ + 已连接工具色点（最多 3 个，多则 +n）
        tag: (d.bindings || []).length
          ? '<span class="arr">→</span>' + (d.bindings || []).slice(0, 3).map(b =>
              `<span class="tool-dot ${toolColorCls(toolOf2(b.tool))}"></span>`).join('')
            + ((d.bindings || []).length > 3 ? `<span>+${d.bindings.length - 3}</span>` : '')
          : '',
        // 目录卡动作：移除 = 解除链接并下架登记，磁盘文件保留（非破坏性）
        acts: [
          { key: 'dirdel', label: '移除', icon: MV.ic('trash'), title: '移除该目录（磁盘文件保留）', danger: true },
        ],
      })),
      ...(S.sources || []).map(x => {
        const key = String(x.key != null ? x.key : x.id);
        // 条目上真正可用的是 source_id（catalog_view 输出）；之前猜的 it.src/it.source 都不存在 → 卡片永远显示 0
        const n = items.filter(it => it.source_id != null && String(it.source_id) === key).length;
        return {
          id: key, name: x.name, short: shortOf(key, x.name), cls: MV.cls(key),
          // 远程来源的计数以服务端 item_count 为准：拉取后本地全量缓存可能尚未刷新
          count: x.item_count != null ? x.item_count : (n || x.count || 0),
          // 稿子：远程仓库卡片带「拉取 / 编辑 / 删除」（复用隐藏来源行上的原有处理器）
          acts: [
            { key: 'pull', label: '拉取', icon: MV.ic('refresh'), title: '拉取该仓库' },
            { key: 'edit', label: '编辑', icon: MV.ic('edit'), title: '编辑仓库配置' },
            { key: 'del', label: '移除', icon: MV.ic('trash'), title: '移除该仓库', danger: true },
          ],
        };
      }),
      // 工具来源 = 工具自己的色（与会话页卡片同色），不再统一主色；角标 = 该工具目录里的条目数
      ...[...tools].map(([tid, tname]) => ({ id: tid, name: tname, short: shortOf(tid, tname),
        cls: (typeof toolColorCls === 'function' ? toolColorCls(toolOf2(tid)) : 'chip--accent'),
        count: _toolCounts[tid] || 0 })),
    ];
    const counts = {}; srcs.forEach(x => { counts[x.id] = x.count; });
    const skActive = S.toolSel ? S.toolSel.id : (S.srcFilter == null ? null : String(S.srcFilter));
    const skTopHTML = MV.top({
      prefix: 'sk', label: 'Skill 来源', sources: srcs, counts,
      activeId: skActive,
      groups: [
        { kind: 'local', label: '本地', desc: '默认目录 + 已链接目录；目录内条目变化实时同步',
          ids: ['manual', ...dirIds],
          actions: ['目录管理', '新建', '导入'] },
        { kind: 'remote', label: '远程仓库', desc: 'Git 仓库拉取，只读跟随上游', ids: remoteKeys,
          actions: ['添加仓库', '全部拉取'] },
        { kind: 'tool', label: '工具', desc: '从已安装工具的目录提取', ids: [...tools.keys()], actions: ['重新扫描'] },
      ],
      bulk: '<button class="hub-btn btn-sm"><span class="btn-ic">' + MV.ic('refresh') + '</span>重新扫描</button>',
      stats: typeof statsFn === 'function' ? statsFn() : [],
      hint: hint || '',
    });
    // 就地同步：只有来源集合 / 数量变了才重建卡片，否则只切 is-on（保住描边生长动效，2026-10-20）
    const skTopSig = srcs.map(x => x.id + ':' + x.count).join(',');
    MV.syncCards(topHost, skTopHTML, skTopSig, skActive);

    // 老来源行只作数据与事件宿主（隐藏）
    const srcRow = (id) => left.querySelector(`.nv-src-row[data-src="${id}"], .nv-src-row[data-tool="${id}"]`);
    const allRow = () => left.querySelector('.nv-src-row[data-src="all"]');
    /**
     * 选中 / 取消选中（用户 2026-10-17 口径）：
     *  · 点已选中的 → 只取消选中，**布局不变**
     *  · 详细布局里点新卡片 → 选中并进入简略布局
     *  · 简略布局里点新 chip → 换选中，仍保持简略
     */
    const pick = (id, fromCards) => {
      const same = activeSrc != null && String(activeSrc) === String(id);
      if (same) {
        const all = allRow(); if (all) all.click();
        refresh();
        return;
      }
      // 改动：点卡片只「选中来源」，不再自动收合成简略布局（用户指令 2026-10-20「取消点击卡片进入简略布局」）——
      // 布局切换收敛到左上角的切换按钮一个入口，选择与布局彻底解耦
      const row = srcRow(id);
      if (row) row.click();
      else if (String(id).indexOf('dir:') === 0) S.srcFilter = id;   // 本地目录卡：无旧来源行宿主，直接设过滤
      refresh();
    };
    left.querySelectorAll('.nv-src-row').forEach(r => {
      const id = r.dataset.src || r.dataset.tool || '';
      const card = topHost.querySelector(`.tcard[data-src="${id}"]`);
      if (card) card.onclick = () => pick(id, true);
      r.hidden = true;
    });
    // 本地目录卡：没有旧来源行宿主可借，直接绑 pick（过滤值在 pick 里落 S.srcFilter）
    topHost.querySelectorAll('.tcard[data-src^="dir:"]').forEach(card => {
      card.onclick = () => pick(card.dataset.src, true);
    });
    // 卡片上的动作按钮：`.tcard__act`（编辑/删除）+ `.tcard__pull`（拉取，与计数同一格）都要绑，
    // 且必须 stopPropagation —— 否则点击会冒泡到卡片 → 打开简略布局（用户 2026-10-20「不能冒泡到卡片」）
    topHost.querySelectorAll('.tcard[data-src] .tcard__act, .tcard[data-src] .tcard__pull').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const src = btn.closest('.tcard').dataset.src;
        const kind = btn.dataset.act;   // pull | edit | del | dirdel
        if (kind === 'dirdel') { removeDirDialog(String(src).slice(4)); return; }
        const tid = kind === 'pull' ? 'skills-pull-' : kind === 'edit' ? 'skills-edit-' : 'skills-del-';
        const legacy = left.querySelector(`[data-testid="${tid}${src}"]`);
        if (!legacy) { HubUI.toast('该来源暂无此操作', 'warn'); return; }
        legacy.click();
        if (kind === 'pull') {
          // 拉取中：图标转圈、动作排保持可见（鼠标移开也不收），结束后自动复位
          const card = btn.closest('.tcard');
          if (card) {
            card.classList.add('is-busy');
            const iv = setInterval(() => {
              if (!legacy.classList.contains('is-loading')) { clearInterval(iv); card.classList.remove('is-busy'); }
            }, 300);
            setTimeout(() => { clearInterval(iv); card.classList.remove('is-busy'); }, 180000);   // 兜底
          }
        }
      };
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
    const sideHost = root.querySelector('#sk-side');
    // Figma CollapsibleHeader：头部在"完整卡片区（full）"与"64px 横向条（strip）"之间切，
    // 并支持鼠标移到条里的项上时"窥视"展开成完整卡片区（浮起，移开再收回）。
    let hdr = root.querySelector('#sk-hdr');
    if (!hdr) {
      hdr = document.createElement('div');
      hdr.id = 'sk-hdr';
      hdr.className = 'hdr';
      const top = root.querySelector('#sk-top');
      if (top && top.parentElement) {
        top.parentElement.insertBefore(hdr, top);
        hdr.appendChild(top);                        // 卡片区（full）
      }
      const bar = document.createElement('div');     // 横向条（strip）
      bar.id = 'sk-bar';
      bar.className = 'cbar-host';
      hdr.appendChild(bar);
    }
    const barHost = hdr.querySelector('#sk-bar');
    const topHostEl = hdr.querySelector('#sk-top');
    // 布局模式与"选中来源"是两个独立维度：点卡片进入 compact；切布局按钮回 detail（保留选中）
    const compact = S._layout === 'compact';
    // 详细布局时量一次完整高度并缓存（compact 时卡片区绝对定位，量不到；不能在切类名后再量，否则同帧往复没有过渡）
    if (!compact) {
      const fullH = (hdr.querySelector('#sk-top') || {}).scrollHeight || 0;
      if (fullH) { S._fullH = fullH; hdr.style.setProperty('--hdr-full', Math.round(fullH) + 'px'); }
    } else if (S._fullH) {
      hdr.style.setProperty('--hdr-full', Math.round(S._fullH) + 'px');
    }
    // 布局切换必须"先绘制旧高度、下一帧再切类名"，否则同一帧里高度直接变成终值 → 没有过渡
    const nextLayout = compact ? 'compact' : 'detail';
    const prevLayout = hdr.dataset.layout || '';
    const applyLayout = () => {
      hdr.style.height = '';                       // 交回 CSS 控制（--hdr-full 或 64px）
      hdr.classList.toggle('is-compact', nextLayout === 'compact');
      hdr.dataset.layout = nextLayout;
    };
    if (!prevLayout || prevLayout === nextLayout) applyLayout();
    else {
      // 先把"当前真实高度"钉成像素值，下一帧再切类名 —— 这样 230 → 64 才有过渡可走
      hdr.style.height = Math.round(hdr.getBoundingClientRect().height) + 'px';
      requestAnimationFrame(() => requestAnimationFrame(applyLayout));
    }
    if (compact) {
      if (topHostEl) topHostEl.hidden = false;       // 保持在 DOM 里：窥视时直接显示（不做二次渲染）
      if (sideHost) { sideHost.hidden = true; sideHost.innerHTML = ''; }
      const dtogC = hdr.querySelector('#sk-hdrtoggle'); if (dtogC) dtogC.hidden = true;
      barHost.hidden = false;
      // 就地同步：chip 集合 / 数量不变时只切 is-on，不重建 DOM —— 否则新节点天生带 is-on，
      // 「描边生长 + 背景扫入」没有起点可播（2026-10-20）
      const skBarSig = srcs.map(x => x.id + ':' + x.count).join(',')
        + '|' + remoteKeys.join(',') + '|' + [...tools.keys()].join(',');
      const skBarSame = barHost.dataset.barsig === skBarSig;
      if (!skBarSame) {
        barHost.dataset.barsig = skBarSig;
        barHost.innerHTML = MV.chipBar({
          prefix: 'sk', items: srcs, activeId: activeSrc,
          groups: [
            { kind: 'local', label: '本地', ids: ['manual', ...dirIds],
              actions: ['目录管理', '新建', '导入'] },
            { kind: 'remote', label: '远程仓库', ids: remoteKeys, actions: ['添加仓库', '全部拉取'] },
            { kind: 'tool', label: '工具', ids: [...tools.keys()], actions: ['重新扫描'] },
          ],
        });
        const back = barHost.querySelector('#sk-barback');
        if (back) {
          back.title = '切换到详细布局';
          back.setAttribute('aria-label', '切换到详细布局');
          back.onclick = () => { S._layout = 'detail'; refresh(); };
        }
        barHost.querySelectorAll('.cbar__it').forEach(b => {
          b.onclick = () => pick(b.dataset.src, false);
        });
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
      MV.hdrToggle(hdr, 'sk', () => { S._layout = 'compact'; refresh(); });
      if (topHostEl) topHostEl.hidden = false;
      if (topHost) topHost.hidden = false;
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
        if (act === '添加仓库') addSourceDialog();
        else if (act === '目录管理') manageDirsDialog();
        else if (act === '新建') createDialog();
        else if (act === '导入') importDialog();
        else if (act === '重新扫描') { loadToolItems().then(() => refresh()); }
        else if (act === '全部拉取') {
          const ids = (S.sources || []).map(x => String(x.key != null ? x.key : x.id));
          if (!ids.length) { HubUI.toast('还没有远程仓库', 'warn'); return; }
          ids.reduce((p, id) => p.then(() => pullSource(id, null)), Promise.resolve());
        }
      };
    });
    const panel = root.querySelector('#sk-panel');
    if (panel) panel.classList.toggle('is-in', !!(S.selected.size || S._detailName || S.mode === 'multi'));
  }

  window.SkillsView = {
    async render(root) {
      root.innerHTML = shellHTML('Skill 来源');
      mountSlots(root);
      S.mode = 'overview'; S.selected = new Set(); S._detailName = null; S.srcFilter = null; S.page = 1; S.q = '';
      S.toolSel = null; S.toolChecked = new Set();
      await primeAllCache();
      await syncLocalIfStale();        // 本地缓存有新提交（应用外 git pull）→ 自动同步，不联网
      await refresh();
    },
    refresh,
  };
})();
