/* 统计页（对齐 Figma Pages.tsx · StatsPage，2026-10-16 更新：从弹层改为顶栏整页）
   KPI 4 卡 + 各工具会话数（条形图，逐个 a-squeeze 进场）+ 最近迁移 lineage
   数据源：/api/stats（totals/by_tool/by_day/by_project）+ state.migrations */
(function () {
  const esc = (s) => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (n) => (n == null ? '0' : Number(n).toLocaleString('zh-CN'));
  let CACHE = null;

  function nameOf(toolId) {
    const t = ((window.hubApp && window.hubApp.state.tool_list) || []).find(x => x.id === toolId);
    return t ? t.name : toolId;
  }
  function chipOf(toolId) {
    const t = ((window.hubApp && window.hubApp.state.tool_list) || []).find(x => x.id === toolId);
    const short = (t && window.MV) ? MV.short(toolId)
      : String(t ? (t.name || toolId) : toolId).slice(0, 2).toUpperCase();
    const cls = (t && typeof toolColorCls === 'function') ? toolColorCls(t) : 'chip--muted';
    return { short, cls };
  }

  function html(st) {
    const app = window.hubApp ? window.hubApp.state : {};
    const totals = (st && st.totals) || {};
    const tools = (st && st.by_tool) || [];
    const migs = (app.migrations || []).slice(0, 8);
    const kpi = [
      { n: fmt(totals.sessions), l: '会话总数' },
      { n: fmt(totals.messages), l: '消息条数' },
      { n: fmt(totals.starred), l: '星标会话' },
      { n: fmt(totals.migrations), l: '迁移次数' },
    ];
    const max = Math.max(1, ...tools.map(t => t.sessions || 0));
    return `
      <div class="statwrap">
        <div class="statkpi">
          ${kpi.map(k => `<div class="mcard lift statkpi__c"><div class="statkpi__n">${esc(k.n)}</div>
            <div class="statkpi__l">${esc(k.l)}</div></div>`).join('')}
        </div>
        <div class="statgrid">
          <section class="mcard statsec">
            <h3 class="statsec__h">各工具会话数</h3>
            <div class="statbars">
              ${tools.map((t, i) => {
                const c = chipOf(t.tool);
                return `<div class="statbar">
                  <span class="mvi__src ${esc(c.cls)} statbar__chip">${esc(c.short)}</span>
                  <span class="statbar__name" title="${esc(nameOf(t.tool))}">${esc(nameOf(t.tool))}</span>
                  <span class="statbar__track"><span class="statbar__fill" style="width:${Math.round((t.sessions || 0) / max * 100)}%;background:var(--c-accent);animation-delay:${i * 40}ms"></span></span>
                  <span class="mono statbar__n">${esc(t.sessions)}</span></div>`;
              }).join('') || '<div class="hub-empty">还没有采集到会话</div>'}
            </div>
          </section>
          <section class="mcard statsec">
            <h3 class="statsec__h">最近迁移 · lineage</h3>
            ${migs.length ? migs.map(m => `
              <div class="statmig">
                <div class="mono statmig__t">${esc((m.ts || '').slice(5, 16).replace('T', ' '))} ·
                  <span class="statmig__lid">${esc(m.lid || '')}</span></div>
                <div class="statmig__d">${esc(nameOf(m.src_tool || m.from_tool))} → ${esc(nameOf(m.dst_tool || m.to_tool))}
                  ${m.status ? ` · ${esc(m.status)}` : ''}${m.src_msg_count ? ` · ${esc(m.src_msg_count)} 条` : ''}</div>
              </div>`).join('') : '<div class="hub-empty">还没有迁移记录</div>'}
          </section>
        </div>
      </div>`;
  }

  window.StatsView = {
    async render(root) {
      if (!root) return;
      root.innerHTML = '<div class="statwrap">' + (window.skeletonRows ? skeletonRows(3) : '<div class="hub-empty">统计加载中…</div>') + '</div>';
      try {
        const r = await fetch('/api/stats').then(x => x.json());
        CACHE = r.stats || null;
      } catch (e) { CACHE = CACHE || null; }
      root.innerHTML = html(CACHE);
    },
  };
})();
