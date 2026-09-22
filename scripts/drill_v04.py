#!/usr/bin/env python3
"""v0.4 端到端演练（干净环境 · 零依赖）：
在全新临时目录中启动隔离 Hub 实例，走完 源→拉取→本地库→分发→幂等→回退→台账 全链路。
用法: python3 scripts/drill_v04.py            # 自动清理
      python3 scripts/drill_v04.py --keep     # 保留临时目录
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP = "--keep" in sys.argv

fails = []
def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print("  [%s] %s %s" % (tag, name, ("— " + str(detail)) if detail else ""))
    if not cond:
        fails.append(name)

def git(*args, cwd=None):
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, capture_output=True)

def api(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())

def main():
    tmp = tempfile.mkdtemp(prefix="hub-drill-")
    port = None
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    base = "http://127.0.0.1:%d" % port
    print("== v0.4 干净环境演练 ==")
    print("  tmp=%s  port=%d" % (tmp, port))

    # ---------- 夹具：源仓库 + 两个目标仓库 ----------
    src = os.path.join(tmp, "src-repo"); os.makedirs(src)
    git("init", "-q", "-b", "main", src)
    sd = os.path.join(src, "skills", "alpha"); os.makedirs(sd)
    with open(os.path.join(sd, "SKILL.md"), "w") as f:
        f.write('---\nname: alpha\ndescription: "Drill skill"\nversion: 1.0.0\n---\n\n# Alpha v1\n')
    git("add", ".", cwd=src)
    subprocess.run(["git", "-C", src, "-c", "user.name=d", "-c", "user.email=d@d",
                    "commit", "-qm", "v1"], check=True)

    targets = {}
    for nm in ("a", "b"):
        d = os.path.join(tmp, "target-" + nm)
        os.makedirs(os.path.join(d, ".claude", "skills"))
        targets[nm] = d

    # ---------- 启动隔离实例 ----------
    env = dict(os.environ)
    env.update({"AGENT_HUB_DIR": os.path.join(tmp, "hub"),
                "HUB_CLAUDE_PROJECTS": os.path.join(tmp, "empty-claude"),
                "CODEX_HOME": os.path.join(tmp, "empty-codex"),
                "HUB_OPENCODE_DB": os.path.join(tmp, "empty-opencode.db"),
                "HUB_PORT": str(port),
                "PATH": env.get("PATH", "") + os.pathsep + os.path.expanduser("~/.local/bin")})
    os.makedirs(env["HUB_CLAUDE_PROJECTS"]); os.makedirs(env["CODEX_HOME"])
    log = open(os.path.join(tmp, "server.err"), "w")
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")],
                            env=env, stdout=subprocess.DEVNULL, stderr=log)
    for _ in range(60):
        try:
            api(base, "GET", "/api/state"); break
        except Exception:
            time.sleep(0.25)
    else:
        print("server failed to boot"); proc.kill(); sys.exit(1)

    try:
        # 1) 源管理
        r = api(base, "POST", "/api/skills/sources",
                {"name": "drill-src", "url": src, "branch": "main"})
        check("1. 注册源仓库", r.get("ok") and r.get("id"), r)
        sid = r["id"]

        # 2) 拉取
        r = api(base, "POST", "/api/skills/sources/%d/pull" % sid)
        check("2. 拉取（快照+差量）", r.get("ok") and r.get("added") == ["alpha"],
              {"added": r.get("added"), "commit": (r.get("commit") or "")[:8]})

        # 3) 更新到本地库
        r = api(base, "POST", "/api/skills/registry/update", {"names": ["alpha"]})
        st = (r.get("results") or [{}])[0]
        check("3. 更新到本地库", r.get("ok") and st.get("status") in ("installed", "updated"),
              {"status": st.get("status"), "version": st.get("version")})

        # 4) 分发到两个目标
        tids = []
        for nm in ("a", "b"):
            r = api(base, "POST", "/api/skills/targets",
                    {"name": "drill-target-" + nm, "kind": "skills_dir", "tool": "claude",
                     "path": os.path.join(targets[nm], ".claude", "skills")})
            tids.append(r["id"])
        r = api(base, "POST", "/api/skills/distribute",
                {"names": ["alpha"], "target_ids": tids})
        oks = [x for x in r["results"] if x.get("status") == "ok"]
        files_a = os.path.exists(os.path.join(targets["a"], ".claude", "skills", "alpha", "SKILL.md"))
        files_b = os.path.exists(os.path.join(targets["b"], ".claude", "skills", "alpha", "SKILL.md"))
        check("4. 分发两目标（落盘）", len(oks) == 2 and files_a and files_b,
              {"ok": len(oks), "dir_a": files_a, "dir_b": files_b})

        # 5) 幂等：重复分发
        r = api(base, "POST", "/api/skills/distribute",
                {"names": ["alpha"], "target_ids": tids})
        sk = [x for x in r["results"] if x.get("status") == "skipped"]
        check("5. 重复分发幂等（skip）", len(sk) == 2, {"skipped": len(sk)})

        # 6) 版本升级 + 回退
        with open(os.path.join(sd, "SKILL.md"), "w") as f:
            f.write('---\nname: alpha\ndescription: "Drill skill"\nversion: 2.0.0\n---\n\n# Alpha v2\n')
        git("add", ".", cwd=src)
        subprocess.run(["git", "-C", src, "-c", "user.name=d", "-c", "user.email=d@d",
                        "commit", "-qm", "v2"], check=True)
        api(base, "POST", "/api/skills/sources/%d/pull" % sid)
        r = api(base, "POST", "/api/skills/registry/update", {"names": ["alpha"]})
        st = (r.get("results") or [{}])[0]
        check("6a. 升级 v2", st.get("status") in ("updated", "installed"),
              {"status": st.get("status"), "version": st.get("version")})
        r = api(base, "POST", "/api/skills/registry/rollback", {"name": "alpha"})
        regfile = open(os.path.join(tmp, "hub", "registry", "skills", "alpha", "SKILL.md")).read()
        cur = api(base, "GET", "/api/skills/registry")
        row = [x for x in cur["items"] if x["name"] == "alpha"][0]
        check("6b. 回退上一版本（内容+版本号）",
              r.get("ok") and "Alpha v1" in regfile and "1.0.0" in str(row.get("version")),
              {"version": row.get("version"), "content_v1": "Alpha v1" in regfile})

        # 7) 台账
        r = api(base, "GET", "/api/ops?module=skills&status=ok&limit=100")
        total = r.get("total", len(r.get("items", [])))
        check("7. 台账可查（skills/ok）", total >= 8, {"total": total})

        # 8) 回退后再分发（同步 v1 内容）
        r = api(base, "POST", "/api/skills/distribute",
                {"names": ["alpha"], "target_ids": tids})
        st = [(x.get("status") or "") for x in r["results"]]
        content = open(os.path.join(targets["a"], ".claude", "skills", "alpha", "SKILL.md")).read()
        check("8. 回退后重新分发（目标回到 v1）",
              all(s in ("ok", "skipped") for s in st) and "Alpha v1" in content, st)

        print("\n== 结果: %s ==" % ("全部通过 ✓" if not fails else ("失败 %d 项: %s" % (len(fails), fails))))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        log.close()
        if not KEEP:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print("保留:", tmp)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
