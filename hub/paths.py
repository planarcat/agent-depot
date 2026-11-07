"""应用数据目录解析：所有持久化路径的唯一出处。

优先级：AGENT_DEPOT_HOME / AGENT_HUB_DIR（显式覆盖）> 默认目录。
默认目录：正式版 ~/.agent-depot；开发版 ~/.agent-depot-dev。
开发版判定：AGENT_DEPOT_ENV=dev 或 AGENT_DEPOT_DEV=1（run.sh 默认注入前者）。
"""
import os
import re


def dev_mode():
    """是否处于开发环境（决定默认目录是否带 -dev 后缀）。"""
    env = (os.environ.get("AGENT_DEPOT_ENV") or "").strip().lower()
    flag = (os.environ.get("AGENT_DEPOT_DEV") or "").strip().lower()
    return env == "dev" or flag in ("1", "true", "yes")


def hub_dir():
    """应用文件夹的绝对路径；环境变量可覆盖（测试用 AGENT_HUB_DIR 隔离沙箱）。"""
    override = os.environ.get("AGENT_DEPOT_HOME") or os.environ.get("AGENT_HUB_DIR")
    if override:
        return os.path.expanduser(override)
    name = ".agent-depot-dev" if dev_mode() else ".agent-depot"
    return os.path.join(os.path.expanduser("~"), name)


def _slug(text):
    """把任意文本转成安全的目录名：保留中英文/数字/._-，其余压成连字符。"""
    out = []
    for ch in str(text or ""):
        if ch.isalnum() or ch in "._-" or "\u4e00" <= ch <= "\u9fff":
            out.append(ch)
        else:
            out.append("-")
    return re.sub(r"-{2,}", "-", "".join(out)).strip("-.")


def repo_name(url):
    """从 Git URL 提取可读仓库名：owner-repo（本地路径取末级目录名）。"""
    s = str(url or "").strip().rstrip("/")
    if s.endswith(".git"):
        s = s[:-4]
    if not s:
        return "repo"
    if s.startswith(("http://", "https://", "ssh://", "git://", "git@")):
        parts = [p for p in s.replace(":", "/").split("/") if p]
        tail = parts[-2:] if len(parts) >= 2 else parts[-1:]
        return _slug("-".join(tail)) or "repo"
    return _slug(os.path.basename(s)) or "repo"


def source_cache_dir(kind, url, branch="main", subdir=""):
    """远程源缓存目录：sources/<类型>/<仓库名>[-<分支>][-<子目录>]。

    仓库名可读；不同分支/子目录追加后缀避免撞目录。
    """
    name = repo_name(url)
    b = str(branch or "").strip()
    if b and b not in ("main", "master"):
        name += "-" + _slug(b)
    sub = str(subdir or "").strip().strip("/")
    if sub:
        name += "-" + _slug(sub)
    return os.path.join(hub_dir(), "sources", kind, name)
