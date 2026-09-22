/* ====================================================================
   MCP 视图：源 / 本地库 / 分发 / 连接验证（与 Skills 同构）
   ==================================================================== */
(function () {
  'use strict';
  const S = { sources: [], targets: [], catalog: [], registry: [], selected: new Set() };

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
      api('/api/mcp/sources'), api('/api/mcp/targets'),
      api('/api/mcp/catalog'), api('/api/mcp/registry')]);
    S.sources = (src.data.sources) || [];
    S.targets = (tgt.data.targets) || [];
    S.catalog = (cat.data.items) || [];
    S.registry = (reg.data.items) || [];
  }

  function renderLeft(el) {
    el.innerHTML = `
      <div class="rail__h">MCP 源 <button class="hub-btn btn-sm" data-testid="mcp-add-source">＋ 添加</button></div>
      <div data-testid="mcp-sources">
        ${S.sources.length ? S.sources.map(s => `
          <div class="tool-card" data-source-id="${s.id}">
            <div class="tool-card__head">
              <span class="tool-dot" style="background:${s.last_error ? 'var(--c-err)' : 'var(--c-accent)'}"></span>
              <span class="tool-card__name">${esc(s.name)}</span><span class="tool-card__count">${s.item_count}</span>
            </div>
            <div class="tool-card__meta">${s.last_sync_at ? '同步 ' + esc(fmtTime(s.last_sync_at)) : '从未同步'}</div>
            <div class="tool-card__acts">
              <button class="hub-btn btn-sm" data-act="pull" data-testid="mcp-pull-${s.id}">拉取</button>
              <button class="hub-btn btn-sm" data-act="del">移除</button>
            </div>
          </div>`).join('') : '<div class="hub-empty">还没有 MCP 源<div class="hub-empty__hint">点「＋ 添加」接入 Git 源（含 mcp/*.json）</div></div>'}
      </div>
      <div class="rail__h" style="margin-top:var(--sp-5)">写入目标</div>
      <div data-testid="mcp-targets">
        ${S.targets.map(t => `
          <div class="tool-card">
            <div class="tool-card__head"><span class="tool-card__name">${esc(t.name)}</span>
              <span class="hub-badge hub-badge--neutral">${esc(t.kind === 'mcp_toml' ? 'TOML' : 'JSON')}</span></div>
            <div class="tool-card__meta mono-xs">${esc(t.path.replace(/^\/Users\/[^/]+/, '~').slice(0, 44))}</div>
          </div>`).join('')}
      </div>`;
    el.querySelector('[data-testid="mcp-add-source"]').onclick = addSourceDialog;
    el.querySelectorAll('[data-source-id]').forEach(card => {
      card.querySelector('[data-act="pull"]').onclick = async (e) => {
        const btn = e.currentTarget; btn.classList.add('is-loading');
        const r = await post('/api/mcp/sources/' + card.dataset.sourceId + '/pull');
        btn.classList.remove('is-loading');
        if (r.data.ok) HubUI.toast(`拉取完成 · 新增 ${r.data.added.length} / 变更 ${r.data.changed.length}`,
          r.data.added.length + r.data.changed.length ? 'success' : 'info');
        else HubUI.toast('拉取失败：' + (r.data.error || ''), 'error', 5200);
        await refresh();
      };
      card.querySelector('[data-act="del"]').onclick = () => {
        HubUI.confirm('移除源', '确认移除该 MCP 源？本地库与已部署配置不受影响。', async () => {
          await api('/api/mcp/sources/' + card.dataset.sourceId, { method: 'DELETE' });
          HubUI.toast('已移除源', 'success'); await refresh();
        }, { confirmText: '移除', danger: true });
      };
    });
  }

  function addSourceDialog() {
    HubUI.modal({
      title: '添加 MCP 源仓库', confirmText: '添加', cancelText: '取消',
      bodyHTML: `
        <div class="form-grid">
          <label>名称<input class="hub-input" id="msrc-name" placeholder="team-mcp"></label>
          <label>Git URL<input class="hub-input" id="msrc-url" placeholder="https://... 或 本地路径"></label>
          <label>分支<input class="hub-input" id="msrc-branch" value="main"></label>
          <label>凭据引用（可选）<input class="hub-input" id="msrc-auth" placeholder="env:GITHUB_TOKEN"></label>
        </div>`,
      onConfirm: async () => {
        const r = await post('/api/mcp/sources', {
          name: document.getElementById('msrc-name').value.trim(),
          url: document.getElementById('msrc-url').value.trim(),
          branch: document.getElementById('msrc-branch').value.trim() || 'main',
          auth_ref: document.getElementById('msrc-auth').value.trim() || null,
        });
        if (r.data.ok) { HubUI.toast('已添加 MCP 源', 'success'); await refresh(); }
        else { HubUI.toast('添加失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
  }

  function renderCenter(el) {
    const rows = S.catalog.map(it => {
      const reg = S.registry.find(r => r.name === it.name);
      const depCount = reg ? (reg.deployments || []).length : 0;
      return `<div class="row sb-row" data-item="${esc(it.name)}" data-testid="mcp-row">
        <div><input type="checkbox" ${S.selected.has(it.name) ? 'checked' : ''}></div>
        <div class="sb-row__main">
          <span class="row__title">${esc(it.name)}</span>&nbsp;${badge(it.status)}
          <span class="hub-badge hub-badge--neutral">${esc(it.transport)}</span>
          <div class="row__sub">${esc(it.target || '')}</div>
        </div>
        <div class="row__msgs">${it.env_keys.length ? it.env_keys.length + ' env' : ''}</div>
        <div class="row__meta">${depCount ? '已写入 ' + depCount + ' 处' : ''}<div class="src">${esc(it.source_name)}</div></div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="center__toolbar">
        <button class="hub-btn btn-sm" data-testid="mcp-update-selected">更新所选到本地</button>
        <button class="hub-btn btn-sm" data-testid="mcp-verify">验证连接</button>
        <span class="sb-spacer"></span>
        <button class="hub-btn btn-sm hub-btn--primary" data-testid="mcp-distribute">分发所选…</button>
      </div>
      <div class="rows" data-testid="mcp-rows">
        ${rows || '<div class="hub-empty">目录为空<div class="hub-empty__hint">先在左侧「拉取」MCP 源</div></div>'}
      </div>`;
    el.querySelector('[data-testid="mcp-update-selected"]').onclick = () => updateToLocal([...S.selected]);
    el.querySelector('[data-testid="mcp-verify"]').onclick = verifySelected;
    el.querySelector('[data-testid="mcp-distribute"]').onclick = () => {
      if (!S.selected.size) { HubUI.toast('先勾选要分发的条目', 'warn'); return; }
      distributeWizard([...S.selected]);
    };
    el.querySelectorAll('[data-testid="mcp-row"]').forEach(row => {
      row.querySelector('input').onclick = (e) => {
        e.stopPropagation();
        const nm = row.dataset.item;
        e.target.checked ? S.selected.add(nm) : S.selected.delete(nm);
      };
      row.onclick = (e) => { if (e.target.type !== 'checkbox') showDetail(row.dataset.item); };
    });
  }

  async function updateToLocal(names) {
    if (!names.length) { HubUI.toast('先勾选条目', 'warn'); return; }
    const r = await post('/api/mcp/registry/update', { names });
    if (!r.data.ok) { HubUI.toast('更新失败：' + (r.data.error || ''), 'error'); return; }
    const res = r.data.results || [];
    HubUI.toast(`更新完成 · 成功 ${res.filter(x => x.status === 'updated' || x.status === 'installed').length} · 冲突 ${res.filter(x => x.status.includes('conflict')).length}`,
      res.some(x => x.status === 'failed' || x.status.includes('conflict')) ? 'warn' : 'success');
    await refresh();
  }

  async function verifySelected() {
    const names = [...S.selected];
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

  async function showDetail(name) {
    const d = (await api('/api/mcp/item/' + encodeURIComponent(name))).data || {};
    const right = document.getElementById('view-mcp').querySelector('.rail.sb-right');
    const cfg = d.config || {};
    const envRows = Object.entries(d.env_masked || {}).map(([k, v]) =>
      `<div class="mono-xs">${esc(k)} = ${esc(v)} <button class="hub-btn btn-sm" data-reveal="${esc(k)}">显示</button></div>`).join('');
    right.innerHTML = `
      <div class="rail__h">${esc(name)} · 详情</div>
      <pre class="sb-md">${esc(JSON.stringify(cfg, null, 2))}</pre>
      ${envRows ? `<div class="rail__h" style="margin-top:var(--sp-4)">环境变量（掩码）</div>${envRows}` : ''}
      <div class="sb-detail__acts" style="margin-top:var(--sp-3)">
        <button class="hub-btn btn-sm" data-testid="mcp-rollback">回退上一版本</button>
      </div>`;
    right.querySelectorAll('[data-reveal]').forEach(b => {
      b.onclick = () => { b.textContent = '（掩码存储，原文不展示）'; b.disabled = true; };
    });
    right.querySelector('[data-testid="mcp-rollback"]').onclick = async () => {
      const r = await post('/api/mcp/registry/rollback', { name });
      if (r.data.ok) { HubUI.toast('已回退到上一版本', 'success'); await refresh(); }
      else HubUI.toast('回退失败：' + (r.data.error || ''), 'error');
    };
  }

  function distributeWizard(names) {
    const tgtHtml = S.targets.map(t => `
      <label class="wiz-target"><input type="checkbox" value="${t.id}"> ${esc(t.name)}
        <span class="mono-xs">${esc(t.path.replace(/^\/Users\/[^/]+/, '~'))}</span></label>`).join('');
    HubUI.modal({
      title: `分发 ${names.length} 个 MCP 条目`, confirmText: '执行分发', cancelText: '取消',
      bodyHTML: `
        <div class="hub-modal__sub">选择写入目标（默认不勾选；建议先 dry-run 预览）：</div>
        <div class="wiz-targets">${tgtHtml || '<div class="hub-empty">没有目标</div>'}</div>
        <div data-testid="mcp-wizard-preview" class="wiz-preview"></div>`,
      onConfirm: async (val, close) => {
        const tids = [...document.querySelectorAll('.wiz-targets input:checked')].map(x => parseInt(x.value, 10));
        if (!tids.length) { HubUI.toast('至少选择一个目标', 'warn'); return false; }
        const dry = await post('/api/mcp/distribute', { names, target_ids: tids, dry_run: true });
        const dryRows = dry.data.results || [];
        const will = dryRows.filter(r => r.status === 'ok').length;
        HubUI.confirm('确认写入 MCP 配置？',
          `将写入 ${will} 项（冲突 ${dryRows.filter(r => r.status === 'conflict').length} / 跳过 ${dryRows.filter(r => r.status === 'skipped').length}）。写入前会自动备份目标文件，逐条结果记录台账。`,
          async () => {
            const r = await post('/api/mcp/distribute', { names, target_ids: tids });
            const res = r.data.results || [];
            HubUI.toast(`分发完成 · 成功 ${res.filter(x => x.status === 'ok').length} · 冲突 ${res.filter(x => x.status === 'conflict').length} · 失败 ${res.filter(x => x.status === 'failed').length}`,
              res.some(x => x.status !== 'ok' && x.status !== 'skipped') ? 'warn' : 'success', 5200);
            close(); await refresh();
          }, { confirmText: '确认写入' });
        return false;
      },
    });
  }

  async function refresh() {
    await loadAll();
    renderLeft(document.getElementById('view-mcp').querySelector('.rail.sb-left'));
    renderCenter(document.getElementById('view-mcp').querySelector('.center.sb-center'));
  }

  window.McpView = { async render(root) {
    root.innerHTML = `
      <div class="main sb-layout">
        <aside class="rail sb-left"></aside>
        <main class="center sb-center"></main>
        <aside class="rail sb-right"><div class="hub-empty">选择条目查看详情</div></aside>
      </div>`;
    await refresh();
  }, refresh };
})();
