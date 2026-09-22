#!/bin/bash
# 创建可复现的演示用「远程」Git 源仓库（本地 git，无需网络）
set -euo pipefail
BASE="$HOME/Documents/Projects/@planarcat"
SK="$BASE/hub-demo-src-skills"
MC="$BASE/hub-demo-src-mcp"

make_skills() {
  rm -rf "$SK"; mkdir -p "$SK"; cd "$SK"; git init -q -b main
  mkdir -p skills/commit-convention skills/code-review
  cat > skills/commit-convention/SKILL.md <<'MD'
---
name: commit-convention
description: "生成遵循 Conventional Commits 的提交信息；团队提交前缀与变更日志规范"
version: 1.0.0
---

# 提交规范 Skill（演示）

## 用法
- 生成 commit message 时遵循 `<type>(<scope>): <subject>`；
- type ∈ feat / fix / docs / refactor / test / chore；
- subject 用祈使句、≤ 50 字符。
MD
  cat > skills/commit-convention/reference.md <<'MD'
# 示例
feat(search): add fuzzy matching to session filter
fix(parser): handle trailing partial line in JSONL tail
MD
  cat > skills/code-review/SKILL.md <<'MD'
---
name: code-review
description: "代码评审清单：安全、性能、可读性、测试覆盖四个维度"
version: 0.2.0
---

# Code Review Skill（演示）

## 检查清单
1. 安全：密钥/注入/越权
2. 性能：N+1、重复 IO
3. 可读性：命名、附带上下文
4. 测试：边界与失败路径
MD
  git add -A
  git -c user.name=demo -c user.email=demo@demo commit -qm "v1.0 initial skills"
  echo "built: $SK"
}

make_mcp() {
  rm -rf "$MC"; mkdir -p "$MC"; cd "$MC"; git init -q -b main
  mkdir -p mcp
  cat > mcp/mcp.json <<'JSON'
{
  "mcpServers": {
    "demo-time": {
      "command": "python3",
      "args": ["-m", "demo_time_mcp"],
      "env": {"DEMO_MODE": "1"}
    },
    "demo-http": {
      "type": "http",
      "url": "https://example.invalid/demo/mcp",
      "headers": {"Authorization": "Bearer ${DEMO_API_KEY}"}
    }
  }
}
JSON
  git add -A
  git -c user.name=demo -c user.email=demo@demo commit -qm "mcp catalog v1"
  echo "built: $MC"
}

make_skills
make_mcp
