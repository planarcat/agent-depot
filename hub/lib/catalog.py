"""目录解析：把 Git 源里的 skills / mcp 内容解析为统一条目。

skills 目录约定：任意深度下含 SKILL.md 的目录 = 一个 skill（名字 = 目录名）。
  可选 manifest 覆盖：SKILL.md frontmatter 的 version 字段，或同目录 skill.json。
mcp 目录约定：源子路径内 `mcp.json`（{"mcpServers": {...}} 或单条目）或 `mcp/*.json`（每文件一条）。
  条目 = {name, config}，config 兼容 claude/codex/opencode 三种形状的公共子集：
  {command, args, env} / {url, headers, type}。
"""
import json


def _parse_frontmatter(text):
    """极简 YAML frontmatter 子集：--- 块内 key: value（支持引号与单行）。"""
    fm = {}
    if not text.startswith("---"):
        return fm
    end = text.find("\n---", 3)
    if end < 0:
        return fm
    for line in text[3:end].splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip(); v = v.strip().strip('"').strip("'")
        fm[k] = v
    return fm


def parse_skills(ls_files, show_bytes, commit, subdir=""):
    """ls_files: {path: blob_hash}（已按 subdir 过滤）；show_bytes(path)->bytes。
    返回 [ {name, path, source_hash, version, meta} ]（path 相对源根）。"""
    skills = {}
    prefix = (subdir.strip("/") + "/") if subdir else ""
    for rel in ls_files:
        r = rel
        base = os.path.basename(r)
        if base not in ("SKILL.md", "skill.json"):
            continue
        dirpath = os.path.dirname(r)
        if dirpath in skills:
            skills[dirpath]["files"].append(r)
        else:
            skills[dirpath] = {"files": [r]}
    out = []
    for dirpath, info in sorted(skills.items()):
        name = os.path.basename(dirpath) if dirpath else "root-skill"
        skill_md_rel = dirpath + "/SKILL.md" if dirpath else "SKILL.md"
        # 完整文件清单（该目录下所有文件）
        dir_prefix = (dirpath + "/") if dirpath else ""
        files = {p: h for p, h in ls_files.items()
                 if (p.startswith(dir_prefix) and not p.startswith(dir_prefix + ".versions/"))}
        if skill_md_rel not in files:
            continue  # 只有 skill.json 没 SKILL.md 的目录跳过（非法条目）
        fm = {}
        raw = show_bytes(skill_md_rel)
        if raw:
            fm = _parse_frontmatter(raw.decode("utf-8", "replace"))
        # 源哈希：目录内文件 blob 集合
        import hashlib
        h = hashlib.sha256()
        for p in sorted(files):
            h.update(p.encode()); h.update(b"\x00"); h.update(files[p].encode()); h.update(b"\n")
        out.append({
            "name": fm.get("name") or name,
            "path": (prefix + dirpath).rstrip("/") or ".",
            "source_hash": h.hexdigest(),
            "version": fm.get("version") or None,  # 无 manifest 版本则回落到 commit 短哈希（由服务层填）
            "meta": {"description": fm.get("description", "")},
        })
    # 去重（同名目录/前后缀情况）
    seen, final = set(), []
    for s in out:
        if s["name"] in seen:
            continue
        seen.add(s["name"]); final.append(s)
    return final


_KNOWN_KEYS = ("command", "args", "env", "url", "headers", "type", "transport", "cwd")


def _normalize_mcp_entry(name, cfg):
    if not isinstance(cfg, dict):
        return None
    norm = {"name": name}
    for k in _KNOWN_KEYS:
        if k in cfg and cfg[k] is not None:
            norm[k] = cfg[k]
    if "command" not in norm and "url" not in norm:
        return None  # 既无命令又无地址 → 非法
    if "env" in norm and not isinstance(norm["env"], dict):
        return None
    norm.setdefault("type", "http" if "url" in norm else "stdio")
    return norm


def parse_mcp(ls_files, show_bytes, subdir=""):
    """解析源内 MCP 文件 → [ {name, path, config, source_hash} ]。
    规则：subdir 内 mcp.json（集合或单条）与 mcp/*.json（每文件一条或多条）。"""
    import hashlib
    candidates = []
    prefix = (subdir.strip("/") + "/") if subdir else ""
    for rel in ls_files:
        if not rel.endswith(".json"):
            continue
        base = os.path.basename(rel)
        if base == "mcp.json" or rel.startswith("mcp/"):
            candidates.append(rel)
    out = []
    for rel in sorted(candidates):
        raw = show_bytes(rel)
        if raw is None:
            continue
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        entries = []
        if isinstance(data, dict) and "mcpServers" in data and isinstance(data["mcpServers"], dict):
            entries = list(data["mcpServers"].items())
        elif isinstance(data, dict) and ("command" in data or "url" in data):
            nm = data.get("name") or os.path.splitext(os.path.basename(rel))[0]
            entries = [(nm, {k: v for k, v in data.items() if k != "name"})]
        elif isinstance(data, dict):
            # {name: cfg, ...} 形式兜底
            entries = [(k, v) for k, v in data.items() if isinstance(v, dict)]
        for name, cfg in entries:
            norm = _normalize_mcp_entry(name, cfg)
            if not norm:
                continue
            h = hashlib.sha256()
            h.update(json.dumps(norm, sort_keys=True, ensure_ascii=False).encode())
            out.append({"name": name, "path": prefix + rel, "config": norm,
                        "source_hash": h.hexdigest()})
    seen, final = set(), []
    for s in out:
        if s["name"] in seen:
            continue
        seen.add(s["name"]); final.append(s)
    return final


import os  # noqa: E402  (供上面 os.path 使用)
