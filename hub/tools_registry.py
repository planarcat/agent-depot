"""工具注册表：可添加 / 停用 / 移除的采集工具。

- 存储：config 表 key="tools"（JSON 数组，仅存覆盖项与自定义工具）。
- 内置三工具（claude / codex / opencode）始终存在：可停用、不可移除，
  路径由环境变量 / 默认值管理。
- 自定义工具必须指明适配器与根路径；移除只断开登记，
  已采集的会话与台账保留、绝不删除。
"""
import json
import os
import re

ADAPTERS = {
    "claude":   {"label": "Claude Code 兼容（JSONL 目录）", "root_hint": "例如 ~/.claude/projects"},
    "codex":    {"label": "Codex 兼容（JSONL 目录）",       "root_hint": "例如 ~/.codex"},
    "opencode": {"label": "OpenCode（SQLite 文件）",        "root_hint": "例如 ~/.local/share/opencode/opencode.db"},
    "pi":       {"label": "Pi-Agent（JSONL 目录）",         "root_hint": "例如 ~/.pi/agent/sessions"},
    "cursor":   {"label": "Cursor（composer 数据库）",      "root_hint": "例如 ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"},
}

BUILTIN_TOOLS = [
    {"id": "claude",   "name": "Claude Code", "adapter": "claude",   "builtin": True, "color": 1},
    {"id": "codex",    "name": "Codex CLI",   "adapter": "codex",    "builtin": True, "color": 2},
    {"id": "opencode", "name": "OpenCode",    "adapter": "opencode", "builtin": True, "color": 3},
]

PALETTE = 6                      # 颜色槽位：tool-dot--p1 .. p6
BUILTIN_IDS = {t["id"] for t in BUILTIN_TOOLS}


def _norm_path(p):
    return os.path.abspath(os.path.expanduser(str(p).strip()))


def _saved_entries(store):
    raw = store.get_config("tools")
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except Exception:
        return []
    return [t for t in v if isinstance(t, dict) and t.get("id")]


def save_tools(store, entries):
    store.set_config("tools", json.dumps(entries, ensure_ascii=False))


def load_tools(store):
    """合并后的工具列表：内置在前，自定义按登记顺序。"""
    saved = _saved_entries(store)
    by_id = {t["id"]: t for t in saved}
    tools = []
    for b in BUILTIN_TOOLS:
        t = dict(b)
        t["enabled"] = True
        s = by_id.get(b["id"])
        if s:
            if "enabled" in s:
                t["enabled"] = bool(s.get("enabled", True))
            if s.get("name"):
                t["name"] = str(s["name"])[:60]
        tools.append(t)
    for t in saved:
        if t["id"] in BUILTIN_IDS:
            continue
        t = dict(t)
        t.setdefault("enabled", True)
        tools.append(t)
    return tools


def tool_by_id(store, tid):
    for t in load_tools(store):
        if t["id"] == tid:
            return t
    return None


def is_active(store, tid):
    t = tool_by_id(store, tid)
    return bool(t and t.get("enabled", True))


def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s[:24]


def _free_id(existing, base):
    base = base or "tool"
    if base not in existing:
        return base
    i = 2
    while ("%s-%d" % (base, i)) in existing:
        i += 1
    return "%s-%d" % (base, i)


def _pick_color(tools):
    used = [t.get("color") for t in tools if not t.get("builtin")]
    for i in range(4, PALETTE + 1):
        if i not in used:
            return i
    return 4 + (len(used) % (PALETTE - 3))


def add_tool(store, name, adapter, root=None):
    """新增自定义工具 → (entry, warning)；校验失败抛 ValueError。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("名称不能为空")
    if len(name) > 60:
        raise ValueError("名称过长（≤60 字符）")
    if adapter not in ADAPTERS:
        raise ValueError("未知的会话格式：%s" % adapter)
    root = _norm_path(root) if (root or "").strip() else ""
    if not root:
        raise ValueError("路径不能为空")
    tools = load_tools(store)
    for t in tools:
        if t["name"].strip().lower() == name.lower():
            raise ValueError("名称已存在：%s" % name)
    tid = _free_id({t["id"] for t in tools}, _slug(name))
    entry = {"id": tid, "name": name, "adapter": adapter, "root": root,
             "enabled": True, "builtin": False, "color": _pick_color(tools)}
    entries = _saved_entries(store)
    entries.append(entry)
    save_tools(store, entries)
    warning = None
    if not os.path.exists(root):
        warning = "路径当前不存在：%s（已保存，生成数据后刷新即可）" % root
    return entry, warning


def update_tool(store, tid, patch):
    """改名 / 启停 / 改路径。校验失败抛 ValueError。"""
    patch = dict(patch or {})
    tools = load_tools(store)
    cur = next((t for t in tools if t["id"] == tid), None)
    if cur is None:
        raise KeyError(tid)
    if patch.get("name") is not None:
        nm = str(patch["name"]).strip()
        if not nm:
            raise ValueError("名称不能为空")
        for t in tools:
            if t["id"] != tid and t["name"].strip().lower() == nm.lower():
                raise ValueError("名称已存在：%s" % nm)
        patch["name"] = nm[:60]
    if "root" in patch and patch.get("root") is not None:
        if not str(patch["root"]).strip():
            raise ValueError("路径不能为空")
        patch["root"] = _norm_path(patch["root"])
    entries = _saved_entries(store)
    ent = next((s for s in entries if s["id"] == tid), None)
    if cur.get("builtin"):
        if patch.get("root"):
            raise ValueError("内置工具路径由环境变量 / 默认值管理，不可修改")
        if ent is None:
            ent = {"id": tid}
            entries.append(ent)
    if ent is None:
        raise KeyError(tid)
    for k in ("name", "enabled", "root"):
        if k in patch and patch[k] is not None:
            ent[k] = patch[k]
    save_tools(store, entries)
    return tool_by_id(store, tid)


def remove_tool(store, tid):
    """移除自定义工具：断开登记 + 清理其定时配置；数据与台账不动。"""
    tools = load_tools(store)
    cur = next((t for t in tools if t["id"] == tid), None)
    if cur is None:
        raise KeyError(tid)
    if cur.get("builtin"):
        raise ValueError("内置工具不可移除（可停用）")
    entries = [s for s in _saved_entries(store) if s["id"] != tid]
    save_tools(store, entries)
    try:
        raw = store.get_config("schedule")
        sched = json.loads(raw) if raw else None
        if isinstance(sched, dict) and tid in sched:
            sched.pop(tid, None)
            store.set_config("schedule", json.dumps(sched))
    except Exception:
        pass
    return cur


def public_list(store, counts=None):
    """给 /api/state 与前端的注册表视图（含计数与路径可用性）。"""
    counts = counts or {}
    out = []
    for t in load_tools(store):
        c = counts.get(t["id"]) or {}
        root = t.get("root")
        out.append({
            "id": t["id"], "name": t["name"], "adapter": t["adapter"],
            "builtin": bool(t.get("builtin")),
            "enabled": bool(t.get("enabled", True)),
            "color": int(t.get("color") or 0),
            "root": root,
            "root_exists": (os.path.exists(root) if root else None),
            "count": c.get("count", 0),
            "latest": c.get("latest"),
            "adapter_label": ADAPTERS.get(t.get("adapter"), {}).get("label", t.get("adapter")),
            "root_hint": ADAPTERS.get(t.get("adapter"), {}).get("root_hint", ""),
        })
    return out
