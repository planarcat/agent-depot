import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, getPrefs, resetPrefs, setPrefs } from "../src/core/prefs.ts";

beforeEach(() => {
  localStorage.clear();
  resetPrefs();
  localStorage.clear();
});

describe("prefs", () => {
  test("无存储时返回默认值", () => {
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });

  test("setPrefs 合并保存并读取", () => {
    const next = setPrefs({ rowChunk: 50, autoScanMemory: false });
    expect(next.rowChunk).toBe(50);
    expect(next.pollIntervalSec).toBe(DEFAULT_PREFS.pollIntervalSec);
    expect(getPrefs().autoScanMemory).toBe(false);
    expect(JSON.parse(localStorage.getItem("agent-depot.prefs.v1") ?? "{}").rowChunk).toBe(50);
  });

  test("非法值被归一化（白名单）", () => {
    const next = setPrefs({
      rowChunk: 999,
      pollIntervalSec: 7,
      defaultView: "nope" as never,
      sessLayout: "grid" as never,
    });
    expect(next.rowChunk).toBe(DEFAULT_PREFS.rowChunk);
    expect(next.pollIntervalSec).toBe(DEFAULT_PREFS.pollIntervalSec);
    expect(next.defaultView).toBe(DEFAULT_PREFS.defaultView);
    expect(next.sessLayout).toBe(DEFAULT_PREFS.sessLayout);
  });

  test("默认视图 / 会话布局可保存", () => {
    const next = setPrefs({ defaultView: "memory", sessLayout: "compact" });
    expect(next.defaultView).toBe("memory");
    expect(next.sessLayout).toBe("compact");
    expect(getPrefs().defaultView).toBe("memory");
  });

  test("坏 JSON 回默认值，不抛", () => {
    localStorage.setItem("agent-depot.prefs.v1", "{bad json");
    // 清缓存：reset 后再注入坏数据
    resetPrefs();
    localStorage.setItem("agent-depot.prefs.v1", "{bad json");
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
  });

  test("resetPrefs 恢复默认并清存储", () => {
    setPrefs({ rowChunk: 200 });
    const next = resetPrefs();
    expect(next).toEqual(DEFAULT_PREFS);
    expect(localStorage.getItem("agent-depot.prefs.v1")).toBeNull();
  });

  test("变更广播 depot:prefs-changed", () => {
    let detail: unknown = null;
    const h = (e: Event): void => {
      detail = (e as CustomEvent).detail;
    };
    window.addEventListener("depot:prefs-changed", h);
    setPrefs({ pollIntervalSec: 30 });
    window.removeEventListener("depot:prefs-changed", h);
    expect((detail as { pollIntervalSec?: number }).pollIntervalSec).toBe(30);
  });
});
