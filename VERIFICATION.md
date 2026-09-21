# 测试记录 · Verification

> 2026-09-21 无人值守开发轮次的自测证据。原始报告在 `tests/evidence/`。

## 测试体系（3 层）

| 层 | 文件 | 方式 | 覆盖 |
|---|---|---|---|
| 1 样式规范 lint | `tests/lint_styles.py` | 静态检查 | 界面文件无游离色值/字号，规范 100% 走 tokens |
| 2 API 集成测试 | `tests/test_hub.py` | 沙箱服务器 + 合成数据（不触碰真实会话） | 基础流 + **边界/失败**：损坏 JSON、空文件、文件收缩重写、200KB 大消息、Unicode/emoji、codex 工具事件、无 session_meta、无换行半行、0 消息会话、失败迁移不拦截、并发刷新 409、非法间隔、未知调度键、SQL 注入惰性、调度 tick 直测、重启持久化 |
| 3 E2E 真实浏览器 | `tests/e2e.mjs` | **CDP 驱动系统 Chrome（零依赖）**，无头 + 有头双模式 | 页面加载/筛选/选择/预览/刷新/调度/记忆/错误态/重复迁移守卫/移动端 390px |
| 4 E2E 沙箱失败场景 | `tests/e2e_sandbox.mjs` | 隔离沙箱 + 100 行预置 + 剥离 casr | 引擎缺失错误反馈、100 行渲染性能（25ms）、空校验、长标题省略、移动端空态 |

## 结果汇总（最近一次全量，`bash tests/run_all.sh`）

| 套件 | 结果 | 备注 |
|---|---|---|
| 样式 lint | ✅ PASSED | 3 files clean |
| API 集成 | ✅ 11/11 | Ran 11 tests — OK |
| E2E 无头 | ✅ 12/12 | Chrome 153 headless |
| E2E 有头冒烟 | ✅ 3/3 | 真实 GUI 窗口渲染 |
| E2E 沙箱失败场景 | ✅ 7/7 | 引擎缺失错误反馈 / 100 行 25ms 渲染 / 空校验 / 长标题 / 移动端 |
| console 干净 | ✅ | 无未处理异常 |

E2E 场景清单：page-load / screenshot-desktop / filter-codex / selection / preview-modal / refresh-one / schedule-flow / memory-flow / memory-validation-error / duplicate-migration-guard / screenshot-mobile / console-clean。

## 修复记录（开发过程中发现并修复）

| # | 问题 | 修复 |
|---|---|---|
| 1 | SQLite 跨线程 `cannot commit` | 共享连接 check_same_thread=False + 全方法 RLock + WAL；6 线程压测通过 |
| 2 | casr 产物末行无换行被 tail 逻辑永久扣住 | 仅当文件不以 `\n` 结尾才扣末行 |
| 3 | 标题取到环境上下文注入 | 噪声正则过滤后再取首条真实用户文本 |
| 4 | casr 用户消息走 event_msg 未被识别 | 增加 event_msg fallback 解析 |
| 5 | lineage 重复创建（同会话两次返回不同编号） | 查询顺序：origin → src → dst 三级查找 |
| 6 | E2E selection 场景残留勾选导致误迁移 | 测试脚本修正（全量清空选择 + 前置清理） |
| 7 | 移动端标题被 badge 挤成 1 字符 / 筛选按钮换行 | 响应式收紧：小屏隐藏 meta 列、按钮 nowrap、流式滚动 |
| 8 | toast 图标与文案 `✓` 重复 | 语料清理（图标由组件统一渲染） |
| 9 | 双弹层时序竞争（取消点击落空） | E2E 按弹层文本精确点击 + 等待关闭断言 |
| 10 | 记忆删除后 md 残留 | 记忆日志改为 append-only 按日 journal（删除=仅删 db 行） |
| 11 | **静态文件路径穿越漏洞**（/assets/../server.py 可读源码） | 子树白名单 + realpath 前缀校验；5 种穿越变体全部 403，回归测试固化 |
| 12 | **非法输入打崩 handler**（interval_min="abc" → 500/连接中断） | 统一异常处理 → 400 JSON；E2E 覆盖 |
| 13 | **GET /api/sessions 端点缺失**（E2E 注入测试发现） | 补齐列表查询 API（tool/q 参数，参数化查询） |
| 14 | XSS 注入面（恶意标题/时间戳经 innerHTML） | 全部服务器派生字符串 esc() 转义；恶意内容以纯文本存储展示 |

## 数据写入核验（抽查）

```bash
# 会话与消息（8 会话 / 49 条消息）
sqlite3 ~/.agent/hub/hub.db "SELECT tool, COUNT(*) FROM sessions GROUP BY tool;"
# lineage 勾连（源与副本双向可查）
sqlite3 ~/.agent/hub/hub.db "SELECT lid, src_tool, dst_tool, status FROM migrations;"
# 台账（80+ 条）
sqlite3 ~/.agent/hub/hub.db "SELECT action, COUNT(*) FROM ledger GROUP BY action;"
# agentmemory（healthy + demo 数据）
agentmemory status | head -12
curl -s http://127.0.0.1:3111/agentmemory/health | head -c 120
# 接线核验
python3 -c "import json; print(json.load(open('/Users/planarcat/.claude.json'))['mcpServers']['agentmemory']['args'])"
grep -A2 mcp_servers.agentmemory ~/.codex/config.toml
```

## 你回来后的手工验收清单

1. `./run.sh --open` → 控制台加载无空白；引擎徽章"已连接"；
2. 点任意带 `[hub:lx-…]` 徽章的会话 → 预览顶部显示 lineage 链；
3. 勾选一条未迁移会话 → 点右侧目标卡片 → 确认迁移 → toast 成功 → 目标工具列表出现新会话（带同编号徽章）；
4. 对已迁移会话重复操作 → 出现"检测到已迁移过的会话"弹层（增量信息 + 同步更新选项）；
5. 定时任务 → 启用某个范围 → 保存 → 状态栏计数变化；等待或改间隔观察 ledger 出现 `refresh:scheduled`；
6. 记忆标签页 → 新增一条记忆 → `~/.agent/hub/memory/<今天>.md` 出现对应条目；删除后 db 消失（journal 保留为历史）；
7. 双击 `~/Applications/AgentSessionHub.app` → 独立窗口打开控制台。
