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
| **Skills** | 远程 Git 源 → 拉取/快照 → 本地库（版本/冲突/回退）→ 分发到各目标；也支持本地手动编写与目录导入 |
| **MCP** | 同构管线 + JSON/TOML 配置写入 + MCP 协议握手验证；支持手动创建 server 条目 |
| 台账 | 统一 ops 流水，按模块/状态筛选，CSV/JSON 导出 |

模块注册表驱动（`/api/modules`），可独立启停；模块间零隐式依赖。

## 功能

- **统一浏览**：所有工具会话一个列表，筛选 / 搜索 / 预览（含 lineage 链）
- **全文搜索（v0.3）**：搜消息内容（不止标题），命中片段高亮展示，点击直达会话
- **导出 Markdown（v0.3）**：任意会话一键导出为可读文档（`~/.agent/hub/exports/`）
- **收藏（v0.3）**：会话星标 + 「★ 收藏」筛选；预览页可复制 resume 命令一键续跑
- **增量采集**：JSONL 按字节 offset tail；OpenCode SQLite 只读；内容哈希去重、重扫幂等
- **定时刷新**：范围随工具注册表动态（全部 + 各启用工具）× 开关 × 间隔编辑，配置持久化，执行入台账
- **即时刷新（v1.0，SSE）**：后端 `hub/watcher.py` 用**内核文件事件**盯住每个工具根与各工具记忆路径（macOS/BSD 走 **kqueue**（stdlib）；装了 `watchdog` 则用它的递归事件；都没有时退化为 manifest 清单比对），事件合并抖动后经 **`GET /api/events`（SSE）** 推给前端，前端只刷新受影响的那一块（会话 / 记忆 / Skills / MCP / 台账）。**自己写盘立刻广播**（POST/PATCH/DELETE 收口 `bump()`，不等 watcher）；溢出 / 断档 / 路径被换掉 → `full=true` 全量重取。`GET /api/watch` 看状态（backend / rev / fds / degraded），`HUB_WATCH=0` 可关。前端 SSE 断开时自动退回自适应轮询（可见 3s / 后台 60s），不再是固定 30s 轮询
- **跨工具迁移**：拖拽 / 点选 → casr 原生格式写回（原子 + 读回验证），迁移副本自动采集回 hub
- **工具注册表（v0.5.1 / v0.8）**：登记采集工具时**只填一条会话路径**——格式与会话名由 hub 按路径内容自动识别（内容嗅探：JSONL 键 / SQLite 表名 / 加密库头；认不出就只作 Skills / MCP 目标，不采集）；预设（claude-code / codex / opencode / pi-agent / cursor / workbuddy / zcode / autoclaw / trae-cn）只负责快速填入路径。可停用 / 删除（默认断开登记保留数据，可勾选彻底清除已采集数据并自动备份）；面板、筛选、定时、刷新全动态。**工具的改 / 删统一在「设置 → 工具」行内面板；界面不提供添加工具（2026-10-16 起），会话页只保留采集与迁移入口**（详见 DESIGN.md §9）
- **工具 = 顶层实体（v0.5.2）**：登记工具时填写 Skills 目录 / MCP 配置，自动同步为对应模块的分发目标（删除工具自动回收）；工具「设置」可一键把记忆总线（agentmemory）接入该工具（先自动备份）；记忆页展示各工具总线接入状态
- **手动条目（v0.6）**：Skills 手动新建（SKILL.md 模板）/ 从本地目录导入；MCP 手动创建 server 配置（表单或 JSON）；与拉取条目同权（分发/验证/回退/台账）；删除保护（有部署先拒，确认后连同目标清理）
- **会话视图重构（v0.8）**：顶部 工具卡片网格（点卡片进入工具视图 → 左侧工具侧边栏）＋ 会话列表**手风琴**（行内展开消息流 / 收藏 / 复制 resume / 导出 MD；展开或勾选时右侧**滑出「迁移目标」面板**：目标单选 + 最近 lineage）；卡片悬停只有「刷新采集 / 迁移到此」——**编辑工具一律在 设置 → 工具**；动效统一 150/250/300ms + 弹性曲线、三级阴影；记忆 / Skills / MCP 仍为三栏布局
- **设置中心（v0.9，对齐 Figma 稿）**：960×680 窗口 + 两行左导航（模块 / 工具 / 定时调度 / 关于，底部版本号）+ 右上 × 关闭；工具行 = 色块 / 名称(内置徽章) / 编辑 / 启停（拖动排序与箭头微调已按注解移除，后端 `POST /api/tools/reorder` 保留）；工具编辑即工具弹窗（色块 + 名称 + 「格式随路径自动识别」+ 启用采集卡片含记忆总线状态）
- **三栏新布局（v0.6）**（记忆 / Skills / MCP）：左＝来源（折叠）+ 条目分页；中＝概览统计 + 内容详情 + 增删改查（仅本地）+ 多选批量；右＝工具状态 + 内联更新（单条/批量/一键/全部，更新类操作零弹窗），选中联动显示逐工具版本差异
- **lineage 勾连**：每条会话唯一编号 `lx-NNNN`，源与副本双向可查；重复迁移自动拦截；支持「同步更新」生成修订副本
- **记忆区**：`~/.agent/hub/memory/` 每日 Markdown 日志 + 数据库双写
- **台账**：所有操作可审计（`ledger` 表）

## 测试（精确测试体系 · 3 层）

```bash
bash tests/run_all.sh        # 全量 6 套件：lint + API 46 + Skills 25 + MCP 9 + Manual 4 + Extras 11 + Watcher 10 + E2E 17 + 有头 3 + 沙箱 14
python3 scripts/drill_v04.py # 干净环境端到端演练（源→拉取→分发→回退→台账，8 步）
python3 tests/lint_styles.py # 样式规范 lint（游离色值/字号检查）
python3 tests/test_hub.py    # API 集成（沙箱，不触碰真实会话）
node tests/e2e.mjs           # E2E：CDP 驱动真实 Chrome（零依赖），--headed 有头模式
python3 tests/test_watcher.py # 文件监控 → SSE：scope 映射 / 抖动合并 / 溢出降级 / manifest 兜底
```

证据输出：`tests/evidence/`（E2E 报告 + 桌面/移动端截图）。

## 设计系统

`web/tokens.css`（token 唯一出处）+ `web/hub-ui.{js,css}`（统一反馈组件）+ 规范文档 [DESIGN.md](DESIGN.md)。风格：Müller-Brockmann 网格功能主义。界面禁止游离色值/字号（lint 强制）。

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
├── DESIGN.md           # 设计规范（视觉唯一真源，改界面前必读）
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
- [x] 工具注册表（v0.5.1）：Pi-Agent / Cursor 首批接入，可添加 / 停用 / 移除
- [x] 工具顶层化联动（v0.5.2）：Skills / MCP 目标自动同步 + 记忆总线状态与一键接入

## 相关

casr · session-migrate · claude-code-history-viewer (CCHV) · agentmemory
