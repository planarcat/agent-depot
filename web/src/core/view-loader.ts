/**
 * 视图懒加载：静态 import 会让所有视图进主 chunk 首屏下载；
 * 这里改成按视图 id 动态 import，bun --splitting 自动切成独立 chunk。
 * 模块 Promise 缓存（同一视图只加载一次）；加载失败不缓存，下次切回可重试。
 */

export interface ViewRuntime {
  /** 首次挂载：建骨架 → 拉数据 → 渲染 */
  render(root: HTMLElement): Promise<void>;
  /** 已挂载后的静默刷新（保留滚动与本地 UI 状态） */
  refresh(root: HTMLElement): Promise<void>;
}

type Loader = () => Promise<ViewRuntime>;

const loaders: Record<string, Loader> = {
  connect: async () => {
    const m = await import("../views/connect.ts");
    return {
      render: (root) => m.ConnectView.render(root),
      refresh: () => m.ConnectView.refresh(),
    };
  },
  skills: async () => {
    const m = await import("../views/skills.ts");
    return {
      render: (root) => m.SkillsView.render(root),
      refresh: () => m.SkillsView.refresh({ parts: ["rows", "targets", "ledger"] }),
    };
  },
  mcp: async () => {
    const m = await import("../views/mcp.ts");
    return {
      render: (root) => m.McpView.render(root),
      refresh: () => m.McpView.refresh({ parts: ["rows", "targets", "ledger"] }),
    };
  },
  ops: async () => {
    const m = await import("../views/ops.ts");
    return {
      render: (root) => m.OpsView.render(root),
      refresh: (root) => m.OpsView.refresh(root),
    };
  },
  stats: async () => {
    const m = await import("../views/stats.ts");
    return {
      render: (root) => m.StatsView.render(root),
      refresh: (root) => m.StatsView.render(root),
    };
  },
  memory: async () => {
    const m = await import("../views/memory.ts");
    return {
      render: (root) => m.MemoryView.render(root),
      refresh: (root) => m.MemoryView.render(root),
    };
  },
  settings: async () => {
    const m = await import("../views/settings.ts");
    return {
      render: () => m.SettingsCenter.refresh(),
      refresh: () => m.SettingsCenter.refresh(),
    };
  },
};

const cache = new Map<string, Promise<ViewRuntime>>();

/** 该 id 是否有懒加载视图（sessions 走主入口自渲染，不在此列）。 */
export function hasLazyView(id: string): boolean {
  return Object.hasOwn(loaders, id);
}

/** 取视图运行态（首次触发 chunk 下载）。 */
export function loadView(id: string): Promise<ViewRuntime> {
  const hit = cache.get(id);
  if (hit) return hit;
  const loader = loaders[id];
  if (!loader) return Promise.reject(new Error(`unknown view: ${id}`));
  const p = loader().catch((e: unknown) => {
    cache.delete(id); // 失败不缓存：网络抖动后切回可重试
    throw e;
  });
  cache.set(id, p);
  return p;
}
