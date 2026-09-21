/* ====================================================================
   Agent Session Hub · UI 组件库（原生 JS，零依赖）
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

  return { toast, modal, confirm: confirmBox, prompt: promptBox };
})();
window.HubUI = HubUI;
