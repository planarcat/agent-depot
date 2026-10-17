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
  function modal({ title, bodyHTML, confirmText = '确定', cancelText = '取消', danger = false, onConfirm, hasInput = false, inputPlaceholder = '' }) {
    const ov = document.createElement('div');
    ov.className = 'hub-overlay';
    ov.innerHTML = `
      <div class="hub-modal" role="dialog" aria-label="${title || ''}">
        <div class="hub-modal__head"><span class="hub-modal__title"></span>
          <button class="hub-modal__x" aria-label="关闭">✕</button></div>
        <div class="hub-modal__body"></div>
        ${hasInput ? '<div class="hub-modal__input"><input type="text" class="hub-input" placeholder=""></div>' : ''}
        <div class="hub-modal__foot">
          <button class="hub-btn hub-btn--ghost hub-modal__cancel"></button>
          <button class="hub-btn ${danger ? 'hub-btn--danger' : 'hub-btn--primary'} hub-modal__ok"></button>
        </div>
      </div>`;
    ov.querySelector('.hub-modal__title').textContent = title || '';
    ov.querySelector('.hub-modal__body').innerHTML = bodyHTML || '';
    const okBtn = ov.querySelector('.hub-modal__ok');
    okBtn.textContent = confirmText;
    ov.querySelector('.hub-modal__cancel').textContent = cancelText;
    const input = ov.querySelector('.hub-input');
    if (input) input.placeholder = inputPlaceholder;
    const close = () => { ov.classList.remove('is-in'); setTimeout(() => ov.remove(), 160); };
    ov.querySelector('.hub-modal__x').onclick = close;
    ov.querySelector('.hub-modal__cancel').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    okBtn.onclick = () => { if (!onConfirm || onConfirm(input ? input.value : undefined, close) !== false) close(); };
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('is-in'));
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

  return { toast, modal, confirm: confirmBox, prompt: promptBox, sourceRemovedDialog, sourceRemovedForDelete };
})();
window.HubUI = HubUI;
