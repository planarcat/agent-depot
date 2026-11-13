import { afterEach, describe, expect, test } from "bun:test";
import {
  type DesktopSettings,
  desktopAvailable,
  displayName,
  getDesktopProfile,
  getDesktopRuntimeInfo,
  getDesktopSettings,
  setDesktopSettings,
} from "../src/core/desktop.ts";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } };

afterEach(() => {
  delete w.__TAURI__;
});

const sample: DesktopSettings = {
  launch_at_login: true,
  menu_bar: true,
  silent_start: false,
  show_dock_icon: false,
};

describe("desktop bridge", () => {
  test("浏览器环境：不可用 / get 返回 null / set 抛错", async () => {
    expect(desktopAvailable()).toBe(false);
    expect(await getDesktopSettings()).toBeNull();
    expect(await getDesktopProfile()).toBeNull();
    await expect(setDesktopSettings(sample)).rejects.toThrow("桌面客户端");
  });

  test("Tauri 环境：get 调 desktop_get_settings", async () => {
    const calls: string[] = [];
    w.__TAURI__ = {
      core: {
        invoke: <T>(cmd: string) => {
          calls.push(cmd);
          return Promise.resolve(sample as T);
        },
      },
    };
    expect(desktopAvailable()).toBe(true);
    expect(await getDesktopSettings()).toEqual(sample);
    expect(calls).toEqual(["desktop_get_settings"]);
  });

  test("Tauri 环境：desktop_profile 返回 dev/release，异常回 null", async () => {
    const answer = (value: string): Invoke => (() => Promise.resolve(value)) as Invoke;
    w.__TAURI__ = { core: { invoke: answer("dev") } };
    expect(await getDesktopProfile()).toBe("dev");
    w.__TAURI__ = { core: { invoke: answer("weird") } };
    expect(await getDesktopProfile()).toBe("release");
    w.__TAURI__ = {
      core: { invoke: (() => Promise.reject(new Error("old shell"))) as Invoke },
    };
    expect(await getDesktopProfile()).toBeNull();
  });

  test("displayName：开发版加 Dev 后缀，正式版/浏览器原样", () => {
    expect(displayName("Agent Depot", "dev")).toBe("Agent Depot Dev");
    expect(displayName("Agent Depot", "release")).toBe("Agent Depot");
    expect(displayName("Agent Depot", null)).toBe("Agent Depot");
  });

  test("Tauri 环境：runtime info 透传实例/端口/PID", async () => {
    const info = {
      profile: "dev" as const,
      instance: "f3373",
      version: "0.6.3",
      pid: 123,
      service_url: "http://127.0.0.1:8317",
      data_dir: "/tmp/data",
      config_dir: "/tmp/config",
    };
    let cmd = "";
    w.__TAURI__ = {
      core: {
        invoke: (<T>(name: string) => {
          cmd = name;
          return Promise.resolve(info as T);
        }) as Invoke,
      },
    };
    expect(await getDesktopRuntimeInfo()).toEqual(info);
    expect(cmd).toBe("desktop_runtime_info");
  });

  test("浏览器环境：runtime info 返回 null", async () => {
    expect(await getDesktopRuntimeInfo()).toBeNull();
  });

  test("Tauri 环境：set 透传 settings 并返回归一化结果", async () => {
    let received: unknown = null;
    w.__TAURI__ = {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => {
          expect(cmd).toBe("desktop_set_settings");
          received = args;
          return Promise.resolve({ ...sample, silent_start: false } as T);
        },
      },
    };
    const out = await setDesktopSettings(sample);
    expect(received).toEqual({ settings: sample });
    expect(out.silent_start).toBe(false);
  });
});
