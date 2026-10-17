# 第 3 轮：变异门禁落地（方案 A）与 lint 基线

> 时间: 2026-10-17 13:10

## 用户提问

继续（继续把质量体系这两项补完：变异门禁按方案 A、lint 基线覆盖未来远程仓库与多分支）。

## 背景与分析

### 变异门禁：为什么「先登记基线」而不是直接卡 60

首次实测（规则集 `m1`，并发 4）：

| 目标 | 变异点 | 杀 / 超时 / 活 | 得分 |
|---|---|---|---|
| `hub/watcher.py` ↔ `test_watcher`（300 点） | 300 | 98 / 1 / 201 | 33.00% |
| `hub/lib/mcpverify.py` ↔ `test_mcp`（174 点） | 174 | 33 / 22 / 119 | 31.61% |
| `scripts/lint_baseline.py` ↔ `test_lint_baseline`（272 点） | 272 | 184 / 0 / 88 | 67.65% |

三个目标都低于 break 60。如果按文档原样把 break 60 当门槛，门禁一上线就是红的，等于没接。

这与指南 §四「接入后先跑一次拿基线」是同一处境：存量水平就是 30% 上下，得先登记、再往上抬。所以加了一条「得分基线」机制：

- `baseline_scores` 登记在 `scripts/mutation.config.json`，容差 2.0 个百分点；
- 已登记的文件只拦「比基线差」，未登记的文件才用 break 60；
- `--ratchet` 只上调、不回退；配置改动属判据口径，提交要留痕。

### 存活集中在字符串

`String` 类存活占大头：watcher 57/73、mcpverify 78/106、lint_baseline 67/88。原因一致——错误提示、日志文本、指纹串没有被断言。这与指南里「存活的 StringLiteral 大多是错误文案没被断言」完全对上，是后续补断言的**性价比最高入口**。

### 时序型套件会抖

`test_watcher` 两次全量跑出了 33.00% 与 32.67%（±1 个变异）。所以对比不能只看总分，要看存活清单差异；容差设 2.0 也是为这个。

### lint 基线：真正要解决的是「多分支」

本仓现在没有远程，但一旦有：别人分支带进来的存量告警会让每个人的检查一起红。基线把口径改成「只拦本次新增」，难点全在「本次变更怎么算」：

| 场景 | 朴素做法 | 会出什么问题 |
|---|---|---|
| 上游是自己同名分支 | `@{u}..HEAD` | 还能用 |
| 从 main 合并过 | 同上 | 把 main 上别人的提交算成你的 |
| 合并进行中 | `git diff` | 对方未提交的文件全算你的 |
| rebase 到新 main | 只按上游 | main 的新提交全算你的 |
| 解冲突时塞了新告警 | 只看 `@{u}..HEAD` 之外的 diff | 漏拦（evil merge） |

解法：基点取「$LINT_BASE（pre-push 远端 sha）/ 上游 / origin 默认分支 / 本地 main」与 HEAD 的 merge-base 中**离 HEAD 最近**的一个；已提交部分走 `--first-parent`，合并提交用 `diff-tree --cc` 只算与所有父提交都不同的文件；合并进行中按 `MERGE_HEAD` 内容比对排除对方文件；无远程时退回全量（不能退化成「只看未提交」，否则提交到 main 的告警永远查不到）。

## 建议与回答

本轮已落地并验证：

1. `scripts/mutate.py`（零依赖，`ast` 定位变异点 + 字节区间替换，副本内执行，HOME 指向临时目录）+ `scripts/mutation.config.json`（阈值、容差、得分基线、目标表）+ `reports/mutation.json`（已 gitignore）。
2. `scripts/lint_baseline.py` + `scripts/lint-baseline.json`；规则本体抽成 `tests/lint_styles.py:scan_file()`，两边共用一份。
3. `tests/check.sh` 第 1 步换成 lint 基线；`tests/check.sh` 第 3 步加 `test_lint_baseline`。
4. pre-push 解析 stdin 传 `LINT_BASE`（远端 sha）。
5. 提交门禁名单加上四类新判据文件。
6. `tests/test_lint_baseline.py` 14 例（真 git：bare 远程 + 两个 clone，覆盖合并中/合并后/evil merge/rebase/首推/ratchet/init）。
7. `AGENTS.md` 卡口节重写为 9 条；`VERIFICATION.md` 补实测记录。

验证方式（均实测）：

- 手工复核存活变异（L108 条件互换 → 副本 diff 确认改动 → 测试仍绿 → 真存活）。
- 删「唯一守卫」断言 → 掉分 0.33 个点并掉出对应突变；删**非唯一**守卫断言不掉分（说明选点要挑唯一守卫）。
- 门禁三分支（低于基线 / 高于基线 / ratchet）逐一验证。
- lint 基线四处定点破坏 → 对应用例变红。
- pre-push stdin 三种形态（已有分支 / 首推 / 多 ref）。

## 本轮要点

- 变异门禁用的是「得分基线 ratchet」（只许升不许降），不是文档原样的 break 60——存量 30% 的仓直接卡 60 等于没接
- 得分与 Stryker / mutmut **不可横向比较**（自研规则集 + 自带算子集），只做本仓前后对比
- 时序套件有 ±1 抖动，对比看存活清单、不看总分；容差 2.0
- lint 基线已按「未来有远程、多分支并行」设计并逐场景写了 14 条判据
- 下一步性价比最高的是补 `String` 类断言（错误文案/指纹串），以及修那 11 个既有红
- 变异门禁**不挂 pre-push**（数十分钟），改测试或改被盯模块时手动跑
