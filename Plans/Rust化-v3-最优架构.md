# Agent Depot · Rust 化方案 v3 —— 最优架构重建

> 2026-11-07 v3 · 用户口径升级：**不以现有实现/代码/架构为历史包袱**，按最优设计重建；
> 避免为兼容旧实现选择有副作用的胶水手段；基建（测试/门禁/检查/辅助开发）一步到位；
> 健壮性、性能、开发便利、产物体验、错误留痕最大化。
> v1/v2（逐字节兼容 strangler）作废；复盘部分（§1）仍有效。

---

## 〇、契约分层（本次决策的基石）

| 层 | 内容 | 策略 |
|---|---|---|
| **Tier 1 · 外部契约（冻结）** | 前端消费的 `/api/*` 请求/响应形状（spec 78 条 + e2e 19 场景即其可执行文档） | 重写后必须原样通过；**允许加法演进**（响应加字段、错误加 `code`——前端忽略未知字段，零破坏）；刻意改契约 = 显式改 spec 用例并在 PR 注明 |
| **Tier 2 · 内部自由** | DB schema、内部格式（deployments/ops/manifest/备份）、hash 体系、模块边界、并发模型 | 第一性原理重设计；**一次性迁移器**搬数据 + 重算基线（数据量小：136MB 主要是会话文本） |

不做逐字节兼容 → 卸掉全部历史包袱：JSON 自由格式 detail、CSV 通道列、
"逐字节复现旧 hash"、ensure() 幂等 ALTER 链、error 中文文案即契约。

---

## 一、目标架构

### 1.1 分层（ports & adapters）

```
depotd (bin)
├─ http/        axum 路由 + DTO（Tier 1 契约层，唯一知道 JSON shape 的地方）
├─ app/         用例层：命令（Command）→ 领域服务 → 领域事件
├─ domain/      实体与业务规则（Item/Target/Binding/Deployment/Session/Policy）
├─ infra/
│  ├─ db/       rusqlite 连接管理 + refinery 风格版本化迁移
│  ├─ fs/       内容寻址 + 原子写 + 备份 + safe_rm（能力trait，测试可替身）
│  ├─ watch/    notify 封装 → 防抖事件流
│  └─ git/      子进程 git CLI 封装（pull/clone/log）
└─ events/      领域事件 → 追加日志（SQLite events 表）→ SSE 扇出 + 台账投影
```

**关键模式：命令 → 事件 → 投影**
- 一切写操作 = Command → 服务执行（领域规则校验）→ 成功/失败都**追加领域事件**（含错误码与上下文）
- 台账（ops UI）、SSE、审计全部从事件日志投影——**留痕由构造保证**，不再依赖各处记得 log_op
- 事件表：`(id, ts, actor, kind, subject, payload JSON, outcome, error_code?)`，append-only

**类型化错误（治本 error 文案问题）**
- 每个错误 = 稳定 `code`（如 `DISTRIBUTE_CONFLICT` / `NAME_TRAVERSAL`）+ 机器可读 `detail` + 人类文案（中文）
- HTTP 错误体：`{ok:false, code, message, detail?}` —— `code` 是 Tier 1 契约（spec 断言 code），文案自由
- Rust 侧 thiserror 2.x 分层：domain 错误（语义）/ infra 错误（IO/DB）；HTTP 层统一映射，永不 500 裸奔（`tower-http::catch_panic::CatchPanicLayer` 兜底——注意只覆盖 handler 同步 panic，`spawn_blocking` 任务 panic 由 JoinError 映射 + panic hook 文件 sink 兜底，三者互补）

### 1.2 数据层重设计（Tier 2 全自由）

- **SQLite 严格化**：`STRICT` 表、外键开启 + 级联、CHECK 约束（kind 白名单下沉到库）
- **关系化替换 JSON/CSV 列**：
  - `deployment_files(deployment_id, path, sha256)` 替代 `detail.files` JSON
  - `binding_channels(binding_id, channel)` 替代 CSV 列
  - `binding_exclusions(binding_id, item_name)` 替代 JSON 数组列
  - `event_log` 替代 ops.detail 自由 JSON（结构化列 + payload）
- **内容寻址规范化**：文件级 sha256 入库（`deployment_files` 表）；树指纹**沿用现有算法定义**（sorted path\0sha\n）——该算法定义升格为规格（spec_hash 黄金样本零成本复用，消除 v2 内部矛盾），作为 Tier 2 内部格式不再视为兼容负担
- **版本化迁移**：`rusqlite_migration`（基于 `user_version` + 校验和版本链，SQLite-only 零额外表；
refinery 为多数据库设计过重，不引）替代 ensure() 幂等 ALTER 链；`depotd migrate` 子命令
- **连接模型**：单写连接（串行写，对位现有语义且 SQLite 最优）+ WAL 只读连接池（并发读不阻塞）

### 1.3 并发与性能

- tokio 全异步；IO 密集（hash/复制/扫描）走 `spawn_blocking` + rayon 并行哈希
- 全部外部交互带超时与取消安全（SSE/文件监听/git 子进程）
- 目标：启动 <100ms、空闲内存 <50MB、万文件扫描 <1s、SSE 扇出 O(订阅数)

---

## 二、基建清单（一步到位）

### 2.1 测试与门禁金字塔

| 层 | 工具 | 门槛 |
|---|---|---|
| 单元 | cargo test + test-utils crate（沙箱构造器/夹具/端口分配） | 核心域行覆盖 ≥90% |
| 属性 | proptest（路径处理/hash/清单/原子写崩溃注入） | 每核心模块 ≥1 组 |
| 契约 | **复用 tests/spec/*.py（HUB_BASE 指 depotd）+ e2e 19** | 全绿（Tier 1 闸门） |
| 变异 | cargo-mutants：depot-core/domain 全量 | ≥80%（一步到位，不做 41 过渡） |
| 静态 | clippy `-D warnings` + rustfmt + cargo-deny（依赖许可/漏洞） | 零容忍 |
| 覆盖 | cargo-llvm-cov 报告入 VERIFICATION.md | ≥85% |

### 2.2 辅助开发

- **just 任务簿**：`just dev / test / mutate / cov / migrate / check`（对位 check.sh 语义，双栈期共存）
- **OpenAPI（降级为可选）**：utoipa 5 + utoipa-axum 从第一天带注解（后补最痛苦）；真实收益 = OpenAPI diff 作契约加法演进门禁 + `/docs` 文档 + 路由清单机器可读来源（接替 `_matrix.py`）；**TS 类型导出砍掉**（零框架 JS 前端无消费者）
- **tracing**：每请求 request-id span；错误全带上下文链；`RUST_LOG` 分级
- **调试端点**：`/healthz`（版本 sha/uptime/db 统计/事件水位）、`/readyz`
- **数据探查**：`depotd doctor`（对位现有）、`depotd db inspect`

### 2.3 产物体验

- **单二进制内嵌前端**：rust-embed 打包 `web/`（零外部文件部署；`--web-dir` 覆盖供前端开发）
- 子命令：`depotd serve / migrate / doctor / version`（clap）
- **迁移器**：`depotd migrate --legacy <hub.db>`：建新库 → 搬会话/记忆 → 重算 hash 基线 → **adopt 已部署文件**（校验托管清单，对不上的条目列清单强制重分发确认）
- 跨架构构建：aarch64 + x86_64（macOS），产物带版本 sha
- 崩溃与留痕：panic hook 写事件日志 + 文件；WAL 崩溃恢复自检（启动时 integrity check）
- **Tauri 桌面壳收编**（既有 `desktop/src-tauri`，当前 shell 拉起 Python）：depotd 成熟后
  Tauri 改为原生 spawn/内嵌 depotd（或Sidecar 二进制）——桌面应用彻底脱离 Python 运行时，
  与单二进制产物同源。此为 v3 完成后的产物体验第二阶段，不在六阶段关键路径内

---

## 三、重写步骤（六阶段，契约测试全程护航）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A · 骨架与基建**（3-4 天） | workspace + CI 门禁全开 + axum/healthz + tracing + 事件表/迁移器框架 + rust-embed | 门禁全绿；depotd 可起、可 migrate --help |
| **B · 数据层 + 迁移器**（1 周） | 新 schema + refinery 链 + fsutil 内容寻址 + **legacy 迁移器**（含 adopt） | 迁移本机存量库 → spec 可运行子集（state/sessions 只读面）数据一致 |
| **C · 领域核心**（1.5 周） | skills/mcp 分发/绑定/容器发现，新内部实现 | **spec_dispatch/versioning/bindings/mcp 四套件原样全绿**（Tier 1） |
| **D · watch/SSE/worker**（1 周） | notify + 事件流 + 绑定 worker | spec_sse + live-sse e2e 绿 |
| **E · 全路由 + 长尾**（1.5 周） | 52 路由全量 + sessions/memory/attachments | **spec 78 + e2e 19 全绿** |
| **F · 切换**（2-3 天） | `depotd migrate` 上生产库 → 日常切换 → 观察 1 周 → 删 Python | 干净 Mac 单二进制跑通全部验收 |

总投入 **5.5–7 周**；期间 Python 冻结（只修 P0）；前端不动（Tier 1 契约保护）。

### 与 v2 的关键差异（为何更快更优）

| v2（逐字节兼容） | v3（最优重建） |
|---|---|
| hash 逐字节复现旧方案（高风险胶水） | 迁移器重算基线（零兼容负担，方案更干净） |
| spec 78 条全部原样（含钉 JSON 自由格式） | spec = Tier 1 闸门；内部格式自由重设计 |
| ensure() ALTER 链照搬 | refinery 版本化迁移 + 严格 schema |
| ops JSON 自由 detail | 事件日志结构化（留痕由构造保证） |
| 双栈影子/回退开关 | 不做；一刀切换 + migrate 命令 |

---

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 迁移器漏数据 | 迁移器自带 `--verify`（行数/校验和双向比对）；旧库保留不删，可随时重跑 |
| adopt 误判（工具内文件与清单对不上） | 对不上 → 不静默收编，列清单要求确认（宁可重分发） |
| Tier 1 契约被无意识破坏 | spec 套件进 pre-push；改 spec 用例 = 改契约，须在 PR 说明 |
| Rust 学习曲线拖慢 | crate 边界小而清晰；test-utils 降低写测试成本；mutants 基线用 80% 而非 100% |
| 内嵌前端与开发热更冲突 | `--web-dir` 覆盖 + rust-embed debug 模式直读磁盘 |


---

## 五、四路评审修订（2026-11-07 · 选型/架构并发/迁移数据/测试门禁）

> 四个子代理并行评审（含对 dev 活跃库与存活进程的实测）。以下修订**并入方案正文效力**。

### 5.1 数据现实核查（迁移器的真实输入，实测 dev 活跃库）

| 维度 | 实测 | 迁移器影响 |
|---|---|---|
| 库体量 | 主库 206MB + **WAL 2.9GB（从未 checkpoint）** + sql-trace.log 3.05GB | 迁移必须先 checkpoint TRUNCATE；**只拷 db 文件 = 静默丢 2.9GB** |
| 会话 | 8 工具 654 会话 / 73,328 消息（content 53MB）/ raw 列恒 NULL（可删）| ATTACH+INSERT SELECT 批量搬（秒级），不逐行 Rust 转换 |
| ops | **408,073 行**（detail 19.7MB）——最大表 | 全量入冷表（不展开成 event_log）；event_log 只存迁移后新事件 |
| deployments | 308 条：27 link（files={}）+ **92 条老格式无 mode 键** | adopt 判定兼容两种 detail；link 用 realpath 比对 |
| config 表 | 10 键（tools 自定义覆盖/schedule/modules.enabled）| **漏迁 = 工具同步行为突变**——迁移清单显式列名 |
| schema 漂移 | dev 缺 sub_path/layout 列；user_version=0 | preflight 按 table_info 特征检测，缺列走显式补齐分支 |
| 存活进程 | **4 个 server.py**（1 真 + 3 spec 沙箱残留）；AutoIngest 每秒写库 | quiesce 协议：进程发现→停止→lsof 零句柄验证 |
| 版本链 | prev_hash 链可能本有断点（rollback 交换语义）| verify 如实报告，不修 |

### 5.2 选型修正（并入 §一）

| 项 | 修正 | 理由 |
|---|---|---|
| 防抖 | notify-debouncer-full 0.7（禁手写）| rename 配对/合并/乱序是 notify 生态公认坑源 |
| 迁移 | rusqlite_migration（user_version）| refinery 多库设计过重 |
| 停机 | SSE 用 CancellationToken + select!（hyper#2787：with_graceful_shutdown 对无限流永久阻塞）；Sse::keep_alive 显式配置 | 优雅停机具体模式 |
| panic | CatchPanicLayer（tower-http）+ spawn_blocking JoinError 映射 + panic hook **文件 sink 无条件 / DB 用新开短连接 try 语义**（防写锁内 panic 自锁）+ 滞留事务 rollback | 三层互补 |
| utoipa | 降级为可选（注解从第一天带）；TS 导出砍 | 零框架 JS 无消费者；spec 闸门已足够 |
| request-id | tower_http::request_id（SetRequestId → TraceLayer 层序）| 不自研 |
| depot-core | **lib crate**（depotd 薄 bin）| Tauri 进程内收编（优于 sidecar：免签名/命名/管道/端口四坑）的前提 |
| 版本 | axum 0.8.x / thiserror 2.x / cargo-mutants 27.x / llvm-cov 0.6.x（rustc≥1.87）/ deny 0.20.x | 2026-11 口径 |
| 可选 | blake3（哈希热时）、static-serve、cargo-zigbuild、shadow-rs 版本注入、notify 9.0（FSEvents 修复）| 按需 |

### 5.3 架构八项补强（实现前必须定的语义，并入 §一）

1. **事件发射绑进 Transaction**：`event_log::append(&tx, ..)` 只接受事务引用——编译期保证「状态变更与留痕原子」；写路径统一 `with_write_txn`（BEGIN IMMEDIATE→领域→commit）。infra 失败（DB 忙/盘满）写不了库 → tracing + 文件 sink，HTTP 带 code（显式边界）
2. **FS 副作用两段事件 + 启动 reconcile**：命令接受写 `intent` 事件 → FS 执行 → 第二短事务写 `applied/failed`；启动对 intent 无 applied 的记录按「磁盘现状收敛」修复 + `reconciled` 事件（吸收 Python 启动兜底扫描语义）
3. **SSE = event_log 回放 + Last-Event-ID**：慢订阅者 Lagged → 发 resync/断流 → 客户端重连带 Last-Event-ID → 按 id>cursor 回放（丢事件降级为一次重放查询）；hello/change 契约键钉死（rev=event_log max(id)）；心跳 = `: ping` 注释行（不碰 DB）；`retry: 3000`
4. **命令级串行**：写互斥粒度 = 命令（mpsc 专职执行器），非语句——消除 plan→apply→record 插队竞态；命令内三段：短事务读快照 → spawn_blocking 做 FS/hash（不持锁，rayon 并行）→ 短事务写结果+事件；读池 `query_only=1`；**每连接 PRAGMA**（WAL/synchronous=NORMAL/busy_timeout/foreign_keys）
5. **优雅停机五步序**（stop.sh 发 SIGTERM）：停 accept（10s 硬上限）→ SSE 主动断流 → watcher 停 → 命令排空（deadline）→ `wal_checkpoint(TRUNCATE)` 退出 0
6. **配置三层**：进程级 → `~/.agent-depot/config.toml`；域数据 → DB；优先级 CLI > env(DEPOT_*) > file > default；`doctor config` 输出合并来源；旧 HUB_* → DEPOT_* 映射表进方案
7. **时钟**：事件序只用 id（AUTOINCREMENT）；调度用 tokio interval（单调）；时间戳存 UTC RFC3339；mtime 指纹等值比较不受回拨影响（写明即可）
8. **资源上限**：DefaultBodyLimit、SSE 连接信号量（超限 503 重试）、watch 根数上限、rayon=核数、JSONL 流式解析（不整文件读入）、soft_heap_limit；启动 quick_check（integrity_check 归 doctor）

### 5.4 迁移器修订：六 Phase 完整清单（并入 §B/§2.3）

```
Phase 0 预检（只读）：进程发现（lsof/.hub.pid/端口）· schema 漂移探测（table_info vs 预期）
        · integrity_check · 悬空引用扫描 · WAL 同在校验（拒绝裸 db 输入）
Phase 1 quiesce：停全部旧实例（lsof 零句柄验证）→ wal_checkpoint(TRUNCATE)（最慢步 1-3min）
        → 冷拷贝三件套快照 → 旧库改名 hub.db.legacy-<ts>（物理隔离双写）→ 清理 3GB trace log
Phase 2 建新库：refinery 链跑在新文件名 depot.db（旧 Python 物理上写不到）
Phase 3 搬数据：sessions(含 starred/title_source)+messages（ATTACH+INSERT SELECT）· cursor
        （payload JSON 吸收异构）· config 全表 · sources/remote_repos/snapshots/items ·
        registry_items（版本链）· deployments（detail 原样，adopt 再解构）· dir_bindings（CSV/JSON→表）·
        local_dirs（缺列置 NULL）· lineages+migrations（lid 续号）· memories+memory_items ·
        ledger(4行,标 legacy)；**ops 408k 全量入冷表**（不展开 event_log）
Phase 4 重算基线：deployment 指纹（按 detail.files）· memory hash · registry 条目 hash（就地收编）
Phase 5 adopt：复用分发 plan 引擎四态判定（一致=静默收编 / 漂移=列清单 / 缺失=重分发或记 removed /
        untracked=不收编仅报告）；**两阶段确认**：非交互自动收编无争议项 + 争议项 status=pending_adopt
        → 起服务后前端台账页「迁移待确认」卡片逐条 adopt/redistribute（复用 Web UI，不做 CLI 逐条问）；
        细节坑：排除 .hub-backup 目录 · link 用 realpath · 92 条老格式按 copy · backup 绝对路径保留
Phase 6 verify+交付：分组校验和（per-sid）· 消息 hash 全量重算逐行比对 · 版本链完整性 · 事件序 ·
        计数一致性（漂移只报告）· 源文件存在性 · FK/integrity/ANALYZE · 迁移报告（JSON+人类可读）
        → 迁移完成事件入 event_log
```

**切换 runbook（8 步）**：preflight 报告 → 停全部旧实例（lsof 验证）→ checkpoint+快照+改名 → migrate → verify 全绿（不绿：删 depot.db 修复重跑，旧库未动）→ adopt 非交互收编 → 起 depotd 冒烟 → 前端逐条 adopt 确认。冷恢复路径 = 快照在 + 旧库改名未动 + Python 未删（阶段 F 前）。

### 5.5 Tier 1 契约补充点名（DB 重设计最易破坏的前端契约）

- `/api/ops` 的 detail `{actor, extra}` 包裹结构（ops.js 直接 JSON.parse 渲染）
- `/api/connect` 的 channels/excluded **数组**形状（connect.js 消费）
- `/api/ops/export` CSV 头 `module`（升 Tier 1）

### 5.6 测试与门禁适配清单（阶段 A/B 前清账）

| # | 事项 | 落点 |
|---|---|---|
| T1 | spec 约 1/4 非纯黑盒（磁盘布局断言：registry/.versions/.hub-backup 目录名、time.sleep 钉 1s 分辨率）→ 改纯 HTTP 断言或移 Rust 单测 | 迁移前 |
| T2 | 错误断言升级：assertErr 优先断 `code`（无 code 回退 keyword，双栈期两栈通用）；多状态码「合法形态」逐条收敛单值；「Rust 需显式决策」注释固化成决策表 `docs/contract-decisions.md` | 迁移前 |
| T3 | env 契约 = depotd 验收项：`just spec-rs` 唯一启动器（内置 env 全集拉起 depotd）；外部模式预检「不得出现真实用户目录」；star 用例空转绿修复 | 阶段 A |
| T4 | spec_hash 定位修正：golden **夹具树语言无关化**（build_tree 同构实现），Rust 侧重生成新口径金样本；Python-only 单测（FsutilUnitSpec/DirSigCacheDirect）标注豁免清单 | 阶段 A |
| T5 | criterion 基准三处（万文件树 hash/SSE 扇出/分发判定）+ hyperfine 启动；nightly 对 baseline ±20% | 阶段 A |
| T6 | SSE 测试写法定型进 test-utils（fake 总线单测 + reqwest 流式断言 + timeout 禁裸 sleep）| 阶段 D 前 |
| T7 | 迁移器夹具矩阵：legacy schema 纪元各留最小库（Python 一次性 builder 入 fixtures）+ assert_cmd 子命令测试 | 阶段 B 前 |
| T8 | cargo-mutants 成本写实：只指 domain/app crate（测试不 spawn HTTP）；pre-push 跑 `--in-diff`，全量 nightly；baseline ratchet 脚本对位 mutate.py 惯例 | 阶段 A |
| T9 | 留痕统一：spec-guard: allowed 扩 `.rs`（扫 `#[ignore]`/测试内 `todo!()`）；cargo-mutants 豁免 = `#[mutants::skip]` + 理由行；pre-push 按路径分发（py 卡口/rs 卡口，双触双跑）| 阶段 A |
| T10 | AGENTS.md 补「双栈地图 + Rust 卡口」章节（hub/ 冻结禁重构、Tier 1 = spec+e2e、spec 双模式、rust-toolchain 锁版、决策表链接）| 阶段 A |
| T11 | insta 三落点（OpenAPI 快照/doctor checks/SSE hello）+ `--unreferenced=reject` | 阶段 C 起 |
| T12 | 并发 soak（写不阻塞读/写串行/SSE 1k 订阅/1000 文件风暴）`#[ignore]` + just soak nightly | 阶段 D |
| T13 | `_matrix.py` 死期与接替：OpenAPI 路由清单 + 测试语料零引用检查（语义保留）| 阶段 E |
| T14 | 覆盖率按 crate 分层：domain ≥90% / http ≥60%（契约背书）/ workspace ≥85% | 阶段 A 定 |
