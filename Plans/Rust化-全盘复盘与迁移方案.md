# Agent Depot · 全盘复盘与 Rust 化迁移方案（纯 Rust 重建版）

> 2026-11-07 定稿 · 用户决策：**不考虑回退，完全去 Python，纯 Rust 化**
> 基于当前工作树实测数据（10,838 行后端 / 10,504 行前端 / 52 条路由）

---

## 一、全盘复盘

### 1.1 项目演化史

| 阶段 | 版本 | 交付 |
|---|---|---|
| 起点 | v0.1–v0.3 | 会话采集（多工具）→ 内容搜索 → 导出/收藏/resume |
| 资产化 | v0.4 | Skills & MCP 一等公民：sources → pull → registry → distribute |
| 工具化 | v0.5–v0.6 | 工具实体（可插拔 registry）、记忆分发线、附件、清理/备份 |
| 合并页 | v1.0 | 连接画布（目录×通道×工具）、绑定通道模型、暂存确认流 |
| 本周 | — | 线状态机定稿（绿实/绿虚/灰虚/无连线）、容器目录自动发现、资源指纹 |

### 1.2 架构现状（实测）

```
后端 10,838 行 Python · 纯标准库 · 零 pip 依赖 · 52 条路由
├─ server.py            1,318  HTTP + SSE + 事件 worker + 路由分发
├─ hub/modules/
│  ├─ mod_skills.py     2,241  分发/绑定/版本链/收编/容器发现（语义最重）
│  ├─ mod_mcp.py        1,306  mcp_json/mcp_toml 注入、registry、回退
│  └─ mod_memory.py       544  记忆采集/写回/漂移
├─ hub/scanners.py      1,404  各工具会话文件解析（JSONL/SQLite 多格式）
├─ hub/watcher.py         514  kqueue/FSEvents/inotify/watchdog 四后端
├─ hub/store.py           603  SQLite WAL 封装（单写锁）
├─ hub/attachments.py     558  会话附件
├─ hub/tools_registry.py  427  可插拔工具实体
├─ hub/core/            1,300+ local_dirs(容器发现)/remote_repos/schema/fsutil/ops/registry
└─ hub/lib/               438  catalog/mcpverify/gitsrc
前端 10,504 行 JS/CSS · 零框架 · 只认 /api/*（与后端语言完全解耦）
测试  unittest 套件 ×6 + 变异门禁 + lint 基线 + CDP e2e 19 场景（HTTP 层）
```

### 1.3 核心语义资产（重写必须逐条复现的行为契约）

1. **分发语义**：conflict / adopt / skipped / drift 四态、逐文件原子写、`.hub-backup` 备份、托管清单 `{rel: sha256}`
2. **版本链**：`prev_hash/prev_version` 链、versions 快照、回退互转存
3. **清理语义**：绑定级反向清理只认 `deployments.detail.binding` 打标；排除条目保留工具内文件
4. **MCP 注入**：JSON 嵌套 key（`mcp.servers`）+ TOML `hub:begin/end` 块、手改检测（toml_edit 保注释）
5. **容器发现**（本周新增）：layout 重算、sub_path、普通/容器双模式
6. **扫描器**：各工具会话格式解析（历史包袱最重）
7. **hash 体系**：`tree_hash_from_files` / `_dir_sig` 指纹缓存——**必须逐字节复现**，否则存量库全部误判漂移
8. **台账**：ops 表结构 + 每类操作的 detail 字段（前端台账页直接渲染）

### 1.4 痛点分级（本会话实证）

| 级别 | 痛点 | 根因 | Rust 化后 |
|---|---|---|---|
| P0 | SIGSEGV / SQLite 卡死 | Apple dylib libsqlite3 病态 | **根治**（rusqlite bundled） |
| P1 | 并发脆弱 | GIL + ThreadingHTTPServer | **根治**（tokio） |
| P2 | 分发形态 | 依赖系统 Python 3.9 | **根治**（单二进制） |
| P3 | 单测/变异慢 | 动态语言反噬 | 改善（cargo test / cargo-mutants） |

### 1.5 方法论教训（重写期继承）

- 验证必须在用户真实视口/状态下做（含悬停、滚动位置）；静态截图不够
- 可验证性内建：`data-build` 构建标记 + 资源指纹机制在 Rust 侧复刻
- 每改一处 grep 确认关键行仍在（批量替换曾静默还原已完成修改）

---

## 二、纯 Rust 重建方案

### 2.0 总原则（用户决策 2026-11-07）

- **不做双栈、不做转发、不留回退开关**。Python 在重写期冻结为**行为基准**（继续运行供对照），Rust 重建到全部判据通过后**一刀切换**，随后删除全部 Python 后端代码
- **行为契约的唯一真源** = 现有 6 个判据套件（约 130 用例）+ e2e 19 场景 + 本文档 1.3 节八条契约
- **数据零迁移**：同一 hub.db、schema/`deployments.detail`/layout JSON 逐字节保持
- **前端零改动**：/api/* 路由、SSE 事件、资源指纹、构建标记全部对位复刻

### 2.1 技术选型（定调）

| 领域 | 选型 | 对位 |
|---|---|---|
| HTTP/SSE | tokio + axum | server.py http.server |
| DB | rusqlite + `bundled`（自编译 sqlite） | sqlite3 + WAL；P0 根治 |
| 写并发 | 单写连接 + tokio Mutex（对位现有单写锁语义） | store.py |
| 文件监听 | notify（kqueue/FSEvents/inotify） | watcher.py 四后端 |
| 序列化 | serde / serde_json | json |
| TOML 编辑 | toml_edit（保注释，对位 hub:begin/end 块） | mod_mcp._toml_block |
| 哈希 | sha2 + 自实现 tree_hash（遍历序对齐 Python 版） | fsutil |
| git | 继续子进程调 git CLI（parity 优先，git2 后续可选） | gitsrc.py |
| 原生选择器 | 继续子进程调 osascript | local_dirs.pick_native |

### 2.2 工程结构

```
depotd/
├─ Cargo.toml                 # workspace
└─ crates/
   ├─ depot-core/             # store(WAL/schema) + fsutil(hash/atomic/backup) + paths + ops 台账
   ├─ depot-skills/           # registry + 版本链 + 分发四态 + 绑定 + 容器发现
   ├─ depot-mcp/              # registry + 注入 + 回退
   ├─ depot-memory/           # 记忆采集/写回/漂移
   ├─ depot-sessions/         # 各工具会话解析（scanners.py 对位）
   ├─ depot-watch/            # notify 封装 + 事件 worker
   └─ depotd/                 # bin：axum 52 路由 + SSE + 资源指纹 + build 标记
```

### 2.3 重写步骤（六步，依赖序）

**S1 · 基础层 + 哈希黄金对齐**（约 1 周）
- depot-core：schema 全量建表/迁移、WAL、单写锁；fsutil 的 `tree_hash_from_files`/`atomic_write_bytes`/`backup_file`
- **黄金样本门**：对本机存量 hub.db 全部 registry 条目 + 每个已部署 target，Rust 算出的 hash 与 Python 侧逐条 diff 为空才算过——这一步不过，后面全部免谈
- 验收：core 单测（schema 往返、原子写、备份语义）+ 黄金样本 100% 对齐

**S2 · 语义核心 skills + mcp**（约 2 周，最大块）
- depot-skills：registry/版本链/分发四态/绑定/容器发现/收编/删除清理；depot-mcp：注入/回退
- 现有 test_skills(40)/test_mcp(21)/test_manual_mcp(6) 判据**逐条转 cargo test**（这是行为一致性的判据本体）
- 验收：三个 crate 判据全绿；对同一份临时目录夹具，Rust 分发结果与 Python 逐文件 diff 为空

**S3 · 监听 + worker + SSE**（约 1 周）
- depot-watch：notify 三后端 + 事件合并抖动 + 启动兜底扫描（对位 watcher.py 全部边界用例）
- SSE 流（事件负载逐字节同 Python）+ 绑定事件驱动同步 worker
- 验收：watcher 边界判据移植全绿；SSE 事件序列与 Python 对照录制 diff

**S4 · HTTP 全量 52 路由**（约 1 周）
- axum 按模块组挂载全部路由；资源指纹（?v=mtime）、`data-build` 标记、SSE、静态子树防穿越
- **e2e 19 场景直打 Rust**（改 base URL 即可）——这是切换的总闸门
- 验收：e2e 19/19 + 台账/统计页数据与 Python 版逐字段一致

**S5 · 长尾**（约 1–2 周）
- depot-sessions（scanners.py：各工具 JSONL/SQLite 解析，格式脏、逐工具移植）、memory、attachments、migrator、tools_registry
- 验收：内容搜索/记忆/附件相关判据转 cargo test 全绿；e2e 内容搜索场景通过

**S6 · 切换与退役**（约 2–3 天）
- `cargo build --release` 单二进制在干净 Mac 上跑通全部 e2e → 切换日常使用
- 观察一周后**删除 server.py 与 hub/**（git 历史即回溯）；判据套件 Python 版退役，判据本体已活在 cargo test
- lint 基线对 CSS/JS 的检查保留（脚本与本语言无关）

### 2.4 里程碑与投入

| 步 | 产出 | 全职工时 | 风险 |
|---|---|---|---|
| S1 | 基础层 + 哈希黄金对齐 | 1 周 | 中（对齐标准硬） |
| S2 | 语义核心 | 2 周 | **高（契约最重，判据护航）** |
| S3 | 监听/worker/SSE | 1 周 | 中 |
| S4 | HTTP 全量 | 1 周 | 低（e2e 总闸门） |
| S5 | 长尾 | 1–2 周 | 中（会话格式脏） |
| S6 | 切换退役 | 2–3 天 | 低 |
| 合计 | 单二进制纯 Rust | **6–8 周** | 期间 Python 冻结只修 P0 级故障 |

预计代码量 14–18k 行 Rust。重写期间**功能冻结**（用户已决策接受）；画布 UI 类改动不受影响（前端独立）。

### 2.5 明确不做

- 不移植已删除口径（创建目录等）
- 不改任何数据格式与前端行为
- 不引入 git2/新依赖替代子进程方案（parity 优先）
