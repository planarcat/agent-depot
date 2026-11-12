/**
 * 全局桥接声明：e2e 与既有视图经 window.* 读取应用对象（保行为契约）。
 * ESM 化后模块内部一律走 import；window.* 仅作为外部调试/e2e 的稳定入口。
 */
import type { AppState } from "./core/state.ts";
import type { SseChange } from "./core/types/api.ts";
import type { HubUI as HubUiShape } from "./hub-ui.ts";

interface HubAppBridge {
  state: AppState;
  loadState: () => Promise<void>;
  setFilter: (tool: string) => void;
  openSession: (sid: string) => void;
  switchView: (id: string) => void;
  [key: string]: unknown;
}

interface MvBridge {
  short: (toolId: string) => string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    hubApp?: HubAppBridge;
    MV?: MvBridge;
    HubUI?: typeof HubUiShape;
    __hubErrors?: string[];
    skeletonRows?: (n?: number) => string;
    collapseRows?: (
      list: string,
      opts?: { keys?: string[]; sel?: (row: HTMLElement) => boolean },
    ) => Promise<number>;
    applyModuleVisibility?: (modules: { id: string; enabled: boolean }[]) => void;
  }
}

export type { SseChange };
