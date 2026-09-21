#!/usr/bin/env python3
"""Style lint: enforce the design system.

Rules:
- No hex colors in app files (html / app.css / hub-ui.css) — tokens only.
- No hardcoded px font-size in app files.
- tokens.css is the single source of truth (exempt).
"""
import re
import sys
import glob
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_FILES = ["web/index.html", "web/app.css", "web/hub-ui.css"]
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
FS_PX = re.compile(r"font-size\s*:\s*\d+(\.\d+)?px")

# allowed exceptions: none by default
ALLOW = {
    # white for spinner rings etc is expressed via var(); keep strict.
}

def main():
    violations = []
    for rel in APP_FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        for ln, line in enumerate(open(path), 1):
            stripped = line.strip()
            if stripped.startswith("<!--") or stripped.startswith("*") or stripped.startswith("/*"):
                continue
            for m in HEX.finditer(line):
                violations.append(f"{rel}:{ln} hex color {m.group(0)} → use var(--c-*)")
            for m in FS_PX.finditer(line):
                violations.append(f"{rel}:{ln} px font-size → use var(--fs-*)")
    if violations:
        print("STYLE LINT FAILED (%d violations):" % len(violations))
        for v in violations[:40]:
            print("  -", v)
        return 1
    print("STYLE LINT PASSED: %d files, no hardcoded colors/font-sizes" % len(APP_FILES))
    return 0

if __name__ == "__main__":
    sys.exit(main())
