"""Git 源封装：clone/fetch/快照读取 + 凭据注入（ASKPASS，不落明文）。

- 源缓存目录由 hub 全权所有（sources/<source_key>），reset --hard 安全；
- auth_ref 支持 'env:VAR' 与 'file:/path'（权限检查不过会告警但不中断读取）；
- 所有错误字符串经 mask 处理，token 永不出现在输出。
"""
import os
import shutil
import stat
import subprocess
import tempfile

from hub.core import fsutil

MAX_CAPTURE = 20000  # 错误输出截断


def run_git(args, cwd=None, env=None, timeout=180):
    full_env = dict(os.environ)
    full_env.update(env or {})
    full_env.setdefault("GIT_TERMINAL_PROMPT", "0")
    try:
        p = subprocess.run(["git"] + args, cwd=cwd, env=full_env,
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "git timeout after %ss" % timeout


def resolve_auth(auth_ref):
    """→ (env_extra, warning|None)。env:VAR 从环境取；file:path 读 600 检查。"""
    if not auth_ref:
        return {}, None
    kind, _, ref = auth_ref.partition(":")
    if kind == "env":
        token = os.environ.get(ref)
        if not token:
            return {}, "环境变量 %s 未设置" % ref
        return {"HUB_GIT_TOKEN": token, "GIT_ASKPASS": _askpass_script()}, None
    if kind == "file":
        path = os.path.expanduser(ref)
        if not os.path.exists(path):
            return {}, "凭据文件不存在：%s" % ref
        mode = stat.S_IMODE(os.stat(path).st_mode)
        warn = None
        if mode & 0o077:
            warn = "凭据文件权限过宽（%o，建议 600）" % mode
        with open(path) as f:
            token = f.read().strip()
        return {"HUB_GIT_TOKEN": token, "GIT_ASKPASS": _askpass_script()}, warn
    return {}, "未知 auth_ref 类型：%s" % kind


def _askpass_script():
    path = os.path.join(tempfile.gettempdir(), "hub-askpass-%d.sh" % os.getpid())
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write("#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token;; *) echo \"$HUB_GIT_TOKEN\";; esac\n")
        os.chmod(path, 0o700)
    return path


def _masked(s):
    out = s or ""
    tok = os.environ.get("HUB_GIT_TOKEN")
    if tok and len(tok) > 6:
        out = out.replace(tok, "***")
    return out[:MAX_CAPTURE]


def _valid_branch(branch):
    return bool(branch) and branch not in ("HEAD", "*", "head")


def ensure_cache(cache_dir, url, branch="main", auth_ref=None):
    """clone 或 fetch；返回 (ok, commit, resolved_branch, error)。cache 缺失则 clone。"""
    env, warn = resolve_auth(auth_ref)
    if not os.path.isdir(os.path.join(cache_dir, ".git")):
        args = ["clone", "--filter=blob:none"]
        if _valid_branch(branch):
            args += ["--branch", branch]
        args += [url, cache_dir]
        code, out, err = run_git(args, env=env, timeout=600)
        if code != 0:
            shutil.rmtree(cache_dir, ignore_errors=True)
            return False, None, None, _masked(err or out)
    else:
        if _valid_branch(branch):
            code, out, err = run_git(["fetch", "--prune", "origin", branch], cwd=cache_dir, env=env)
        else:
            code, out, err = run_git(["fetch", "--prune", "origin"], cwd=cache_dir, env=env)
        if code != 0:
            return False, None, None, _masked(err or out)
        reset_to = ("origin/%s" % branch) if _valid_branch(branch) else "FETCH_HEAD"
        code, out, err = run_git(["reset", "--hard", reset_to], cwd=cache_dir, env=env)
        if code != 0 and reset_to != "FETCH_HEAD":
            code, out, err = run_git(["reset", "--hard", "FETCH_HEAD"], cwd=cache_dir, env=env)
        if code != 0:
            return False, None, None, _masked(err or out)
    # resolve actual branch name for persistence
    code, out, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=cache_dir)
    resolved = out.strip() if code == 0 else None
    code, out, _ = run_git(["rev-parse", "--short", "HEAD"], cwd=cache_dir)
    commit = out.strip() if code == 0 else None
    return True, commit, resolved, (warn if warn else None)


def ls_tree(cache_dir, commit, subdir=""):
    """返回 {path: blob_hash}（相对 subdir 的路径）。"""
    code, out, err = run_git(["ls-tree", "-r", commit], cwd=cache_dir)
    if code != 0:
        return {}
    prefix = (subdir.strip("/") + "/") if subdir else ""
    files = {}
    for line in out.splitlines():
        try:
            meta, path = line.split("\t", 1)
            _mode, _typ, blob = meta.split()
        except ValueError:
            continue
        if prefix and not path.startswith(prefix):
            continue
        rel = path[len(prefix):] if prefix else path
        files[rel] = blob
    return files


def show_bytes(cache_dir, commit, path):
    code, out, err = run_git(["show", "%s:%s" % (commit, path)], cwd=cache_dir)
    if code != 0:
        return None
    return out.encode()


def remote_head(cache_dir):
    code, out, _ = run_git(["ls-remote", "--symref", "origin", "HEAD"], cwd=cache_dir)
    return out if code == 0 else ""
