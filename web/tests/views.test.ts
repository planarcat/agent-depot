import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTools } from "../src/core/tools.ts";
import { state } from "../src/core/state.ts";
import type { MigrationRow, ToolPublic } from "../src/core/types/api.ts";
import { MemoryView } from "../src/views/memory.ts";
import { OpsView } from "../src/views/ops.ts";
import { StatsView } from "../src/views/stats.ts";

const realFetch = globalThis.fetch;
let paths: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function route(rules: Record<string, Handler | Response>): void {
  paths = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:7788");
    paths.push(url.pathname + url.search);
    const r = rules[url.pathname];
    if (r === undefined) return Promise.resolve(json({ ok: false, error: "unmocked" }, 404));
    return Promise.resolve(r instanceof Response ? r.clone() : r(url, init));
  }) as typeof fetch;
}

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
    color: 2,
    root: "/tmp/r",
    root_exists: true,
    count: 0,
    latest: null,
    adapter_label: "",
    root_hint: "",
    ...over,
  };
}

function host(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setTools([tool(), tool({ id: "codex", name: "Codex CLI", color: 5 })]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("StatsView", () => {
  test("KPI / 工具条 / 最近迁移", async () => {
    route({
      "/api/stats": json({
        ok: true,
        stats: {
          totals: { sessions: 10, messages: 20, starred: 3, migrations: 2 },
          by_tool: [
            { tool: "claude", sessions: 6, messages: 12 },
            { tool: "codex", sessions: 2, messages: 4 },
          ],
        },
      }),
    });
    state.migrations = [
      {
        id: 1,
        lid: "lid-1",
        ts: "2026-11-11T08:30:00Z",
        src_tool: "claude",
        src_sid: "s1",
        dst_tool: "codex",
        dst_sid: "s2",
        status: "ok",
        src_msg_count: 5,
      } satisfies MigrationRow,
    ];
    const root = host();
    await StatsView.render(root);
    expect(root.querySelectorAll(".statkpi__c")).toHaveLength(4);
    expect(root.textContent).toContain("10");
    expect(root.querySelectorAll(".statbar")).toHaveLength(2);
    expect(root.textContent).toContain("Claude Code");
    expect(root.textContent).toContain("lid-1");
    expect(root.textContent).toContain("→");
  });

  test("空数据降级为空态，不抛", async () => {
    route({ "/api/stats": json({ ok: true }) });
    state.migrations = [];
    const root = host();
    await StatsView.render(root);
    expect(root.textContent).toContain("还没有采集到会话");
    expect(root.textContent).toContain("还没有迁移记录");
  });

  test("请求失败也渲染（cache=null 降级）", async () => {
    route({});
    const root = host();
    await StatsView.render(root);
    expect(root.querySelectorAll(".statkpi__c")).toHaveLength(4);
  });

  test("root 为空 → 直接返回", async () => {
    route({});
    await StatsView.render(null);
    expect(paths).toHaveLength(0);
  });
});

describe("OpsView", () => {
  const row = (id: number, status: string, action: string) => ({
    id,
    ts: "2026-11-11T08:30:00Z",
    module: "skills",
    actor: "user",
    action,
    item_kind: "skill",
    item_name: "demo",
    item_version: "abc123",
    source_id: 1,
    target_id: 2,
    status,
    error_code: null,
    reason: status === "failed" ? "boom" : null,
    detail: '{"k":1}',
    extra: {},
    target_name: "claude",
    source_name: "repo",
  });

  test("渲染行 / 统计 / 详情", async () => {
    route({
      "/api/ops": json({ ok: true, total: 2, items: [row(1, "ok", "sync"), row(2, "failed", "push")] }),
    });
    const root = host();
    await OpsView.render(root);
    expect(root.querySelectorAll('[data-testid="ops-row"]')).toHaveLength(2);
    expect(root.querySelector('[data-testid="ops-count"]')?.textContent).toBe("2");
    expect(root.textContent).toContain("失败 · 本页");
    (root.querySelector('[data-oid="2"]') as HTMLElement).click();
    expect(root.querySelector("#ops-detail")?.textContent).toContain("push");
    expect(root.querySelector("#ops-detail")?.textContent).toContain("boom");
  });

  test("模块 / 状态筛选触发新请求并重置页", async () => {
    route({
      "/api/ops": json({ ok: true, total: 1, items: [row(1, "ok", "sync")] }),
    });
    const root = host();
    await OpsView.render(root);
    (root.querySelector('[data-m="memory"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(paths.at(-1)).toContain("module=memory");
    (root.querySelector('[data-s="failed"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(paths.at(-1)).toContain("status=failed");
    expect(paths.at(-1)).toContain("offset=0");
  });

  test("搜索 250ms 防抖后带 q 请求", async () => {
    route({ "/api/ops": json({ ok: true, total: 0, items: [] }) });
    const root = host();
    await OpsView.render(root);
    const input = root.querySelector('[data-testid="ops-search"]') as HTMLInputElement;
    input.value = "  sync  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 320));
    expect(paths.at(-1)).toContain("q=sync");
    expect(root.textContent).toContain("没有匹配的操作记录");
  });

  test("分页：下一页 offset 递增，首/末页按钮禁用", async () => {
    route({ "/api/ops": json({ ok: true, total: 100, items: [row(1, "ok", "sync")] }) });
    const root = host();
    await OpsView.render(root);
    const prev = root.querySelector('[data-p="prev"]') as HTMLButtonElement;
    const next = root.querySelector('[data-p="next"]') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(paths.at(-1)).toContain("offset=40");
    expect(root.querySelector(".nv-pinfo")?.textContent).toContain("第 2 页");
  });

  test("末页时下一页禁用", async () => {
    route({ "/api/ops": json({ ok: true, total: 40, items: [row(1, "ok", "sync")] }) });
    const root = host();
    await OpsView.render(root);
    expect((root.querySelector('[data-p="next"]') as HTMLButtonElement).disabled).toBe(true);
  });

  test("refresh 复用当前状态", async () => {
    route({ "/api/ops": json({ ok: true, total: 0, items: [] }) });
    const root = host();
    await OpsView.render(root);
    await OpsView.refresh(root);
    expect(paths).toHaveLength(2);
  });
});

describe("MemoryView", () => {
  test("条目按来源渲染 + 二次 render 命中 30s 缓存", async () => {
    route({
      "/api/memory/overview": json({
        ok: true,
        tools: [
          {
            id: "claude",
            name: "Claude Code",
            color: 2,
            readable: true,
            writable: true,
            degraded: false,
            error: null,
            has_layout: true,
            scanned: true,
          },
        ],
        items: [
          {
            id: 7,
            source_tool: "claude",
            kind: "note",
            scope: "global",
            name: "记忆条目A",
            version: 2,
            hash: "h",
            prev_hash: null,
            last_source_hash: null,
            source_path: null,
            updated_at: "2026-11-11T08:30:00Z",
            status: "ok",
            kind_label: "笔记",
            deployments: [],
          },
        ],
        memstore: "/tmp/mem",
      }),
    });
    const root = host();
    await MemoryView.render(root);
    expect(root.querySelector("#mv-top")).not.toBeNull();
    expect(root.querySelector("#mv-rows")).not.toBeNull();
    expect(root.textContent).toContain("笔记 · 本地");
    expect(root.textContent).toContain("记忆条目A");
    const before = paths.length;
    await MemoryView.render(root);
    expect(paths.length).toBe(before); // 30s 内复用缓存，不重复请求
  });

  test("root 为空 → 不请求", async () => {
    route({});
    await MemoryView.render(null);
    expect(paths).toHaveLength(0);
  });
});
