/* ====================================================================
   Agent Depot · UI 组件库（原生 JS，零依赖）
   统一反馈规范落地：
   - HubToast.success / .error / .info / .warn —— 全局唯一提示样式
   - HubConfirm / HubPrompt —— 模态确认/输入（替代原生 confirm/prompt）
   - 按钮 loading 态：btn.classList.add('is-loading')
   ==================================================================== */
const HubUI = (() => {
  /* ---------- Toast ---------- */
  const ICONS = { success: '✓', error: '✕', warn: '△', info: '·' };
  function toast(msg, type = 'info', ms = 3200) {
    let wrap = document.getElementById('hub-toasts');
    if (!wrap) {
      wrap = document.createElement('div'); wrap.id = 'hub-toasts'; wrap.className = 'hub-toasts';
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    t.className = 'hub-toast hub-toast--' + type;
    t.innerHTML = `<span class="hub-toast__ic">${ICONS[type] || '·'}</span><span class="hub-toast__msg"></span>`;
    t.querySelector('.hub-toast__msg').textContent = msg;
    wrap.appendChild(t);
    // 最多同时 4 条：最旧的带退出动画让位（连点开关不再刷出一长串）
    const live = [...wrap.children].filter(x => !x.dataset.leaving);
    live.slice(0, Math.max(0, live.length - 4)).forEach(x => {
      x.dataset.leaving = '1'; x.classList.remove('is-in'); setTimeout(() => x.remove(), 220);
    });
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 200); }, ms);
    return t;
  }

  /* ---------- Modal (confirm / prompt / custom) ---------- */
  function modal({ title, bodyHTML, confirmText = '确定', cancelText = '取消', danger = false, onConfirm, hasInput = false, inputPlaceholder = '', wide = false }) {
    const ov = document.createElement('div');
    ov.className = 'hub-overlay';
    ov.innerHTML = `
      <div class="hub-modal ${wide ? 'hub-modal--wide' : ''}" role="dialog" aria-label="${title || ''}">
        <div class="hub-modal__head"><span class="hub-modal__title"></span>
          <button class="hub-modal__x" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="hub-modal__body"></div>
        ${hasInput ? '<div class="hub-modal__input"><input type="text" class="hub-input" placeholder=""></div>' : ''}
        <div class="hub-modal__foot">
          <button class="hub-btn hub-btn--ghost hub-modal__cancel"></button>
          <button class="hub-btn ${danger ? 'hub-btn--danger' : 'hub-btn--primary'} hub-modal__ok"></button>
        </div>
      </div>`;
    ov.querySelector('.hub-modal__title').textContent = title || '';
    ov.querySelector('.hub-modal__body').innerHTML = bodyHTML || '';
    const close = () => { ov.classList.remove('is-in'); setTimeout(() => ov.remove(), 160); };
    const okBtn = ov.querySelector('.hub-modal__ok');
    okBtn.textContent = confirmText;
    const cancelBtn = ov.querySelector('.hub-modal__cancel');
    if (cancelText === null) cancelBtn.remove();   // 只留一个关闭/下载按钮（图片预览等）
    else { cancelBtn.textContent = cancelText; cancelBtn.onclick = close; }
    const input = ov.querySelector('.hub-input');
    if (input) input.placeholder = inputPlaceholder;
    ov.querySelector('.hub-modal__x').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    okBtn.onclick = () => { if (!onConfirm || onConfirm(input ? input.value : undefined, close) !== false) close(); };
    document.body.appendChild(ov);
    // 先把初始态绘制出去（强制回流），下一帧再加 is-in，过渡才会真正播放
    void ov.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('is-in')));
    if (input) input.focus();
    return { close, overlay: ov };
  }
  const confirmBox = (title, bodyHTML, onConfirm, opts = {}) =>
    modal(Object.assign({ title, bodyHTML, onConfirm }, opts));
  const promptBox = (title, bodyHTML, onConfirm, opts = {}) =>
    modal(Object.assign({ title, bodyHTML, onConfirm, hasInput: true }, opts));

  /* ---------- 源移除/删除同步对话框（Skills / MCP 通用） ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 拉取时远程删除了条目 → 三选：删除本地副本 / 转为本地 / 取消同步
  // opts.afterRemove(sid)：处理完成后回调（视图负责清筛选并刷新）
  function sourceRemovedDialog(kind, sid, data, opts = {}) {
    const after = opts.afterRemove || (() => {});
    const rows = (data.removed_detail || []).map(d => {
      const bits = [];
      if (d.in_registry) bits.push('已在本地库');
      if (d.deployed_count) bits.push(`已分发 ${d.deployed_count} 处`);
      return `<div class="nv-mkrow"><span class="nv-mt" style="font-weight:400">${esc(d.name)}</span><span class="nv-msub">${bits.join(' · ') || '仅在目录中'}</span></div>`;
    }).join('');
    modal({
      title: '远程源删除了条目', hasInput: false, confirmText: '删除', cancelText: '取消同步', danger: true,
      bodyHTML: `
        <div class="hub-modal__sub">源在远程删除了 ${data.removed.length} 个条目，本次拉取未应用。请选择处理方式：</div>
        <div style="max-height:160px;overflow-y:auto;border:1px solid var(--c-line-soft);border-radius:var(--r-m);padding:var(--sp-1) 0;margin-bottom:var(--sp-3)">${rows}</div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">「删除」：本地库副本一并清除（先备份，已分发到工具的文件保留）· 取消则本次拉取不生效，源保持旧状态。</div>
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end">
          <button class="hub-btn" id="hub-localize-btn">转为本地条目（${data.removed.length}）</button>
        </div>`,
      onConfirm: async () => {
        const r2 = await post(`/api/${kind}/sources/${sid}/pull`, { removed_action: 'delete' });
        if (r2.data.ok && !r2.data.needs_action) {
          toast(`已删除 ${r2.data.removed.length} 个条目（本地副本已备份）`, 'success');
          await after(sid);
        } else { toast('操作失败：' + (r2.data.error || ''), 'error'); return false; }
      },
    });
    document.getElementById('hub-localize-btn').onclick = async () => {
      const r2 = await post(`/api/${kind}/sources/${sid}/pull`, { removed_action: 'localize' });
      if (r2.data.ok && !r2.data.needs_action) {
        toast(`已将 ${r2.data.removed.length} 个条目转为本地手动条目`, 'success');
        await after(sid);
      } else toast('操作失败：' + (r2.data.error || ''), 'error');
    };
  }

  // 移除源时本地库仍有条目 → 三选：连条目删除 / 转为本地 / 取消
  function sourceRemovedForDelete(kind, sid, name, count, opts = {}) {
    const after = opts.afterRemove || (() => {});
    modal({
      title: '移除源', hasInput: false, confirmText: '删除', cancelText: '取消', danger: true,
      bodyHTML: `
        <div class="hub-modal__sub">源「${esc(name)}」有 ${count} 个条目已拉取到本地库。移除源时如何处理这些条目？</div>`,
      onConfirm: async () => {
        const r = await api(`/api/${kind}/sources/${sid}?removed_action=delete`, { method: 'DELETE' });
        if (r.data.ok) {
          toast(`已移除源 · 清除 ${(r.data.purged || []).length} 个本地副本（已备份）`, 'success');
          await after(sid);
        } else { toast('移除失败：' + (r.data.error || ''), 'error'); return false; }
      },
    });
    // 「转为本地」并入底部按钮行（modal foot 的 cancel 与 ok 之间）
    const foot = document.querySelector('.hub-overlay.is-in .hub-modal__foot') || document.querySelector('.hub-modal__foot');
    if (foot) {
      const btn = document.createElement('button');
      btn.className = 'hub-btn';
      btn.id = 'hub-src-localize-btn';
      btn.textContent = `转为本地条目（${count}）`;
      btn.onclick = async () => {
        const r = await api(`/api/${kind}/sources/${sid}?removed_action=localize`, { method: 'DELETE' });
        if (r.data.ok) {
          toast(`已移除源 · ${(r.data.localized || []).length} 个条目转为本地手动条目`, 'success');
          await after(sid);
        } else toast('移除失败：' + (r.data.error || ''), 'error');
      };
      const cancelBtn = foot.querySelector('.hub-modal__cancel');
      foot.insertBefore(btn, cancelBtn);
    }
  }

  /* ---------- 自定义下拉选择（对齐 .hub-input 盒型；展开体淡入位移 + 选项悬停/选中反馈） ----------
     用法：HubUI.select({ id, testid, value, options:[{value,label}] }) 返回 HTML 字符串；
     挂载后自动水合（MutationObserver）：元素上定义 value getter/setter 并派发 change 事件，
     既有 el.value / el.onchange 调用点零改动。键盘：↑↓ 换值、Enter/Esc 开合。 */
  function select(cfg) {
    const opts = (cfg.options || []).map(o =>
      `<button type="button" class="hub-select__opt${String(o.value) === String(cfg.value) ? ' is-on' : ''}"`
      + ` data-value="${esc(o.value)}" role="option">${esc(o.label)}</button>`).join('');
    const cur = (cfg.options || []).find(o => String(o.value) === String(cfg.value));
    return `<div class="hub-select${cfg.disabled ? ' is-disabled' : ''}" ${cfg.id ? `id="${esc(cfg.id)}" ` : ''}data-value="${esc(cfg.value == null ? '' : cfg.value)}"`
      + `${cfg.testid ? ` data-testid="${esc(cfg.testid)}"` : ''}${cfg.disabled ? ' aria-disabled="true"' : ''}>
      <button type="button" class="hub-select__btn" aria-haspopup="listbox" aria-expanded="false" ${cfg.disabled ? 'disabled' : ''}>
        <span class="hub-select__label">${esc(cur ? cur.label : (cfg.value == null ? '' : cfg.value))}</span>
        <span class="hub-select__chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
      </button>
      <div class="hub-select__pop" role="listbox">${opts}</div>
    </div>`;
  }
  function hydrateSelect(el) {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    const btn = el.querySelector('.hub-select__btn');
    const label = el.querySelector('.hub-select__label');
    const opts = [...el.querySelectorAll('.hub-select__opt')];
    const sync = () => {
      opts.forEach(o => o.classList.toggle('is-on', o.dataset.value === el.dataset.value));
      const cur = opts.find(o => o.dataset.value === el.dataset.value);
      if (cur) label.textContent = cur.textContent;
    };
    sync();
    // 禁用态：只保留 value getter/setter，不绑任何交互（键盘/点击/外点全部无效）
    if (el.classList.contains('is-disabled')) {
      Object.defineProperty(el, 'value', {
        get() { return el.dataset.value; },
        set(v) { el.dataset.value = String(v); sync(); },
        configurable: true,
      });
      return;
    }
    const setOpen = (yes) => {
      el.classList.toggle('is-open', yes);
      btn.setAttribute('aria-expanded', yes ? 'true' : 'false');
      if (yes) { const on = el.querySelector('.hub-select__opt.is-on'); if (on) on.scrollIntoView({ block: 'nearest' }); }
    };
    btn.onclick = (e) => { e.stopPropagation(); setOpen(!el.classList.contains('is-open')); };
    opts.forEach(o => {
      o.onclick = (e) => {
        e.stopPropagation();
        el.dataset.value = o.dataset.value; sync(); setOpen(false); btn.focus();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
    });
    el.onkeydown = (e) => {
      const open = el.classList.contains('is-open');
      if (e.key === 'Escape') { setOpen(false); btn.focus(); return; }
      const idx = opts.findIndex(o => o.dataset.value === el.dataset.value);
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) { e.preventDefault(); setOpen(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const nx = opts[(idx + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length];
        el.dataset.value = nx.dataset.value; sync();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (e.key === 'Enter') { e.preventDefault(); setOpen(false); }
    };
    Object.defineProperty(el, 'value', {
      get() { return el.dataset.value; },
      set(v) { el.dataset.value = String(v); sync(); },
      configurable: true,
    });
  }
  function hydrateSelects(root) { (root || document).querySelectorAll('.hub-select:not([data-ready])').forEach(hydrateSelect); }
  // 外点关闭：document 级只装一次；挂载后自动水合（对话框 / 列表重绘都会被捕获）
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.hub-select.is-open').forEach(el => {
      if (!el.contains(e.target)) el.classList.remove('is-open');
    });
  });
  new MutationObserver(() => hydrateSelects(document)).observe(document.body, { childList: true, subtree: true });
  hydrateSelects(document);

  /* ---------- 列表悬停浮层（.spanel__targets 用）：高亮从上一行平滑滑到当前行 ----------
     图层在首次 mouseover 时懒创建（列表 innerHTML 重绘后自动重建）；
     悬停已选中的行时不显示（它有自己的描边态）。 */
  function hoverLayerOf(list) {
    let layer = list.querySelector(':scope > .hub-hoverlayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'hub-hoverlayer';
      list.insertBefore(layer, list.firstChild);
    }
    return layer;
  }
  function hideHoverLayer(list) {
    const layer = list.querySelector(':scope > .hub-hoverlayer');
    if (layer) layer.style.opacity = '0';
    list.classList.remove('is-hovering');
  }
  document.addEventListener('mouseover', (e) => {
    const list = e.target.closest('.spanel__targets');
    if (!list) return;
    document.querySelectorAll('.spanel__targets.is-hovering').forEach(l => { if (l !== list) hideHoverLayer(l); });
    const li = e.target.closest('li');
    const btn = li && li.querySelector('.stgt');
    if (!btn || btn.classList.contains('is-on')) { hideHoverLayer(list); return; }
    list.classList.add('is-hovering');
    const layer = hoverLayerOf(list);
    layer.style.transform = 'translateY(' + btn.offsetTop + 'px)';
    layer.style.height = btn.offsetHeight + 'px';
    layer.style.opacity = '1';
  });
  document.addEventListener('mouseout', (e) => {
    const list = e.target.closest('.spanel__targets');
    if (list && !list.contains(e.relatedTarget)) hideHoverLayer(list);
  });

  /* ---------- 选中描边生长帧（目标行 / 工具卡片 / 条头 chip 共用） ----------
     参考 2026-10-20 用户提供的实现：SVG 用像素级 viewBox（与实际尺寸 1:1，随尺寸重建），
     pathLength=1 + dashoffset 1→0 播放「左上角点 → 分别沿上边/左边（含圆角）→ 右下角点」；
     圆角读宿主 computed border-radius（卡片 --r-l / 行·chip --r-m 各自适配）。
     之前「拉伸 viewBox + non-scaling-stroke」的 dash 在 Chromium 下不可靠，已弃用。
     CSS 侧见 app.css .stgt-frame（opacity 门闩 + 与背景扫入同步的 --t-base） */
  function buildFrame(svg) {
    const host = svg.parentElement;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    let r = parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const up = svg.querySelector('.fr-up'), dn = svg.querySelector('.fr-dn');
    // 圆角弧的中点（描边实际可见的「角点」）：两条路径都从左上角点出发、在右下角点汇合
    const k = r > 0 ? r * (1 - Math.SQRT1_2) : 0;
    if (up) up.setAttribute('d', r > 0
      ? `M ${k} ${k} A ${r} ${r} 0 0 1 ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${h - r} A ${r} ${r} 0 0 1 ${w - k} ${h - k}`
      : `M 0 0 L ${w} 0 L ${w} ${h}`);
    if (dn) dn.setAttribute('d', r > 0
      ? `M ${k} ${k} A ${r} ${r} 0 0 0 0 ${r} L 0 ${h - r} A ${r} ${r} 0 0 0 ${r} ${h} L ${w - r} ${h} A ${r} ${r} 0 0 0 ${w - k} ${h - k}`
      : `M 0 0 L 0 ${h} L ${w} ${h}`);
  }
  const frameRO = ('ResizeObserver' in window) ? new ResizeObserver(entries => {
    for (const e of entries) { const svg = e.target.querySelector && e.target.querySelector('.stgt-frame'); if (svg) buildFrame(svg); }
  }) : null;
  const frameSeen = new WeakSet();
  function drawFrames(root) {
    (root || document).querySelectorAll('.stgt-frame').forEach(svg => {
      buildFrame(svg);
      const host = svg.parentElement;
      if (frameRO && !frameSeen.has(host)) { frameSeen.add(host); frameRO.observe(host); }
    });
  }

  return { toast, modal, confirm: confirmBox, prompt: promptBox, sourceRemovedDialog, sourceRemovedForDelete, select, hydrateSelects, drawFrames };
})();
window.HubUI = HubUI;
