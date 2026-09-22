# Agent Depot

> v0.5.0 起更名：**Agent Depot**（原 Agent Session Hub）—— 已不止是会话记录工具。

本地优先的 AI Agent 资产枢纽：**会话 · 记忆 · Skills · MCP · 台账** 五个一级模块一站管理。统一采集 Claude Code / Codex / OpenCode 等工具的会话（浏览、增量、定时刷新、跨工具迁移、lineage 勾连）到 `~/.agent/hub/`；Skills 与 MCP 支持从远程 Git 源拉取、版本管理与分发到各工具与项目仓库。

**零第三方依赖**：Python 3.9+ 标准库运行。迁移引擎调用 [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer)（未安装时优雅降级为只读浏览）。

## 快速开始

```bash
./run.sh          # 后台启动（pid + 日志在仓库内）
./run.sh --open   # 启动并打开控制台
./stop.sh         # 停止
# 或双击 ~/Applications/AgentDepot.app（脚本：scripts/make-app.sh 重建）
```

控制台：<http://127.0.0.1:8317>

## 一级模块（v0.4）

| 模块 | 说明 |
|---|---|
| 会话 | 多工具会话采集 / 浏览 / 迁移（lineage 勾连） |
| 记忆 | hub.db + 每日 Markdown 日志 |
| **Skills** | 远程 Git 源 → 拉取/快照 → 本地库（版本/冲突/回退）→ 分发到各目标 |
| **MCP** | 同构管线 + JSON/TOML 配置写入 + MCP 协议握手验证 |
| 台账 | 统一 ops 流水，按模块/状态筛选，CSV/JSON 导出 |

模块注册表驱动（`/api/modules`），可独立启停；模块间零隐式依赖。

## 功能

- **统一浏览**：所有工具会话一个列表，筛选 / 搜索 / 预览（含 lineage 链）
- **全文搜索（v0.3）**：搜消息内容（不止标题），命中片段高亮展示，点击直达会话
- **导出 Markdown（v0.3）**：任意会话一键导出为可读文档（`~/.agent/hub/exports/`）
- **收藏（v0.3）**：会话星标 + 「★ 收藏」筛选；预览页可复制 resume 命令一键续跑
- **增量采集**：JSONL 按字节 offset tail；OpenCode SQLite 只读；内容哈希去重、重扫幂等
- **定时刷新**：4 个范围（全部 + 3 工具）× 开关 × 间隔编辑，配置持久化，执行入台账
- **跨工具迁移**：拖拽 / 点选 → casr 原生格式写回（原子 + 读回验证），迁移副本自动采集回 hub
- **lineage 勾连**：每条会话唯一编号 `lx-NNNN`，源与副本双向可查；重复迁移自动拦截；支持「同步更新」生成修订副本
- **记忆区**：`~/.agent/hub/memory/` 每日 Markdown 日志 + 数据库双写
- **台账**：所有操作可审计（`ledger` 表）

## 测试（精确测试体系 · 3 层）

```bash
bash tests/run_all.sh        # 全量 6 套件 / 91 项：lint + API 35 + Skills 13 + MCP 9 + Extras 8 + E2E 16 + 有头 3 + 沙箱 7
python3 scripts/drill_v04.py # 干净环境端到端演练（源→拉取→分发→回退→台账，8 步）
python3 tests/lint_styles.py # 样式规范 lint（游离色值/字号检查）
python3 tests/test_hub.py    # API 集成（沙箱，不触碰真实会话）
node tests/e2e.mjs           # E2E：CDP 驱动真实 Chrome（零依赖），--headed 有头模式
```

证据输出：`tests/evidence/`（E2E 报告 + 桌面/移动端截图）。

## 设计系统

`web/tokens.css`（token 唯一出处）+ `web/hub-ui.{js,css}`（统一反馈组件）+ 规范文档 [docs/STYLE_GUIDE.md](docs/STYLE_GUIDE.md)。风格：Müller-Brockmann 网格功能主义。界面禁止游离色值/字号（lint 强制）。

## 架构

```
agent-depot/
├── server.py           # HTTP 服务 + API + 调度器
├── hub/
│   ├── store.py        # SQLite：会话/消息/lineage/迁移/记忆/台账/游标/配置
│   ├── scanners.py     # 三家采集适配器（增量、去重、噪声过滤）
│   └── migrator.py     # casr 封装 + 迁移守卫 + 同步基线
├── web/                # tokens.css / hub-ui / app.css / app.js / index.html
├── tests/              # lint + unittest + CDP E2E + run_all.sh + evidence/
├── desktop/            # Tauri 桌面壳工程（原生窗口；构建说明见 desktop/README.md）
├── scripts/            # make-app.sh（Tauri 构建/安装）· make-thin-app.sh（薄壳回退）
├── docs/STYLE_GUIDE.md # 样式规范
├── HANDOFF.md          # 交接说明（先读这个）
└── VERIFICATION.md     # 测试记录
```

## 设计约定

- **只读采集**：从不修改源工具的会话文件；OpenCode 数据库只读打开
- **迁移 = 新副本**：经 casr 在目标工具生成新会话，绝不覆盖原生会话文件
- **去重守卫**：同一 (会话, 目标) 重复迁移默认拦截；「同步更新」显式生成修订副本
- **追加式台账**：`ledger` 可审计可回溯

## Roadmap

- [x] lineage 编号 + 迁移守卫 + 同步基线
- [x] 定时调度增强（间隔编辑 / 批量 / 执行记录）
- [x] 记忆区（db + 每日 Markdown 日志）
- [x] macOS 桌面壳（Tauri 原生窗口；`desktop/` 工程，`bash scripts/make-app.sh` 重建；零依赖薄壳保留为回退）
- [ ] 真·增量回流（需先解决原生会话文件的追加写风险；建议向 casr 上游提需求）
- [x] 与 agentmemory 接线（三工具 MCP 已连接，viewer :3113）

## 相关

casr · session-migrate · claude-code-history-viewer (CCHV) · agentmemory
