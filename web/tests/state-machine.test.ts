import { describe, expect, test } from "bun:test";
import {
  aggState,
  baseBind,
  type CanvasState,
  CHANNEL_LABEL,
  channelState,
  createCanvasState,
  itemOn,
  type LaneVisual,
  laneExcluded,
  laneKey,
  laneMode,
  laneOn,
  lanePaused,
  laneState,
  namesFromItems,
  targetOf,
} from "../src/core/state-machine.ts";
import type { DirBinding, TargetPublic } from "../src/core/types/api.ts";

function target(id: number, tool: string, kind: string): TargetPublic {
  return { id, name: `${tool}-${kind}`, kind, tool, path: `/tmp/${tool}`, format_key: null };
}

function bind(over: Partial<DirBinding> = {}): DirBinding {
  return {
    id: 1,
    dir_id: 1,
    target_id: 10,
    mode: "copy",
    enabled: true,
    created_at: "2026-11-11T00:00:00Z",
    last_sync_at: null,
    last_result: null,
    channels: ["skills"],
    excluded: [],
    dir_name: "dir",
    target_name: "claude-skills",
    tool: "claude",
    target_kind: "skills_dir",
    ...over,
  };
}

function mk(over: Partial<CanvasState> = {}): CanvasState {
  const s = createCanvasState();
  s.dirs = [{ id: 1, name: "d1", counts: { skills: 3, mcp: 2 }, layout: null }];
  s.tools = [{ id: "claude", name: "Claude", color: 2 }];
  s.skTargets = [target(10, "claude", "skills_dir")];
  s.mcpTargets = [target(11, "claude", "mcp_config")];
  return Object.assign(s, over);
}

const T = "claude";
const D = 1;

describe("无绑定基线", () => {
  const s = mk();
  test("四态全部为未连接", () => {
    expect(laneOn(s, D, T, "skills")).toBe(false);
    expect(lanePaused(s, D, T, "skills")).toBe(false);
    expect(laneState(s, D, T, "skills")).toBe("off");
    expect(channelState(s, D, T, "skills")).toBe("off");
    expect(channelState(s, D, T, "mcp")).toBe("off");
    expect(aggState(s, D, T)).toBeNull();
    expect(itemOn(s, "any", D, T, "skills")).toBe(false);
  });

  test("默认值：mode=copy、excluded 空、无 baseBind", () => {
    expect(laneMode(s, D, T, "skills")).toBe("copy");
    expect([...laneExcluded(s, D, T, "skills")]).toEqual([]);
    expect(baseBind(s, D, T, "skills")).toBeNull();
  });

  test("未知目录/工具不会误判在线", () => {
    expect(laneOn(s, 999, T, "skills")).toBe(false);
    expect(laneOn(s, D, "nope", "skills")).toBe(false);
  });
});

describe("真实绑定 · enabled 两态", () => {
  test("enabled=1 → full（无排除）", () => {
    const s = mk({ binds: [bind()] });
    expect(laneOn(s, D, T, "skills")).toBe(true);
    expect(lanePaused(s, D, T, "skills")).toBe(false);
    expect(channelState(s, D, T, "skills")).toBe("full");
    expect(itemOn(s, "a", D, T, "skills")).toBe(true);
    expect(aggState(s, D, T)).toBe("full");
  });

  test("enabled=0 → paused（仍算已连线）", () => {
    const s = mk({ binds: [bind({ enabled: false })] });
    expect(laneOn(s, D, T, "skills")).toBe(true);
    expect(lanePaused(s, D, T, "skills")).toBe(true);
    expect(channelState(s, D, T, "skills")).toBe("paused");
    expect(aggState(s, D, T)).toBe("paused");
  });

  test("channels 不含该通道 → 该通道 off", () => {
    const s = mk({ binds: [bind()] });
    expect(laneOn(s, D, T, "mcp")).toBe(false);
    expect(channelState(s, D, T, "mcp")).toBe("off");
  });

  test("同一绑定含双通道 → 两通道都 on", () => {
    const s = mk({ binds: [bind({ channels: ["skills", "mcp"] })] });
    expect(channelState(s, D, T, "skills")).toBe("full");
    expect(channelState(s, D, T, "mcp")).toBe("full");
    expect(aggState(s, D, T)).toBe("full");
  });
});

describe("排除项 → part / blocked", () => {
  test("排除 1/3 → part", () => {
    const s = mk({ binds: [bind({ excluded: ["a"] })] });
    expect(channelState(s, D, T, "skills")).toBe("part");
    expect(aggState(s, D, T)).toBe("part");
    expect(itemOn(s, "a", D, T, "skills")).toBe(false);
    expect(itemOn(s, "b", D, T, "skills")).toBe(true);
  });

  test("排除 3/3 → blocked", () => {
    const s = mk({ binds: [bind({ excluded: ["a", "b", "c"] })] });
    expect(channelState(s, D, T, "skills")).toBe("blocked");
    expect(aggState(s, D, T)).toBe("blocked");
  });

  test("排除数超过 total 仍按 blocked 封顶", () => {
    const s = mk({ binds: [bind({ excluded: ["a", "b", "c", "d", "e"] })] });
    expect(channelState(s, D, T, "skills")).toBe("blocked");
  });

  test("total=0 时任何排除都算 full（空目录无部分态）", () => {
    const s = mk({
      dirs: [{ id: 1, name: "empty", counts: { skills: 0, mcp: 0 }, layout: null }],
      binds: [bind({ excluded: ["ghost"] })],
    });
    expect(channelState(s, D, T, "skills")).toBe("full");
    expect(channelState(s, D, T, "mcp")).toBe("off");
  });

  test("精确口径：selDir 命中 + items 非空时只统计清单内名字", () => {
    const s = mk({
      binds: [bind({ excluded: ["a", "b"] })],
      selDir: D,
      items: { skills: ["a"], mcp: [] },
    });
    // 清单只有 a；排除项命中 a 1 个 → 1 < 3 → part（不是 2/3 的粗算）
    expect(channelState(s, D, T, "skills")).toBe("part");
  });

  test("精确口径：清单覆盖全部排除项且总数相等 → blocked", () => {
    const s = mk({
      dirs: [{ id: 1, name: "d", counts: { skills: 2, mcp: 0 }, layout: null }],
      binds: [bind({ excluded: ["a", "b"] })],
      selDir: D,
      items: { skills: ["a", "b"], mcp: [] },
    });
    expect(channelState(s, D, T, "skills")).toBe("blocked");
  });

  test("精确口径：清单里没有排除项 → full", () => {
    const s = mk({
      binds: [bind({ excluded: ["x"] })],
      selDir: D,
      items: { skills: ["a", "b"], mcp: [] },
    });
    expect(channelState(s, D, T, "skills")).toBe("full");
  });

  test("selDir 未命中时退回粗算", () => {
    const s = mk({
      binds: [bind({ excluded: ["a"] })],
      selDir: 99,
      items: { skills: ["zzz"], mcp: [] },
    });
    expect(channelState(s, D, T, "skills")).toBe("part");
  });
});

describe("同步模式", () => {
  test("base mode=link 时缺省读取 link", () => {
    const s = mk({ binds: [bind({ mode: "link" })] });
    expect(laneMode(s, D, T, "skills")).toBe("link");
  });
});

describe("aggState 聚合优先级", () => {
  const cases: Array<[string, ReturnType<typeof bind>[], "skills" | "mcp", LaneVisual | null]> = [
    ["双 full", [bind({ channels: ["skills", "mcp"] })], "skills", "full"],
    [
      "full + part",
      [bind({ channels: ["skills"] }), bind({ id: 2, channels: ["mcp"], excluded: ["a"] })],
      "skills",
      "full",
    ],
    [
      "part + paused",
      [
        bind({ channels: ["skills"], excluded: ["a"] }),
        bind({ id: 2, channels: ["mcp"], enabled: false }),
      ],
      "skills",
      "part",
    ],
    [
      "paused + blocked",
      [
        bind({ channels: ["skills"], enabled: false }),
        bind({ id: 2, channels: ["mcp"], excluded: ["a", "b", "c"] }),
      ],
      "skills",
      "paused",
    ],
    ["只有 blocked", [bind({ excluded: ["a", "b", "c"] })], "skills", "blocked"],
    ["双 off", [], "skills", null],
  ];

  for (const [name, binds, ch, want] of cases) {
    test(`聚合：${name}（${ch}）`, () => {
      const s = mk({ binds });
      expect(aggState(s, D, T)).toBe(want);
    });
  }
});

describe("辅助查询", () => {
  test("targetOf 按通道取目标", () => {
    const s = mk();
    expect(targetOf(s, T, "skills")?.id).toBe(10);
    expect(targetOf(s, T, "mcp")?.id).toBe(11);
    expect(targetOf(s, "nope", "skills")).toBeNull();
  });

  test("baseBind 精确匹配目录 + 工具 + 通道", () => {
    const s = mk({ binds: [bind()] });
    expect(baseBind(s, D, T, "skills")?.id).toBe(1);
    expect(baseBind(s, 2, T, "skills")).toBeNull();
    expect(baseBind(s, D, "codex", "skills")).toBeNull();
    expect(baseBind(s, D, T, "mcp")).toBeNull();
  });

  test("laneKey 格式稳定", () => {
    expect(laneKey(3, "codex", "mcp")).toBe("3:codex:mcp");
  });

  test("namesFromItems 只取 name", () => {
    expect(
      namesFromItems({
        items: [
          { name: "a", kind: "skill" },
          { name: "b", kind: "skill" },
        ] as never,
      }),
    ).toEqual(["a", "b"]);
  });

  test("通道标签", () => {
    expect(CHANNEL_LABEL.skills).toBe("Skills");
    expect(CHANNEL_LABEL.mcp).toBe("MCP");
  });
});
