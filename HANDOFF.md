# Agent Session Hub · 交接说明

> 2026-09-21 · v0.2.0 · 本文件是你回来后的第一落点：**怎么跑、干了什么、怎么验收、什么没干及为什么**。

## 30 秒验收

```bash
cd ~/Documents/Projects/@planarcat/agent-session-hub
./run.sh --open          # 启动服务并打开控制台（或双击 ~/Applications/AgentSessionHub.app）
bash tests/run_all.sh    # 全量测试：lint + API 集成 + E2E 无头 + E2E 有头冒烟
```

## 功能清单（全部已实现并自测通过）

| # | 功能 | 说明 | 验证 |
|---|---|---|---|
| 1 | 三家增量采集 | Claude Code / Codex（JSONL tail）+ OpenCode（SQLite 只读） | 单测 + E2E |
| 2 | 统一浏览 + 搜索 + 过滤 | 工具卡 / 分段过滤 / 搜索 | E2E filter-codex |
| 3 | 会话预览 | 消息流 + lineage 链 + 工具标色 | E2E preview-modal |
| 4 | 手动刷新 | 单工具 + 全部 | E2E refresh-one |
| 5 | 定时刷新 | 4 个范围（全部+3 工具）× 开关 × 间隔编辑（5/10/15/30/60/180 分钟） | E2E schedule-flow |
| 6 | 跨工具迁移 | 拖拽/点选 → casr 原生写回（原子+读回验证） | E2E + 实机迁移 |
| 7 | **lineage 勾连** | lx-NNNN 编号；源与副本双向可查；迁移链展示 | E2E + 数据核验 |
| 8 | **迁移去重守卫** | 重复迁移拦截 + 自上次迁移后新增 N 条的**同步更新**（修订副本） | E2E duplicate-migration-guard |
| 9 | **记忆区** | hub.db + `~/.agent/hub/memory/` 每日 Markdown 日志双写；增删查 | E2E memory-flow |
| 10 | 台账 | 每次刷新/迁移/配置变更入 ledger，可审计 | 数据核验 |
| 11 | 桌面壳 | `~/Applications/AgentSessionHub.app` 双击即开独立窗口 | 启动器实测 |
| 12 | 设计系统 | tokens + HubUI 组件 + STYLE_GUIDE + lint 强制 | lint + 视觉走查 |

## 延后项落实情况（本次全部处理）

| 原延后项 | 结果 |
|---|---|
| lineage 编号 + ledger 导出映射 | ✅ 完成（含迁移去重、同步基线、`/api/sync/preview`） |
| 导出水印 + 循环检测 | ✅ 按保守默认落地：**不写入原生会话文件**（任何工具目录），以「去重守卫 + 消息数基线 + 修订副本"同步更新"」实现等价目标；原因：原生追加写的格式风险远大于收益（casr 官方也仅做整会话转换），详见决策记录 |
| Tauri 桌面壳 | ⭕ 替代为**零依赖 macOS .app 壳**（双击即开，功能等价）。原因：Rust 工具链 + 数百 MB 依赖 + 本机对 GitHub 大文件下载极慢（23MB 实测 150s 超时）；`scripts/make-app.sh` 一键重建。可复议 |
| 记忆区接入 agentmemory | 🔄 agentmemory 已通过镜像全局安装并 init（`~/.agentmemory/`），引擎（iii-engine）正在后台自动安装；完成后执行 `agentmemory connect --all` 即完成接线。hub 侧记忆区（db + journal）已独立可用 |
| 定时间隔编辑 UI | ✅ 完成 |
| 全工具批量开关 | ✅ 完成（"全部工具"范围） |
| OpenCode 迁移目标实测 | ✅ 完成（opencode→claude、opencode→codex 真实链路均跑通） |
| 会话预览改进 | ✅ 完成（截断放宽、lineage 链、assistant/tool 区分样式） |
| 超长会话压测 | ⏸ 搁置（现有数据量小，未构造数万行会话；风险低，机制上为流式逐行处理） |

## 设计系统（UI 库选型与样式规范）

- **选型决策**：默认 npm 源不可达（npmmirror 可用但仅用于 agentmemory 安装）。为保证**零依赖、离线可用**，自建轻量设计系统：`web/tokens.css`（全部字号/字色/间距/圆角/状态色）+ `web/hub-ui.js|css`（Toast/Modal/Button/Input/Badge/Empty 组件）+ `docs/STYLE_GUIDE.md`（规范文档）；`tests/lint_styles.py` **强制**：界面文件不允许出现游离十六进制色值与 px 字号（CI 化，全量套件第一步）。
- 风格：Müller-Brockmann 网格功能主义——8pt 基线、双色方案（墨色系 + 深青绿 `#0d6a63` 单强调）、7 档字号阶梯。
- 反馈统一：成功/失败/警告/信息 4 类 toast、危险操作模态确认、按钮 loading 态、空态组件——同类场景全局一致，E2E 逐项验证。

## 数据存储（可核验）

| 存储 | 位置 | 内容 |
|---|---|---|
| 主库 | `~/.agent/hub/hub.db` | sessions / messages / lineages / migrations / memories / cursor / ledger / config |
| 记忆日志 | `~/.agent/hub/memory/YYYY-MM-DD.md` | 追加式人类可读日志 |
| 证据 | `tests/evidence/` | E2E 报告 JSON + 截图 PNG |

抽查方法：`sqlite3 ~/.agent/hub/hub.db "SELECT * FROM migrations ORDER BY id DESC LIMIT 5;"`

## 搁置清单（保守未执行的操作）

| # | 事项 | 原因 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | 测试期间在真实工具目录生成的会话副本（`~/.codex/sessions/2026/09/21/` 下 4 个 rollout、`~/.claude/projects/` 下 1 个副本 75a2f5a5） | 删除文件需你确认 | 各工具 resume 列表可见这些副本 | 验收后可删（或留着当样例） |
| 2 | `~/.agent/hub/memory/` 下 10 个旧实现产生的单条记忆 md 文件 | 同上 | 无功能影响 | 确认后可清 |
| 3 | CCHV 桌面版 DMG（`~/Downloads/…universal.dmg`，9MB/23MB 未完成） | GitHub 下载极慢 | 深度查看器不可用（非 hub 依赖） | 网络好时续传 |
| 4 | agentmemory `connect --all`（若引擎安装未完成） | 引擎后台安装中 | 记忆总线暂未接线 | 见下方命令 |

## agentmemory 收尾命令（引擎安装完成后执行一次）

```bash
agentmemory status              # 确认 Running
agentmemory connect --all       # 接线所有已安装工具（claude-code/codex/opencode 等）
agentmemory status              # 目视各工具 connected ✓
```

## 下一步建议

1. 用一周：真实迁移几条会话，观察 resume 体验与记忆区；
2. 如需要：`agentmemory remove --keep-data`/重连可逆；
3. 长期：修订副本→真增量（需先解决原生追加写的格式风险，建议先给 casr 上游提需求）。

## 决策记录（执行期间无反馈，按保守默认推进）

1. **迁移=新副本、绝不写入原生会话文件**——最保守且与 casr 官方语义一致（官方明确"not a live sync"）；
2. **去重守卫默认开启**——防手滑产生重复副本；需要时「同步更新」显式生成修订版；
3. **UI 库自建**（见上）；4. **桌面壳用 .app**（见上）；5. **记忆日志 append-only 按日**——避免"删除记忆=删文件"的权限敏感操作。
