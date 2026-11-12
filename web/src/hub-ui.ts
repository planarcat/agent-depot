/* ====================================================================
   Agent Depot · UI 组件库（原生 TS，零依赖）
   统一反馈规范：HubUI.toast / confirm / prompt；按钮 loading 走 .is-loading。
   ==================================================================== */

import { mustById, qs, qsa } from "./core/dom.ts";
import { esc } from "./core/format.ts";

export type ToastType = "success" | "error" | "warn" | "info";

export interface ModalOptions {
  title?: string;
  bodyHTML?: string;
  confirmText?: string | null;
  cancelText?: string | null;
  danger?: boolean;
  wide?: boolean;
  hasInput?: boolean;
  inputPlaceholder?: string;
  onConfirm?: (
    inputValue: string | undefined,
    close: () => void,
  ) => boolean | void | Promise<boolean | void>;
}

export interface ModalHandle {
  close: () => void;
  overlay: HTMLDivElement;
}

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface SelectConfig {
  id?: string;
  testid?: string;
  value?: string | number | null;
  disabled?: boolean;
  options?: SelectOption[];
}

const ICONS: Record<ToastType, string> = { success: "✓", error: "✕", warn: "△", info: "·" };

function toastWrap(): HTMLElement {
  const existing = document.getElementById("hub-toasts");
  if (existing) return existing;
  const wrap = document.createElement("div");
  wrap.id = "hub-toasts";
  wrap.className = "hub-toasts";
  document.body.appendChild(wrap);
  return wrap;
}

function toast(msg: string, type: ToastType = "info", ms = 3200): HTMLElement {
  const wrap = toastWrap();
  const t = document.createElement("div");
  t.className = `hub-toast hub-toast--${type}`;
  t.innerHTML = `<span class="hub-toast__ic">${ICONS[type] || "·"}</span><span class="hub-toast__msg"></span>`;
  const msgNode = qs<HTMLElement>(".hub-toast__msg", t);
  if (msgNode) msgNode.textContent = msg;
  wrap.appendChild(t);
  // 最多同时 4 条：最旧的带退出动画让位（连点开关不再刷出一长串）
  const live = Array.from(wrap.children).filter(
    (x): x is HTMLElement => x instanceof HTMLElement && !x.dataset["leaving"],
  );
  for (const x of live.slice(0, Math.max(0, live.length - 4))) {
    x.dataset["leaving"] = "1";
    x.classList.remove("is-in");
    setTimeout(() => x.remove(), 220);
  }
  requestAnimationFrame(() => t.classList.add("is-in"));
  setTimeout(() => {
    t.classList.remove("is-in");
    setTimeout(() => t.remove(), 200);
  }, ms);
  return t;
}

function modal(options: ModalOptions): ModalHandle {
  const {
    title = "",
    bodyHTML = "",
    confirmText = "确定",
    cancelText = "取消",
    danger = false,
    wide = false,
    hasInput = false,
    inputPlaceholder = "",
    onConfirm,
  } = options;
  const ov = document.createElement("div");
  ov.className = "hub-overlay";
  ov.innerHTML = `
      <div class="hub-modal ${wide ? "hub-modal--wide" : ""}" role="dialog" aria-label="${esc(title)}">
        <div class="hub-modal__head"><span class="hub-modal__title"></span>
          <button class="hub-modal__x" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="hub-modal__body"></div>
        ${hasInput ? '<div class="hub-modal__input"><input type="text" class="hub-input" placeholder=""></div>' : ""}
        <div class="hub-modal__foot">
          <button class="hub-btn hub-btn--ghost hub-modal__cancel"></button>
          <button class="hub-btn ${danger ? "hub-btn--danger" : "hub-btn--primary"} hub-modal__ok"></button>
        </div>
      </div>`;
  const titleNode = qs<HTMLElement>(".hub-modal__title", ov);
  if (titleNode) titleNode.textContent = title;
  const bodyNode = qs<HTMLElement>(".hub-modal__body", ov);
  if (bodyNode) bodyNode.innerHTML = bodyHTML;
  const close = (): void => {
    ov.classList.remove("is-in");
    setTimeout(() => ov.remove(), 160);
  };
  const okBtn = qs<HTMLButtonElement>(".hub-modal__ok", ov);
  const cancelBtn = qs<HTMLButtonElement>(".hub-modal__cancel", ov);
  if (okBtn) okBtn.textContent = confirmText;
  if (cancelBtn) {
    if (cancelText === null) cancelBtn.remove();
    else {
      cancelBtn.textContent = cancelText;
      cancelBtn.onclick = close;
    }
  }
  const input = qs<HTMLInputElement>(".hub-input", ov);
  if (input) input.placeholder = inputPlaceholder;
  const xBtn = qs<HTMLButtonElement>(".hub-modal__x", ov);
  if (xBtn) xBtn.onclick = close;
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });
  if (okBtn) {
    okBtn.onclick = () => {
      const value = input ? input.value : undefined;
      const result = onConfirm ? onConfirm(value, close) : undefined;
      if (result !== false) close();
    };
  }
  document.body.appendChild(ov);
  // 先绘制初始态（强制回流），下一帧再加 is-in，过渡才会真正播放
  void ov.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add("is-in")));
  if (input) input.focus();
  return { close, overlay: ov };
}

const confirmBox = (
  title: string,
  bodyHtml: string,
  onConfirm?: ModalOptions["onConfirm"],
  opts: Omit<ModalOptions, "title" | "bodyHTML" | "onConfirm"> = {},
): ModalHandle => {
  const merged: ModalOptions = { title, bodyHTML: bodyHtml, ...opts };
  if (onConfirm) merged.onConfirm = onConfirm;
  return modal(merged);
};

const promptBox = (
  title: string,
  bodyHtml: string,
  onConfirm?: ModalOptions["onConfirm"],
  opts: Omit<ModalOptions, "title" | "bodyHTML" | "onConfirm" | "hasInput"> = {},
): ModalHandle => {
  const merged: ModalOptions = { title, bodyHTML: bodyHtml, hasInput: true, ...opts };
  if (onConfirm) merged.onConfirm = onConfirm;
  return modal(merged);
};

export interface SourceRemovedDetail {
  name: string;
  in_registry: boolean;
  deployed_count: number;
}

export interface SourceRemovedData {
  removed: string[];
  removed_detail?: SourceRemovedDetail[];
}

interface DialogHooks {
  afterRemove?: (sid: number) => void | Promise<void>;
  /** pull 调用（视图注入，避免组件层直接依赖 api 模块的响应类型）。 */
  pull?: (
    sid: number,
    action: "delete" | "localize",
  ) => Promise<{ ok: boolean; error?: string; removed?: string[] }>;
  removeSource?: (
    sid: number,
    action: "delete" | "localize",
  ) => Promise<{ ok: boolean; error?: string; purged?: string[]; localized?: string[] }>;
}

/** 拉取时远程删除了条目 → 三选：删除本地副本 / 转为本地 / 取消同步。 */
function sourceRemovedDialog(
  _kind: string,
  sid: number,
  data: SourceRemovedData,
  opts: DialogHooks = {},
): void {
  const after = opts.afterRemove ?? (() => undefined);
  const rows = (data.removed_detail ?? [])
    .map((d) => {
      const bits: string[] = [];
      if (d.in_registry) bits.push("已在本地库");
      if (d.deployed_count) bits.push(`已分发 ${d.deployed_count} 处`);
      return `<div class="nv-mkrow"><span class="nv-mt" style="font-weight:400">${esc(d.name)}</span><span class="nv-msub">${bits.join(" · ") || "仅在目录中"}</span></div>`;
    })
    .join("");
  modal({
    title: "远程源删除了条目",
    hasInput: false,
    confirmText: "删除",
    cancelText: "取消同步",
    danger: true,
    bodyHTML: `
        <div class="hub-modal__sub">源在远程删除了 ${data.removed.length} 个条目，本次拉取未应用。请选择处理方式：</div>
        <div style="max-height:160px;overflow-y:auto;border:1px solid var(--c-line-soft);border-radius:var(--r-m);padding:var(--sp-1) 0;margin-bottom:var(--sp-3)">${rows}</div>
        <div class="hub-modal__sub" style="color:var(--c-ink-4)">「删除」：本地库副本一并清除（先备份，已分发到工具的文件保留）· 取消则本次拉取不生效，源保持旧状态。</div>
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end">
          <button class="hub-btn" id="hub-localize-btn">转为本地条目（${data.removed.length}）</button>
        </div>`,
    onConfirm: async () => {
      if (!opts.pull) return false;
      const r = await opts.pull(sid, "delete");
      if (r.ok) {
        toast(`已删除 ${(r.removed ?? []).length} 个条目（本地副本已备份）`, "success");
        await after(sid);
        return;
      }
      toast(`操作失败：${r.error ?? ""}`, "error");
      return false;
    },
  });
  const localize = document.getElementById("hub-localize-btn");
  if (localize) {
    localize.onclick = async () => {
      if (!opts.pull) return;
      const r = await opts.pull(sid, "localize");
      if (r.ok) {
        toast(`已将 ${(r.removed ?? []).length} 个条目转为本地手动条目`, "success");
        await after(sid);
      } else toast(`操作失败：${r.error ?? ""}`, "error");
    };
  }
}

/** 移除源时本地库仍有条目 → 三选：连条目删除 / 转为本地 / 取消。 */
function sourceRemovedForDelete(
  _kind: string,
  sid: number,
  name: string,
  count: number,
  opts: DialogHooks = {},
): void {
  const after = opts.afterRemove ?? (() => undefined);
  modal({
    title: "移除源",
    hasInput: false,
    confirmText: "删除",
    cancelText: "取消",
    danger: true,
    bodyHTML: `
        <div class="hub-modal__sub">源「${esc(name)}」有 ${count} 个条目已拉取到本地库。移除源时如何处理这些条目？</div>`,
    onConfirm: async () => {
      if (!opts.removeSource) return false;
      const r = await opts.removeSource(sid, "delete");
      if (r.ok) {
        toast(`已移除源 · 清除 ${(r.purged ?? []).length} 个本地副本（已备份）`, "success");
        await after(sid);
        return;
      }
      toast(`移除失败：${r.error ?? ""}`, "error");
      return false;
    },
  });
  const foot =
    document.querySelector(".hub-overlay.is-in .hub-modal__foot") ??
    document.querySelector(".hub-modal__foot");
  if (foot) {
    const btn = document.createElement("button");
    btn.className = "hub-btn";
    btn.id = "hub-src-localize-btn";
    btn.textContent = `转为本地条目（${count}）`;
    btn.onclick = async () => {
      if (!opts.removeSource) return;
      const r = await opts.removeSource(sid, "localize");
      if (r.ok) {
        toast(`已移除源 · ${(r.localized ?? []).length} 个条目转为本地手动条目`, "success");
        await after(sid);
      } else toast(`移除失败：${r.error ?? ""}`, "error");
    };
    const cancelBtn = foot.querySelector(".hub-modal__cancel");
    if (cancelBtn) foot.insertBefore(btn, cancelBtn);
    else foot.appendChild(btn);
  }
}

/* ---------- 自定义下拉选择 ---------- */

function select(cfg: SelectConfig): string {
  const options = cfg.options ?? [];
  const opts = options
    .map(
      (o) =>
        `<button type="button" class="hub-select__opt${String(o.value) === String(cfg.value ?? "") ? " is-on" : ""}"\
 data-value="${esc(o.value)}" role="option">${esc(o.label)}</button>`,
    )
    .join("");
  const cur = options.find((o) => String(o.value) === String(cfg.value ?? ""));
  return `<div class="hub-select${cfg.disabled ? " is-disabled" : ""}" ${cfg.id ? `id="${esc(cfg.id)}" ` : ""}data-value="${esc(cfg.value ?? "")}"\
${cfg.testid ? ` data-testid="${esc(cfg.testid)}"` : ""}${cfg.disabled ? ' aria-disabled="true"' : ""}>
      <button type="button" class="hub-select__btn" aria-haspopup="listbox" aria-expanded="false" ${cfg.disabled ? "disabled" : ""}>
        <span class="hub-select__label">${esc(cur ? cur.label : (cfg.value ?? ""))}</span>
        <span class="hub-select__chev" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
      </button>
      <div class="hub-select__pop" role="listbox">${opts}</div>
    </div>`;
}

interface SelectElement extends HTMLElement {
  value: string;
}

function hydrateSelect(el: SelectElement): void {
  if (el.dataset["ready"]) return;
  el.dataset["ready"] = "1";
  const btn = qs<HTMLButtonElement>(".hub-select__btn", el);
  const label = qs<HTMLElement>(".hub-select__label", el);
  const opts = qsa<HTMLButtonElement>(".hub-select__opt", el);
  const sync = (): void => {
    for (const o of opts) o.classList.toggle("is-on", o.dataset["value"] === el.dataset["value"]);
    const cur = opts.find((o) => o.dataset["value"] === el.dataset["value"]);
    if (cur && label) label.textContent = cur.textContent;
  };
  sync();
  // 禁用态：只保留 value getter/setter，不绑任何交互
  if (el.classList.contains("is-disabled")) {
    Object.defineProperty(el, "value", {
      get: () => el.dataset["value"] ?? "",
      set: (v: string) => {
        el.dataset["value"] = String(v);
        sync();
      },
      configurable: true,
    });
    return;
  }
  if (!btn) return;
  const setOpen = (yes: boolean): void => {
    el.classList.toggle("is-open", yes);
    btn.setAttribute("aria-expanded", yes ? "true" : "false");
    if (yes) {
      const on = qs<HTMLElement>(".hub-select__opt.is-on", el);
      if (on) on.scrollIntoView({ block: "nearest" });
    }
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    setOpen(!el.classList.contains("is-open"));
  };
  for (const o of opts) {
    o.onclick = (e) => {
      e.stopPropagation();
      el.dataset["value"] = o.dataset["value"] ?? "";
      sync();
      setOpen(false);
      btn.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
  }
  el.onkeydown = (e) => {
    const open = el.classList.contains("is-open");
    if (e.key === "Escape") {
      setOpen(false);
      btn.focus();
      return;
    }
    const idx = opts.findIndex((o) => o.dataset["value"] === el.dataset["value"]);
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : opts.length - 1;
      const next = opts[(idx + step) % opts.length];
      if (next) {
        el.dataset["value"] = next.dataset["value"] ?? "";
        sync();
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      setOpen(false);
    }
  };
  Object.defineProperty(el, "value", {
    get: () => el.dataset["value"] ?? "",
    set: (v: string) => {
      el.dataset["value"] = String(v);
      sync();
    },
    configurable: true,
  });
}

function hydrateSelects(root: ParentNode = document): void {
  qsa<SelectElement>(".hub-select:not([data-ready])", root).forEach((el) => {
    hydrateSelect(el);
  });
}

// 外点关闭：document 级只装一次
document.addEventListener("click", (e) => {
  const target = e.target;
  for (const el of qsa<HTMLElement>(".hub-select.is-open")) {
    if (!(target instanceof Node && el.contains(target))) el.classList.remove("is-open");
  }
});
new MutationObserver(() => hydrateSelects(document)).observe(document.body, {
  childList: true,
  subtree: true,
});
hydrateSelects(document);

/* ---------- 列表悬停浮层（.spanel__targets）：高亮从上一行平滑滑到当前行 ---------- */

function hoverLayerOf(list: HTMLElement): HTMLElement {
  let layer = qs<HTMLElement>(":scope > .hub-hoverlayer", list);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "hub-hoverlayer";
    list.insertBefore(layer, list.firstChild);
  }
  return layer;
}

function hideHoverLayer(list: HTMLElement): void {
  const layer = qs<HTMLElement>(":scope > .hub-hoverlayer", list);
  if (layer) layer.style.opacity = "0";
  list.classList.remove("is-hovering");
}

document.addEventListener("mouseover", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const listEl = target.closest(".spanel__targets");
  if (!(listEl instanceof HTMLElement)) return;
  for (const l of qsa<HTMLElement>(".spanel__targets.is-hovering")) {
    if (l !== listEl) hideHoverLayer(l);
  }
  const li = target.closest("li");
  const btn = li ? qs<HTMLElement>(".stgt", li) : null;
  if (!btn || btn.classList.contains("is-on")) {
    hideHoverLayer(listEl);
    return;
  }
  listEl.classList.add("is-hovering");
  const layer = hoverLayerOf(listEl);
  layer.style.transform = `translateY(${btn.offsetTop}px)`;
  layer.style.height = `${btn.offsetHeight}px`;
  layer.style.opacity = "1";
});
document.addEventListener("mouseout", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const listEl = target.closest(".spanel__targets");
  if (!(listEl instanceof HTMLElement)) return;
  const related = e.relatedTarget;
  if (!(related instanceof Node && listEl.contains(related))) hideHoverLayer(listEl);
});

/* ---------- 选中描边生长帧（目标行 / 工具卡片 / 条头 chip 共用） ---------- */

function buildFrame(svg: SVGSVGElement): void {
  const host = svg.parentElement;
  if (!host) return;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!(w && h)) return;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  let r = Number.parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const up = qs<SVGPathElement>(".fr-up", svg);
  const dn = qs<SVGPathElement>(".fr-dn", svg);
  // 圆角弧中点（描边实际可见的「角点」）：两条路径都从左上角点出发、右下角点汇合
  const k = r > 0 ? r * (1 - Math.SQRT1_2) : 0;
  if (up) {
    up.setAttribute(
      "d",
      r > 0
        ? `M ${k} ${k} A ${r} ${r} 0 0 1 ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w} ${r} L ${w} ${h - r} A ${r} ${r} 0 0 1 ${w - k} ${h - k}`
        : `M 0 0 L ${w} 0 L ${w} ${h}`,
    );
  }
  if (dn) {
    dn.setAttribute(
      "d",
      r > 0
        ? `M ${k} ${k} A ${r} ${r} 0 0 0 0 ${r} L 0 ${h - r} A ${r} ${r} 0 0 0 ${r} ${h} L ${w - r} ${h} A ${r} ${r} 0 0 0 ${w - k} ${h - k}`
        : `M 0 0 L 0 ${h} L ${w} ${h}`,
    );
  }
}

const frameRo: ResizeObserver | null =
  "ResizeObserver" in window
    ? new ResizeObserver((entries) => {
        for (const e of entries) {
          const target = e.target;
          if (target instanceof Element) {
            const svg = qs<SVGSVGElement>(".stgt-frame", target);
            if (svg) buildFrame(svg);
          }
        }
      })
    : null;
const frameSeen = new WeakSet<Element>();

function drawFrames(root: ParentNode = document): void {
  for (const svg of qsa<SVGSVGElement>(".stgt-frame", root)) {
    buildFrame(svg);
    const host = svg.parentElement;
    if (frameRo && host && !frameSeen.has(host)) {
      frameSeen.add(host);
      frameRo.observe(host);
    }
  }
}

export const HubUI = {
  toast,
  modal,
  confirm: confirmBox,
  prompt: promptBox,
  sourceRemovedDialog,
  sourceRemovedForDelete,
  select,
  hydrateSelects,
  drawFrames,
};

void mustById;
