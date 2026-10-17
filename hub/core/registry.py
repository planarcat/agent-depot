"""模块注册表：四个一级模块的声明、路由归属、启停控制。

边界约定：
- 每个模块拥有独立路由前缀（见 MODULE_ROUTES）；
- 模块间禁止互相 import（依赖只允许向下：modules -> lib/core -> store）；
- 启停开关存 config 表：modules.enabled.<id>（缺省 True）。
"""
MODULE_IDS = ("sessions", "memory", "skills", "mcp")

MODULES = {
    "sessions": {
        "id": "sessions",
        "name": "会话",
        "desc": "多工具会话采集 / 浏览 / 迁移",
        # 路由归属（legacy 路由由 server.py 承载，归属声明用于诊断与 UI 元数据）
        "routes": ["/api/state", "/api/sessions", "/api/session", "/api/refresh",
                   "/api/migrate", "/api/sync/preview", "/api/lineage", "/api/search",
                   "/api/export", "/api/export/batch", "/api/stats"],
        "nav": {"key": "sessions", "label": "会话", "order": 1},
    },
    "memory": {
        "id": "memory",
        "name": "记忆",
        "desc": "记忆分发线（工具记忆 ↔ hub 中间体）+ 长期笔记",
        "routes": ["/api/memory/", "/api/memories"],
        "nav": {"key": "memory", "label": "记忆", "order": 2},
    },
    "skills": {
        "id": "skills",
        "name": "Skills",
        "desc": "技能源拉取 / 本地库 / 分发到各目标",
        "routes": ["/api/skills/"],
        "nav": {"key": "skills", "label": "Skills", "order": 3},
    },
    "mcp": {
        "id": "mcp",
        "name": "MCP",
        "desc": "MCP 配置源拉取 / 本地库 / 分发与连接验证",
        "routes": ["/api/mcp/"],
        "nav": {"key": "mcp", "label": "MCP", "order": 4},
    },
}


def enabled(store, module_id):
    """模块是否启用（config 表，缺省全开）。"""
    v = store.get_config("modules.enabled.%s" % module_id)
    if v is None:
        return True
    return str(v).lower() not in ("0", "false", "off", "no")


def set_enabled(store, module_id, on):
    store.set_config("modules.enabled.%s" % module_id, "1" if on else "0")
    store.log("config", {"module": module_id, "enabled": bool(on)})


def module_of_path(path):
    """按路径找归属模块（用于 ops 归属与诊断）。"""
    for mid, m in MODULES.items():
        for r in m["routes"]:
            if path == r or path.startswith(r):
                return mid
    return None


def snapshot(store):
    """供 /api/modules 与 UI 导航使用。"""
    out = []
    for mid in MODULE_IDS:
        m = MODULES[mid]
        out.append({
            "id": mid, "name": m["name"], "desc": m["desc"],
            "enabled": enabled(store, mid),
            "nav": m["nav"],
        })
    return out
