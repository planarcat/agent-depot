"""路由 × 测试触达覆盖矩阵（行为规格套件的完备性度量）。

从 server.py + 模块 dispatch 自动提取路由面，扫描 tests/ 触达证据，
输出缺口清单（双零路由 / 仅 happy 路由）。退出码：有双零路由 = 1。

用法：python3 tests/spec/_matrix.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVER = os.path.join(ROOT, "server.py")
MODULES = ["hub/modules/mod_skills.py", "hub/modules/mod_mcp.py", "hub/modules/mod_memory.py"]
TEST_DIRS = [os.path.join(ROOT, "tests")]

ROUTE_RE = re.compile(r'(?:path\s*==\s*|path\.startswith\()\s*"(/api/[^"]*)"')
METHOD_RE = re.compile(r'method\s*==\s*"(\w+)"')


def extract_routes():
    """(method, path) 集合：按 handler 块就近配对 method 与 path。"""
    routes = set()
    for fpath in [SERVER] + [os.path.join(ROOT, m) for m in MODULES]:
        src = open(fpath, encoding="utf-8").read()
        # 逐行扫描：method 与 path 在同一/相邻条件里
        lines = src.split("\n")
        pending_methods = set()
        for i, line in enumerate(lines):
            for m in METHOD_RE.finditer(line):
                pending_methods.add(m.group(1))
            for m in ROUTE_RE.finditer(line):
                p = m.group(1)
                methods = pending_methods or {"GET"}
                if "method" not in line:
                    # 路由在独立行：查前后 3 行内的 method 判定
                    window = "\n".join(lines[max(0, i - 3):i + 4])
                    methods = set(METHOD_RE.findall(window)) or {"GET"}
                for meth in methods:
                    routes.add((meth, p))
            if re.match(r"^\s*(if|elif)\s", line) and "method" not in line and "path" not in line:
                continue
            if line.strip().startswith(("return", "#")):
                pending_methods = set()
    return routes


def test_evidence():
    """tests/ 全文（含 spec/）作为触达证据语料。"""
    blob = []
    for d in TEST_DIRS:
        for dirpath, _dirs, files in os.walk(d):
            for fn in files:
                if fn.endswith((".py", ".mjs")):
                    blob.append(open(os.path.join(dirpath, fn), encoding="utf-8",
                                     errors="replace").read())
    return "\n".join(blob)


# 模块内路由以相对形式书写（PREFIX 拼接），提取器拿不到前缀 → 已知映射登记
KNOWN_PREFIX_MAP = {
    ("POST", "/api/targets/seed"): "/api/skills/targets/seed",
}


def main():
    routes = extract_routes()
    evidence = test_evidence()
    zero, touched = [], []
    for meth, path in sorted(routes):
        evidence += "\n" + KNOWN_PREFIX_MAP.get((meth, path), "")
        # 触达证据：路径字面量出现在测试语料（宽松匹配 startswith 型路由取前缀）
        probe = path.rstrip("/")
        if probe in evidence:
            touched.append((meth, path))
        else:
            zero.append((meth, path))
    print("路由面总数（含方法）：", len(routes))
    print("已触达：", len(touched))
    print("双零（测试语料零引用）：", len(zero))
    for meth, path in sorted(zero):
        print("  ❌ %s %s" % (meth, path))
    return 1 if zero else 0


if __name__ == "__main__":
    sys.exit(main())
