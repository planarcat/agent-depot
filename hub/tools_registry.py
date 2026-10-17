"""工具注册表：可添加 / 停用 / 移除的采集工具。

- 存储：config 表 key="tools"（JSON 数组，仅存覆盖项与自定义工具）。
- 内置三工具（claude / codex / opencode）始终存在：可停用、不可移除，
  路径由环境变量 / 默认值管理。
- 自定义工具必须指明适配器与根路径；移除只断开登记，
  已采集的会话与台账保留、绝不删除。
"""
import json
import json
import os
import re

ADAPTERS = {
    "claude":   { "name": "Claude Code","label": "Claude Code 兼容（JSONL 目录）", "root_hint": "例如 ~/.claude/projects", "root_hint_default": "~/.claude/projects"},
    "codex":    { "name": "Codex CLI","label": "Codex 兼容（JSONL 目录）",       "root_hint": "例如 ~/.codex", "root_hint_default": "~/.codex"},
    "opencode": { "name": "OpenCode","label": "OpenCode（SQLite 文件）",        "root_hint": "例如 ~/.local/share/opencode/opencode.db", "root_hint_default": "~/.local/share/opencode/opencode.db"},
    "pi":       { "name": "Pi-Agent","label": "Pi-Agent（JSONL 目录）",         "root_hint": "例如 ~/.pi/agent/sessions"},
    "cursor":   { "name": "Cursor","label": "Cursor（composer 数据库）",      "root_hint": "例如 ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"},
    "workbuddy": { "name": "WorkBuddy","label": "WorkBuddy（JSONL 目录）",        "root_hint": "例如 ~/.workbuddy/projects", "root_hint_default": "~/.workbuddy/projects"},
    "zcode":    { "name": "ZCode","label": "ZCode（SQLite 文件）",            "root_hint": "例如 ~/.zcode/cli/db/db.sqlite", "root_hint_default": "~/.zcode/cli/db/db.sqlite"},
    "autoclaw": { "name": "AutoClaw","label": "AutoClaw（JSONL 目录）",          "root_hint": "例如 ~/.openclaw-autoclaw", "root_hint_default": "~/.openclaw-autoclaw/agents"},
    "trae-cn":  { "name": "Trae CN","label": "Trae CN（会话库加密，暂不可采集）", "root_hint": "会话正文为加密存储，仅登记 Skills / MCP", "root_hint_default": "~/.trae-cn"},
    # 共享技能目录：无会话、无 MCP，仅承载 ~/.agents/skills（Codex CLI / OpenCode / Cursor 原生直读）
    "agents":   { "name": "共享技能目录","label": "共享技能目录（仅 Skills 分发，无会话采集）", "root_hint": "无会话采集，仅登记 Skills 目录"},
}

BUILTIN_TOOLS = [
    {"id": "claude", "name": "Claude Code", "adapter": "claude", "builtin": True, "color": 1,
     "skills_dir": "~/.claude/skills", "mcp_config": "~/.claude.json", "mcp_format": "mcpServers"},
    # Codex CLI / OpenCode 原生直读共享目录 ~/.agents/skills（由内置 agents 工具承载），
    # 故 skills_dir 置空：路径为空的工具不在 Skills 界面显示，无需额外判断
    {"id": "codex", "name": "Codex CLI", "adapter": "codex", "builtin": True, "color": 2,
     "skills_dir": "", "mcp_config": "~/.codex/config.toml", "mcp_format": None},
    {"id": "opencode", "name": "OpenCode", "adapter": "opencode", "builtin": True, "color": 3,
     "skills_dir": "", "mcp_config": "~/.config/opencode/opencode.json",
     "mcp_format": "mcp"},
    # ---- v0.6 新增：本机在用的四个工具（路径取自 2026-10-09 实测）----
    {"id": "workbuddy", "name": "WorkBuddy", "adapter": "workbuddy", "builtin": True, "color": 4,
     "root": "~/.workbuddy/projects", "skills_dir": "~/.workbuddy/skills",
     "mcp_config": "~/.workbuddy/mcp.json", "mcp_format": "mcpServers"},
    {"id": "zcode", "name": "ZCode", "adapter": "zcode", "builtin": True, "color": 5,
     "root": "~/.zcode/cli/db/db.sqlite", "skills_dir": "~/.zcode/skills",
     "mcp_config": "~/.zcode/cli/config.json", "mcp_format": "mcp.servers"},
    {"id": "autoclaw", "name": "AutoClaw", "adapter": "autoclaw", "builtin": True, "color": 6,
     "root": "~/.openclaw-autoclaw/agents", "skills_dir": "~/.openclaw-autoclaw/skills",
     "mcp_config": "~/.openclaw-autoclaw/openclaw.json", "mcp_format": "mcp.servers"},
    {"id": "trae-cn", "name": "Trae CN", "adapter": "trae-cn", "builtin": True, "color": 7,
     # 技能目录由 Trae CN 首次上传技能时懒创建；MCP 配置在 App Support 的 User/mcp.json（标准 mcpServers 结构）
     "root": "~/.trae-cn", "skills_dir": "~/.trae-cn/skills",
     "mcp_config": "~/Library/Application Support/Trae CN/User/mcp.json", "mcp_format": "mcpServers"},
    # ---- v0.6 新增：共享技能目录（无会话 / 无 MCP，仅 Skills）----
    {"id": "agents", "name": "Agents", "adapter": "agents", "builtin": True, "color": 8,
     "skills_dir": "~/.agents/skills"},
]

# 已知工具预设：一键填满「会话采集 + Skills 目录 + MCP 配置」三件套
TOOL_PRESETS = [
    {"key": "claude-code", "name": "Claude Code", "adapter": "claude",
     "root": "~/.claude/projects", "skills_dir": "~/.claude/skills",
     "mcp_config": "~/.claude.json", "mcp_format": "mcpServers"},
    # codex / opencode / cursor 原生直读共享目录 ~/.agents/skills，预设 skills_dir 置空
    {"key": "codex", "name": "Codex CLI", "adapter": "codex",
     "root": "~/.codex", "skills_dir": "",
     "mcp_config": "~/.codex/config.toml", "mcp_format": None},
    {"key": "opencode", "name": "OpenCode", "adapter": "opencode",
     "root": "~/.local/share/opencode/opencode.db", "skills_dir": "",
     "mcp_config": "~/.config/opencode/opencode.json", "mcp_format": "mcp"},
    {"key": "cursor", "name": "Cursor", "adapter": "cursor",
     "root": "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
     "skills_dir": "", "mcp_config": "~/.cursor/mcp.json", "mcp_format": "mcpServers"},
    {"key": "pi-agent", "name": "Pi-Agent", "adapter": "pi",
     "root": "~/.pi/agent/sessions", "skills_dir": "~/.pi/agent/skills",
     "mcp_config": None, "mcp_format": None},
    {"key": "workbuddy", "name": "WorkBuddy", "adapter": "workbuddy",
     "root": "~/.workbuddy/projects", "skills_dir": "~/.workbuddy/skills",
     "mcp_config": "~/.workbuddy/mcp.json", "mcp_format": "mcpServers"},
    {"key": "zcode", "name": "ZCode", "adapter": "zcode",
     "root": "~/.zcode/cli/db/db.sqlite", "skills_dir": "~/.zcode/skills",
     "mcp_config": "~/.zcode/cli/config.json", "mcp_format": "mcp.servers"},
    {"key": "autoclaw", "name": "AutoClaw", "adapter": "autoclaw",
     "root": "~/.openclaw-autoclaw/agents", "skills_dir": "~/.openclaw-autoclaw/skills",
     "mcp_config": "~/.openclaw-autoclaw/openclaw.json", "mcp_format": "mcp.servers"},
    {"key": "trae-cn", "name": "Trae CN", "adapter": "trae-cn",
     "root": "~/.trae-cn", "skills_dir": "~/.trae-cn/skills",
     "mcp_config": "~/Library/Application Support/Trae CN/User/mcp.json", "mcp_format": "mcpServers"},
]


def presets():
    """给前端的已知工具预设（一键填表）。"""
    return [dict(p) for p in TOOL_PRESETS]

PALETTE = 12                     # 颜色槽位：tool-dot--p1 .. p12（1-7 归内置，8+ 给自定义）
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


ORDER_KEY = "tools.order"


def _saved_order(store):
    """展示顺序（含内置）；未列出的工具按默认顺序追加在后。"""
    try:
        raw = store.get_config(ORDER_KEY)
        return json.loads(raw) if raw else []
    except Exception:
        return []


def set_order(store, ids):
    """保存工具展示顺序 → 生效后的完整顺序列表。"""
    all_ids = [t["id"] for t in load_tools(store)]
    seen, order = set(), []
    for i in (ids or []):
        i = str(i)
        if i in all_ids and i not in seen:
            seen.add(i)
            order.append(i)
    for i in all_ids:
        if i not in seen:
            order.append(i)
    store.set_config(ORDER_KEY, json.dumps(order))
    return order


def load_tools(store):
    """合并后的工具列表：默认内置在前、自定义按登记顺序；有自定义顺序时以它为准。"""
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
            for k in ("skills_dir", "mcp_config", "mcp_format"):
                if k in s:
                    t[k] = s.get(k)
        tools.append(t)
    for t in saved:
        if t["id"] in BUILTIN_IDS:
            continue
        t = dict(t)
        t.setdefault("enabled", True)
        tools.append(t)
    _dedupe_colors(tools)
    order = _saved_order(store)
    if order:
        idx = {tid: i for i, tid in enumerate(order)}
        tools.sort(key=lambda t: idx.get(t["id"], len(idx)))
    return tools


def _dedupe_colors(tools):
    """颜色去重（原地）：内置优先占用自己的槽位，自定义工具被挪到空闲槽。

    历史自定义工具可能占着后来被内置工具用掉的槽位（如 Pi-Agent 原为 4，
    而 WorkBuddy 现在也是 4），这里统一改到 len(BUILTIN_TOOLS)+1 之后的空位。
    """
    used = {t.get("color") for t in tools if t.get("builtin")}
    nxt = len(BUILTIN_TOOLS) + 1
    for t in tools:
        if t.get("builtin"):
            continue
        c = t.get("color")
        if not c or c in used:
            while nxt in used:
                nxt += 1
            c = nxt
            t["color"] = c
        used.add(c)


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
    """自定义工具从不与内置冲突的槽位起分配（内置占用 1..len(BUILTIN_TOOLS)）。"""
    used = {t.get("color") for t in tools}
    start = len(BUILTIN_TOOLS) + 1
    for i in range(start, PALETTE + 1):
        if i not in used:
            return i
    return start


def _norm_path_opt(v):
    v = str(v or "").strip()
    return _norm_path(v) if v else None


def detect_adapter(root):
    """按路径内容识别会话格式（延迟导入：scanners 依赖本模块）。"""
    try:
        from . import scanners
        return scanners.detect_format(root)
    except Exception:
        return {"adapter": None, "reason": "error"}


def _auto_name(adapter, root, tools):
    """命名不由用户填：优先取格式的产品名，重名时补路径末段区分多实例。"""
    base = (ADAPTERS.get(adapter or "", {}).get("name")
            or os.path.basename(str(root or "").rstrip("/")) or "未识别路径")
    taken = {t["name"].strip().lower() for t in tools}
    if base.lower() not in taken:
        return base
    tail = os.path.basename(str(root or "").rstrip("/"))
    cand = ("%s · %s" % (base, tail)) if tail and tail != base else base
    if cand.lower() not in taken:
        return cand
    n = 2
    while ("%s %d" % (cand, n)).lower() in taken:
        n += 1
    return "%s %d" % (cand, n)


def add_tool(store, name=None, adapter=None, root=None, skills_dir=None, mcp_config=None,
             mcp_format=None):
    """登记一个采集路径 → (entry, warning)；校验失败抛 ValueError。

    格式与会话名都不要求用户提供：adapter 缺省时按路径内容识别，
    name 缺省时按格式产品名自动命名（重名补路径末段）。
    """
    root = _norm_path(root) if (root or "").strip() else ""
    if not root:
        raise ValueError("路径不能为空")
    tools = load_tools(store)
    det = {}
    if adapter not in ADAPTERS:
        det = detect_adapter(root)
        adapter = det.get("adapter")          # 认不出 → None：只登记，不采集
        if adapter is not None and adapter not in ADAPTERS:
            adapter = None
    name = (name or "").strip()
    if not name:
        name = _auto_name(adapter, root, tools)
    if len(name) > 60:
        raise ValueError("名称过长（≤60 字符）")
    for t in tools:
        if t["name"].strip().lower() == name.lower():
            raise ValueError("名称已存在：%s" % name)
    tid = _free_id({t["id"] for t in tools}, _slug(name))
    entry = {"id": tid, "name": name, "adapter": adapter, "root": root,
             "enabled": True, "builtin": False, "color": _pick_color(tools),
             "skills_dir": _norm_path_opt(skills_dir), "mcp_config": _norm_path_opt(mcp_config),
             "mcp_format": (mcp_format or None)}
    entries = _saved_entries(store)
    entries.append(entry)
    save_tools(store, entries)
    warning = None
    if not os.path.exists(root):
        warning = "路径当前不存在：%s（已保存，生成数据后刷新即可）" % root
    elif adapter is None:
        warning = "未识别出会话格式：该路径只作登记，不采集会话（仍可作 Skills / MCP 目标）"
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
    for k in ("skills_dir", "mcp_config"):
        if k in patch:
            patch[k] = _norm_path_opt(patch.get(k))
    # 路径变了就重新识别格式（除非调用方显式指定 adapter）
    if "root" in patch and "adapter" not in patch and not cur.get("builtin"):
        if patch.get("root") != cur.get("root"):
            patch["adapter"] = detect_adapter(patch.get("root")).get("adapter")
    if "adapter" in patch and patch.get("adapter") is not None:
        ad = str(patch["adapter"]).strip()
        if ad not in ADAPTERS:
            raise ValueError("未知的会话格式：%s" % ad)
        if cur.get("builtin") and ad != cur.get("adapter"):
            raise ValueError("内置工具的会话格式不可修改")
        patch["adapter"] = ad
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
    for k in ("name", "enabled", "adapter", "root", "skills_dir", "mcp_config", "mcp_format"):
        if k in patch and patch[k] is not None:
            ent[k] = patch[k]
        elif k in ("skills_dir", "mcp_config") and k in patch and patch[k] is None:
            ent.pop(k, None)
    save_tools(store, entries)
    return tool_by_id(store, tid)


def remove_tool(store, tid, purge=False):
    """移除自定义工具 → (tool, stats)。

    purge=False：仅断开登记（已采集数据保留）。
    purge=True ：另清除该工具已采集的会话/消息/游标（删除前自动导出备份 zip）。
    台账与迁移历史保持不动（审计）。
    """
    tools = load_tools(store)
    cur = next((t for t in tools if t["id"] == tid), None)
    if cur is None:
        raise KeyError(tid)
    if cur.get("builtin"):
        raise ValueError("内置工具不可移除（可停用）")
    stats = {"purged": False, "sessions": 0, "messages": 0, "backup": None}
    if purge:
        from .store import export_batch
        sids = [x["sid"] for x in store.list_sessions(tool=tid)]
        with store.lock:
            n_msg = store.db.execute("SELECT COUNT(*) FROM messages WHERE tool=?",
                                     (tid,)).fetchone()[0]
        stats["sessions"] = len(sids)
        stats["messages"] = int(n_msg)
        if sids:
            try:
                res = export_batch(store, sids=sids, limit=10000)
                stats["backup"] = res.get("path")
            except Exception:
                stats["backup"] = None
        with store.lock:
            store.db.execute("DELETE FROM messages WHERE tool=?", (tid,))
            store.db.execute("DELETE FROM sessions WHERE tool=?", (tid,))
            store.db.execute("DELETE FROM cursor WHERE source_key LIKE ?", (tid + ":%",))
            store.db.commit()
        stats["purged"] = True
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
    return cur, stats


def public_list(store, counts=None):
    """给 /api/state 与前端的注册表视图（含计数与路径可用性）。"""
    counts = counts or {}
    out = []
    for t in load_tools(store):
        c = counts.get(t["id"]) or {}
        root = t.get("root") or (ADAPTERS.get(t.get("adapter"), {}).get("root_hint_default") or None)
        out.append({
            "id": t["id"], "name": t["name"], "adapter": t["adapter"],
            "skills_dir": t.get("skills_dir"), "mcp_config": t.get("mcp_config"),
            "mcp_format": t.get("mcp_format"),
            "builtin": bool(t.get("builtin")),
            "enabled": bool(t.get("enabled", True)),
            "color": int(t.get("color") or 0),
            "root": root,
            "root_exists": (os.path.exists(os.path.expanduser(root)) if root else None),
            "count": c.get("count", 0),
            "latest": c.get("latest"),
            "adapter_label": ADAPTERS.get(t.get("adapter"), {}).get("label", t.get("adapter")),
            "root_hint": ADAPTERS.get(t.get("adapter"), {}).get("root_hint", ""),
        })
    return out
