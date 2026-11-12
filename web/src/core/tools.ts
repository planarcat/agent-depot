/** 工具注册表（全局单点真源）：/api/state.tool_list 驱动。 */

import type { ToolPublic } from "./types/api.ts";

const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
};

const TOOL_SHORT: Record<string, string> = {
  claude: "CC",
  codex: "CX",
  opencode: "OC",
  workbuddy: "WB",
  zcode: "ZC",
  autoclaw: "AC",
  "trae-cn": "TR",
  agents: "AG",
  "pi-agent": "PI",
  cursor: "CU",
};

let tools: ToolPublic[] = [];

export function setTools(list: ToolPublic[]): void {
  tools = list;
  for (const t of list) TOOL_NAMES[t.id] = t.name;
}

/** 已启用且登记了会话根的工具（会话视图工具卡范围）。 */
export function sessionTools(): ToolPublic[] {
  return tools.filter((t) => t.enabled && !!t.root);
}

export function allTools(): ToolPublic[] {
  return tools;
}

export function toolById(id: string | null | undefined): ToolPublic | null {
  if (!id) return null;
  return tools.find((t) => t.id === id) ?? null;
}

export function toolName(id: string): string {
  return TOOL_NAMES[id] ?? id;
}

/** 卡片色块 class（未知工具回退 p1）。 */
export function toolColorCls(t: Pick<ToolPublic, "color"> | null | undefined): string {
  return `tool-dot--p${(t && t.color) || 1}`;
}

/** 短名（预设优先，未知工具取名称词首字母）。 */
export function toolShort(t: Pick<ToolPublic, "id" | "name"> | null | undefined): string {
  if (!t) return "··";
  const preset = TOOL_SHORT[t.id];
  if (preset) return preset;
  const words = String(t.name || "")
    .split(/[\s\-_/]+/u)
    .filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  return (
    words.length > 1
      ? `${first.slice(0, 1)}${second.slice(0, 1)}`
      : String(t.name || "?").slice(0, 2)
  ).toUpperCase();
}
