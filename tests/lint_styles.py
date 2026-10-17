#!/usr/bin/env python3
"""Style lint: enforce the design system.

Rules:
- No hex colors in app files (html / app.css / hub-ui.css) — tokens only.
- No hardcoded px font-size in app files.
- No bare-number z-index (use var(--z-*)); `0` / `-1` allowed as resets.
- tokens.css is the single source of truth (exempt).

详见 DESIGN.md §11 禁止项。
"""
import re
import sys
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_FILES = ["web/index.html", "web/app.css", "web/hub-ui.css"]
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FS_PX = re.compile(r"font-size\s*:\s*\d+(\.\d+)?px")
ZINDEX = re.compile(r"z-index\s*:\s*(-?\d+)")
ZINDEX_ALLOW = {"0", "-1"}

# allowed exceptions: none by default
ALLOW = {
    # white for spinner rings etc is expressed via var(); keep strict.
}

def scan_file(rel):
    """扫单个文件，返回违规条目列表（不存在则为空）。
    供 scripts/lint_baseline.py 复用——规则只在本文件定义一份，避免两处打架。"""
    violations = []
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return violations
    for ln, line in enumerate(open(path, encoding="utf-8"), 1):
        stripped = line.strip()
        if stripped.startswith("<!--") or stripped.startswith("*") or stripped.startswith("/*"):
            continue
        for m in HEX.finditer(line):
            violations.append(f"{rel}:{ln} hex color {m.group(0)} → use var(--c-*)")
        for m in FS_PX.finditer(line):
            violations.append(f"{rel}:{ln} px font-size → use var(--fs-*)")
        for m in ZINDEX.finditer(line):
            if m.group(1) in ZINDEX_ALLOW:
                continue
            violations.append(f"{rel}:{ln} bare z-index {m.group(1)} → use var(--z-*)")
    return violations


def main():
    violations = []
    for rel in APP_FILES:
        violations.extend(scan_file(rel))
    if violations:
        print("STYLE LINT FAILED (%d violations):" % len(violations))
        for v in violations[:40]:
            print("  -", v)
        return 1
    print("STYLE LINT PASSED: %d files, no hardcoded colors/font-sizes/z-index" % len(APP_FILES))
    return 0

if __name__ == "__main__":
    sys.exit(main())
