/**
 * 桌面壳（Tauri）桥：设置页与菜单栏/开机启动等原生能力交互。
 * 浏览器打开时这些能力不可用（invoke 不存在），调用方需先 desktopAvailable()。
 */

export type DesktopProfile = "dev" | "release";

/** 显示名：开发版加 " Dev" 后缀（窗口标题 / 顶栏 / 托盘 / Dock 一致）。 */
export function displayName(base: string, profile: DesktopProfile | null): string {
  return profile === "dev" ? `${base} Dev` : base;
}

export interface DesktopRuntimeInfo {
  profile: "dev" | "release";
  instance: string;
  version: string;
  pid: number;
  service_url: string;
  data_dir: string;
  config_dir: string;
}

export interface DesktopSettings {
  /** 登录时自动启动（macOS LaunchAgent） */
  launch_at_login: boolean;
  /** 菜单栏挂载（托盘图标 + 关窗隐藏） */
  menu_bar: boolean;
  /** 静默启动：不弹窗口，只挂菜单栏（依赖 menu_bar） */
  silent_start: boolean;
  /** 是否在 Dock 显示图标 */
  show_dock_icon: boolean;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function invokeFn(): Invoke | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke } };
  };
  return w.__TAURI__?.core?.invoke ?? null;
}

/** 当前是否运行在桌面客户端内。 */
export function desktopAvailable(): boolean {
  return invokeFn() !== null;
}

/** 当前桌面壳是开发版还是正式版（设置互不共享）；非桌面环境返回 null。 */
export async function getDesktopProfile(): Promise<DesktopProfile | null> {
  const invoke = invokeFn();
  if (!invoke) return null;
  try {
    const p = await invoke<string>("desktop_profile");
    return p === "dev" ? "dev" : "release";
  } catch {
    return null; // 旧壳没有该命令：保持未知，不阻断设置页
  }
}

/** 开发版监控页的运行时信息（实例/端口/PID/数据目录）；非桌面环境返回 null。 */
export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo | null> {
  const invoke = invokeFn();
  if (!invoke) return null;
  try {
    return await invoke<DesktopRuntimeInfo>("desktop_runtime_info");
  } catch {
    return null;
  }
}

/** 读取桌面设置；非桌面环境返回 null。 */
export async function getDesktopSettings(): Promise<DesktopSettings | null> {
  const invoke = invokeFn();
  if (!invoke) return null;
  return invoke<DesktopSettings>("desktop_get_settings");
}

/** 保存并立即应用桌面设置（返回后端归一化后的值）。 */
export async function setDesktopSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  const invoke = invokeFn();
  if (!invoke) throw new Error("当前不在桌面客户端内");
  return invoke<DesktopSettings>("desktop_set_settings", { settings });
}
