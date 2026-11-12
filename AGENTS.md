# AGENTS.md · Agent Depot

本地优先的 AI Agent 资产枢纽：多工具会话采集 / 浏览 / 迁移，外加记忆、Skills 分发、MCP 写入、台账。  
技术面：Rust 后端（`depotd/`，axum + rusqlite）+ TypeScript 前端（`web/`，Bun 构建/测试，零运行时依赖；`web/dist/` 由 depotd 优先服务）。Python 后端已于 2026-11-11 移除；`tests/spec/*.py` 保留——它们是黑盒行为真源（经 HUB_BASE 打任意引擎），不是后端代码。

## 仓库布局：WorkTrees 工作流（2026-11-08）

- **仓库本体（`.git`）在 `WorkTrees/main`**（2026-11-09 起）；外层 `agent-depot/` 是**普通文件夹**（无 `.git`，只有 `WorkTrees/` / `reports/`（日报）/ AGENTS.md+CLAUDE.md 锚点），**禁止在外层改代码**。
- **main 分支常驻检出在 `WorkTrees/main`**：代码 / 测试 / 构建全在这里，depotd 也从这里起。
- 新开发内容一律从 main 拉分支新建 worktree：
  `git worktree add WorkTrees/<分支名> -b <分支名> main`
  完工合回 main：`git -C WorkTrees/main merge --no-ff <分支名>`，然后 `git worktree remove WorkTrees/<分支名>`。
- git hooks 走 main worktree 的**绝对路径**（`core.hooksPath` 已指向 `WorkTrees/main/scripts/hooks`）。
- **禁止直接推送生产分支（main）**：一律 PR 审核流，由用户审核合并。
- **⚠️ 钩子环境泄漏教训**：`git push` 会给钩子注入 GIT_DIR/GIT_WORK_TREE，
  check.sh 的测试子进程继承后，夹具 git 操作会写进真实仓库（曾把 fixture 提交
  推上远程覆盖 main）。check.sh 顶部已统一 unset 这些变量——**不要移除**；
  新增任何跑 git 的测试一律显式 `-C <夹具目录>`。
- 日常门禁（在对应 worktree 内跑）：`bash scripts/soak_check.sh`（内存/事件门禁）、
  `bash scripts/run_spec_rust.sh`（spec 78 行为闸门）、`(cd web && bun run check:ci)`（前端全链路）。

## 桌面壳（`desktop/`）硬规则

- 设置页「桌面」的四个开关（开机启动 / 菜单栏挂载 / 静默启动 / Dock 图标）由 Tauri 命令
  `desktop_get_settings` / `desktop_set_settings` 驱动，配置落在
  `~/Library/Application Support/local.planarcat.agent-depot/desktop.json`。
- 控制台是 remote URL（`http://127.0.0.1:8317`），IPC 放行靠
  `desktop/src-tauri/capabilities/default.json` 的 `remote.urls`——**不要删**，删了设置页全失效。
- 静默启动依赖菜单栏挂载（Rust 侧 `normalized()` 会兜底）；开机启动写
  `~/Library/LaunchAgents/local.planarcat.agent-depot.plist`。
- 改桌面壳后至少跑 `(cd desktop/src-tauri && cargo test)`；重装正式版用 `bash scripts/make-app.sh`。
- **开发版与正式版必须隔离**：`AGENT_DEPOT_PROFILE=dev`（或 debug 构建）→ `AgentDepot-Dev.app` /
  `desktop-dev.json` / `*-dev.plist` / dev 库；正式版走默认。新增桌面设置时禁止把两版写进同一条路径。

## 改 `web/` 之前的硬规则

1. **视觉唯一真源是 `DESIGN.md`** —— 动手前先读。注意 **§0.1 场景基调：本项目是工具型应用**（布局变化度 3 / 动效强度 2 / 信息密度 8），**不要为每个页面追求不同的"指纹"**。
2. 颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效**只用 `web/tokens.css` 的变量**，不写裸数值；要新值就先加 token 再引用。
3. 交互反馈一律走 `HubUI.*` 与 `.hub-*` 组件：禁原生 `alert/confirm/prompt`，禁静默等待（异步要给 `.is-loading`），禁首屏空白。
4. 组件样式只进 `web/hub-ui.css`，页面布局只进 `web/app.css`，两者不混。
5. 停用工具在**所有界面隐藏**（卡片 / 侧栏 / 列表 / 迁移目标）；工具编辑只在 设置 → 工具，会话页不得出现编辑入口。
6. **用户指令 > Figma 稿子**：与稿子冲突时以用户明确指令为准。你让删/改的元素，稿子里**往往还留着**（稿子不会同步你的指令）——那些属于**过时内容，不许按稿子加回来**。动手前先翻仓库根 `FIGMA_OVERRIDES.md`（覆盖清单，**不写进 DESIGN.md**）；你每给一次「删 / 不要 / 去掉」这类指令，**同一轮就把那一条补进该清单**（含依据与日期），别让下一轮的人以为是漏做。
7. **交活前自评**：对照 `DESIGN.md §11` 逐条过一遍，并对**主张 / 层级 / 执行 / 具体性 / 克制 / 变化** 六项打分（1–5），任一项 <3 先改再交；再跑 `python3 scripts/lint_baseline.py` 必须 PASSED（规则本体是 `tests/lint_styles.py`）。改 `data-testid` 须同步改 `tests/e2e*.mjs`。
8. **前端工具链是 Bun/TypeScript**：`cd web && bun install` → `bun run check:ci`（biome + 双 tsconfig + build + 体积预算 + core 覆盖率）。改 `src/` 后必须 `bun run build`（depotd 服务 `web/dist/`）；**禁止新增裸 `.js` 源文件**，新视图只在 `core/view-loader.ts` 注册动态 import。细节见 `web/README.md`。

> 本文件只放硬规则与指向，**不复制 token 数值**——那份清单只在 `DESIGN.md`，避免两处打架。
> 完整流程（方向探索 → 规范固化 → 实现 → 质检）见 `Plans/设计质感/落地方案.md`。

## 质量卡口（改任何源码之前先读）

- `bash tests/check.sh` = 本仓 check 全链路（spec 守卫 → **前端 biome + tsc + bun build + 体积/覆盖率门禁** → cargo 单测 → 行为真源 spec 78 条打 depotd），**pre-push 自动跑，不绿推不出去**。
- `bash tests/run_all.sh` = check 全链路 + E2E 三步（真 Chrome），**交活前完整验收**。
- 变异门禁已随 Python 栈移除（Rust 侧暂无对应物）；行为回归以 `bash scripts/run_spec_rust.sh` 为准。

所有卡口都是惰性调用：机器上没铺体系就直接放行；检查不许挂进 `run.sh` 与 dev 启动链路。

1. **测试是判据，改它要留痕**：`tests/` 目录（本层）与全部判据文件（`tests/**/*.py`·`*.mjs`，含 `fixtures/`）默认被 macOS 内核锁（`chflags uchg`）。
   写测试报 `Operation not permitted` = **撞锁，不是权限问题**，别往环境/权限方向瞎试：
   ① `bash scripts/unlock-tests.sh` → ② 改 → ③ `bash scripts/lock-tests.sh` 锁回。解锁与写文件别放同一批并行工具调用（会抢在解锁前执行）。
   commit message 必须写清三件事：**解锁了哪些文件 / 为什么改（口径出处）/ 改了什么口径**。
2. **软改松一律红灯**：`@unittest.skip` / `it.only` / `xit` / `expectedFailure` 被 `scripts/check_spec_guards.py` 扫到即红（check 第 0 步）。
   确实必须跳过：在同一行加 `spec-guard: allowed <理由>` —— 留痕放行，输出里会列出来。
3. **提交门禁**：暂存 `tests/` 或门禁本体（`scripts/check_spec_guards.py` / `lint_baseline.py` / `lint-baseline.json` / `mutate.py` / `mutation.config.json` / `lock-tests.sh` / `unlock-tests.sh` / `scripts/hooks/`）会被 pre-commit 拦下。
   确认无误要放行：`LOCAL_GUARD_OK=1 git commit ...`（这个动作本身就是留痕）。**禁 `--no-verify`**（push 同理）。
4. **门禁只在本机**：钩子本体 `scripts/local-guard.sh` 被 `.gitignore` 兜住；启用靠一条本机命令 `git config core.hooksPath scripts/hooks`（进仓的是 `scripts/hooks/pre-commit` 与 `pre-push`，惰性调用）。
5. **锁的粒度**：`tests/` 用**本层** `uchg`（挡新建/改名/删除），**不用 `-R` 递归** —— 递归会把 `tests/evidence/` 一起锁死，e2e 就写不了截图与 `e2e-report-*.json`。实测：本层锁只挡这一层，子目录内部照旧可写，改/建/删判据三向皆拒。
6. **lint 基线**（`scripts/lint_baseline.py`，check 第 1 步）：只对「本次变更文件」比对 `scripts/lint-baseline.json` 登记的存量，**新增告警即红**。
   多分支安全：基点取（pre-push 远端 sha / 上游 / origin 默认分支 / 本地 main）与 HEAD 最近的 merge-base；合并对方带入的文件不算你的，解冲突时新塞的告警照拦；无远程时全量比对；改规则或基线自动全量。
   基线**只许降**：修掉存量后 `--ratchet` 下调；**禁止靠改基线让新告警过关**（上调只能手改 JSON，会被第 3 条拦下留痕）。
7. **变异门禁**（`scripts/mutate.py`，配置 `scripts/mutation.config.json`，报告 `reports/mutation.json`）：Python 标准库 `ast` 自研，在仓库副本里变异，不碰源码。
   口径：timeout 算 killed；阈值 high 80 / low 60 / break 60，低于 break 则 `exit 1`；规则集版本 `m1`，**得分不可与 Stryker / mutmut 横向比较**。
   时序型测试（如 `test_watcher`）有 ±1 个变异的抖动，对比时以存活清单差异为准，不只看总分。
   等价变异（杀不死也不该杀）：在那一行加 `# mutate: disable <理由>`，理由必填，输出里列为留痕跳过。
8. **改判据的提交规则**：除第 1 条三要素，commit message 还要带**变异得分改前 → 改后**（涉及被盯模块时）与**判据数变化**（check 用例数）。
   降分、判据数减少、软改松增多 = 改松，直接打回。
9. **已知跳过项（跳过 ≠ 通过）**：前端**变异测试**跳过（跑真 Chrome 数小时，收益低）；但前端已有 `bun test` 单测（208 条，core 覆盖 ≥90%）+ e2e 19 条，不再属于「只有 E2E、没有单测」；
   Rust 外壳 `desktop/src-tauri` 没有 `#[test]`，变异得分没有参考意义 → 记跳过（后端转 Rust 后改用 `cargo-mutants`）。

> 出处：`~/Documents/灵创引擎/Docs/AI开发质量体系-落地方指南.md`（本仓为其适配落地，逐条实测记录见 `VERIFICATION.md`）。

## 工作区常驻规则（自动推送 / 视觉路径记忆 / 接口快照 · 2026-11-06）

> 本节与工作区根 `AGENTS.md` 同文；**改动以根为准**，本副本保证在 cwd 内可读。

> 不靠用户提示词：agent 自主决定截图 / 看画面时同样生效。

本会话**第一次为了看画面 / 截图而打开网页、应用、报表或跑出图命令前**：

1. 若尚未 Read `visual-route-memory`，先 Read 它的 `SKILL.md` 全文。
2. 按技能里的索引，只读命中的**那一个**画面文件，不整目录读。
3. 只复用操作手法；本次判定与结论一律现做，不写回卡片。

规则挂「动作」不挂「措辞」——不看用户说了什么，只看是不是要调画面。卡片落本工作区（位置由技能正文 / 工作区配置定），是操作手册，不是测试档案。

**接口快照（`api-snapshot`）同理**：本会话第一次调接口拿到响应（或用户贴了接口 / 入参 / 返回数据）需要留存时：

1. 若尚未 Read `api-snapshot`，先 Read 它的 `SKILL.md` 全文。
2. 按它的 `_index.md` 只定位需要的那一份快照，不整目录读；大文件用脚本按字段取。
3. 当场落盘、必脱敏、不覆盖历史。

两条都挂「动作」不挂「措辞」，只指路不复制正文。

## 开发收尾：自动推送判定（2026-11-06）

> 不等用户说「生成 commit」，**不问要不要推**。

在开发分支上完成较完整功能后，由 agent 自行判定：

1. Read `generate-commit` 的 `SKILL.md` 全文，按「自动推送时机」判定是否形成功能闭环。
2. 闭环 → 推送前核验 → 按**该仓仓库文档**规定的目标分支推送；文档没写就停下问，不猜。
3. 未闭环 → 只本地 commit，汇报写「未推：功能未闭环 + 缺什么」。
4. 频次：一个需求**默认 1 次**、最多 2 次、**同一天 ≤1 次**；两次之间须有新的可验收状态变化。
5. 用户说「只提交 / 先别推」→ 只 commit。
6. 主分支 / 测试分支禁止直推（只经 PR/MR）；不 `--force`。
> 推送途中遇冲突：一律自己解决（按 `generate-commit` 的取舍优先级），不问、不停、不讨论；动了本需求行为须同步回 dev。仅身份 / 权限 / 网络这类做不了的才如实汇报。

## 工作记录：自动落盘（2026-11-06 · 不问、不等口令）

> 挂「动作」不挂「措辞」：完成一段可归属的工作（提交 / 推送 / 阶段收尾 / 用户要总结）就落盘，**不等用户说「记一下」，不问要不要记**。

1. Read 公司库 `日报采集共写`（`report-pipeline`）全文，按其落点与共写规则写入 `Reports/daily_work/YYYY-MM-DD/【需求id_标题】.md`（目录不存在就建，不用问）；只更新自己会话块，每条工作节点带 `[HH:MM]`。
2. **对话里列清单、表格、总结都不算记录** —— 必须落盘，并在汇报里给文件路径。落点以 `工作区配置.json` 的 `paths.dailyReport` 为准。
3. **用户说「不要汇报 / 别总结 / 安静点」＝ 只减少对话输出，落盘照做**；不得就「要不要记」提问。
4. **禁止**把「日报没写」列进遗留 / 待办，禁止反问「是不是漏了最重要的事」；发现没写就当场补，不列欠账。
5. 素材从本会话已有上下文取（提交、对话、测试输出），**不要求开发过程额外配合**（日报零注入原则）。





<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agent-depot** (2253 symbols, 7546 relationships, 196 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/agent-depot/context` | Codebase overview, check index freshness |
| `gitnexus://repo/agent-depot/clusters` | All functional areas |
| `gitnexus://repo/agent-depot/processes` | All execution flows |
| `gitnexus://repo/agent-depot/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
