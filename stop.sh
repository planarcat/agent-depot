#!/bin/bash
# 停止 depotd（本地服务；客户端窗口关闭不影响服务，停服务用本脚本）
pkill -f "depotd/target/debug/depotd serve" 2>/dev/null && echo "depotd 已停止" || echo "无运行中的 depotd"
