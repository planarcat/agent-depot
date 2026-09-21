# Agent Session Hub

本地优先的 AI 编码会话枢纽：把 Claude Code / Codex / OpenCode 等工具的会话统一到一个公共目录（`~/.agent/hub/`），提供浏览、增量采集、定时刷新与跨工具迁移。

**零第三方依赖**：Python 3.9+ 标准库运行。迁移引擎调用 [casr](https://github.com/Dicklesworthstone/cross_agent_session_resumer)（未安装时优雅降级为只读浏览）。

## 快速开始

```bash
./run.sh          # 后台启动（pid + 日志在仓库内）
./run.sh --open   # 启动并打开界面
./stop.sh         # 停止
# 或前台运行：./run.sh --fg    /    python3 server.py
```

## 功能（MVP）

- **统一浏览**：所有工具的会话一个列表，按工具 / 关键词过滤
- **增量采集**：JSONL 工具按字节 offset 增量读取；OpenCode（SQLite 只读）按更新时间增量
- **定时刷新**：应用内调度器，按工具开关与间隔，配置持久化
- **会话预览**：对话流只读预览（深度 diff / 用量统计推荐 CCHV）
- **跨工具迁移**：调用 casr 转换会话到目标工具原生格式（需安装 casr）
- **台账**：每次刷新 / 迁移记录在 ledger 表，可审计、可回溯

## 数据源（已适配）

| 工具 | 位置 | 方式 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | tail 增量 |
| Codex CLI | `~/.codex/sessions/**/*.jsonl`（CODEX_HOME 可重定向） | tail 增量 |
| OpenCode | `~/.local/share/opencode/opencode.db`（SQLite 只读） | 更新时间游标 |

## 架构

```
agent-session-hub/
├── server.py        # HTTP 服务 + API + 调度器
├── hub/
│   ├── store.py     # SQLite（~/.agent/hub/hub.db）：会话/消息/台账/游标/配置
│   ├── scanners.py  # 三家采集适配器（增量、内容哈希去重）
│   └── migrator.py  # casr 封装
└── web/index.html   # 控制台界面（原生 JS，无构建）
```

## 设计约定

- **只读采集**：从不修改源工具的会话文件；OpenCode 数据库以只读 URI 打开
- **内容哈希去重**：同会话内相同 role+content 的消息只入一次库
- **追加式台账**：所有操作可审计；ledger 是未来增量勾连（lineage/水位）的底座
- **迁移 = 新副本**：经 casr 迁移在目标工具生成新会话，绝不覆盖原生会话文件

## Roadmap

- [ ] lineage 编号 + ledger 导出映射（跨工具增量勾连）
- [ ] 导出水印与循环检测（A→B→A 增量回流）
- [ ] Tauri 桌面壳
- [ ] 记忆区接入 agentmemory

## 相关

casr · session-migrate · claude-code-history-viewer (CCHV) · agentmemory
