#!/usr/bin/env python3
"""[钉桩] 测试软改松检查 —— 扫描测试文件里的 skip / only / todo。

能力边界：只做文本断言，不解析 AST；
覆盖不了「动态拼接出来的 skip」和「用 if 包住整个用例」（那类要靠代码审查）。
用途：测试是判据 —— unittest.skip / it.only / xit 这类软改松 = 判据悄悄失效。
这里一律红灯，逼着走「解锁 + 留痕」的正门：
  真需要跳过时，在那一行加 `spec-guard: allowed <为什么>` 就是留痕（会在输出里列出来）。

用法：python3 scripts/check_spec_guards.py
来源：Docs/AI开发质量体系-落地方指南.md §三 第 4 条（由 JS 版 checkSpecGuards.mjs 适配）。
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
SKIP_DIRS = {"__pycache__", "evidence"}  # evidence = 产出物，不是判据

# 逐行扫描：注掉整行不算（防止文档性注释误报）
PATTERNS = [
    (re.compile(r"@\s*unittest\s*\.\s*(?:skip|skipIf|skipUnless|expectedFailure)\b"), "unittest.skip"),
    (re.compile(r"@\s*(?:pytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)|pytest\s*\.\s*skip)\b"), "pytest.skip"),
    (re.compile(r"\bunittest\s*\.\s*skip(?:If|Unless)?\s*\("), "unittest.skip(...)"),
    (re.compile(r"\bself\s*\.\s*skipTest\s*\("), "self.skipTest(...)"),
    (re.compile(r"@\s*(?:skip|skipIf|skipUnless)\s*\("), "裸 skip 装饰器"),
    (re.compile(r"\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo|fails)\b"), "skip/only/todo"),
    (re.compile(r"\b(?:xit|xdescribe|xtest)\s*\("), "xit/xdescribe/xtest"),
]
ALLOW_MARK = "spec-guard: allowed"
COMMENT_RE = re.compile(r"^\s*(?:#|//|\*|/\*)")


def is_test_file(name: str) -> bool:
    return name.endswith(".py") or name.endswith(".mjs")


def collect_files() -> list[str]:
    files = []
    for base, dirs, names in os.walk(TESTS):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            if is_test_file(n):
                files.append(os.path.join(base, n))
    return sorted(files)


def main() -> int:
    if not os.path.isdir(TESTS):
        print("[钉桩] check_spec_guards：仓里没有 tests/ → 不检查（不新建空目录凑数）")
        return 0

    files = collect_files()
    violations: list[str] = []
    allowed: list[str] = []

    for path in files:
        rel = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as fh:
            for ln, line in enumerate(fh.read().split("\n"), 1):
                if COMMENT_RE.match(line):
                    continue
                for rex, label in PATTERNS:
                    m = rex.search(line)
                    if not m:
                        continue
                    hit = f"{rel}:{ln} 出现 {label}（{m.group(0).strip()}）"
                    if ALLOW_MARK in line:
                        allowed.append(hit)
                    else:
                        violations.append(hit)
                    break  # 一行只报一次（同一行可能命中多条规则，重复报是噪音）

    for a in allowed:
        print(f"· 留痕放行 {a}")

    for v in violations:
        print(f"✗ {v} —— 测试被软改松，走解锁+留痕的正门")

    print(
        f"\n[钉桩] check_spec_guards：{len(files)} 个判据文件扫完，"
        f"软改松 {len(violations)} 处（留痕放行 {len(allowed)} 处）"
    )
    if violations:
        print("自救：① 测试文件改不动 = 被锁 → bash scripts/unlock-tests.sh（改完锁回）")
        print("     ② 确实必须跳过 → 同一行加 `spec-guard: allowed <理由>`，并在 commit message 写清口径")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
