# Agent Depot · 样式规范（Style Guide）

> 设计方向：**Müller-Brockmann 网格功能主义**（数学网格 · 严格对齐 · 双色方案 · 功能至上）。
> 所有样式必须来自 `web/tokens.css` 的变量；**界面文件（html/app.css/hub-ui.css）中不允许出现游离的十六进制颜色或 px 字号** —— 由 `tests/lint_styles.py` 强制检查。

## 1. 色彩

| Token | 值 | 用途 |
|---|---|---|
| `--c-ink` ~ `--c-ink-4` | 墨色 4 级 | 主文本 → 弱化文本，层级逐级降低 |
| `--c-bg` / `--c-surface` / `--c-surface-2` | 三层表面 | 应用底 / 面板 / 卡片 |
| `--c-line` / `--c-line-soft` | 发丝线 | 分隔线，1px，禁止粗边框 |
| `--c-accent` | `#0d6a63`（深青绿） | **全应用唯一强调色**：主按钮、激活态、链接、徽章 |
| `--c-ok` / `--c-warn` / `--c-err` | 语义三态 | 成功 / 警告 / 失败，**只用于反馈，不用于装饰** |
| `--c-tool-*` | 工具识别色 | 仅用于来源识别点，不参与交互 |

规则：一屏内 accent 强调元素 ≤ 2 处可见；状态色只出现在反馈组件与徽章，不做背景大面积铺色。

## 2. 字号阶梯（仅 7 档）

| Token | px | 用途 |
|---|---|---|
| `--fs-xs` | 10 | 状态栏、时间戳（mono） |
| `--fs-s` | 11 | 标签、徽章、次要元数据 |
| `--fs-body` | 13 | 正文基准 |
| `--fs-m` | 14 | 列表主字、强调正文 |
| `--fs-l` | 16 | 卡片标题、区块题 |
| `--fs-xl` | 20 | 视图标题 |
| `--fs-2xl` | 26 | 应用标题（仅头部） |

规则：不得引入第 8 档；正文行高 1.5–1.6，标题 1.2–1.3。

## 3. 间距（8pt 网格）

`--sp-1:4 · --sp-2:8 · --sp-3:12 · --sp-4:16 · --sp-5:24 · --sp-6:32 · --sp-7:48`
规则：所有内边距/外边距/间隔从中取值；布局尺寸（栅格宽、侧栏宽）允许具体 px。

## 4. 圆角与层级

- 圆角仅 3 档：`--r-s:4`（按钮/输入）· `--r-m:8`（卡片/弹层）· `--r-l:12`（大浮层）
- 层级：`--z-dropdown:40 · --z-modal:50 · --z-toast:60`，不得散落魔法数字
- 阴影克制：仅用 `0 0 0 1px` 描边或极轻阴影；禁止渐变/霓虹

## 5. 反馈与交互规范（全局统一）

| 场景 | 组件 | 行为 |
|---|---|---|
| 操作成功 | `HubUI.toast(msg, 'success')` | 右下角绿色 toast，3.2s 自动消失 |
| 操作失败 | `HubUI.toast(msg, 'error')` | 红色 toast，同位置同动效 |
| 警告/降级 | `HubUI.toast(msg, 'warn')` | 黄色 toast |
| 中性信息 | `HubUI.toast(msg, 'info')` | 墨色 toast |
| 危险/重大确认 | `HubUI.confirm/danger` | 模态框，主按钮用 danger 色，需显式确认 |
| 需要输入 | `HubUI.prompt` | 模态框内嵌输入框，回车确认、Esc 取消 |
| 异步进行中 | `btn.classList.add('is-loading')` | 按钮内嵌 spinner + 禁用；**禁止静默等待** |
| 列表为空 | `.hub-empty` | 统一空态样式：一句话 + 操作提示 |
| 加载中 | `.hub-empty` + "加载中…" | 首屏不得空白 |

规则：**禁止使用原生 `alert/confirm/prompt`**；同类场景（键鼠操作、移动端点击）反馈一致；错误信息必须说明原因与人话建议。

## 6. 组件清单（web/hub-ui.js / hub-ui.css）

`HubUI.toast` · `HubUI.confirm` · `HubUI.prompt` · `HubUI.modal` · `.hub-btn(--primary/--danger/--ghost/is-loading)` · `.hub-input` · `.hub-badge` · `.hub-empty` · `.hub-overlay/.hub-modal`

扩展规则：新组件先加 token，再写样式；组件样式只进 `hub-ui.css`，页面布局样式只进 `app.css`。

## 7. 检查

```bash
python3 tests/lint_styles.py   # 游离色值/字号检查（CI 化）
```
