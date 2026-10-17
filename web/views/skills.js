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

  async function loadAll() {
    const [src, tgt] = await Promise.all([api('/api/skills/sources'), api('/api/skills/targets')]);
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
  }

  function selectedRows() { return S.items.filter(it => S.selected.has(it.name)); }

  /* ============================== 左栏 ============================== */
  function renderLeft(el) {
    const manualCount = S.total && S.srcFilter === 'manual'
      ? S.total : (S._manualTotal != null ? S._manualTotal : '');
    const srcRows = [
      { key: 'all', name: '全部', count: '', dot: 'var(--c-accent)' },
      { key: 'manual', name: '本地 · 手动', count: manualCount, dot: '', local: true },
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
        // 工具来源组：按 target 的 tool 去重，整行点击进入提取模式
        const seen = new Map();
        for (const t of (S.targets || [])) if (t.tool && t.tool !== 'plain' && !seen.has(t.tool)) seen.set(t.tool, t.tool_name || t.name || t.tool);
        if (!seen.size) return '';
        return `<div class="nv-h"><span>工具（提取来源）</span></div>
        <div class="nv-srcs" data-testid="skills-tool-srcs">
          ${[...seen].map(([tid, tname]) => `
            <div class="nv-src-row ${S.toolSel && S.toolSel.id === tid ? 'is-on' : ''}" data-tool="${esc(tid)}" data-testid="skills-tool-src">
              <span class="tool-dot tool-dot--local"></span>
              <span class="nv-sname">${esc(tname)}</span>
            </div>`).join('')}
        </div>`;
      })()}
      <div class="nv-h" style="margin-top:var(--sp-2)"><span>条目</span><span class="nv-cnt" data-testid="skills-total">${S.total}</span></div>
      <div class="nv-filter"><input class="hub-input" data-testid="skills-search" placeholder="搜索条目…" value="${esc(S.q)}"></div>
      <div class="nv-list" data-testid="skills-list">
        ${S.items.map(it => MV.item({
          id: it.name, testid: 'skills-row', chkTestid: 'skills-check',
          sel: S.selected.has(it.name),
          chipText: it.manual ? '本地' : String(it.source_name || '').slice(0, 2),
          chipCls: it.manual ? 'chip--muted' : 'chip--accent',
          title: it.name,
          sub: it.description || '',
          meta: it.manual ? '本地' : String(it.source_name || ''),
        })).join('') || '<div class="hub-empty">没有条目<div class="hub-empty__hint">拉取源仓库或手动新建</div></div>'}
      </div>
      <div class="nv-pager" data-testid="skills-pager">
        <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? 'disabled' : ''}>‹</button>
        ${pageButtons()}
        <button class="nv-pbtn" data-p="next" ${S.page >= S.pages ? 'disabled' : ''}>›</button>
        <button class="nv-pbtn" data-sel="all" data-testid="skills-sel-all" title="全选本页">全选</button>
        <button class="nv-pbtn" data-sel="invert" data-testid="skills-sel-invert" title="反选本页">反选</button>
        <button class="nv-pbtn" data-sel="none" data-testid="skills-sel-none" title="清空选择" ${S.selected.size ? '' : 'disabled'}>清空</button>
        <span class="nv-pinfo">${S.selected.size ? `已选 ${S.selected.size} · ` : ''}每页 ${S.perPage} · 共 ${S.total} 条</span>
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
        await refresh();
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
        renderCenter(document.querySelector('#view-skills .nv-center'));
        renderRight(document.querySelector('#view-skills .nv-right'));
      };
      row.onclick = async (e) => {
        if (e.target.type === 'checkbox' || e.target.closest('.mvi__body')) return;
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
        renderCenter(document.querySelector('#view-skills .nv-center'));
        renderRight(document.querySelector('#view-skills .nv-right'));
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

  async function pullSource(sid, btn) {
    btn.classList.add('is-loading');
    const r = await post('/api/skills/sources/' + sid + '/pull');
    btn.classList.remove('is-loading');
    if (r.data.ok) {
      if (r.data.needs_action) { HubUI.sourceRemovedDialog('skills', sid, r.data, { afterRemove }); return; }
      const d = r.data;
      HubUI.toast(`拉取完成 · 新增 ${d.added.length} / 变更 ${d.changed.length} / 移除 ${d.removed.length}`,
        d.added.length + d.changed.length ? 'success' : 'info');
    } else HubUI.toast('拉取失败：' + (r.data.error || ''), 'error', 5200);
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
          <label>工具<select class="hub-input" id="tgt-tool">
            ${TOOL_LIST.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
            <option value="plain">通用 (.agents)</option>
          </select></label>
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
        <div class="nv-stat"><b>${Object.values(S.reg).filter(r => r.manual).length}</b><span>本地 · 手动</span></div>
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
      if (r.data.ok) showDetail(it.name);
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
          <span class="nv-dv">${esc(r.source_name)}${r.manual ? ' · 手动' : ' · v' + esc(String(r.version || '').slice(0, 8))}</span>
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
        <div class="nv-ddesc">该工具 skills 目录中实际存在的条目，与本地库对齐。未收编 / 有差异可提取入库；工具内文件保留不动。</div>
        <div class="nv-dops" data-testid="skills-tool-ops">
          <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-tool-extract" ${checked.length ? '' : 'disabled'}>提取所选（${checked.length}）</button>
          <button class="hub-btn btn-sm" data-testid="skills-tool-extract-all" ${extractable.length ? '' : 'disabled'}>提取全部可收编（${extractable.length}）</button>
        </div>
      </div>
      <div class="nv-sec"><span>条目</span><span class="nv-cnt" style="font-weight:400;font-family:var(--font-mono);color:var(--c-ink-4)">未收编 ${cnt('local_only')} · 有差异 ${cnt('diff')} · 一致 ${cnt('synced')}</span></div>
      ${items.map(it => `
        <div class="nv-deprow" data-name="${esc(it.name)}" data-testid="skills-tool-row">
          <input type="checkbox" data-testid="skills-tool-check" ${S.toolChecked.has(it.name) ? 'checked' : ''} ${it.state === 'synced' ? 'disabled' : ''}>
          <span class="nv-dt">${esc(it.name)}</span>
          ${stateBadge(it.state)}
          <span class="nv-dv">${esc(it.tools.map(t => t.name).join(' · '))}</span>
        </div>`).join('') || '<div class="nv-note">该工具 skills 目录为空或不存在</div>'}`;
    el.querySelectorAll('[data-testid="skills-tool-check"]').forEach(cb => {
      cb.onchange = () => {
        const name = cb.closest('[data-name]').dataset.name;
        cb.checked ? S.toolChecked.add(name) : S.toolChecked.delete(name);
        renderToolCenter(el);
      };
    });
    el.querySelector('[data-testid="skills-tool-extract"]').onclick = () => extractSelected(checked.map(i => i.name));
    el.querySelector('[data-testid="skills-tool-extract-all"]').onclick = () => extractSelected(extractable.map(i => i.name));
  }

  function renderToolRight(el) {
    el.innerHTML = `
      <div class="nv-h"><span>提取说明</span></div>
      <div class="nv-note">提取 = 把工具中实际存在的条目复制进本地库（与源拉取条目同权），之后可在常规视图右栏分发给其他工具。</div>
      <div class="nv-sec"><span>状态含义</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--warn">未收编</span><span class="nv-msub">本地库没有 → 提取后入库</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--err">有差异</span><span class="nv-msub">同名不同内容 → 以工具内容为准覆盖本地库（先备份）</span></div>
      <div class="nv-mkrow"><span class="hub-badge sb-status--ok">一致</span><span class="nv-msub">与本地库内容相同，无需处理</span></div>`;
  }

  /* ============================== 右栏 ============================== */
  function renderRight(el) {
    if (S.toolSel) return renderToolRight(el);
    const rows = S.mode === 'detail' && S._detailName ? S.items.filter(x => x.name === S._detailName)
      : S.mode === 'multi' ? selectedRows() : [];
    const title = S.mode === 'detail' ? S._detailName : S.mode === 'multi' ? `已选 ${rows.length} 条汇总` : '全部条目';
    const staleAll = S.targetsStat.reduce((a, t) => a + t.items.stale, 0);
    const missingAll = S.targetsStat.reduce((a, t) => a + t.items.missing, 0);
    el.innerHTML = `
      <div class="nv-h"><span>工具 · ${esc(title)}</span><button class="hub-btn btn-sm" data-testid="skills-add-target">＋ 添加</button></div>
      <div class="nv-uops">
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-inline-update" ${staleAll ? '' : 'disabled'}>一键更新可更新（${staleAll}）</button>
        <button class="hub-btn btn-sm" data-testid="skills-inline-install" ${missingAll ? '' : 'disabled'}>安装缺失（${missingAll}）</button>
        <button class="hub-btn btn-sm" data-testid="skills-inline-all" ${S.targetsStat.length ? '' : 'disabled'}>全部更新</button>
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
        const label = stale ? `${stale}/${n} 需更新` : missing ? `${missing}/${n} 未安装` : n ? `${latest}/${n} 最新` : '暂无条目';
        return `
        <div class="nv-trow" data-testid="skills-target-row">
          <div class="nv-th"><span class="nv-tname">${esc(t.tool_name || t.name)}</span><span class="hub-badge sb-status--${tone}">${label}</span></div>
          <div class="nv-tpath">${esc(tilde(t.path))}</div>
          ${(staleNames.length || missingNames.length) ? `
          <div class="nv-tstat"><span class="nv-tver">${esc([...staleNames, ...missingNames].slice(0, 3).join(' · '))}${staleNames.length + missingNames.length > 3 ? ' …' : ''}</span></div>` : ''}
          <div class="nv-tstat">
            <span class="nv-tver">${stale ? '更新前自动备份被覆盖文件' : missing ? '首次安装将创建目录' : scope ? '全部为最新版本' : (t.items.missing ? '' : '全部为最新版本')}</span>
            <span style="flex:1"></span>
            ${stale ? `<button class="hub-btn btn-sm hub-btn--primary" data-tid="${t.id}" data-act="stale" data-testid="skills-tgt-update">更新（${stale}）</button>` : ''}
            ${missing ? `<button class="hub-btn btn-sm" data-tid="${t.id}" data-act="missing" data-testid="skills-tgt-install">安装（${missing}）</button>` : ''}
            ${!stale && !missing && n ? '<button class="hub-btn btn-sm" disabled>已是最新</button>' : ''}
          </div>
        </div>`;
      }).join('') || '<div class="hub-empty">没有 skills_dir 目标<div class="hub-empty__hint">点「＋ 添加」接入</div></div>'}`;
    el.querySelector('[data-testid="skills-add-target"]').onclick = addTargetDialog;
    el.querySelector('[data-testid="skills-inline-update"]').onclick = () => {
      if (!staleAll) return;
      for (const t of S.targetsStat) {
        if (t.items.stale) inlineUpdate({ names: t.stale_names || [], tid: t.id });
      }
    };
    el.querySelector('[data-testid="skills-inline-install"]').onclick = () => {
      if (!missingAll) return;
      for (const t of S.targetsStat) installMissing(t.id);
    };
    el.querySelector('[data-testid="skills-inline-all"]').onclick = updateAllToTargets;
    el.querySelectorAll('[data-tid]').forEach(btn => {
      btn.onclick = () => {
        const tid = Number(btn.dataset.tid);
        if (btn.dataset.act === 'stale') inlineUpdate({ names: (S.targetsStat.find(t => t.id === tid).stale_names || []), tid });
        else if (btn.dataset.act === 'missing') installMissing(tid);
      };
    });
    syncShell(skillsStats, '勾选条目 → 右侧选择目标安装；安装 / 更新前会自动备份目标目录。');
  }

  let _allCache = null;
  async function primeAllCache() {
    const r = await api('/api/skills/items?per_page=100');
    _allCache = (r.data.items || []);
  }
  function allItemsCache() { return _allCache; }

  function staleNamesFor(tid) {
    return (S.targetsStat.find(t => t.id === tid) || {}).stale_names || [];
  }

  async function inlineUpdate({ names, tid, installAll }) {
    const target = S.targetsStat.find(t => t.id === tid);
    let list = names;
    if (installAll) list = await missingFor(tid);
    if (!list || !list.length) { HubUI.toast('没有需要更新的条目', 'info'); return; }
    const r = await post('/api/skills/distribute', { names: list, target_ids: [tid] });
    notifyResults(`写入 ${target ? target.name : tid}`, r.data);
    await refresh();
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

  async function installMissing(tid) {
    const list = await missingFor(tid);
    if (!list.length) { HubUI.toast('没有缺失条目', 'info'); return; }
    const target = S.targetsStat.find(t => t.id === tid);
    const r = await post('/api/skills/distribute', { names: list, target_ids: [tid] });
    notifyResults(`安装到 ${target ? target.name : tid}`, r.data);
    await refresh();
  }

  async function updateAllToTargets() {
    const tids = S.targetsStat.map(t => t.id);
    if (!tids.length) { HubUI.toast('没有目标', 'warn'); return; }
    await primeAllCache();
    const names = [...new Set((_allCache || []).map(x => x.name))];
    if (!names.length) { HubUI.toast('没有条目可更新', 'info'); return; }
    const r = await post('/api/skills/distribute', { names, target_ids: tids });
    notifyResults('全部更新', r.data);
    await refresh();
  }

  async function batchUpdate() {
    const names = [...S.selected];
    if (!names.length) { HubUI.toast('先勾选条目', 'warn'); return; }
    const tids = S.targetsStat.map(t => t.id);
    if (!tids.length) { HubUI.toast('没有目标，请先添加', 'warn'); return; }
    const r = await post('/api/skills/distribute', { names, target_ids: tids });
    notifyResults('批量分发', r.data);
    await refresh();
  }

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
        HubUI.toast(`${x.item} → ${x.target}：${x.reason || x.status}`, tone === 'warn' ? 'warn' : 'info', 5600);
      }
    }
  }

  /* ============================== CRUD 对话框 ============================== */
  const TEMPLATE = `---\nname: NAME\ndescription: \n---\n\n# NAME\n\n在这里描述这个 skill 的用途、输入输出与工作流程。\n`;

  function createDialog() {
    HubUI.modal({
      title: '新建 Skill', hasInput: false, confirmText: '创建', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">手动编写的条目与远程拉取同库同权：保存后进入本地库，可分发到任意目标、记入台账。</div>
        <div class="form-grid">
          <label>名称<input class="hub-input" id="ms-name" data-testid="skills-new-name" placeholder="my-skill"></label>
          <label>描述<input class="hub-input" id="ms-desc" data-testid="skills-new-desc" placeholder="一句话说明用途（写入 SKILL.md frontmatter）"></label>
          <label>SKILL.md（预填模板，可直接改写）
            <textarea class="hub-input" id="ms-body" data-testid="skills-new-body" rows="9" style="font-family:var(--font-mono);font-size:var(--fs-xs)">${esc(TEMPLATE.split('NAME').join('my-skill'))}</textarea></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">保存后写入 registry/skills/&lt;名称&gt;/ · 与现有条目重名将拦截 · 操作记入台账</div>`,
      onConfirm: async () => {
        const name = document.getElementById('ms-name').value.trim();
        const desc = document.getElementById('ms-desc').value.trim();
        let body = document.getElementById('ms-body').value;
        const r = await post('/api/skills/registry/item', {
          name, description: desc,
          files: { 'SKILL.md': body },
        });
        if (r.data.ok) { HubUI.toast('已创建 ' + name + ' · 已记入台账', 'success'); await refresh(); showDetail(name); }
        else { HubUI.toast('创建失败：' + (r.data.error || ''), 'error', 5200); return false; }
      },
    });
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
          if (r.data.ok) { HubUI.toast('已保存 · 已记入台账', 'success'); await refresh(); showDetail(name); }
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
          <label>名称（默认取目录名）<input class="hub-input" id="mi-name" data-testid="skills-import-name" placeholder="留空 = 目录名"></label>
        </div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">需包含 SKILL.md，缺失时报错 · 与现有条目重名将拦截 · 导入记入台账</div>`,
      onConfirm: async () => {
        const r = await post('/api/skills/registry/import', {
          path: document.getElementById('mi-path').value.trim(),
          name: document.getElementById('mi-name').value.trim() || null,
        });
        if (r.data.ok) {
          HubUI.toast(`已导入 ${r.data.name} · ${r.data.files} 个文件 · 已记入台账`, 'success');
          await refresh(); showDetail(r.data.name);
        } else {
          const msg = r.data.error || '';
          if (msg.includes('同名手动条目')) {
            HubUI.confirm('同名条目已存在', esc(msg) + '<br>用目录内容覆盖它？（当前版本会先备份）', async () => {
              const r2 = await post('/api/skills/registry/import', {
                path: document.getElementById('mi-path') ? document.getElementById('mi-path').value.trim() : '',
                name: document.getElementById('mi-name') ? document.getElementById('mi-name').value.trim() || null : null,
                overwrite: true,
              });
              if (r2.data.ok) { HubUI.toast(`已覆盖导入 ${r2.data.name}`, 'success'); await refresh(); showDetail(r2.data.name); }
              else HubUI.toast('导入失败：' + (r2.data.error || ''), 'error', 5200);
            }, { confirmText: '覆盖导入', danger: true });
            return false;
          }
          HubUI.toast('导入失败：' + msg, 'error', 5200);
          return false;
        }
      },
    });
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
        if (r.data.ok) { HubUI.toast(`已覆盖导入 ${name}`, 'success'); await refresh(); showDetail(name); }
        else { HubUI.toast('导入失败：' + (r.data.error || ''), 'error', 5200); return false; }
      },
    });
  }

  function deleteFlow(name, after) {
    HubUI.confirm('删除 ' + name, '将删除该本地条目；已部署的会连同目标内文件一起删除（先备份）。', async () => {
      const r = await api('/api/skills/registry/item/' + encodeURIComponent(name) + '?force=1', { method: 'DELETE' });
      if (r.data.ok) { HubUI.toast('已删除 ' + name + ' · 已记入台账', 'success'); S.selected.delete(name); await refresh(); if (after) after(); }
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
    if (wasOpen) { showDetailClose(); syncPanelOpen(); return; }
    await showDetail(name);                          // 右侧「部署目标」面板跟随当前条目
    const row = [...host.querySelectorAll('.mvi')].find(r => r.dataset.id === name);
    const it = S.items.find(x => x.name === name);
    if (row && it) openAcc(row, it);
    syncPanelOpen();
  }
  function openAcc(row, it) {
    row.classList.add('is-open');
    const box = row.querySelector('.mvi__accin');
    box.innerHTML = MV.accBody({
      meta: it.manual ? '本地' : (it.source_name || ''),
      source: it.manual ? '本地库' : (it.source_name || ''),
      actions: [
        { key: 'edit', label: '编辑', disabled: !it.manual, title: it.manual ? '' : '远程条目只读（改源仓库后拉取）' },
        { key: 'copy', label: '复制' },
        { key: 'del', label: '删除', disabled: !it.manual, title: it.manual ? '' : '远程条目随源仓库同步，不能单独删除' },
      ],
    });
    const pre = box.querySelector('[data-acc-pre]');
    api('/api/skills/item/' + encodeURIComponent(it.name)).then(r => {
      if (pre.isConnected) pre.textContent = ((r.data || {}).skill_md || '（未找到 SKILL.md）').slice(0, 6000);
    }).catch(() => { pre.textContent = '（加载失败）'; });
    box.querySelectorAll('[data-acc]').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.acc === 'edit') editDialog(it.name);
        if (b.dataset.acc === 'del') deleteFlow(it.name, () => showDetailClose());
        if (b.dataset.acc === 'copy') {
          try { await navigator.clipboard.writeText(pre.textContent || ''); HubUI.toast('已复制 SKILL.md', 'success'); }
          catch (err) { HubUI.toast('复制失败：' + err.message, 'error'); }
        }
      };
    });
  }
  function syncPanelOpen() {
    const panel = document.querySelector('#sk-panel');
    if (panel) panel.classList.toggle('is-in', !!(S.selected.size || S._detailName || S.mode === 'multi'));
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
      { n: reg.filter(r => r.manual).length, label: '本地 · 手动' },
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
    const t = root.querySelector('#sk-title');
    // 稿子：标题只随"当前来源"变（展开某条不改标题）
    if (t) t.textContent = (S.mode === 'multi' ? `已选 ${S.selected.size} 条`
        : (activeSrcName() ? `${activeSrcName()} · Skills` : '全部 Skills'));
    const c = root.querySelector('#sk-count');
    if (c) c.textContent = `· ${S.items.length} / ${S.total}`;
  }

  /** 外壳统一走 MV.shell（与会话页 / 记忆同一骨架）。view 自己的容器名挂到槽位上，
      逻辑一行不改，也不用再各写一套骨架。 */
  function shellHTML(topLabel) {
    return MV.shell({ prefix: 'sk', top: '', title: topLabel, q: S.q, placeholder: '搜索条目…' })
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
    const root = document.getElementById('view-skills');
    const topHost = root.querySelector('#sk-top');
    const left = root.querySelector('.nv-left');
    if (!topHost || !left) return;

    // ---- 来源分组：走 MV.top（与记忆共用同一套 markup：分组头 / 卡片 / 统计条 / 提示语）----
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
      prefix: 'sk', label: 'Skill 来源', sources: srcs, counts,
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
    const sideHost = root.querySelector('#sk-side');
    if (activeSrc) {
      if (topHost) topHost.hidden = true;
      if (sideHost) {
        sideHost.hidden = false;
        sideHost.innerHTML = MV.side({
          prefix: 'sk', items: srcs, counts, activeId: activeSrc,
          groups: [
            { label: '本地', ids: ['manual'] },
            { label: '远程仓库', ids: remoteKeys },
            { label: '工具', ids: [...tools.keys()] },
          ],
        });
        const back = sideHost.querySelector('#sk-back');
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
      await refresh();
    },
    refresh,
  };
})();
