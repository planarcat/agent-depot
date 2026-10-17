# AGENTS.md · Agent Depot

本地优先的 AI Agent 资产枢纽：多工具会话采集 / 浏览 / 迁移，外加记忆、Skills 分发、MCP 写入、台账。  
技术面：Python 标准库后端（`server.py` + `hub/`），零框架前端（`web/`，原生 JS + CSS 变量）。

## 改 `web/` 之前的硬规则

1. **视觉唯一真源是 `DESIGN.md`** —— 动手前先读。注意 **§0.1 场景基调：本项目是工具型应用**（布局变化度 3 / 动效强度 2 / 信息密度 8），**不要为每个页面追求不同的"指纹"**。
2. 颜色 / 字号 / 间距 / 圆角 / 阴影 / 动效**只用 `web/tokens.css` 的变量**，不写裸数值；要新值就先加 token 再引用。
3. 交互反馈一律走 `HubUI.*` 与 `.hub-*` 组件：禁原生 `alert/confirm/prompt`，禁静默等待（异步要给 `.is-loading`），禁首屏空白。
4. 组件样式只进 `web/hub-ui.css`，页面布局只进 `web/app.css`，两者不混。
5. 停用工具在**所有界面隐藏**（卡片 / 侧栏 / 列表 / 迁移目标）；工具编辑只在 设置 → 工具，会话页不得出现编辑入口。
6. **用户指令 > Figma 稿子**：与稿子冲突时以用户明确指令为准。你让删/改的元素，稿子里**往往还留着**（稿子不会同步你的指令）——那些属于**过时内容，不许按稿子加回来**。动手前先翻仓库根 `FIGMA_OVERRIDES.md`（覆盖清单，**不写进 DESIGN.md**）；你每给一次「删 / 不要 / 去掉」这类指令，**同一轮就把那一条补进该清单**（含依据与日期），别让下一轮的人以为是漏做。
7. **交活前自评**：对照 `DESIGN.md §11` 逐条过一遍，并对**主张 / 层级 / 执行 / 具体性 / 克制 / 变化** 六项打分（1–5），任一项 <3 先改再交；再跑 `python3 scripts/lint_baseline.py` 必须 PASSED（规则本体是 `tests/lint_styles.py`）。改 `data-testid` 须同步改 `tests/e2e*.mjs`。

> 本文件只放硬规则与指向，**不复制 token 数值**——那份清单只在 `DESIGN.md`，避免两处打架。
> 完整流程（方向探索 → 规范固化 → 实现 → 质检）见 `Plans/设计质感/落地方案.md`。

## 质量卡口（改任何源码之前先读）

- `bash tests/check.sh` = 本仓 check 全链路（快线 ≈1min：钉桩 → lint 基线 → API → 模块 + 门禁自测），**pre-push 自动跑，不绿推不出去**。
- `bash tests/run_all.sh` = check 全链路 + E2E 三步（真 Chrome），**交活前完整验收**。
- `python3 scripts/mutate.py` = 变异门禁（数分钟，**不挂 pre-push**），改测试或改被盯模块时手动跑。

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
9. **已知跳过项（跳过 ≠ 通过）**：前端 `web/*.js` 只有 E2E，没有单测，变异一次要跑真 Chrome 数小时 → 记跳过；
   Rust 外壳 `desktop/src-tauri` 没有 `#[test]`，变异得分没有参考意义 → 记跳过（后端转 Rust 后改用 `cargo-mutants`）。

> 出处：`~/Documents/灵创引擎/Docs/AI开发质量体系-落地方指南.md`（本仓为其适配落地，逐条实测记录见 `VERIFICATION.md`）。

