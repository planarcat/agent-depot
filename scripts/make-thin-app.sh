#!/bin/bash
# 薄壳（回退方案）：零依赖 .app —— 启动器确保服务运行 + Chrome 应用模式窗口。
# 说明：Tauri 壳已于 2026-09-22 落地（scripts/make-app.sh + desktop/ 工程）；
# 本脚本保留为零依赖回退（输出 ~/Applications/AgentDepot-thin.app）。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/AgentDepot-thin.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Agent Depot</string>
  <key>CFBundleDisplayName</key><string>Agent Depot</string>
  <key>CFBundleIdentifier</key><string>local.planarcat.agent-depot</string>
  <key>CFBundleVersion</key><string>0.5.0</string>
  <key>CFBundleShortVersionString</key><string>0.5.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>LSUIElement</key><false/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/launcher" <<LAUNCH
#!/bin/bash
# Agent Depot 启动器：确保服务运行，然后以独立窗口打开控制台
REPO="$REPO"
cd "\$REPO" || exit 1
./run.sh >>.hub.log 2>&1
if [ "\${HUB_SKIP_OPEN:-0}" = "1" ]; then exit 0; fi
if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="http://127.0.0.1:8317" --window-size=1480,960
else
  open "http://127.0.0.1:8317"
fi
LAUNCH
chmod +x "$APP/Contents/MacOS/launcher"
echo "built: $APP"
