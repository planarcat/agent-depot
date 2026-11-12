import { describe, expect, test } from "bun:test";
import { hasLazyView, loadView } from "../src/core/view-loader.ts";

describe("view-loader", () => {
  test("已注册的懒加载视图", () => {
    for (const id of ["connect", "skills", "mcp", "ops", "stats", "memory", "settings"]) {
      expect(hasLazyView(id)).toBe(true);
    }
  });

  test("sessions / 未知 id 不走懒加载", () => {
    expect(hasLazyView("sessions")).toBe(false);
    expect(hasLazyView("nope")).toBe(false);
  });

  test("全部懒加载视图可装载（render/refresh 齐备）", async () => {
    for (const id of ["connect", "skills", "mcp", "ops", "stats", "memory", "settings"]) {
      const v = await loadView(id);
      expect(typeof v.render).toBe("function");
      expect(typeof v.refresh).toBe("function");
    }
  });

  test("同一视图缓存同一 Runtime", async () => {
    const a = await loadView("stats");
    const b = await loadView("stats");
    expect(a).toBe(b);
  });

  test("未知 id fail-loud", async () => {
    await expect(loadView("nope")).rejects.toThrow("unknown view: nope");
  });
});
