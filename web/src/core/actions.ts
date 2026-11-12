/**
 * 应用动作注册表：打断 main ↔ views 的循环依赖。
 * main 在启动时注册渲染动作；视图通过 appActions() 调用。
 * 未注册即抛错（fail-loud，避免半初始化状态的静默空转）。
 */

import type { ViewId } from "./state.ts";

export interface AppActions {
  renderAll: () => void;
  renderRows: () => void;
  renderPanel: () => void;
  renderMemoryView: () => void;
  switchView: (id: ViewId) => Promise<void> | void;
  loadState: () => Promise<void>;
}

let actions: AppActions | null = null;

export function registerAppActions(next: AppActions): void {
  actions = next;
}

export function appActions(): AppActions {
  if (!actions) throw new Error("应用动作未注册（main 尚未完成初始化）");
  return actions;
}
