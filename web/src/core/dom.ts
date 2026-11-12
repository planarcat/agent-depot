/** DOM 原语：类型安全的查询/创建/动画辅助。视图层只用这些，不裸摸 document。 */

/** 按 id 取元素；缺失返回 null（调用方显式判空）。 */
export function byId<E extends HTMLElement = HTMLElement>(id: string): E | null {
  return document.getElementById(id) as E | null;
}

/** 按 id 取元素；缺失即抛（用于"渲染后必然存在"的节点）。 */
export function mustById<E extends HTMLElement = HTMLElement>(id: string): E {
  const node = byId<E>(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node;
}

export function qs<E extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): E | null {
  return root.querySelector<E>(sel);
}

export function qsa<E extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): E[] {
  return Array.from(root.querySelectorAll<E>(sel));
}

/** querySelector + 断言存在（"渲染后必然存在"的节点用；缺失即抛，与旧代码 TypeError 同类）。 */
export function mustQs<E extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): E {
  const node = root.querySelector<E>(sel);
  if (!node) throw new Error(`缺少 DOM 节点 ${sel}`);
  return node;
}

/** 创建元素（class / text / attrs 一次给全）。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: { class?: string; text?: string; html?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  }
  return node;
}

/** 骨架屏占位（首屏列表加载中）。 */
export function skeletonRows(n = 3): string {
  return `<div class="ske">${Array.from(
    { length: n },
    () => '<div class="ske__row"><span class="ske__a"></span><span class="ske__b"></span></div>',
  ).join("")}</div>`;
}

export interface CollapseOptions {
  /** 备选：按 dataset 键筛选（如 'id'）。 */
  keys?: string[];
  /** 备选：自定义筛选。 */
  sel?: (row: HTMLElement) => boolean;
}

/** 删除行：先收起高度（180ms）再让调用方刷新——避免列表整体跳。 */
export function collapseRows(list: string, opts: CollapseOptions = {}): Promise<number> {
  const rows = qsa<HTMLElement>(list).filter((r) => {
    if (opts.keys) {
      const id = r.dataset["id"];
      return id !== undefined && opts.keys.includes(id);
    }
    return opts.sel ? opts.sel(r) : true;
  });
  if (rows.length === 0) return Promise.resolve(0);
  for (const r of rows) r.classList.add("is-removing");
  return new Promise<number>((resolve) => {
    setTimeout(() => {
      for (const r of rows) r.remove();
      resolve(rows.length);
    }, 180);
  });
}

/** 闪一下（1.2s 淡出，不改变布局）。 */
export function flash(node: Element | null): void {
  if (!(node && node instanceof HTMLElement)) return;
  node.classList.remove("is-flash");
  void node.offsetWidth;
  node.classList.add("is-flash");
  setTimeout(() => node.classList.remove("is-flash"), 1300);
}

/** 记录一组元素的 dataset 键（刷新后判断哪些是新增）。 */
export function keySet(selector: string, attr: string): Set<string> {
  const out = new Set<string>();
  for (const e of qsa<HTMLElement>(selector)) {
    const v = e.dataset[attr];
    if (v) out.add(v);
  }
  return out;
}

/** 复制文本（clipboard API → execCommand 兜底）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

/** 按钮 loading 态包装：执行期间加 .is-loading，异常也必摘。 */
export async function withLoading<T>(btn: HTMLElement | null, fn: () => Promise<T>): Promise<T> {
  btn?.classList.add("is-loading");
  try {
    return await fn();
  } finally {
    btn?.classList.remove("is-loading");
  }
}

/** 滚动容器是否已滚到底（分批加载用）。 */
export function nearBottom(container: HTMLElement, threshold = 240): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

/** 按模块启用态显示/隐藏顶部导航按钮（设置中心与启动早期共用）。 */
export function applyModuleVisibility(mods: { id: string; enabled: boolean }[]): void {
  for (const m of mods) {
    const navBtn = qs<HTMLElement>(`.mod-nav button[data-view="${m.id}"]`);
    if (navBtn) navBtn.style.display = m.enabled ? "" : "none";
  }
}
