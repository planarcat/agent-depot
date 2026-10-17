# 测试记录 · Verification

> 最新更新：2026-10-17（质量卡口落地 + 变异门禁 + lint 基线；既有 11 条判据漂移已修绿）。原始报告在 `tests/evidence/`。

## 修复既有 11 条失败 + 补断言提变异得分（2026-10-17）

开工时 `bash tests/check.sh` 有 11 条红（`test_hub` 4 · `test_skills` 6 · `test_manual_mcp` 1），全部归属开工前已存在的判据漂移。逐条定性后：**3 处是口径变了、1 处是生产 bug、1 处是测试环境不再隔离**。

| 现象 | 定性 | 处理 |
|---|---|---|
| `adapters` 9 ≠ 实际 10 | 口径：新增「共享技能目录」`agents` 适配器 | 改判据：10，并断言 `agents` 存在 |
| 空名称登记工具应 400，现为 200 | 口径：名称/格式改为自动（`_auto_name`、`detect_adapter`） | 改判据：空名称→自动命名且不重名；未知 adapter→按路径识别；仍钉住「空路径 400」「重名 400」 |
| 拉取后 `update_registry` 返回 `unchanged` | 口径：**拉取即落库**（`pull_source` 自动物化 added/changed） | 改判据：直接断言已落库 + `unchanged` 幂等；新增 `materialized` 断言 |
| `delete_source` 只转手动 1 条，现 2 条 | 同上口径：两条都已落库 | 改判据：全部落库条目都转手动 / 都清除 |
| 分发后立刻被判定 `stale` | **生产 bug**：`_dep_stale` 拿注册表原始配置（带内嵌 `name`）比目标文件值（不带）→ 永远 stale | 修代码：改用已有的 `_reg_cfg()`（去内嵌 name），与 `tool_items` 口径一致 |
| 内容搜索搜不到夹具会话 | **测试环境失效**：`workbuddy/zcode/autoclaw` 的 `BUILTIN_TOOLS` 自带 `root: ~/...`，改 env 无效 → 测试扫真实会话（真实数据把夹具挤出 top 40） | 修测试：沙箱 `HOME` 改到临时目录，所有 `~/...` 路径（含未来新增工具）自动隔离 |

副作用：`test_hub` 从 8.4s → **1.5s**（不再扫真实用户数据，也顺带消除了隐私与不稳定因素）。

### 补断言：`hub/lib/mcpverify.py` 变异得分 31.61% → **100.00%**

新增 12 条直接判据（`McpVerifyUnit`）：握手字段（protocol/version/tool_count/env_keys）、命令不存在、无有效响应（含「空 stderr 不得拼出冒号」）、stderr 按 400 字节截断、`args` 类型错、服务端立即退出、`tools/list` 无响应（`tool_count=None`）、默认超时（12s / 8s，用签名钉住）、http JSON / SSE / 纯文本 / 非法 UTF-8 / 不可达、`headers` 透传（缺头 403 端点）、分发三条键。
夹具 `fake_mcp_server.py` 同步升级为「真服务端那样校验客户端」：协议版本、clientInfo、jsonrpc、id、initialized 通知任一项不对就回 error / 直接退出。

顺带修两个生产 bug（都是新判据逼出来的）：

1. **`_read_msg` 的 deadline 形同虚设**：`readline()` 在子进程不写时永久阻塞，服务端不响应会把验证请求挂死 → 改 `os.read` + `selectors`，到点一定返回 `None`。
2. **`Popen` 只捕 `FileNotFoundError`**：配置里 `args` 写成字符串等会抛穿到请求线程 → 补宽兜底，返回 `启动失败: ...`。

剩余 14 个变异点全部按文档写了 `# mutate: disable <理由>`（等价 maxsplit / 读缓冲区大小 / 毫秒量纲系数 / 截断长度 / `err=""` 被后续覆盖 / urllib 自动把空 method 当 POST / 需 IO 竞态才能触发的分支 / 清理等待时长），跑一次就能在输出里看到。

另：首次集成用例「删一条断言」验证时发现——删 `test_watcher:44` 的 scope 断言**不掉分**（L117-123 还有一个守卫），删「溢出必须降级 full=true」这个**唯一守卫**才掉分（33.00% → 32.67%）。结论：判据强度看「谁在守这条逻辑」，不是数断言条数。

## 质量卡口落地（2026-10-17）

**目标**：把「AI 开发质量体系」的卡口层铺到本仓——测试是判据，改判据必须留痕。

**落地物**：

| 卡口 | 载体 | 拦什么 |
|---|---|---|
| check 全链路 | `tests/check.sh`（快线 ≈1min）/ `tests/run_all.sh`（check + E2E 三步） | 钉桩 → lint 基线 → API → 模块；E2E 不进快线 |
| 判据钉桩 | `scripts/check_spec_guards.py`（check 第 0 步） | `@unittest.skip` / `it.only` / `xit` / `expectedFailure` 等软改松，扫到即红 |
| **lint 基线** | `scripts/lint_baseline.py` + `scripts/lint-baseline.json`（check 第 1 步；规则本体 `tests/lint_styles.py`） | 只对「本次变更文件」比对存量，**新增**样式告警即红；多分支/合并/rebase 不误报 |
| **变异门禁** | `scripts/mutate.py` + `scripts/mutation.config.json`（手动跑，不挂 pre-push） | 变异得分低于本仓基线（只许升不许降）；等价变异靠 `# mutate: disable <理由>` 留痕 |
| 测试目录内核锁 | `scripts/lock-tests.sh` · `unlock-tests.sh`（macOS `chflags uchg`，非 macOS 自动跳过） | 改 / 建 / 删判据（`tests/` 目录本层 + 12 个 `.py`·`.mjs` 文件） |
| 提交门禁 | `scripts/hooks/pre-commit`（进仓）+ `scripts/local-guard.sh`（gitignore 兜住，本机） | 提交夹带测试/门禁文件不留痕；放行开关 `LOCAL_GUARD_OK=1` |
| **推送门禁** | `scripts/hooks/pre-push`（进仓） | check 未全绿就拒推（不绿推不出去）；无放行开关，禁 `--no-verify` |
| 引导层 | `AGENTS.md`「质量卡口」节 | agent 撞锁/撞门禁时不用往权限方向瞎试 |

**启用方式**：`git config core.hooksPath scripts/hooks`（本机一次性；两个钩子都是惰性调用，机器上没铺体系即自动放行）。

**反向验证（全跑过，非设计稿）**：

- 钉桩：埋 `@unittest.skip` / `it.only` / `xit` 三种形态 → 逐处报出 `文件:行` + `exit 1`；同行 `spec-guard: allowed <理由>` → 列为「留痕放行」；清理后回绿（接入 lint 基线判据后为 12 文件 · 0 处）。整行注释里的关键词不误报。
- 提交门禁：暂存 `tests/__probe_hook__.py` → 真跑 `git commit` 被拦 `exit 1`（未产生提交）→ `LOCAL_GUARD_OK=1 git commit` 放行 `exit 0` → 回滚探针，暂存区与探针前逐行一致。
- 推送门禁：真跑 `git push /tmp/prepush-bare.git main`（临时 bare 仓，不动仓配置）→ check 红 → 拒推 `exit 1`、零 ref 上传；隔离目录用绿 stub 跑钩子本体 → `[pre-push] check 全绿，放行` `exit 0`。
- 内核锁（已生效，非仅脚本）：改已有 `.mjs` / 删 `.py` / **新建判据文件** 三向均 `Operation not permitted` → `unlock` 后改成功、探针行精确剥离（与快照字节一致）→ 锁回后再写仍被拒；`tests/evidence/` 全程可写（e2e 落证据不受影响）。

**变异门禁（`scripts/mutate.py`，2026-10-17 接入）**

Python 标准库 `ast` 自研，零依赖；在仓库副本里改一处 → 跑指定套件（timeout = 基线 × 3 + 5s，timeout 计 killed）→ 还原。
算子：`Compare` 互换 / `BoolOp` 与或互换 / `Not` 去除 / `BinOp` 互换 / 布尔取反 / 整数 `n→n+1` / 字符串→`""` / `return x→return None` / `if` 条件取反。

首次实测（并发 4，规则集 `m1`）：

| 目标 | 测试 | 变异点 | 杀 / 超时 / 活 | 得分 | 耗时 |
|---|---|---|---|---|---|
| `hub/watcher.py` | `test_watcher` | 300 | 98 / 1 / 201 | 33.00% | 约 5min |
| `hub/lib/mcpverify.py` | `test_mcp` | 174 → 189 | 33 / 22 / 119 | 31.61% → **100.00%**（补断言后，189 点杀 138 / 超时 37 / 留痕跳过 14） | 约 5min |
| `scripts/lint_baseline.py` | `test_lint_baseline` | 272 | 184 / 0 / 88 | 67.65% | 18min |

口径：

- **得分基线**登记在 `scripts/mutation.config.json` 的 `baseline_scores`，容差 2.0。已登记的文件只拦「比基线差」，未登记才用 break 60。这是「先接入拿基线、再逐步抬」，与指南 §四一致。
- 存活集中在 `String`（watcher 57/73、mcpverify 78/106、lint_baseline 67/88）——错误提示/日志文本没被断言，与指南描述一致。
- 时序型测试（`test_watcher`）有 ±1 个变异的抖动（实测 33.00% 与 32.67%），对比时以**存活清单差异**为准，不只看总分。

反向验证：

- 手工复核存活变异：`hub/watcher.py` L108 `parent != "/" → parent == "/"`，副本 diff 确认确实改了，变异后 `test_watcher` 仍绿 → **真存活，不是变异器没生效**。
- 删断言应掉分：在副本里删 `test_watcher` 的 `assertTrue(any(e["full"] for e in got), "溢出必须降级为 full=true")` → 33.00% → 32.67%，回执多出 1 个存活突变（`L172 True→False` / `L189 full or f → full and f`）→ 判据有效。（删 `test_watcher:44` 那条 scope 断言**没掉分**，因为 L117-123 还有一个 `assertIn("memory", ...)` 守着——删断言位置要挑「唯一守卫」才看得出来。）
- 门禁三分支（临时副本 + 微型被测模块）：得分低于基线 → `exit 1` 并点名文件；高于基线 → `exit 0` 并提示可 ratchet；`--ratchet` → 写回配置并提示「属判据口径，提交需留痕」。
- 474 个（watcher + mcpverify）变异点全部 `compile()` 通过，不存在「变异后语法错→计 kill」的假杀。

**lint 基线（`scripts/lint_baseline.py` + 判据 `tests/test_lint_baseline.py` 14 例）**

为什么不只靠全量零容忍：有远程仓库、多分支并行后，别人带进来的存量告警会把所有人的检查一起拦红，且与本次改动无关。

「本次变更」如何算（多分支安全）：

1. 基点 = `$LINT_BASE`（pre-push 传入的远端 sha）/ 上游 `@{u}` / `origin` 默认分支 / 本地 `main`，取与 HEAD 的 merge-base 中**离 HEAD 最近**的——同时覆盖「上游是自己同名分支」「从 main 合并过」「rebase 到新 main」。
2. 已提交部分走 `--first-parent`；合并提交只算 `diff-tree --cc`（与所有父提交都不同 = 冲突解决/evil merge 新塞的）。
3. 未提交部分 = 工作区 + 未跟踪；`MERGE_HEAD` 存在时，内容与对方一致的文件视为对方带入、不计。
4. 规则或基线被改 → 自动全量；无远程（变更集无从定义）→ 全量；非 git 仓 → 全量。
5. 基线只许降：`--ratchet` 只下调、拒绝上调；`--init` 拒绝覆盖已有基线。

判据（14 例，`tests/test_lint_baseline.py`，用真 git：bare 远程 + 两个 clone）全绿，并做了四处**定点破坏**验证判据有效：拆「合并期排除对方文件」→ 用例 06 红；拆 `--first-parent` → 用例 07/08 红；把「无远程退全量」改回「只看未提交」→ 用例 12 红；把「基点取最近」改成「取第一个」→ 用例 09 红。

pre-push 接线：stdin 三种形态已实测——推已有分支（取远端 sha）、新分支首推（远端 sha 全 0 → 不传 `LINT_BASE`，退上游/默认分支）、多 ref（取第一个非零）。

**锁的粒度（对源文档的一处调整）**：文档默认 `-R` 递归锁整个测试目录；本仓 e2e 要往 `tests/evidence/` 写截图与 `e2e-report-*.json`，递归锁会把证据一起锁死。
故改为「目录本层 `uchg` + 判据文件逐个上锁」：挡新建/改名/删除与文件改写，子目录内部保持可写，改/建/删判据三向仍皆拒。

**当前状态（2026-10-17）**：`bash tests/check.sh` 结果为——钉桩 ✅ / 样式 lint ✅ / `test_mcp`·`test_extras`·`test_watcher` ✅；
红点共 11 个，均属开工前既有判据漂移（与本卡口无关）：`test_hub` 4、`test_skills` 6、`test_manual_mcp` 1（适配器 9→10、`RemovedItemsFlow`、registry update 等）。
按第 5 条铁律，**pre-push 会因此拒推，直到这 11 条修绿**（改判据需先 `unlock`，并带三要素 + 判据数留痕）。

> 附：中途遇到过一轮 timeout 型 errors（`socket.timeout`），追查后判定为**负载偶发**而非锁引起：单独起沙箱 server 测 `POST /api/refresh`，锁 ON/OFF 耗时区间重叠（2.4–3.9s），客户端 timeout 仅 10s，在连跑多套件后容易被击穿；
> 上锁后 `test_hub` 连跑两次均为 `FAILED (failures=4)`，与解锁时完全一致。

**来源**：`~/Documents/灵创引擎/Docs/AI开发质量体系-落地方指南.md`（§三 / §五 / §六 / §七 / §八 的适配落地）。

## v1.0 即时刷新：文件监控 → SSE（2026-10-16）
**目标**：磁盘一变界面就变，去掉固定 30s 轮询。

- 新增 `hub/watcher.py`：三级后端自动降级——`watchdog`（若已安装，递归精确到文件）→ **kqueue**（macOS/BSD，纯 stdlib，注册目录 + 文件 fd）→ manifest 清单比对（浅层 + 上限兜底）。合并抖动 250ms；订阅端 `queue.Queue` 满则丢最旧，**永不阻塞** watcher 线程。
- 新增端点：`GET /api/events`（SSE，`hello`/`change`/`ping`）；`GET /api/watch`（backend / rev / watched / fds / degraded / roots）。
- 自身写入（`POST/PATCH/DELETE` 统一收口）→ `bump()` **立即广播**，不等 watcher；定时扫描完也广播。`/api/state` 增加 `rev` 与 `watch`。
- 监控范围：`tool:<id>` = 每个工具根 + 技能目录；`memory:<id>` = 各工具记忆布局路径；`memory:hub` = 中间体目录。`HUB_WATCH=0` 可整体关闭（前端自动退回轮询）。
- 前端：`EventSource` 订阅 → 按 scope 只刷新对应模块；**安静窗口**（自己刚写过 / 用户刚点过 900–1500ms）内不推外部刷新，避免打断正在进行的操作；SSE 断开 → 自适应轮询（可见 3s / 后台 60s）；状态栏实时显示「即时 · kqueue」。
- 实测：磁盘写文件 → 前端 rev 前进 **0.24–0.34s**（kqueue 注册 475 fd、23 个监控根）；E2E 新增 `live-sse-refresh`（断言 SSE 模式 + 真实写盘触发刷新 + 自身写入广播）；单测 `tests/test_watcher.py` 10 例（scope 映射 / 抖动合并 / 溢出降级 / 慢订阅端 / manifest 增删改 / 服务端 roots 形状）。
- 顺带修：状态栏新增徽标导致 390px 视口横向溢出（改 `overflow:hidden` + 宽度上限）；`memory-flow` 的自我循环失败（历史残留同名条目导致"删掉后应消失"永不成立 → 改用唯一标题 + 用例内清理）。

## v0.6.1 四视图统一布局（2026-10-05）

- 范围：会话 / 台账 / 记忆三个视图按 Skills·MCP 的 nv-layout 统一（左 280 导航 + 中 1fr 内容 + 右 360 联动）。
- 会话：工具卡改紧凑行 + 悬停浮层按钮（⟳/设置，不占宽度）；中栏新增统计卡（会话/工具/消息/lineage/收藏）+ 分页器（全选/反选/清空 + 已选计数）；预览 overlay 保留（顶栏级详情，e2e 全量覆盖其行为）；**迁移确认由弹窗改为右栏内联确认条**（nv-migconfirm，dup「同步更新」弹窗保留——它是二次决策不是操作确认）。
- 台账：外壳换 nv-layout；左栏模块/状态筛选（原 seg 并入）；中栏统计卡（成功/失败/冲突/跳过）+ 真分页（offset，原 limit=200 截断）；右栏单条详情（对象/原因/detail JSON）。
- 记忆：左栏总线接入行 + 新增表单；中栏统计 + 列表 + 搜索 + 导出；右栏**新增记忆详情（带删除）**——此前删除只存在于旧侧栏，独立视图无删除入口；合并了 app.js 中两处重复的记忆渲染实现。
- 顺带修复：`mv-add` onclick 在 `await` 后使用 `e.currentTarget`（规范规定此时为 null）抛 TypeError 导致保存成功但列表不刷新——先存引用再异步（web/app.js:844）。
- 测试：E2E 更新 5 个场景断言（memory-flow 删除走详情、迁移确认内联、tab-memory 移除、validation-empty-memory 换 mv-add）；全量 lint + API 46 + Skills 24 + MCP 9 + Manual 4 + Extras 8 + E2E 17 + 有头 3 + 沙箱 14 = **ALL PASSED**。

## v0.6 手动条目 + 新布局（2026-10-05）

- 范围：Skills / MCP 支持本地手动编写（新建 / 编辑 / 从本地目录导入 / 删除）与远程拉取同权（分发 / 验证 / 台账 / 回退）；三栏新布局（左：来源折叠 + 条目分页；中：概览统计 + 详情 CRUD + 多选批量；右：工具状态 + 内联更新，更新类操作零弹窗）；新 `/api/{skills,mcp}/items` 统一列表（来源过滤 + 关键词 + 分页 + 逐目标部署状态/版本差异）。
- 结果：`ALL SUITES PASSED ✓` —— lint + API 46 + Skills 19 + MCP 9 + Manual MCP 4 + Extras 8 + E2E 无头 16 + 有头 3 + 沙箱 14。
- 新增用例：手动创建（重名 / 非法名 / 路径穿越拦截）、编辑版本演进（prev 可回退）、本地目录导入（缺 SKILL.md 拒绝 / 覆盖导入留快照）、stale 联动（部署后编辑 → stale → 重写 → latest）、删除保护（有部署先拒，force 连同目标清理）、MCP 手动 config 白名单归一化、items_view 逐目标状态。
- 真实环境验证：`planarcat/agent-skills`（28 个 skill）拉取入库并分发到 Claude 全局目录；测试 MCP（npx everything / filesystem / DeepWiki http）握手验证通过；手动条目创建→分发→编辑→stale→重写→删除全链路走通，台账逐步记录。
- 顺带修复：① MCP Streamable HTTP 验证器补 `Accept: application/json, text/event-stream`（此前对 DeepWiki 等新式端点误报 406）并支持 SSE 响应解析；② casr 查找增加用户安装目录兑底（nohup 裁剪 PATH 下引擎误报未安装）；③ DELETE 请求 query 参数（如 `?force=1`）现可到达模块层；④ 分发记录 `item_version`（右栏版本差异数据基础）。

## v0.5.1 工具注册表（2026-09-22）

- 范围：`/api/tools` CRUD（添加 / 改名 / 停用 / 删除 / 彻底删除）+ 五种格式模板 + 动态面板/筛选/定时；新适配器 Pi-Agent 与 Cursor。
- 结果：`ALL SUITES PASSED ✓` —— lint + API 46 + Skills 13 + MCP 9 + Extras 8 + E2E 无头 16 + 有头 3 + 沙箱 14 = **109 项 + lint**。
- 实机数据：Pi-Agent 38 会话 / 4989 消息、Cursor 9 composer / 637 消息 均已入库（55 会话总量）。
- 边界覆盖：空名称 / 未知格式 / 空路径 / 重名 / 路径不存在（警告不阻断）/ 内置不可删 / 移除后数据保留 / 彻底删除先备份后清除（备份 zip 落盘断言，`?purge=1`）/ 未知定时范围 400 / 停用不参与扫描。
- 顶层联动（v0.5.2）：工具集成字段自动同步 Skills / MCP 目标（origin 溯源 + 删除回收断言）；`wire-memory` 克隆 + 备份 + 幂等；预设快填与目标同步均有沙箱 E2E 覆盖。
- 滚动与并发加固（2026-09-22 修复）：会话 / 记忆 / Skills / MCP 视图高度链修正（列表超一屏可滚动，page-load 内置防回归断言）；服务端 listen backlog 5→128，页面加载的连接突发不再被 RST 掐断（修前 20 并发 36% 失败 → 修后 20/60 并发 0 异常，另在 90s 并发压力下跑通全量 E2E）。
- 会话格式编辑（2026-09-23 修复）：自定义工具可修改会话格式（PATCH adapter：未知格式 400 / 内置锁定 400 / 持久化与还原断言）；内置工具格式与路径锁定，界面明确灰化 + 锁定提示；沙箱 E2E 新场景「自定义可改（持久化+还原）· 内置锁定+提示可见」。

## 测试体系（4 层 + 演练）

| 层 | 文件 | 方式 | 覆盖 |
|---|---|---|---|
| 1 样式规范 lint | `tests/lint_styles.py` | 静态检查 | 界面文件无游离色值/字号，100% 走 tokens |
| 2 API 集成测试 | `tests/test_hub.py`（35） | 沙箱服务器 + 合成数据（不触碰真实会话） | 基础流 + 边界/失败 + v0.3 搜索/导出/收藏 + v0.4 stats/记忆搜索导出/批量 zip/HTTP 动词 |
| 3 模块集成测试 | `tests/test_skills.py`（13）· `tests/test_mcp.py`（9）· `tests/test_extras.py`（8） | 真实本地 git 夹具 + 临时 Store | 源/拉取/更新/冲突/回退/分发幂等/TOML 受管块/握手验证/S3 定时拉取 |
| 4 E2E 真实浏览器 | `tests/e2e.mjs`（16 场景）· `tests/e2e_sandbox.mjs`（7） | **CDP 驱动系统 Chrome（零依赖）**，无头 + 有头双模式 | 全流程 + 五视图 + 拉取/分发向导 + 沙箱失败场景 |
| 5 端到端演练 | `scripts/drill_v04.py`（8 步） | 干净临时环境 + 隔离实例 | 注册→拉取→更新→分发×2→幂等→升级→回退→台账 |

### 卡口层（2026-10-17 起，run_all 第 0 步起算）

| 卡口 | 文件 | 触发 | 通过判据 |
|---|---|---|---|
| 判据钉桩 | `scripts/check_spec_guards.py` | `bash tests/check.sh` 第 0 步 / 手动 | 12 个判据文件软改松 0 处 |
| lint 基线 | `scripts/lint_baseline.py`（规则 `tests/lint_styles.py`） | `bash tests/check.sh` 第 1 步 / pre-push | 本次变更文件告警 ≤ `scripts/lint-baseline.json`；判据 `tests/test_lint_baseline.py` 14 例 |
| 变异门禁 | `scripts/mutate.py` + `scripts/mutation.config.json` | 手动（数分钟，不挂 pre-push） | 得分 ≥ `baseline_scores` − 容差 2.0（当前：watcher 33.0 / mcpverify 100.0 / lint_baseline 67.65） |
| 内核锁 | `scripts/lock-tests.sh` / `unlock-tests.sh` | 手动（上锁/解锁） | `ls -lO tests` 本层含 `uchg` + 11 个判据文件含 `uchg` |
| 提交门禁 | `scripts/hooks/pre-commit` → `scripts/local-guard.sh` | `git commit` 暂存 `tests/` 或门禁本体 | 无 `LOCAL_GUARD_OK=1` 时 exit 1 |
| 推送门禁 | `scripts/hooks/pre-push` | `git push` | `bash tests/check.sh` 全绿才放行 |

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
8. `bash tests/run_all.sh` → 六套件全绿（109 项）。
9. 工具注册表：会话页「＋ 添加工具」→ 选模板（如 Pi-Agent / Cursor）→ 刷新即采集；卡片「设置」中可停用/移除（已采集数据保留）。
- 筛选条重构（v0.6.2 补丁，2026-10-06）：会话左栏筛选改为「横向滚动区 + ★ 收藏固定最右」——滚动区 `overflow-x:auto` + 细滚动条，★ 独立按钮（`.nv-starbtn`）不随滚动移动；修掉了 seg 上残留 `display:contents` 导致 CSS 失效、按钮换行挤压的问题；`setFilter` 改走 `syncFilterSegActive()` 同步高亮（含 ★ 态）。实测：7 按钮单行、构造溢出后 `scrollWidth 570 > clientWidth 221`（可滚）、★ 点击过滤 2 条收藏会话、E2E 全量 ALL PASSED。

## v0.7 设置中心（2026-10-06）

- 入口：顶栏「⚙ 设置」→ 大模态（web/views/settings.js，零新依赖）。
- 模块启用：sessions/memory/skills/mcp 四开关，调 `POST /api/modules/{id}/toggle`；禁用后导航按钮同步隐藏（`applyModuleVisibility`，loadState 时拉 /api/modules 刷新）、对应 API 由既有 503 守卫拦截；当前视图被禁用时自动回会话视图。
- 工具管理：全部工具（内置 3 + 自定义）统一列表——启停开关（PATCH enabled，禁用后采集/筛选/导航同步隐藏）、「编辑」跳既有工具模态（内置锁 root/adapter、可改 name/skills_dir/mcp_config）、「接入记忆」按钮（wire-memory）、添加工具入口。
- 定时调度：内嵌摘要 + 跳转原「定时任务」面板（sched-overlay 全量断言保留）。
- 运行环境：casr/agentmemory 状态、数据目录（AGENT_HUB_DIR）、端口（HUB_PORT）只读展示。
- 顺带修复：preview-actions 收藏翻转 flaky——POST /api/star 与 30s 轮询并发时 300ms 固定 sleep 偶尔不够，改为 waitFor 文本真正翻转（连跑 3 次全过）。
- 全量：lint + API 46 + Skills 24 + MCP 9 + Manual 4 + Extras 8 + E2E 17 + 有头 3 + 沙箱 14 = ALL PASSED。
- 设置中心 v2 落地修复（2026-10-06）：重构为「左锚点导航（模块/工具/定时调度/关于）+ 右内容面板」窗口化界面（.setwin，880×640）；工具行内联展开编辑（名称/Skills 路径/MCP 配置；内置锁 root+adapter），wire-memory、启停开关并入；定时调度内嵌每范围间隔+开关（免跳转）。修复两处崩溃级 bug：① app.js init 残留引用已移除的 settings-cancel/tool-add/sched-open 节点 → getElementById null 抛 TypeError 中断整个 DOMContentLoaded 绑定（页面「加载中」卡死、引擎徽章停在检测中）；② settings.js v2 漏绑 .setwin__item 导航点击 → 锚点无响应。实测四面板切换、工具编辑表单展开（se-name/se-skills/se-mcp）、模块开关联动导航显隐均正常；全量 ALL PASSED。
- 桌面壳 ⌘R（v0.7 补丁，2026-10-06）：Tauri 2 macOS 默认菜单不含 Reload（v1 才有，2.11.6 源码 menu.rs 证实无 zoom/reload 项）——补应用菜单「重新加载 ⌘R」（菜单事件 → webview.eval(location.reload())），窗口加 zoom_hotkeys_enabled(true)（⌘±/0 由 Tauri 内建 polyfill 接管）；web/index.html 内联 ⌘R/F5 keydown 兜底。cargo check 零警告；make-app.sh 重建安装完成；E2E 连跑 3 次 17/17（preview-actions 加首次未翻转 1.5s 重试一次，消除与 30s 轮询并发的偶发丢失）。

## v0.9.2 采集静默失败修复（2026-10-15）

**症状**：启用的工具（zcode / autoclaw / trae-cn …）刷新后始终 0 条会话，无任何报错。

**根因（两条，均为真 bug）**：
1. **扫描器不展开 `~`**：内置工具的 root 存的是 `~/.xxx`（`root_hint_default`），`build_scanners` 原样交给扫描器，而扫描器用 `glob` / `os.path.exists` —— 它们不展开 `~` → 一律返回空 → **所有内置工具静默采不到**（claude / codex / opencode / workbuddy / zcode / autoclaw 全中）。
2. **AutoClaw 布局不一致**：内置 root 已是 `~/.openclaw-autoclaw/agents`，而 `AutoClawScanner.sources()` 又拼一层 `agents/*/sessions/*.jsonl` → 双重 `agents`；同时未过滤 `.trajectory.jsonl`。

**修复**：`hub/scanners.py` 新增 `_expand_root()`，在所有扫描器 `__init__` 与 `build_scanners` 两处展开；`AutoClawScanner.sources()` 同时接受 `.../.openclaw-autoclaw` 与 `.../agents` 两种 root 形态，并过滤 `.trajectory.jsonl`。

**实测（一次刷新）**：zcode **227 会话 / 8881 消息**、autoclaw **34 会话 / 2117 消息**（2.7s）；trae-cn 0（SQLCipher 加密，设计如此）、agents 0（无采集器，设计如此）。会话页 261 行，卡片计数 `zcode=227 / autoclaw=34` 与列表一致。

**回归防护**：`tests/test_extras.py` 新增 `ScannerRootTildeTest`（3 项：`~` 展开助手、8 个扫描器 `__init__`、`build_scanners` 构造结果）→ 11/11 通过。

**连带修复**：内容搜索收敛到可见域（口径 B 下命中"已停用工具"的会话点进去打不开）。
