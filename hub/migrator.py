"""casr wrapper: cross-tool session migration.

casr (https://github.com/Dicklesworthstone/cross_agent_session_resumer) converts
native session files between providers through a canonical IR, with atomic
writes + read-back verification. We shell out to it; when absent, migration is
disabled and the UI degrades gracefully.
"""
import json
import shutil
import subprocess

TOOL_TO_CASR = {
    "claude": "cc",
    "codex": "cod",
    "opencode": "opc",
}


def casr_path():
    for p in ("casr", shutil.which("casr")):
        if p and (p != "casr" or shutil.which("casr")):
            return shutil.which("casr")
    return None


def available():
    return shutil.which("casr") is not None


def migrate(store, sid, source_tool, target_tool):
    """Migrate session `sid` from source_tool to target_tool via casr.

    Returns dict with ok / detail. Never touches the source files.
    """
    if not available():
        return {"ok": False, "error": "casr 未安装（brew/pip 安装后自动启用）"}
    if target_tool not in TOOL_TO_CASR:
        return {"ok": False, "error": "目标工具暂不支持：%s" % target_tool}
    if source_tool == target_tool:
        return {"ok": False, "error": "源与目标相同，无需迁移"}

    sess = store.session(sid)
    if not sess:
        return {"ok": False, "error": "会话不存在：%s" % sid}

    src_flag = "-" + TOOL_TO_CASR[source_tool]
    dst_flag = "-" + TOOL_TO_CASR[target_tool]
    cmd = ["casr", "resume", TOOL_TO_CASR[target_tool], sid, "--source", TOOL_TO_CASR[source_tool]]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "casr 超时（120s）"}
    out = (proc.stdout or "") + (proc.stderr or "")
    ok = proc.returncode == 0
    store.log("migrate", {
        "sid": sid, "from": source_tool, "to": target_tool,
        "ok": ok, "cmd": " ".join(cmd), "output": out[-800:],
    })
    return {"ok": ok, "cmd": " ".join(cmd), "output": out[-2000:], "new_id": _parse_new_id(out)}


def _parse_new_id(output):
    """Try to find the new session id casr prints (uuid-ish)."""
    import re
    m = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", output)
    return m.group(0) if m else None


def providers():
    if not available():
        return {"ok": False, "error": "casr 未安装"}
    proc = subprocess.run(["casr", "providers"], capture_output=True, text=True, timeout=30)
    return {"ok": proc.returncode == 0, "output": proc.stdout or proc.stderr}
