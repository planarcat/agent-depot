# Agent Depot · 前端（web/）

零框架、零运行时依赖的单页应用：**TypeScript + Bun（构建/测试/运行时）+ Biome**。  
后端只提供 JSON API 与静态文件（`depotd` 优先服务 `web/dist/`，无产物时回退源码目录）。

## 命令

| 命令 | 作用 |
|---|---|
| `bun run build` | `bun build` 打包到 `web/dist/`：minify + 按视图 code splitting + 外置 sourcemap + 内容哈希 |
| `bun run typecheck` | `tsc --noEmit`（src 严格配置）+ `tsc -p tsconfig.test.json`（测试含 Bun 类型） |
| `bun run lint` / `bun run lint:fix` | Biome：格式 + 规则（a11y/correctness/suspicious/security 为 error） |
| `bun test` | 单元/组件测试（happy-dom 预载，`tests/`） |
| `bun run test:cov` | `bun test --coverage` + `scripts/coverage-gate.ts`（core 行/函数 ≥90%） |
| `bun run budget` | 产物体积门禁 + 完整性检查（入口/CSS 引用、chunk 可解析、文件名哈希） |
| `bun run check` | lint + typecheck + test + budget（本地快检） |
| `bun run check:ci` | lint + typecheck + build + budget + test:cov（`tests/check.sh` 调这个） |

> 首次拉分支先 `bun install`（依赖只在 `web/node_modules`，不进仓库）。

## 目录

```
src/
├─ main.ts            入口：会话视图 / SSE 实时刷新 / 导航 / 视图懒加载 / 全局桥接
├─ hub-ui.ts          HubUI：toast / modal / confirm / prompt / select / drawFrames
├─ core/
│  ├─ api.ts          fetch 封装：超时、ApiError 归一、慢请求上报钩子
│  ├─ validate.ts     零依赖运行时守卫（str/num/obj/arr/oneOf…）
│  ├─ types/api.ts    全量接口契约（响应形状的单一真源）
│  ├─ state-machine.ts 连接画布四态机（纯函数，无 DOM）
│  ├─ mv.ts           版式组件库（卡片 / 目标选择 / 条目行 / 骨架）
│  ├─ dom.ts          类型安全 DOM 原语
│  ├─ format.ts       转义与格式化
│  ├─ report.ts       前端可观测：错误 / 慢请求 / 慢渲染 → 台账上报
│  ├─ view-loader.ts  视图动态 import 注册表（code splitting 切点）
│  └─ actions.ts      应用动作注册表（打断 main ↔ views 循环依赖）
└─ views/             connect / skills / mcp / memory / ops / settings / stats
tests/                单元与 happy-dom 组件测试（setup 由 bunfig.toml preload）
../scripts/build-frontend.ts / frontend-budget.ts / coverage-gate.ts
```

## 构建产物协议（depotd 依赖）

- 入口命名 `main-<hash>.js`；共享 chunk `chunk-<hash>.js`；视图按 `import()` 自动分块。
- CSS 三件套按内容哈希复制：`tokens-*` / `hub-ui-*` / `app-*`。
- `dist/index.html` 由 `web/index.html` 生成，只引用带哈希的入口与 CSS。
- `dist/manifest.json` 记录入口、CSS、字节数与文件清单（budget/排障用）。
- 带哈希资源响应 `Cache-Control: public, max-age=31536000, immutable`；`index.html` 不缓存。
- 安全头由 depotd 统一注入：CSP `default-src 'self'`、`nosniff`、`no-referrer`；
  `style-src` 保留 `'unsafe-inline'`（现有大量 `style="--var:…"` 内联写法，移除需全量样式重构）。

## 代码约定（评审会打回的点）

1. **动态文本进 innerHTML 必须 `esc()`**——它转义 `& < > " '`，属性值与文本节点同一口径。
2. **接口响应形状变化先改 `core/types/api.ts`**；关键响应用 `validate` 守卫，失败抛 `ApiError(kind=shape)`。
3. **视图不直接 `fetch`**——一律走 `core/api.ts`；失败按 `ApiError.kind` 分支处理。
4. **视图只通过 `appActions()` 反向调 main**，不得 `import main.ts`。
5. 新增视图：在 `core/view-loader.ts` 注册动态 import，`mountView` 自动懒加载；不要再加静态 import。
6. 大列表用分批渲染（会话列表首屏 100 行 + 触底追加）；重渲染路径用 `measureRender` 包住。
7. SSE 断线由 `scheduleSseReconnect` 指数退避（1s→30s，±20% 抖动），不要改回 EventSource 原生重连。
8. 不引入运行时依赖；工具链依赖只进 `devDependencies`。

## 设置页（v0.6.0）

- **通用**（`core/prefs.ts`，localStorage `agent-depot.prefs.v1`）：会话列表每批行数、SSE 断线轮询间隔、默认启动视图、会话默认布局、
  首次进入记忆页自动扫描、前端错误上报开关；「恢复默认」清空本地偏好。
- **桌面**（`core/desktop.ts`，仅 Tauri 壳内可用）：开机启动、菜单栏挂载、静默启动、Dock 图标。
  通过 `window.__TAURI__.core.invoke` 调 `desktop_get_settings` / `desktop_set_settings`，持久化在
  桌面壳的 `desktop.json`；浏览器打开时显示「桌面客户端专属设置」占位。
- 新增偏好：加字段到 `Prefs` + `DEFAULT_PREFS` + `sanitize`，UI 在 `settings.ts` 的 `renderGeneral()`。

## 可观测

- 未捕获异常 / unhandledrejection / 慢请求（>2s）/ 慢渲染（>阈值）批量 POST `/api/frontend-errors`。
- depotd 写入 `event_log(module='frontend')`，在「台账」页把模块筛选切到 `frontend` 可见；
  单批 ≤50 条、message ≤200 字符、限流 30 批/分钟。
- 关页时用 `sendBeacon` 冲掉最后一批缓冲。
