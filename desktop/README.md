# Agent Depot · 桌面壳（Tauri）

原生 macOS 窗口壳：启动时**确保本地服务（127.0.0.1:8317）在跑**（幂等，未运行则执行仓库 `./run.sh`），
然后用系统 WKWebView 加载控制台；服务不可用时显示内置提示页。

- 运行时零第三方依赖：渲染用系统 WebKit；产物为单文件原生二进制（约 10 MB）
- 构建期依赖：Rust 工具链（~/.cargo）+ tauri-cli（本目录 node_modules），仅重打包时需要
- 关窗 ≠ 停服务；停服务用仓库根 `./stop.sh`（与薄壳时代语义一致）
- 本机实测：tauri 2.11.6 · Rust 1.98.1 · 不再依赖浏览器窗口

## 构建 / 重装

```bash
bash scripts/make-app.sh     # 仓库根执行：编译 + 安装到 ~/Applications/AgentDepot.app（旧版自动移入废纸篓）
```

仅构建（不安装）：

```bash
cd desktop
PATH="$HOME/.cargo/bin:$PATH" ./node_modules/.bin/tauri build
# 产物：src-tauri/target/release/bundle/macos/Agent Depot.app
```

## 工作原理

1. `src-tauri/src/main.rs` 启动探测 `127.0.0.1:8317`；未运行则 `bash -c "cd <repo> && ./run.sh"`（幂等），随后最多轮询 6s
2. 服务可用 → 创建窗口（1480×960）加载 `http://127.0.0.1:8317`
3. 服务不可用 → 加载内置提示页（前端资源嵌入于二进制，源在 `ui/index.html`）
4. 仓库路径默认 `~/Documents/Projects/@planarcat/agent-depot`，可用环境变量 `AGENT_DEPOT_REPO` 覆盖

## 修改指南

| 想改什么 | 改哪里 |
|---|---|
| 窗口标题 / 尺寸 | `src-tauri/src/main.rs`：`.title()` / `.inner_size()` |
| 应用图标 | 替换 `assets/icon-source.png`（1024×1024；可用 `assets/gen_icon.py` 重新生成），然后 `./node_modules/.bin/tauri icon assets/icon-source.png` |
| 端口 | `src-tauri/src/main.rs` 的 `PORT`（与 `run.sh` 的 `HUB_PORT` 保持一致） |
| 版本号 | `package.json` · `src-tauri/Cargo.toml` · `src-tauri/tauri.conf.json` 三处同步 |
| 提示页文案 | `ui/index.html` |

## 国内网络（构建镜像）

- Rust 工具链：`RUSTUP_DIST_SERVER=https://rsproxy.cn`、`RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup`
- crates 源：`~/.cargo/config.toml` → rsproxy sparse（`sparse+https://rsproxy.cn/index/`）
- tauri-cli：`npm --registry=https://registry.npmmirror.com install`

## 回退

薄壳（零依赖，Chrome 应用模式窗口）仍可用：`bash scripts/make-thin-app.sh` → `~/Applications/AgentDepot-thin.app`。
