import { beforeEach, describe, expect, test } from "bun:test";
import { appActions, registerAppActions } from "../src/core/actions.ts";
import {
  applyModuleVisibility,
  byId,
  collapseRows,
  copyText,
  el,
  flash,
  keySet,
  mustById,
  mustQs,
  nearBottom,
  qs,
  qsa,
  skeletonRows,
  withLoading,
} from "../src/core/dom.ts";
import { state } from "../src/core/state.ts";
import {
  allTools,
  sessionTools,
  setTools,
  toolById,
  toolColorCls,
  toolName,
  toolShort,
} from "../src/core/tools.ts";
import type { ToolPublic } from "../src/core/types/api.ts";

function tool(over: Partial<ToolPublic> = {}): ToolPublic {
  return {
    id: "claude",
    name: "Claude Code",
    adapter: null,
    skills_dir: null,
    mcp_config: null,
    mcp_format: null,
    builtin: false,
    enabled: true,
    color: 3,
    root: "/tmp/sessions",
    root_exists: true,
    count: 2,
    latest: null,
    adapter_label: "",
    root_hint: "",
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("dom · 查询原语", () => {
  test("byId 命中 / 缺失", () => {
    document.body.innerHTML = '<div id="a" class="x"></div>';
    expect(byId("a")?.className).toBe("x");
    expect(byId("nope")).toBeNull();
  });

  test("mustById 缺失即抛", () => {
    document.body.innerHTML = '<div id="present"></div>';
    expect(mustById("present").id).toBe("present");
    expect(() => mustById("missing")).toThrow("缺少 DOM 节点 #missing");
  });

  test("qs / qsa / mustQs", () => {
    document.body.innerHTML = '<ul id="l"><li class="i">1</li><li class="i">2</li></ul>';
    expect(qs<HTMLElement>("#l")?.id).toBe("l");
    expect(qsa(".i")).toHaveLength(2);
    expect(qs(".none")).toBeNull();
    expect(mustQs<HTMLElement>(".i").textContent).toBe("1");
    expect(() => mustQs(".none")).toThrow("缺少 DOM 节点 .none");
  });

  test("qsa 支持自定义 root", () => {
    document.body.innerHTML = '<div id="r"><b>1</b><b>2</b></div><b>3</b>';
    expect(qsa("b", mustById("r"))).toHaveLength(2);
  });
});

describe("dom · 创建与骨架", () => {
  test("el 一次给全 class/text/attrs", () => {
    const n = el("div", { class: "a b", text: "hi", attrs: { "data-x": "1", id: "n" } });
    expect(n.className).toBe("a b");
    expect(n.textContent).toBe("hi");
    expect(n.getAttribute("data-x")).toBe("1");
    expect(n.id).toBe("n");
  });

  test("el 支持 html 注入（仅供内部常量）", () => {
    const n = el("span", { html: "<b>bold</b>" });
    expect(n.innerHTML).toBe("<b>bold</b>");
  });

  test("skeletonRows 数量", () => {
    expect(skeletonRows(0)).toContain('class="ske"');
    expect(skeletonRows(0).match(/ske__row/gu)).toBeNull();
    expect(skeletonRows(2).match(/ske__row/gu)).toHaveLength(2);
  });
});

describe("dom · 动画与批量", () => {
  test("collapseRows 按 keys 收起并删除", async () => {
    document.body.innerHTML =
      '<div id="r1" data-id="a"></div><div id="r2" data-id="b"></div><div id="r3" data-id="c"></div>';
    const p = collapseRows("[data-id]", { keys: ["a", "c"] });
    expect(document.querySelectorAll(".is-removing")).toHaveLength(2);
    await expect(p).resolves.toBe(2);
    expect(document.getElementById("r1")).toBeNull();
    expect(document.getElementById("r3")).toBeNull();
    expect(document.getElementById("r2")).not.toBeNull();
  });

  test("collapseRows 支持自定义 sel；无命中立即返回 0", async () => {
    document.body.innerHTML = '<div class="row" id="x"></div>';
    await expect(collapseRows(".row", { sel: (r) => r.id === "x" })).resolves.toBe(1);
    await expect(collapseRows(".missing")).resolves.toBe(0);
  });

  test("flash 加类后 1.3s 移除；非 HTMLElement 忽略", async () => {
    const node = el("div");
    flash(node);
    expect(node.classList.contains("is-flash")).toBe(true);
    flash(null);
    flash(document.createTextNode("t") as never);
    await new Promise((r) => setTimeout(r, 1350));
    expect(node.classList.contains("is-flash")).toBe(false);
  });

  test("keySet 收集 dataset 值", () => {
    document.body.innerHTML =
      '<div class="r" data-id="a"></div><div class="r" data-id=""></div><div class="r"></div><div class="r" data-id="b"></div>';
    expect([...keySet(".r", "id")].sort()).toEqual(["a", "b"]);
  });
});

describe("dom · 剪贴板 / loading / 滚动", () => {
  test("copyText 首选 clipboard API", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    expect(await copyText("hi")).toBe(true);
  });

  test("copyText 兜底 execCommand", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("denied")),
      },
    });
    document.execCommand = (() => true) as typeof document.execCommand;
    expect(await copyText("hi")).toBe(true);
    expect(document.querySelector("textarea")).toBeNull();
  });

  test("copyText 两条路都失败 → false", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("denied")),
      },
    });
    document.execCommand = (() => {
      throw new Error("nope");
    }) as typeof document.execCommand;
    expect(await copyText("hi")).toBe(false);
  });

  test("withLoading 结束时摘除；异常也摘除", async () => {
    const btn = el("button");
    await withLoading(btn, async () => 42);
    expect(btn.classList.contains("is-loading")).toBe(false);
    await expect(
      withLoading(btn, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(btn.classList.contains("is-loading")).toBe(false);
    await withLoading(null, async () => 1);
  });

  test("nearBottom 阈值判定", () => {
    const box = el("div");
    Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 400, configurable: true });
    box.scrollTop = 400; // 1000-400-400 = 200 < 240
    expect(nearBottom(box)).toBe(true);
    box.scrollTop = 100; // 500 >= 240
    expect(nearBottom(box)).toBe(false);
    expect(nearBottom(box, 600)).toBe(true);
  });

  test("applyModuleVisibility 按 enabled 显隐导航按钮", () => {
    document.body.innerHTML =
      '<nav class="mod-nav"><button data-view="sessions"></button><button data-view="memory"></button></nav>';
    applyModuleVisibility([
      { id: "sessions", enabled: true },
      { id: "memory", enabled: false },
      { id: "ghost", enabled: true },
    ]);
    const btn = (v: string): HTMLElement => mustQs(`.mod-nav button[data-view="${v}"]`);
    expect(btn("sessions").style.display).toBe("");
    expect(btn("memory").style.display).toBe("none");
  });
});

describe("tools 注册表", () => {
  test("setTools + allTools + sessionTools 过滤 enabled && root", () => {
    const list = [
      tool({ id: "claude", enabled: true, root: "/a" }),
      tool({ id: "codex", enabled: false, root: "/b" }),
      tool({ id: "opencode", enabled: true, root: null }),
    ];
    setTools(list);
    expect(allTools()).toBe(list);
    expect(sessionTools().map((t) => t.id)).toEqual(["claude"]);
  });

  test("toolById：空 id → null，未知 → null", () => {
    setTools([tool({ id: "claude" })]);
    expect(toolById("claude")?.id).toBe("claude");
    expect(toolById(null)).toBeNull();
    expect(toolById(undefined)).toBeNull();
    expect(toolById("")).toBeNull();
    expect(toolById("nope")).toBeNull();
  });

  test("toolName：内置名 + 注册表覆盖 + 原样回退", () => {
    setTools([tool({ id: "zcode", name: "ZCode" })]);
    expect(toolName("claude")).toBe("Claude Code");
    expect(toolName("zcode")).toBe("ZCode");
    expect(toolName("custom")).toBe("custom");
  });

  test("toolColorCls 未知回退 p1", () => {
    expect(toolColorCls({ color: 7 })).toBe("tool-dot--p7");
    expect(toolColorCls({ color: 0 })).toBe("tool-dot--p1");
    expect(toolColorCls(null)).toBe("tool-dot--p1");
    expect(toolColorCls(undefined)).toBe("tool-dot--p1");
  });

  test("toolShort：预设 / 首字母组合 / 单字 / 空", () => {
    expect(toolShort({ id: "claude", name: "Claude Code" })).toBe("CC");
    expect(toolShort({ id: "zcode", name: "ZCode" })).toBe("ZC");
    expect(toolShort({ id: "mystery", name: "My Tool" })).toBe("MT");
    expect(toolShort({ id: "mystery", name: "Solo" })).toBe("SO");
    expect(toolShort({ id: "mystery", name: "" })).toBe("?");
    expect(toolShort(null)).toBe("··");
    expect(toolShort(undefined)).toBe("··");
  });
});

describe("state 初始值", () => {
  test("会话视图默认口", () => {
    expect(state.filter).toBe("all");
    expect(state.view).toBe("sessions");
    expect(state.tab).toBe("migrate");
    expect(state.sessions).toEqual([]);
    expect(state.selected).toBeInstanceOf(Set);
    expect(state._sessLayout).toBe("detail");
    expect(state.engine).toEqual({ casr: false, agentmemory: false });
  });

  test("watch 状态默认关闭且未降级", () => {
    expect(state.watch.backend).toBe("off");
    expect(state.watch.degraded).toBe(false);
    expect(state.watch.subs).toBe(0);
  });
});

describe("actions 注册表", () => {
  test("未注册 fail-loud", () => {
    expect(() => appActions()).toThrow("应用动作未注册");
  });

  test("注册后返回同一对象", () => {
    const acts = {
      renderAll: () => undefined,
      renderRows: () => undefined,
      renderPanel: () => undefined,
      renderMemoryView: () => undefined,
      switchView: () => undefined,
      loadState: async () => undefined,
    };
    registerAppActions(acts);
    expect(appActions()).toBe(acts);
  });
});
