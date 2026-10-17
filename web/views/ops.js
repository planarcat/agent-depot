/* ====================================================================
   台账视图（v0.6 统一 nv-layout）
   左：模块 / 状态筛选（紧凑行）；中：统计卡 + 流水列表 + 分页；
   右：单条详情（动作 / 台账原文 / reason）。
   ==================================================================== */
(function () {
  'use strict';
  const S = { module: 'all', status: 'all', q: '', page: 1, perPage: 40, items: [], total: 0, sel: null };

  async function load(root) {
    const qs = new URLSearchParams({
      module: S.module, status: S.status,
      limit: String(S.perPage), offset: String((S.page - 1) * S.perPage),
    });
    if (S.q) qs.set('q', S.q);
    const d = (await api('/api/ops?' + qs.toString())).data || {};
    S.items = d.items || [];
    S.total = d.total || 0;
    render(root);
  }

  function render(root) {
    const ok = S.items.filter(o => o.status === 'ok').length;
    const failed = S.items.filter(o => o.status === 'failed').length;
    const conflict = S.items.filter(o => o.status === 'conflict').length;
    const skipped = S.items.filter(o => o.status === 'skipped').length;
    root.innerHTML = `
      <div class="nv-layout">
        <aside class="nv-left">
          <div class="nv-h"><span>模块</span></div>
          <div class="nv-srcs">
            ${['all', 'sessions', 'memory', 'skills', 'mcp', 'system'].map(m => `
              <div class="nv-src-row ${S.module === m ? 'is-on' : ''}" data-m="${m}">
                <span class="tool-dot ${m === 'all' ? '' : 'tool-dot--local'}"></span>
                <span class="nv-sname">${m === 'all' ? '全部' : m}</span>
              </div>`).join('')}
          </div>
          <div class="nv-h" style="margin-top:var(--sp-2)"><span>状态</span></div>
          <div class="nv-srcs">
            ${[['all', '全部'], ['ok', '成功'], ['failed', '失败'], ['conflict', '冲突'], ['skipped', '跳过']].map(([v, label]) => `
              <div class="nv-src-row ${S.status === v ? 'is-on' : ''}" data-s="${v}">
                <span class="tool-dot ${v === 'all' || v === 'ok' ? '' : 'tool-dot--local'}"></span>
                <span class="nv-sname">${label}</span>
              </div>`).join('')}
          </div>
        </aside>
        <main class="center sb-center nv-center" style="border:0">
          <div class="nv-stats">
            <div class="nv-stat"><b>${S.total}</b><span>符合条件（总）</span></div>
            <div class="nv-stat"><b>${ok}</b><span>成功 · 本页</span></div>
            <div class="nv-stat"><b style="color:var(--c-err)">${failed}</b><span>失败 · 本页</span></div>
            <div class="nv-stat"><b style="color:var(--c-warn)">${conflict}</b><span>冲突 · 本页</span></div>
            <div class="nv-stat"><b>${skipped}</b><span>跳过 · 本页</span></div>
          </div>
          <div class="center__toolbar">
            <input class="hub-input search" data-testid="ops-search" placeholder="搜索条目 / 动作…" value="${esc(S.q)}">
            <span class="sb-spacer"></span>
            <span class="mono-xs">共 <b data-testid="ops-count">${S.total}</b> 条</span>
            <a class="hub-btn btn-sm" data-testid="ops-export-csv" href="/api/ops/export?format=csv">导出 CSV</a>
            <a class="hub-btn btn-sm" data-testid="ops-export-json" href="/api/ops/export?format=json">导出 JSON</a>
          </div>
          <div class="rows" data-testid="ops-rows">
            ${S.items.length ? S.items.map(o => `
              <div class="row sb-row ${S.sel && S.sel.id === o.id ? 'is-sel' : ''}" data-testid="ops-row" data-oid="${o.id}">
                <div class="mono-xs">${esc((o.ts || '').slice(5, 16).replace('T', ' '))}</div>
                <div class="sb-row__main">
                  <span class="hub-badge hub-badge--neutral">${esc(o.module)}</span>
                  <span class="row__title">${esc(o.action)}</span>
                  <span class="hub-badge sb-status--${o.status === 'ok' ? 'ok' : (o.status === 'failed' ? 'err' : 'neutral')}">${esc(o.status)}</span>
                  <div class="row__sub">${esc(o.item_name || '')} ${o.item_version ? '· ' + esc(String(o.item_version).slice(0, 14)) : ''} ${o.source_name ? '· 源 ' + esc(o.source_name) : ''} ${o.target_name ? '· 目标 ' + esc(o.target_name) : ''}</div>
                </div>
              </div>`).join('') : '<div class="hub-empty">没有匹配的操作记录</div>'}
          </div>
          <div class="nv-pager">
            <button class="nv-pbtn" data-p="prev" ${S.page <= 1 ? 'disabled' : ''}>‹</button>
            <span class="nv-pinfo">第 ${S.page} 页 · 每页 ${S.perPage} · 共 ${S.total} 条</span>
            <button class="nv-pbtn" data-p="next" ${S.page * S.perPage >= S.total ? 'disabled' : ''}>›</button>
          </div>
        </main>
        <aside class="nv-right">
          <div class="nv-h"><span>台账详情</span></div>
          <div id="ops-detail"><div class="nv-note">点击中栏任意一条记录查看详情。</div></div>
        </aside>
      </div>`;
    root.querySelectorAll('.nv-src-row[data-m]').forEach(row => {
      row.onclick = () => { S.module = row.dataset.m; S.page = 1; load(root); };
    });
    root.querySelectorAll('.nv-src-row[data-s]').forEach(row => {
      row.onclick = () => { S.status = row.dataset.s; S.page = 1; load(root); };
    });
    let t = null;
    root.querySelector('[data-testid="ops-search"]').oninput = (e) => {
      clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); S.page = 1; load(root); }, 250);
    };
    root.querySelectorAll('.nv-pbtn[data-p]').forEach(b => {
      b.onclick = () => {
        if (b.disabled) return;
        S.page = b.dataset.p === 'prev' ? S.page - 1 : S.page + 1;
        load(root);
      };
    });
    root.querySelectorAll('[data-testid="ops-row"]').forEach(row => {
      row.onclick = () => showDetail(root, Number(row.dataset.oid));
    });
    if (S.sel && S.items.some(o => o.id === S.sel.id)) showDetail(root, S.sel.id);
  }

  function showDetail(root, oid) {
    const o = S.items.find(x => x.id === oid);
    if (!o) return;
    S.sel = o;
    root.querySelectorAll('[data-testid="ops-row"]').forEach(r =>
      r.classList.toggle('is-sel', Number(r.dataset.oid) === oid));
    const box = root.querySelector('#ops-detail');
    if (!box) return;
    let extra = '';
    try {
      const d = JSON.parse(o.detail || 'null');
      if (d && typeof d === 'object') {
        extra = `<div class="nv-sec"><span>detail</span></div>
          <pre class="sb-md">${esc(JSON.stringify(d, null, 2))}</pre>`;
      }
    } catch (e) { /* 非 JSON detail 忽略 */ }
    box.innerHTML = `
      <div class="nv-dhead">
        <div class="nv-dtitle" style="font-size:var(--fs-m)">${esc(o.action)} <span class="hub-badge hub-badge--neutral">${esc(o.module)}</span>
          <span class="hub-badge sb-status--${o.status === 'ok' ? 'ok' : (o.status === 'failed' ? 'err' : 'neutral')}">${esc(o.status)}</span></div>
        <div class="nv-ddesc mono-xs">${esc(o.ts || '')}</div>
      </div>
      <div class="nv-sec"><span>对象</span></div>
      <div class="nv-frow"><span class="mono-xs">条目</span><span class="nv-fmeta">${esc(o.item_name || '—')}${o.item_version ? ' · ' + esc(String(o.item_version).slice(0, 14)) : ''}</span></div>
      <div class="nv-frow"><span class="mono-xs">来源</span><span class="nv-fmeta">${esc(o.source_name || '—')}</span></div>
      <div class="nv-frow"><span class="mono-xs">目标</span><span class="nv-fmeta">${esc(o.target_name || '—')}</span></div>
      ${o.reason ? `<div class="nv-sec"><span>原因</span></div><div class="nv-note sb-err-text">${esc(String(o.reason).slice(0, 400))}</div>` : ''}
      ${extra}`;
  }

  window.OpsView = {
    async render(root) { await load(root); },
    refresh: load,
  };
})();
