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
- Rust 侧 thiserror 分层：domain 错误（语义）/ infra 错误（IO/DB）；HTTP 层统一映射，永不 500 裸奔（tower CatchPanic 兜底 → 500 带事件留痕）

### 1.2 数据层重设计（Tier 2 全自由）

- **SQLite 严格化**：`STRICT` 表、外键开启 + 级联、CHECK 约束（kind 白名单下沉到库）
- **关系化替换 JSON/CSV 列**：
  - `deployment_files(deployment_id, path, sha256)` 替代 `detail.files` JSON
  - `binding_channels(binding_id, channel)` 替代 CSV 列
  - `binding_exclusions(binding_id, item_name)` 替代 JSON 数组列
  - `event_log` 替代 ops.detail 自由 JSON（结构化列 + payload）
- **内容寻址规范化**：文件级 sha256 入库（现有 tree hash 保留为派生值——由 `deployment_files` 重算，不再手工拼 `\x00\n` 串）；树指纹 = 对 sorted(path,sha) 的 sha256（**新方案自有定义**，迁移时重算基线，不存在兼容负担）
- **版本化迁移**：refinery 式迁移链（V1__init…，带校验和），替代 ensure() 幂等 ALTER 链；`depotd migrate` 子命令
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
- **OpenAPI**：utoipa 从 axum handler 派生 → `/docs` 交互文档 + 导出 TS 类型（前端未来受益）
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
