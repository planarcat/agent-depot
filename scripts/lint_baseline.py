#!/usr/bin/env python3
"""[lint 基线] 只对「本次变更文件」比对样式告警数，任一文件超基线即红。

为什么要基线：全量零容忍（tests/lint_styles.py）在单人单分支时最严；
  一旦有远程仓库、多分支并行，别人分支带进来的存量告警会让所有人的检查一起红，
  而且这和你本次改动无关。基线 = 只登记存量，**新增**才拦。

「本次变更」怎么算（多分支安全）：
  1. 基点 = 下列候选与 HEAD 的 merge-base 中**离 HEAD 最近**的那个：
       $LINT_BASE（pre-push 会传远端 sha）> 上游 @{u} > origin 默认分支 > 本地 main/master
     取「最近」能同时覆盖：上游是自己同名分支、从 main 合并过、rebase 到新 main 之后。
  2. 已提交部分只走 first-parent 链：
       普通提交 → 它改的文件；合并提交 → 只算「与所有父提交都不同」的文件（冲突解决 / evil merge），
       对方分支带进来的文件不算你的。
  3. 未提交部分 = 工作区相对 HEAD 的改动 + 未跟踪文件；
     合并进行中（有 MERGE_HEAD）时，内容与 MERGE_HEAD 一致的文件 = 对方带入，不算。
  4. 规则本身（tests/lint_styles.py）或基线文件被改 → 自动切全量模式。
  5. 不在 git 仓库 / 还没有提交 / 没有任何参照分支（无远程的单机仓）→ 全量模式。

基线只许降、不许静默升：
  --ratchet  把已改善的文件下调到当前值（永不上调）
  --init     基线文件不存在时按当前全量结果生成（已存在则拒绝）
  上调只能手改 scripts/lint-baseline.json —— 提交门禁会拦下，走 LOCAL_GUARD_OK=1 留痕。

用法：python3 scripts/lint_baseline.py [--all] [--explain] [--ratchet | --init]
来源：《AI开发质量体系-落地方指南》§三-3 + §九「合并期 lint:baseline 误报」。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # tests/ 目录被锁，别尝试往里写 __pycache__

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE_REL = "scripts/lint-baseline.json"
RULE_REL = "tests/lint_styles.py"
SELF_REL = "scripts/lint_baseline.py"
BASELINE = os.path.join(ROOT, BASELINE_REL)
FULL_TRIGGERS = {RULE_REL, BASELINE_REL, SELF_REL}


# --------------------------------------------------------------------------- git
def git(*args) -> tuple[int, str]:
    r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=ROOT,
                       capture_output=True, text=True)
    return r.returncode, r.stdout


def git_ok(*args) -> str | None:
    rc, out = git(*args)
    return out.strip() if rc == 0 else None


def names_z(out: str) -> list[str]:
    return [x for x in out.split("\0") if x]


def resolve_base() -> tuple[str | None, str]:
    """返回 (基点 commit | None, 说明)。None = 没有可用提交（全量）。"""
    if git_ok("rev-parse", "--is-inside-work-tree") != "true":
        return None, "不在 git 仓库"
    head = git_ok("rev-parse", "-q", "--verify", "HEAD^{commit}")
    if not head:
        return None, "仓库还没有任何提交"

    cands: list[tuple[str, str]] = []
    env_base = os.environ.get("LINT_BASE", "").strip()
    if env_base:
        cands.append(("$LINT_BASE", env_base))
    up = git_ok("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    if up:
        cands.append(("上游 " + up, up))
    origin_head = git_ok("symbolic-ref", "-q", "refs/remotes/origin/HEAD")
    if origin_head:
        cands.append(("origin 默认分支 " + origin_head.replace("refs/remotes/", ""), origin_head))
    for b in ("main", "master"):
        ref = "refs/remotes/origin/" + b
        if git_ok("rev-parse", "-q", "--verify", ref):
            cands.append(("origin/" + b, ref))
    current = git_ok("symbolic-ref", "-q", "--short", "HEAD")
    for b in ("main", "master"):
        if b != current and git_ok("rev-parse", "-q", "--verify", "refs/heads/" + b):
            cands.append(("本地 " + b, "refs/heads/" + b))

    best = None  # (距离, 描述, mb)
    for desc, ref in cands:
        if not git_ok("rev-parse", "-q", "--verify", ref + "^{commit}"):
            continue  # 例如 pre-push 传来的远端 sha 本地没有
        mb = git_ok("merge-base", ref, "HEAD")
        if not mb:
            continue
        dist = int(git_ok("rev-list", "--count", mb + "..HEAD") or 0)
        if best is None or dist < best[0]:
            best = (dist, desc, mb)

    if best is None:
        # 没有任何参照分支（单机仓 / 没远程）→「本次变更」无从定义。
        # 不能退化成「只看未提交」：那样提交到 main 的违规以后再也查不到。全量比对基线才安全。
        return None, "无上游 / 无默认分支，变更集无从定义"
    dist, desc, mb = best
    return mb, "merge-base(%s, HEAD) = %s（距 HEAD %d 个提交）" % (desc, mb[:8], dist)


def committed_changes(base: str) -> set[str]:
    out = git_ok("rev-list", "--first-parent", "--parents", base + "..HEAD") or ""
    files: set[str] = set()
    for line in out.splitlines():
        parts = line.split()
        c, parents = parts[0], parts[1:]
        if len(parents) <= 1:
            _, o = git("diff-tree", "-r", "--no-commit-id", "--name-only", "--no-renames", "-z", "--root", c)
        else:
            # 合并提交：只算与「所有」父提交都不同的文件（冲突解决 / evil merge）
            _, o = git("diff-tree", "-r", "--cc", "--no-commit-id", "--name-only", "-z", c)
        files.update(names_z(o))
    return files


def worktree_changes() -> tuple[set[str], set[str]]:
    """返回 (算你的, 合并带入被排除的)。"""
    _, o1 = git("diff", "--name-only", "--no-renames", "-z", "HEAD")
    _, o2 = git("ls-files", "--others", "--exclude-standard", "-z")
    files = set(names_z(o1)) | set(names_z(o2))
    merged_in: set[str] = set()
    if git_ok("rev-parse", "-q", "--verify", "MERGE_HEAD"):
        for f in sorted(files):
            p = os.path.join(ROOT, f)
            if not os.path.isfile(p):
                continue
            theirs = git_ok("rev-parse", "-q", "--verify", "MERGE_HEAD:" + f)
            mine = git_ok("hash-object", "--", f)
            if theirs and mine and theirs == mine:
                merged_in.add(f)
        files -= merged_in
    return files, merged_in


# --------------------------------------------------------------------------- lint
VIOLATION_RE = re.compile(r"^\s*-\s+(.+?):(\d+)\s+(.*)$")


def file_details(scope: list[str]) -> dict[str, list[str]]:
    """逐文件违规明细。

    优先用规则本体的 API（tests/lint_styles.py:scan_file）；
    老版本规则没有这个函数时，退化为解析它自己的命令行输出（`- <file>:<line> <原因>`）——
    这样基线脚本不挑规则版本，避免「仓里的规则与工作树里的规则不同步」把门禁搞红。
    """
    rules = load_rules()
    if hasattr(rules, "scan_file"):
        return {f: rules.scan_file(f) for f in scope}
    out = subprocess.run([sys.executable, os.path.join(ROOT, RULE_REL)],
                         cwd=ROOT, capture_output=True, text=True).stdout
    details: dict[str, list[str]] = {f: [] for f in scope}
    for line in out.splitlines():
        m = VIOLATION_RE.match(line)
        if m and m.group(1) in details:
            details[m.group(1)].append("%s:%s %s" % (m.group(1), m.group(2), m.group(3)))
    return details


def load_rules():
    spec = importlib.util.spec_from_file_location("lint_styles", os.path.join(ROOT, RULE_REL))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_baseline() -> dict | None:
    if not os.path.exists(BASELINE):
        return None
    with open(BASELINE, encoding="utf-8") as fh:
        return json.load(fh)


def save_baseline(data: dict):
    data["files"] = {k: v for k, v in sorted(data.get("files", {}).items()) if v > 0}
    with open(BASELINE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def new_baseline(counts: dict) -> dict:
    return {
        "_说明": "lint 存量登记（scripts/lint_baseline.py 读取）。只许降（--ratchet），不许静默升；"
                 "手改升高须走提交门禁留痕（LOCAL_GUARD_OK=1，commit 写清理由）。",
        "rule_source": RULE_REL,
        "files": counts,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="lint 基线：只对本次变更文件比对，超基线即红")
    ap.add_argument("--all", action="store_true", help="全量模式（不看 git，所有 lint 文件都比对）")
    ap.add_argument("--explain", action="store_true", help="打印基点与变更集推导过程")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--ratchet", action="store_true", help="把已改善的文件下调到当前值（永不上调）")
    g.add_argument("--init", action="store_true", help="基线不存在时按当前全量结果生成")
    args = ap.parse_args()

    rules = load_rules()
    scope = list(rules.APP_FILES)
    details = file_details(scope)
    count = {f: len(v) for f, v in details.items()}

    if args.init:
        if os.path.exists(BASELINE):
            print("✗ %s 已存在 → 拒绝覆盖（只许 --ratchet 下调；上调请手改并走门禁留痕）" % BASELINE_REL)
            return 2
        save_baseline(new_baseline(dict(count)))
        print("[lint 基线] 已生成 %s：%s" % (BASELINE_REL, json.dumps(load_baseline()["files"], ensure_ascii=False)))
        return 0

    base_data = load_baseline()
    if base_data is None:
        print("✗ 缺基线文件 %s → 先 python3 scripts/lint_baseline.py --init" % BASELINE_REL)
        return 2
    allowed = base_data.get("files", {})

    if args.ratchet:
        lowered, refused = [], []
        for f, n in count.items():
            a = allowed.get(f, 0)
            if n < a:
                allowed[f] = n
                lowered.append("%s %d→%d" % (f, a, n))
            elif n > a:
                refused.append("%s 当前 %d > 基线 %d" % (f, n, a))
        base_data["files"] = allowed
        save_baseline(base_data)
        print("[lint 基线] ratchet：下调 %d 项%s" % (len(lowered), ("：" + "；".join(lowered)) if lowered else ""))
        for r in refused:
            print("  ⛔ 不上调：%s（新增告警请修掉，不是刷基线）" % r)
        return 0

    # ---- 推导本次变更集
    merged_in: set[str] = set()
    if args.all:
        mode, base_desc, changed = "全量（--all）", "—", set(scope)
    else:
        base, base_desc = resolve_base()
        if base is None:
            mode, changed = "全量（%s）" % base_desc, set(scope)
        else:
            committed = committed_changes(base)
            wt, merged_in = worktree_changes()
            changed = committed | wt
            if changed & FULL_TRIGGERS:
                mode = "全量（规则或基线被改：%s）" % ", ".join(sorted(changed & FULL_TRIGGERS))
                changed = set(scope)
            else:
                mode = "增量"
            if args.explain:
                print("  已提交（first-parent）：%s" % (", ".join(sorted(committed)) or "—"))
                print("  未提交：%s" % (", ".join(sorted(wt)) or "—"))

    targets = [f for f in scope if f in changed]
    print("[lint 基线] 模式：%s · 基点：%s" % (mode, base_desc))
    print("            本次变更命中 lint 范围 %d/%d 个文件%s"
          % (len(targets), len(scope),
             ("（合并带入、不计：%s）" % ", ".join(sorted(merged_in))) if merged_in else ""))

    failed, improved = 0, []
    for f in targets:
        n, a = count[f], allowed.get(f, 0)
        if n > a:
            failed += 1
            print("  ✗ %s 告警 %d > 基线 %d（新增 %d）：" % (f, n, a, n - a))
            for v in details[f][:30]:
                print("      - " + v)
        else:
            print("  ✓ %s 告警 %d ≤ 基线 %d" % (f, n, a))
            if n < a:
                improved.append(f)
    if improved:
        print("  ↓ 已改善：%s → 可 python3 scripts/lint_baseline.py --ratchet 下调基线" % ", ".join(improved))

    if failed:
        print("[lint 基线] FAILED：%d 个文件超基线。修掉新增告警（不要刷基线）。" % failed)
        return 1
    print("[lint 基线] PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
