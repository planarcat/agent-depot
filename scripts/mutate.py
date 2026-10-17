#!/usr/bin/env python3
"""[变异门禁] 零依赖变异测试器（Python 标准库 ast）。

用途：测试是判据——「看着有、其实杀不死」的测试，靠变异得分暴露。
      对被盯文件逐处注入小改动（变异），跑对应测试：
        测试变红 / 超时 = 杀死（killed / timeout）
        测试仍绿          = 存活（survived）—— 说明这处逻辑没被测试钉住
      得分 = (killed + timeout) / (killed + timeout + survived)，低于 break 阈值 → exit 1。

口径（对齐 Stryker 官方，见《AI开发质量体系-落地方指南》§四）：
  - timeout 计入 killed；变异后编译不过的（compile error）不计分。
  - 自研规则集（RULESET）与 Stryker / mutmut 的得分**不可横向比较**，只做本仓前后对比。

做法：
  1. 整仓复制到临时目录（每个并行 worker 一份），绝不碰真实源码、绝不碰运行中的 hub。
  2. ast 定位变异点 → 按源码**字节区间**替换该节点（保留其余格式与注释）。
  3. 先跑一次未变异基线：不绿直接中止（红测试上算变异分没有意义）。
  4. 每个变异：写入 → 跑测试（超时 = 基线 × 3 + 5s）→ 还原。
  安全：测试进程的 HOME 指向临时目录，变异后的代码就算误写盘也写不到真实用户目录。

等价变异（杀不死也不该杀）：在变异点所在行加 `# mutate: disable <理由>`，
  会被跳过并在输出里列为「留痕跳过」（理由必填，空理由不认）。

用法：
  python3 scripts/mutate.py                       # 跑配置里的全部目标
  python3 scripts/mutate.py --target hub/watcher.py
  python3 scripts/mutate.py --list                # 只列变异点，不跑
  python3 scripts/mutate.py --concurrency 8
配置：scripts/mutation.config.json    报告：reports/mutation.json
"""
from __future__ import annotations

import argparse
import ast
import copy
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "scripts", "mutation.config.json")
RULESET = "m1"  # 改变异规则 = 改判据口径：升版本号，前后得分不可直接比

COPY_IGNORE = shutil.ignore_patterns(
    ".git", "__pycache__", "*.pyc", "evidence", "reports", "node_modules", "target",
    "desktop", "原型", "Plans", ".workbuddy", ".zwork", ".hub.pid", ".hub.log",
)
DISABLE_RE = re.compile(rb"#\s*mutate:\s*disable\b[ \t]*([^\n]*)")


# --------------------------------------------------------------------------- 变异点
class Site:
    __slots__ = ("idx", "line", "col", "end_line", "end_col", "op", "before", "after", "skip")

    def __init__(self, line, col, end_line, end_col, op, after):
        self.line, self.col, self.end_line, self.end_col = line, col, end_line, end_col
        self.op, self.after = op, after
        self.before = ""
        self.skip = None  # 留痕跳过的理由
        self.idx = -1


CMP_SWAP = {
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq,
    ast.Lt: ast.GtE, ast.GtE: ast.Lt,
    ast.Gt: ast.LtE, ast.LtE: ast.Gt,
    ast.In: ast.NotIn, ast.NotIn: ast.In,
    ast.Is: ast.IsNot, ast.IsNot: ast.Is,
}
BIN_SWAP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div, ast.Div: ast.Mult}


def _expr(node) -> str:
    # 表达式替换一律加括号：与原节点所处上下文的优先级无关，永远安全
    return "(" + ast.unparse(node) + ")"


class Collector(ast.NodeVisitor):
    """遍历 AST 收集变异点。跳过：docstring、类型注解、f-string 内部、`if __name__ == "__main__"`。"""

    def __init__(self):
        self.sites: list[Site] = []

    def _add(self, node, op, replacement: str):
        if getattr(node, "end_lineno", None) is None:
            return
        self.sites.append(Site(node.lineno, node.col_offset, node.end_lineno,
                               node.end_col_offset, op, replacement))

    # 跳过的子树 ------------------------------------------------------------
    def _body_skip_docstring(self, body):
        start = 0
        if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
                and isinstance(body[0].value.value, str):
            start = 1
        for stmt in body[start:]:
            self.visit(stmt)

    def visit_Module(self, node):
        self._body_skip_docstring(node.body)

    def _visit_func(self, node):
        for d in node.decorator_list:
            self.visit(d)
        for d in node.args.defaults + [x for x in node.args.kw_defaults if x is not None]:
            self.visit(d)
        self._body_skip_docstring(node.body)   # 参数注解 / 返回注解不进

    visit_FunctionDef = _visit_func
    visit_AsyncFunctionDef = _visit_func

    def visit_ClassDef(self, node):
        for d in node.decorator_list + node.bases:
            self.visit(d)
        self._body_skip_docstring(node.body)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self.visit(node.value)            # 注解本身不进

    def visit_JoinedStr(self, node):
        return                                  # f-string 内部不变异

    def visit_If(self, node):
        t = node.test
        is_main = (isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == "__name__")
        if is_main:
            return
        # 条件取反：if c → if not (c)
        self._add(t, "IfNegate", _expr(ast.UnaryOp(op=ast.Not(), operand=t)))
        self.generic_visit(node)

    # 变异算子 --------------------------------------------------------------
    def visit_Compare(self, node):
        for i, op in enumerate(node.ops):
            swap = CMP_SWAP.get(type(op))
            if swap:
                m = copy.deepcopy(node)
                m.ops[i] = swap()
                self._add(node, "Compare:%s→%s" % (type(op).__name__, swap.__name__), _expr(m))
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        m = copy.deepcopy(node)
        m.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        self._add(node, "BoolOp:%s→%s" % (type(node.op).__name__, type(m.op).__name__), _expr(m))
        self.generic_visit(node)

    def visit_UnaryOp(self, node):
        if isinstance(node.op, ast.Not):
            self._add(node, "NotRemove", _expr(node.operand))
        self.generic_visit(node)

    def visit_BinOp(self, node):
        swap = BIN_SWAP.get(type(node.op))
        if swap:
            m = copy.deepcopy(node)
            m.op = swap()
            self._add(node, "BinOp:%s→%s" % (type(node.op).__name__, swap.__name__), _expr(m))
        self.generic_visit(node)

    def visit_Constant(self, node):
        v = node.value
        if isinstance(v, bool):
            self._add(node, "Bool:%s→%s" % (v, not v), repr(not v))
        elif isinstance(v, int):
            self._add(node, "Int:n→n+1", repr(v + 1))
        elif isinstance(v, str):
            self._add(node, "String:→\"\"" if v else "String:\"\"→\"mutated\"", '""' if v else '"mutated"')

    def visit_Return(self, node):
        v = node.value
        if v is not None and not (isinstance(v, ast.Constant) and v.value is None):
            self._add(node, "ReturnNone", "return None")
        self.generic_visit(node)


def _offsets(src: bytes):
    """行号(1起) → 该行在整文件中的字节起点。ast 的 col_offset 是 UTF-8 字节偏移。"""
    starts, pos = [0], 0
    for line in src.split(b"\n"):
        pos += len(line) + 1
        starts.append(pos)
    return starts


def collect_sites(src: bytes) -> list[Site]:
    tree = ast.parse(src)
    c = Collector()
    c.visit(tree)
    starts = _offsets(src)
    lines = src.split(b"\n")
    seen, out = set(), []
    for s in c.sites:
        key = (s.line, s.col, s.end_line, s.end_col, s.after)
        if key in seen:
            continue
        seen.add(key)
        a = starts[s.line - 1] + s.col
        b = starts[s.end_line - 1] + s.end_col
        s.before = src[a:b].decode("utf-8", "replace")
        if s.before.strip("()") == s.after.strip("()"):
            continue                              # 等价改写（unparse 归一化后无变化），不算变异
        m = DISABLE_RE.search(lines[s.line - 1])
        if m:
            reason = m.group(1).decode("utf-8", "replace").strip()
            s.skip = reason or None               # 空理由不认 → 照常变异
        out.append(s)
    for i, s in enumerate(out):
        s.idx = i
    return out


def apply_site(src: bytes, s: Site) -> bytes:
    starts = _offsets(src)
    a = starts[s.line - 1] + s.col
    b = starts[s.end_line - 1] + s.end_col
    return src[:a] + s.after.encode("utf-8") + src[b:]


# --------------------------------------------------------------------------- 运行
def _clear_flags(path):
    # macOS：shutil 复制会连 chflags(uchg) 一起带过来 → 副本删不掉。统一清掉。
    if not hasattr(os, "chflags"):
        return
    for base, dirs, files in os.walk(path):
        for n in dirs + files:
            p = os.path.join(base, n)
            try:
                os.chflags(p, 0, follow_symlinks=False)
            except OSError:
                pass
    try:
        os.chflags(path, 0)
    except OSError:
        pass


def make_copy(tmp_root: str, name: str) -> str:
    dst = os.path.join(tmp_root, name)
    shutil.copytree(ROOT, dst, ignore=COPY_IGNORE, symlinks=True, copy_function=shutil.copyfile)
    _clear_flags(dst)
    return dst


def test_env(work: str, home: str) -> dict:
    env = dict(os.environ)
    env.update({
        "HOME": home,                         # 变异后的代码误写盘也只落在临时目录
        "PYTHONDONTWRITEBYTECODE": "1",      # 杜绝「同秒同尺寸 → 旧 pyc 被复用」导致变异不生效
        "PYTHONHASHSEED": "0",
        "GIT_AUTHOR_NAME": "mutate", "GIT_AUTHOR_EMAIL": "mutate@localhost",
        "GIT_COMMITTER_NAME": "mutate", "GIT_COMMITTER_EMAIL": "mutate@localhost",
        "HUB_WATCH": env.get("HUB_WATCH", "1"),
    })
    return env


def run_tests(cmds: list[str], cwd: str, env: dict, timeout: float):
    """返回 (状态, 耗时)；状态 ∈ pass / fail / timeout。"""
    t0 = time.time()
    for cmd in cmds:
        try:
            r = subprocess.run(cmd, shell=True, cwd=cwd, env=env, timeout=timeout,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return "timeout", time.time() - t0
        if r.returncode != 0:
            return "fail", time.time() - t0
    return "pass", time.time() - t0


def load_config() -> dict:
    with open(CONFIG, encoding="utf-8") as fh:
        return json.load(fh)


def score_of(c: dict):
    denom = c["killed"] + c["timeout"] + c["survived"]
    return None if denom == 0 else 100.0 * (c["killed"] + c["timeout"]) / denom


def main() -> int:
    ap = argparse.ArgumentParser(description="零依赖变异测试器（ast）")
    ap.add_argument("--target", action="append", help="只跑指定文件（可多次）")
    ap.add_argument("--list", action="store_true", help="只列变异点，不跑测试")
    ap.add_argument("--concurrency", type=int)
    ap.add_argument("--json", default=None, help="报告路径（默认取配置）")
    ap.add_argument("--ratchet", action="store_true",
                    help="把已提升的得分登记进配置（只升不降；回退的文件不登记）")
    args = ap.parse_args()

    cfg = load_config()
    th = cfg.get("thresholds", {"high": 80, "low": 60, "break": 60})
    # 得分基线 = 本仓自己的存量水平（对齐《落地方指南》§四「接入后先跑一次拿基线」）。
    # 没登记基线的文件用 break 阀值；登记了就只拦「比基线差」——允许先把它接进门禁，得分再逐步往上抬。
    baselines = {k: float(v) for k, v in cfg.get("baseline_scores", {}).items()}
    tol = float(cfg.get("tolerance", 2.0))  # 时序型测试有 ±1 个变异的抖动，容差给 2 个百分点
    regressions: list[tuple[str, float, float]] = []
    improvements: list[tuple[str, float, float]] = []
    targets = cfg["targets"]
    if args.target:
        want = set(args.target)
        targets = [t for t in targets if t["file"] in want]
        missing = want - {t["file"] for t in targets}
        if missing:
            print("✗ 配置里没有这些目标：%s（先写进 scripts/mutation.config.json）" % ", ".join(sorted(missing)))
            return 2

    # ---- 收集变异点
    plan = []
    for t in targets:
        path = os.path.join(ROOT, t["file"])
        src = open(path, "rb").read()
        sites = collect_sites(src)
        plan.append((t, src, sites))

    if args.list:
        for t, _, sites in plan:
            print("== %s（%d 处）" % (t["file"], len(sites)))
            for s in sites:
                tag = "  [留痕跳过：%s]" % s.skip if s.skip is not None else ""
                print("  #%-4d L%-5d %-26s %s  →  %s%s" % (s.idx, s.line, s.op, s.before[:40].replace("\n", " "),
                                                          s.after[:40], tag))
        return 0

    conc = max(1, args.concurrency or cfg.get("concurrency", 4))
    tmp_root = tempfile.mkdtemp(prefix="hub-mutate-")
    report = {"ruleset": RULESET, "thresholds": th, "concurrency": conc,
              "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "files": []}
    total = {"killed": 0, "timeout": 0, "survived": 0, "compile_error": 0, "skipped": 0}
    t_all = time.time()
    try:
        print("[变异] 规则集 %s · 并发 %d · 临时目录 %s" % (RULESET, conc, tmp_root))
        workers = [make_copy(tmp_root, "w%d" % i) for i in range(conc)]
        homes = []
        for i in range(conc):
            h = os.path.join(tmp_root, "home%d" % i)
            os.makedirs(h)
            homes.append(h)
        pool_lock = threading.Lock()
        free = list(range(conc))

        for t, src, sites in plan:
            rel, cmds = t["file"], t["tests"]
            print("\n== %s ↔ %s" % (rel, " && ".join(cmds)))

            # 基线：未变异必须绿
            st, base_dt = run_tests(cmds, workers[0], test_env(workers[0], homes[0]), timeout=600)
            if st != "pass":
                print("✗ 基线未通过（%s）：被测套件本身是红的 → 不算变异分。先把测试修绿。" % st)
                return 2
            timeout = base_dt * 3 + 5
            todo = [s for s in sites if s.skip is None]
            skipped = [s for s in sites if s.skip is not None]
            print("  基线 %.1fs ✓ · 变异点 %d（留痕跳过 %d）· 单例超时 %.0fs"
                  % (base_dt, len(sites), len(skipped), timeout))

            results = {}
            done = [0]

            def job(s: Site):
                with pool_lock:
                    w = free.pop()
                work = workers[w]
                target_path = os.path.join(work, rel)
                try:
                    mutated = apply_site(src, s)
                    try:
                        compile(mutated, rel, "exec")
                    except SyntaxError:
                        return s, "compile_error", 0.0
                    with open(target_path, "wb") as fh:
                        fh.write(mutated)
                    st2, dt = run_tests(cmds, work, test_env(work, homes[w]), timeout)
                    status = {"pass": "survived", "fail": "killed", "timeout": "timeout"}[st2]
                    return s, status, dt
                finally:
                    with open(target_path, "wb") as fh:
                        fh.write(src)
                    with pool_lock:
                        free.append(w)
                        done[0] += 1
                        if done[0] % 10 == 0 or done[0] == len(todo):
                            print("  … %d/%d" % (done[0], len(todo)), flush=True)

            with ThreadPoolExecutor(max_workers=conc) as ex:
                for s, status, dt in ex.map(job, todo):
                    results[s.idx] = (status, dt)

            counts = {"killed": 0, "timeout": 0, "survived": 0, "compile_error": 0, "skipped": len(skipped)}
            for status, _ in results.values():
                counts[status] += 1
            sc = score_of(counts)
            base = baselines.get(rel)
            bad = sc is not None and (sc < base - tol if base is not None else sc < th["break"])
            if bad:
                regressions.append((rel, base if base is not None else th["break"], sc))
            if base is not None and sc is not None and sc > base + tol:
                improvements.append((rel, base, sc))
            for k in total:
                total[k] += counts[k]

            survivors = [s for s in todo if results[s.idx][0] == "survived"]
            for s in survivors:
                print("  存活 L%-5d %-26s %s  →  %s" % (s.line, s.op, s.before[:50].replace("\n", " "), s.after[:50]))
            for s in skipped:
                print("  · 留痕跳过 L%-5d %-22s 理由：%s" % (s.line, s.op, s.skip))
            print("  小计：killed %(killed)d · timeout %(timeout)d · survived %(survived)d · "
                  "compile_error %(compile_error)d · 跳过 %(skipped)d" % counts
                  + " → 得分 %s" % ("—" if sc is None else "%.2f%%" % sc)
                  + ("（基线 %s，容差 %.1f）%s" % ("%.2f%%" % base, tol, "  ✗ 低于基线" if bad else "  ✓")
                     if base is not None else "（未登记基线，按 break %d 判定）%s" % (th["break"], "  ✗" if bad else "")))

            report["files"].append({
                "file": rel, "tests": cmds, "baseline_seconds": round(base_dt, 2), "counts": counts,
                "score": None if sc is None else round(sc, 2),
                "mutants": [{"line": s.line, "op": s.op, "before": s.before, "after": s.after,
                             "status": ("skipped" if s.skip is not None else results[s.idx][0]),
                             **({"reason": s.skip} if s.skip is not None else {})} for s in sites],
            })
    finally:
        _clear_flags(tmp_root)
        shutil.rmtree(tmp_root, ignore_errors=True)

    sc = score_of(total)
    report["counts"] = total
    report["score"] = None if sc is None else round(sc, 2)
    report["seconds"] = round(time.time() - t_all, 1)
    out = args.json or os.path.join(ROOT, cfg.get("report", "reports/mutation.json"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    band = "—" if sc is None else ("high" if sc >= th["high"] else "low" if sc >= th["low"] else "危险")
    print("\n[变异] 总分 %s（%s）· 阈值 high %d / low %d / break %d · 耗时 %.0fs · 报告 %s"
          % ("—" if sc is None else "%.2f%%" % sc, band, th["high"], th["low"], th["break"],
             report["seconds"], os.path.relpath(out, ROOT)))

    if args.ratchet:
        if regressions:
            print("✗ 有文件低于基线，拒绝 ratchet（先修回基线以上）")
            return 1
        if improvements:
            cfg.setdefault("baseline_scores", {})
            for rel, old, new in improvements:
                cfg["baseline_scores"][rel] = round(new, 2)
                print("  ↑ 登记基线：%s %.2f%% → %.2f%%" % (rel, old, new))
            with open(CONFIG, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            print("  （写回 %s；改动属判据口径 → 提交时走门禁留痕，附改前→改后）" % os.path.relpath(CONFIG, ROOT))
        else:
            print("  ratchet：没有超过「基线 + 容差」的文件，配置未改")
        return 0

    if regressions:
        for rel, base, now in regressions:
            print("✗ %s 得分 %.2f%% < %s → 判据变松了"
                  % (rel, now, ("基线 %.2f%%（容差 %.1f）" % (base, tol)) if rel in baselines
                     else "break 阈值 %d" % th["break"]))
        print("补断言把存活变异杀掉；确属等价变异，在那一行加 `# mutate: disable <理由>`。")
        return 1
    if improvements:
        print("↑ 得分已高于基线：%s → 可 `python3 scripts/mutate.py --ratchet` 上调登记"
              % "；".join("%s %.2f%%→%.2f%%" % x for x in improvements))
    print("✓ 变异得分不低于基线（只许升不许降）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
