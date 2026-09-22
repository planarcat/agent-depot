/* ====================================================================
   台账视图：统一 ops 流水（筛选 + 导出）
   ==================================================================== */
(function () {
  'use strict';
  const S = { module: 'all', status: 'all', q: '' };

  async function load(el) {
    const qs = new URLSearchParams({ module: S.module, status: S.status, limit: '200' });
    if (S.q) qs.set('q', S.q);
    const d = (await api('/api/ops?' + qs.toString())).data || {};
    const rows = d.items || [];
    el.querySelector('[data-testid="ops-count"]').textContent = d.total || 0;
    el.querySelector('[data-testid="ops-rows"]').innerHTML = rows.length ? rows.map(o => `
      <div class="row sb-row" data-testid="ops-row">
        <div class="mono-xs">${esc((o.ts || '').slice(5, 16).replace('T', ' '))}</div>
        <div class="sb-row__main">
          <span class="hub-badge hub-badge--neutral">${esc(o.module)}</span>
          <span class="row__title">${esc(o.action)}</span>
          <span class="hub-badge sb-status--${o.status === 'ok' ? 'ok' : (o.status === 'failed' ? 'err' : 'neutral')}">${esc(o.status)}</span>
          <div class="row__sub">${esc(o.item_name || '')} ${o.item_version ? '· ' + esc(String(o.item_version).slice(0, 14)) : ''} ${o.source_name ? '· 源 ' + esc(o.source_name) : ''} ${o.target_name ? '· 目标 ' + esc(o.target_name) : ''}</div>
          ${o.reason ? `<div class="row__sub sb-err-text">${esc(String(o.reason).slice(0, 120))}</div>` : ''}
        </div>
      </div>`).join('') : '<div class="hub-empty">没有匹配的操作记录</div>';
  }

  window.OpsView = {
    async render(root) {
      root.innerHTML = `
        <div class="ops-wrap">
          <div class="ops-toolbar">
            <div class="seg" id="ops-mod-seg">
              <button class="is-on" data-m="all">全部</button>
              <button data-m="sessions">会话</button>
              <button data-m="memory">记忆</button>
              <button data-m="skills">Skills</button>
              <button data-m="mcp">MCP</button>
              <button data-m="system">系统</button>
            </div>
            <div class="seg" id="ops-status-seg">
              <button class="is-on" data-s="all">全状态</button>
              <button data-s="ok">成功</button>
              <button data-s="failed">失败</button>
              <button data-s="conflict">冲突</button>
              <button data-s="skipped">跳过</button>
            </div>
            <input class="hub-input" style="max-width:200px" data-testid="ops-search" placeholder="搜索条目/动作…">
            <span class="sb-spacer"></span>
            <span class="mono-xs">共 <b data-testid="ops-count">0</b> 条</span>
            <a class="hub-btn btn-sm" data-testid="ops-export-csv" href="/api/ops/export?format=csv">导出 CSV</a>
            <a class="hub-btn btn-sm" data-testid="ops-export-json" href="/api/ops/export?format=json">导出 JSON</a>
          </div>
          <div class="ops-head"><div>时间</div><div>模块 / 动作 / 状态 / 明细</div></div>
          <div class="rows" data-testid="ops-rows"></div>
        </div>`;
      root.querySelectorAll('#ops-mod-seg button').forEach(b => b.onclick = () => {
        root.querySelectorAll('#ops-mod-seg button').forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on'); S.module = b.dataset.m; load(root);
      });
      root.querySelectorAll('#ops-status-seg button').forEach(b => b.onclick = () => {
        root.querySelectorAll('#ops-status-seg button').forEach(x => x.classList.remove('is-on'));
        b.classList.add('is-on'); S.status = b.dataset.s; load(root);
      });
      let t = null;
      root.querySelector('[data-testid="ops-search"]').oninput = (e) => {
        clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); load(root); }, 250);
      };
      await load(root);
    },
  };
})();
