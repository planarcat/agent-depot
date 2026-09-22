/* ====================================================================
   Skills 视图：源管理 / 拉取 / 本地库 / 分发向导（三栏）
   ==================================================================== */
(function () {
  'use strict';
  const S = { sources: [], targets: [], catalog: [], registry: [], selected: new Set(), detail: null };

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

  async function loadAll() {
    const [src, tgt, cat, reg] = await Promise.all([
      api('/api/skills/sources'), api('/api/skills/targets'),
      api('/api/skills/catalog'), api('/api/skills/registry')]);
    S.sources = (src.data.sources) || [];
    S.targets = (tgt.data.targets) || [];
    S.catalog = (cat.data.items) || [];
    S.registry = (reg.data.items) || [];
  }

  function renderLeft(el) {
    el.innerHTML = `
      <div class="rail__h">源仓库 <button class="hub-btn btn-sm" data-testid="skills-add-source">＋ 添加</button></div>
      <div data-testid="skills-sources">
        ${S.sources.length ? S.sources.map(s => `
          <div class="tool-card" data-source-id="${s.id}">
            <div class="tool-card__head">
              <span class="tool-dot" style="background:${s.last_error ? 'var(--c-err)' : 'var(--c-accent)'}"></span>
              <span class="tool-card__name">${esc(s.name)}</span>
              <span class="tool-card__count">${s.item_count}</span>
            </div>
            <div class="tool-card__meta">${s.last_sync_at ? '同步 ' + esc(fmtTime(s.last_sync_at)) : '从未同步'}${s.last_error ? '<br><span class="sb-err-text">' + esc(String(s.last_error).slice(0, 60)) + '</span>' : ''}</div>
            <div class="tool-card__acts">
              <button class="hub-btn btn-sm" data-act="pull" data-testid="skills-pull-${s.id}">拉取</button>
              <button class="hub-btn btn-sm" data-act="del-source">移除</button>
            </div>
          </div>`).join('') : '<div class="hub-empty">还没有源仓库<div class="hub-empty__hint">点「＋ 添加」接入 Git 源</div></div>'}
      </div>
      <div class="rail__h" style="margin-top:var(--sp-5)">分发目标 <button class="hub-btn btn-sm" data-testid="skills-add-target">＋ 添加</button></div>
      <div data-testid="skills-targets">
        ${S.targets.map(t => `
          <div class="tool-card" data-target-id="${t.id}">
            <div class="tool-card__head"><span class="tool-card__name">${esc(t.name)}</span></div>
            <div class="tool-card__meta mono-xs">${esc(t.tool || t.kind)} · ${esc(t.path.replace(/^\/Users\/[^/]+/, '~').slice(0, 42))}</div>
          </div>`).join('')}
      </div>`;
    el.querySelector('[data-testid="skills-add-source"]').onclick = addSourceDialog;
    el.querySelector('[data-testid="skills-add-target"]').onclick = addTargetDialog;
    el.querySelectorAll('[data-source-id]').forEach(card => {
      card.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const sid = card.dataset.sourceId;
          if (btn.dataset.act === 'pull') await pullSource(sid, btn);
          if (btn.dataset.act === 'del-source') await delSource(sid, card);
        };
      });
    });
  }

  async function pullSource(sid, btn) {
    btn.classList.add('is-loading');
    const r = await post('/api/skills/sources/' + sid + '/pull');
    btn.classList.remove('is-loading');
    if (r.data.ok) {
      const d = r.data;
      HubUI.toast(`拉取完成 · 新增 ${d.added.length} / 变更 ${d.changed.length} / 移除 ${d.removed.length}`,
        d.added.length + d.changed.length ? 'success' : 'info');
    } else HubUI.toast('拉取失败：' + (r.data.error || ''), 'error', 5200);
    await refresh();
  }
  async function delSource(sid, card) {
    HubUI.confirm('移除源', '确认移除该源？已拉取到本地库的内容不受影响。', async () => {
      const r = await api('/api/skills/sources/' + sid, { method: 'DELETE' });
      if (r.data.ok) HubUI.toast('已移除源', 'success'); else HubUI.toast('移除失败', 'error');
      await refresh();
    }, { confirmText: '移除', danger: true });
  }

  function addSourceDialog() {
    HubUI.modal({
      title: '添加 Skills 源仓库', hasInput: false, confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="src-name" placeholder="my-skills"></label>
          <label>Git URL<input class="hub-input" id="src-url" placeholder="https://github.com/org/repo.git 或 本地路径"></label>
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
            <option value="claude">Claude Code</option><option value="codex">Codex CLI</option>
            <option value="opencode">OpenCode</option><option value="plain">通用 (.agents)</option>
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

  function renderCenter(el) {
    const rows = S.catalog.map(it => {
      const reg = S.registry.find(r => r.name === it.name);
      const depCount = reg ? (reg.deployments || []).length : 0;
      return `<div class="row sb-row" data-item="${esc(it.name)}" data-testid="skills-row">
        <div><input type="checkbox" data-testid="skills-check" ${S.selected.has(it.name) ? 'checked' : ''}></div>
        <div class="sb-row__main">
          <span class="row__title">${esc(it.name)}</span>&nbsp;${badge(it.status)}
          <div class="row__sub">${esc(it.description || '')}</div>
        </div>
        <div class="row__msgs">v${esc(String(it.version || '').slice(0, 10))}</div>
        <div class="row__meta">${depCount ? '已部署 ' + depCount + ' 处' : ''}<div class="src">${esc(it.source_name)}</div></div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="center__toolbar">
        <button class="hub-btn btn-sm" data-testid="skills-update-selected">更新所选到本地</button>
        <button class="hub-btn btn-sm" data-testid="skills-update-all">一键更新全部可更新</button>
        <span class="sb-spacer"></span>
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="skills-distribute">分发所选…</button>
      </div>
      <div class="rows" data-testid="skills-rows">
        ${rows || '<div class="hub-empty">目录为空<div class="hub-empty__hint">先在左侧「拉取」源仓库</div></div>'}
      </div>`;
    el.querySelector('[data-testid="skills-update-selected"]').onclick = () => updateToLocal([...S.selected]);
    el.querySelector('[data-testid="skills-update-all"]').onclick = () => {
      const upd = S.catalog.filter(i => i.status === 'update-available' || i.status === 'not-installed').map(i => i.name);
      if (!upd.length) { HubUI.toast('没有可更新的条目', 'info'); return; }
      updateToLocal(upd);
    };
    el.querySelector('[data-testid="skills-distribute"]').onclick = () => {
      if (!S.selected.size) { HubUI.toast('先勾选要分发的条目', 'warn'); return; }
      distributeWizard([...S.selected]);
    };
    el.querySelectorAll('[data-testid="skills-row"]').forEach(row => {
      row.querySelector('input').onclick = (e) => {
        e.stopPropagation();
        const nm = row.dataset.item;
        e.target.checked ? S.selected.add(nm) : S.selected.delete(nm);
      };
      row.onclick = (e) => { if (e.target.type !== 'checkbox') showDetail(row.dataset.item, el); };
    });
  }

  async function updateToLocal(names) {
    if (!names.length) { HubUI.toast('先勾选条目，或用「一键更新全部可更新」', 'warn'); return; }
    const r = await post('/api/skills/registry/update', { names });
    if (!r.data.ok) { HubUI.toast('更新失败：' + (r.data.error || ''), 'error'); return; }
    const res = r.data.results || [];
    const ok = res.filter(x => x.status === 'updated' || x.status === 'installed').length;
    const conflict = res.filter(x => x.status.includes('conflict')).length;
    const failed = res.filter(x => x.status === 'failed').length;
    HubUI.toast(`更新完成 · 成功 ${ok} · 冲突 ${conflict} · 失败 ${failed}`,
      failed || conflict ? 'warn' : 'success', 4800);
    for (const x of res) {
      if (x.status.includes('conflict')) HubUI.toast(`${x.item}：${x.reason}`, 'warn', 5200);
    }
    await refresh();
  }

  async function showDetail(name, centerEl) {
    const [detail, diff] = await Promise.all([
      api('/api/skills/item/' + encodeURIComponent(name)),
      api('/api/skills/diff?name=' + encodeURIComponent(name))]);
    const d = detail.data || {};
    const right = document.getElementById('view-skills').querySelector('.rail.sb-right');
    const dif = (diff.data && diff.data.diff) || '';
    right.innerHTML = `
      <div class="rail__h">${esc(name)} · 详情</div>
      <div class="sb-detail__meta">版本：${esc(d.version || '—')} · 文件 ${ (d.files || []).length} 个</div>
      <div class="sb-detail__acts">
        <button class="hub-btn btn-sm" data-testid="skills-rollback">回退上一版本</button>
      </div>
      <div class="rail__h" style="margin-top:var(--sp-4)">与源对比</div>
      <pre class="sb-diff" data-testid="skills-diff">${esc(dif.slice(0, 6000) || '（无差异）')}</pre>
      <div class="rail__h" style="margin-top:var(--sp-4)">SKILL.md</div>
      <pre class="sb-md">${esc((d.skill_md || '').slice(0, 6000))}</pre>`;
    right.querySelector('[data-testid="skills-rollback"]').onclick = async () => {
      const r = await post('/api/skills/registry/rollback', { name });
      if (r.data.ok) { HubUI.toast('已回退到上一版本', 'success'); await refresh(); }
      else HubUI.toast('回退失败：' + (r.data.error || ''), 'error');
    };
  }

  function distributeWizard(names) {
    const tgtHtml = S.targets.map(t => `
      <label class="wiz-target"><input type="checkbox" value="${t.id}" checked> ${esc(t.name)}
        <span class="mono-xs">${esc(t.path.replace(/^\/Users\/[^/]+/, '~'))}</span></label>`).join('');
    HubUI.modal({
      title: `分发 ${names.length} 个条目`, confirmText: '执行分发', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">选择目标（可多选）：</div>
        <div class="wiz-targets">${tgtHtml || '<div class="hub-empty">没有目标，请先添加</div>'}</div>
        <div class="hub-modal__sub" style="margin-top:var(--sp-3)">预览（dry-run）：</div>
        <div data-testid="skills-wizard-preview" class="wiz-preview">点「执行分发」前可先预览；直接执行也可，逐条结果会显示在这里。</div>`,
      onConfirm: async (val, close) => {
        const tids = [...document.querySelectorAll('.wiz-targets input:checked')].map(x => parseInt(x.value, 10));
        if (!tids.length) { HubUI.toast('至少选择一个目标', 'warn'); return false; }
        const preview = document.querySelector('[data-testid="skills-wizard-preview"]');
        const dry = await post('/api/skills/distribute', { names, target_ids: tids, dry_run: true });
        const dryRows = (dry.data.results || []);
        const will = dryRows.filter(r => r.status === 'ok').length;
        const dryNote = `将写入 ${will} 项；冲突/跳过 ${dryRows.length - will} 项。`;
        this.__preview = dryNote;
        preview.innerHTML = `<div>${esc(dryNote)}</div><div class="mono-xs">${dryRows.slice(0, 8).map(r => esc(`${r.item} → ${r.target}: ${r.status}${r.reason ? '（' + r.reason.slice(0, 30) + '）' : ''}`)).join('<br>')}</div>`;
        // 二次确认执行
        HubUI.confirm('确认执行分发？', dryNote + '<br>逐条结果将记录到台账。', async () => {
          const r = await post('/api/skills/distribute', { names, target_ids: tids });
          const res = r.data.results || [];
          const ok = res.filter(x => x.status === 'ok').length;
          const conflict = res.filter(x => x.status === 'conflict').length;
          const failed = res.filter(x => x.status === 'failed').length;
          HubUI.toast(`分发完成 · 成功 ${ok} · 冲突 ${conflict} · 失败 ${failed}`,
            failed || conflict ? 'warn' : 'success', 5200);
          close();
          await refresh();
        }, { confirmText: '确认分发' });
        return false; // 保持向导打开直到确认流程结束
      },
    });
  }

  async function refresh() {
    await loadAll();
    renderLeft(document.getElementById('view-skills').querySelector('.rail.sb-left'));
    renderCenter(document.getElementById('view-skills').querySelector('.center.sb-center'));
  }

  window.SkillsView = {
    async render(root) {
      root.innerHTML = `
        <div class="main sb-layout">
          <aside class="rail sb-left"></aside>
          <main class="center sb-center"></main>
          <aside class="rail sb-right"><div class="hub-empty">选择条目查看详情</div></aside>
        </div>`;
      await refresh();
    },
    refresh,
  };
})();
