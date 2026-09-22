# 测试记录 · Verification

> 最新更新：2026-09-22（v0.5.2 工具顶层化联动 · **108 项测试全绿**）。原始报告在 `tests/evidence/`。

## v0.5.1 工具注册表（2026-09-22）

- 范围：`/api/tools` CRUD（添加 / 改名 / 停用 / 删除 / 彻底删除）+ 五种格式模板 + 动态面板/筛选/定时；新适配器 Pi-Agent 与 Cursor。
- 结果：`ALL SUITES PASSED ✓` —— lint + API 46 + Skills 13 + MCP 9 + Extras 8 + E2E 无头 16 + 有头 3 + 沙箱 13 = **108 项 + lint**。
- 实机数据：Pi-Agent 38 会话 / 4989 消息、Cursor 9 composer / 637 消息 均已入库（55 会话总量）。
- 边界覆盖：空名称 / 未知格式 / 空路径 / 重名 / 路径不存在（警告不阻断）/ 内置不可删 / 移除后数据保留 / 彻底删除先备份后清除（备份 zip 落盘断言，`?purge=1`）/ 未知定时范围 400 / 停用不参与扫描。
- 顶层联动（v0.5.2）：工具集成字段自动同步 Skills / MCP 目标（origin 溯源 + 删除回收断言）；`wire-memory` 克隆 + 备份 + 幂等；预设快填与目标同步均有沙箱 E2E 覆盖。

## 测试体系（4 层 + 演练）

| 层 | 文件 | 方式 | 覆盖 |
|---|---|---|---|
| 1 样式规范 lint | `tests/lint_styles.py` | 静态检查 | 界面文件无游离色值/字号，100% 走 tokens |
| 2 API 集成测试 | `tests/test_hub.py`（35） | 沙箱服务器 + 合成数据（不触碰真实会话） | 基础流 + 边界/失败 + v0.3 搜索/导出/收藏 + v0.4 stats/记忆搜索导出/批量 zip/HTTP 动词 |
| 3 模块集成测试 | `tests/test_skills.py`（13）· `tests/test_mcp.py`（9）· `tests/test_extras.py`（8） | 真实本地 git 夹具 + 临时 Store | 源/拉取/更新/冲突/回退/分发幂等/TOML 受管块/握手验证/S3 定时拉取 |
| 4 E2E 真实浏览器 | `tests/e2e.mjs`（16 场景）· `tests/e2e_sandbox.mjs`（7） | **CDP 驱动系统 Chrome（零依赖）**，无头 + 有头双模式 | 全流程 + 五视图 + 拉取/分发向导 + 沙箱失败场景 |
| 5 端到端演练 | `scripts/drill_v04.py`（8 步） | 干净临时环境 + 隔离实例 | 注册→拉取→更新→分发×2→幂等→升级→回退→台账 |

## 结果汇总（最近一次全量，`bash tests/run_all.sh`）

| 套件 | 结果 | 备注 |
|---|---|---|
| 样式 lint | ✅ PASSED | 3 files clean |
| API 集成 | ✅ 35/35 | Ran 35 tests — OK |
| Skills 模块 | ✅ 13/13 | Ran 13 tests — OK |
| MCP 模块 | ✅ 9/9 | Ran 9 tests — OK |
| Extras（S1/S2/S3） | ✅ 8/8 | Ran 8 tests — OK |
| E2E 无头 | ✅ 16/16 | 真实 Chrome headless |
| E2E 有头冒烟 | ✅ 3/3 | 真实 GUI 窗口渲染 |
| E2E 沙箱失败场景 | ✅ 7/7 | 引擎缺失 / 100 行 25ms 渲染 / 空校验 / 长标题 / 移动端 |
| **合计** | **✅ 91 项 + lint 全绿 · console clean** | |

E2E 场景清单：page-load / screenshot-desktop / filter-codex / selection / preview-modal / refresh-one / schedule-flow / memory-flow / memory-validation-error / duplicate-migration-guard / content-search-flow / preview-actions / module-nav-views / skills-pull-and-wizard / screenshot-mobile / console-clean。

## v0.4 模块测试细则（本轮新增）

| 套件 | 覆盖 |
|---|---|
| test_skills（13） | 拉取/增量/更新/幂等/本地修改冲突/force/回退（含版本号）/双目标分发/重复跳过/目标手改冲突/未托管保护/dry-run/只读目标/坏源/差异视图 |
| test_mcp（9） | 源/注册表/JSON 目标写入（保留原条目）/幂等/未托管冲突/TOML 受管块/原生表冲突/握手验证（成功+失败）/回退 |
| test_extras（8） | S3 定时拉取（到期/间隔/禁用门控/scheduler 集成）+ S1 统计/批量 zip + S2 记忆搜索转义/导出 |
| test_hub V4（4） | /api/stats · 记忆搜索/导出（md/json/坏格式）· 批量导出 · HTTP PATCH/DELETE |

## 闭环演示记录（可复现）

1. `bash scripts/make-demo-sources.sh` → 生成 `hub-demo-src-skills` / `hub-demo-src-mcp`（本地 git 夹具）；
2. 拉取：skills added `[code-review, commit-convention]`，mcp added `[demo-time, demo-http]`；
3. 更新到本地库 → 分发到 `hub-demo-target-a/b` 两个项目仓库：8 条 `ok` 落盘（抽查 SKILL.md、mcpServers.demo-time）；
4. 重复分发 → 8/8 `skipped`（幂等）；台账 26+ 条可筛选/导出；
5. **干净环境演练**：`python3 scripts/drill_v04.py` 8/8（含升级 v2 → 回退内容+版本号 → 回退后重新分发）；
6. **S3 真机**：poll_min=1 时 09:17:16 / 09:18:17 两轮 `auto-pull` 入台账（幂等 added 0），关闭后停止。

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
| 15 | **回退后版本号未回填**（内容回 v1 但 version 仍 v2；skills+mcp 双模块同病，干净环境演练发现） | rollback 采用 prev_* 交换语义（版本号随内容回退，可再切回）；test_skills 预置断言回归 |
| 16 | **HTTP 层缺 DELETE/PATCH/PUT**（UI「移除源」与 poll_min 更新实际 501，真机演示发现） | Handler 补齐三动词（仅模块/控制面路由生效）；非 POST 动词不得落入旧 POST 路由（404 兜底）；动词回归用例 |

## 数据写入核验（抽查）

```bash
# 会话与消息
sqlite3 ~/.agent/hub/hub.db "SELECT tool, COUNT(*) FROM sessions GROUP BY tool;"
# lineage 勾连（源与副本双向可查）
sqlite3 ~/.agent/hub/hub.db "SELECT lid, src_tool, dst_tool, status FROM migrations;"
# v0.4 台账（按模块/状态筛选）
sqlite3 ~/.agent/hub/hub.db "SELECT module, action, status, COUNT(*) FROM ops GROUP BY module, action, status;"
# v0.4 本地库 / 部署
sqlite3 ~/.agent/hub/hub.db "SELECT name, version, substr(hash,1,8) FROM registry_items;"
sqlite3 ~/.agent/hub/hub.db "SELECT item_name, target_id, status, substr(deployed_hash,1,8) FROM deployments;"
# agentmemory（healthy）
curl -s http://127.0.0.1:3111/agentmemory/health | head -c 120
```

## 你回来后的手工验收清单

1. `./run.sh --open` → 控制台加载无空白；引擎徽章"已连接"；
2. 顶部导航走查五个一级模块：会话 / 记忆（搜索+导出） / **Skills**（拉取→勾选→更新→分发向导→验证） / **MCP**（同构 + 连接验证按钮） / **台账**（筛选+导出）；
3. Skills 页：拉取 demo-skills 源 → 勾选一个条目 → 分发向导选目标（含两个 demo 项目仓库）→ dry-run → 确认写入 → 目标目录出现文件；
4. 对源卡片改「定时拉取（分钟）」> 0 → 等待调度器轮次 → 台账出现 `auto-pull`；
5. 会话页「统计」按钮 → 面板 + 「批量导出全部（zip）」；
6. 记忆页搜索关键词 → 命中片段；「导出 MD/JSON」直接下载；
7. `python3 scripts/drill_v04.py` 一键复现完整闭环（8/8）；
8. `bash tests/run_all.sh` → 六套件全绿（108 项）。
9. 工具注册表：会话页「＋ 添加工具」→ 选模板（如 Pi-Agent / Cursor）→ 刷新即采集；卡片「设置」中可停用/移除（已采集数据保留）。
