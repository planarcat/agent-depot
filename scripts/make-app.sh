#!/bin/bash
# 构建 Agent Depot 桌面壳（Tauri：原生窗口，启动时确保本地服务后加载控制台）
# 构建期依赖：Rust 工具链（~/.cargo/bin）+ 项目内 tauri-cli（desktop/node_modules）。
# 国内网络镜像：Rust 走 rsproxy.cn；npm 走 npmmirror（详见 desktop/README.md）。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$REPO/desktop"
APP="$HOME/Applications/AgentDepot.app"
BUNDLE="$DESKTOP/src-tauri/target/release/bundle/macos/Agent Depot.app"
mkdir -p "$HOME/Applications"

if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo '缺少 Rust 工具链：以 RUSTUP_DIST_SERVER=https://rsproxy.cn 安装 rustup 后重试' >&2
  exit 1
fi

cd "$DESKTOP"
if [ ! -d node_modules ]; then
  npm --registry=https://registry.npmmirror.com install
fi
export PATH="$HOME/.cargo/bin:$PATH"
export AGENT_DEPOT_PROFILE=release
./node_modules/.bin/tauri build

if [ ! -d "$BUNDLE" ]; then
  echo "构建产物缺失: $BUNDLE" >&2
  exit 1
fi

if [ -d "$APP" ]; then
  TRASH="$HOME/.Trash/AgentDepot-$(date +%Y%m%d-%H%M%S).app"
  mv "$APP" "$TRASH"
  echo "旧版已移入废纸篓: $TRASH"
fi

cp -R "$BUNDLE" "$APP"
echo "built: $APP"
