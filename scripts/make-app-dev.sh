#!/bin/bash
# 构建 Agent Depot 开发版桌面壳（独立 bundle id / 独立设置 / 独立 localStorage）
# 产物安装到 ~/Applications/AgentDepot-Dev.app；正式版仍用 scripts/make-app.sh。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$REPO/desktop"
APP="$HOME/Applications/AgentDepot-Dev.app"
BUNDLE="$DESKTOP/src-tauri/target/release/bundle/macos/Agent Depot Dev.app"
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
export AGENT_DEPOT_PROFILE=dev
./node_modules/.bin/tauri build --config src-tauri/tauri.dev.conf.json

if [ ! -d "$BUNDLE" ]; then
  echo "构建产物缺失: $BUNDLE" >&2
  exit 1
fi

if [ -d "$APP" ]; then
  TRASH="$HOME/.Trash/AgentDepot-Dev-$(date +%Y%m%d-%H%M%S).app"
  mv "$APP" "$TRASH"
  echo "旧版已移入废纸篓: $TRASH"
fi

cp -R "$BUNDLE" "$APP"
echo "built: $APP"
