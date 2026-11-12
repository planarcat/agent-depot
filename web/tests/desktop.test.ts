import { afterEach, describe, expect, test } from "bun:test";
import {
  type DesktopSettings,
  desktopAvailable,
  getDesktopProfile,
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
