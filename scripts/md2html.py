#!/usr/bin/env python3
"""Minimal Markdown -> styled HTML (Build 风：大留白/细字重/单强调色)。
支持：标题/粗体/行内代码/代码块/表格/列表/引用/分隔线。
用法: python3 scripts/md2html.py input.md output.html "页面标题"
"""
import html
import re
import sys

def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    return t

def convert(md):
    out, i, lines = [], 0, md.split("\n")
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            buf, i = [], i + 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(html.escape(lines[i])); i += 1
            out.append("<pre><code>" + "\n".join(buf) + "</code></pre>")
        elif re.match(r"^#{1,4} ", ln):
            lvl = len(ln) - len(ln.lstrip("#"))
            out.append("<h%d>%s</h%d>" % (lvl, inline(ln[lvl+1:]), lvl))
        elif ln.strip() == "---":
            out.append("<hr>")
        elif ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.match(r"^:?-{2,}:?$", c) for c in cells):
                    rows.append(cells)
                i += 1
            i -= 1
            if rows:
                h = "<table><thead><tr>" + "".join("<th>%s</th>" % inline(c) for c in rows[0]) + "</tr></thead><tbody>"
                for r in rows[1:]:
                    h += "<tr>" + "".join("<td>%s</td>" % inline(c) for c in r) + "</tr>"
                out.append(h + "</tbody></table>")
        elif re.match(r"^[0-9]+\. ", ln) or ln.startswith("- "):
            items = []
            while i < len(lines) and (re.match(r"^[0-9]+\. ", lines[i]) or lines[i].startswith("- ") or (lines[i].startswith("  ") and lines[i].strip())):
                if lines[i].strip():
                    items.append(re.sub(r"^([0-9]+\. |\- )", "", lines[i].strip()))
                i += 1
            i -= 1
            out.append("<ul>" + "".join("<li>%s</li>" % inline(x) for x in items) + "</ul>")
        elif ln.startswith(">"):
            buf = []
            while i < len(lines) and lines[i].startswith(">"):
                buf.append(lines[i].lstrip("> ").strip()); i += 1
            i -= 1
            out.append("<blockquote>" + inline(" ".join(buf)) + "</blockquote>")
        elif ln.strip():
            buf = [ln]
            while i + 1 < len(lines) and lines[i+1].strip() and not re.match(r"^(#|\||>|```|---|[-*] |[0-9]+\. )", lines[i+1]):
                i += 1; buf.append(lines[i])
            out.append("<p>" + inline(" ".join(buf)) + "</p>")
        i += 1
    return "\n".join(out)

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
  :root {{ --ink:#1c1c1a; --ink2:#4a4a47; --ink3:#8a8a85; --line:#e4e4e0; --accent:#0d6a63; --bg:#fbfbf9; }}
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{ background:var(--bg); color:var(--ink); font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;
         font-size:15px; line-height:1.8; font-weight:300; -webkit-font-smoothing:antialiased; }}
  .wrap {{ max-width:860px; margin:0 auto; padding:96px 32px 160px; }}
  .doc-meta {{ font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:.14em; color:var(--ink3);
               text-transform:uppercase; margin-bottom:40px; }}
  h1 {{ font-size:30px; font-weight:600; letter-spacing:-.01em; margin:0 0 12px; line-height:1.35; }}
  h2 {{ font-size:20px; font-weight:600; margin:72px 0 20px; padding-top:32px; border-top:1px solid var(--line); }}
  h3 {{ font-size:16px; font-weight:600; margin:40px 0 12px; }}
  h4 {{ font-size:14.5px; font-weight:600; margin:28px 0 8px; }}
  p {{ margin:14px 0; color:var(--ink2); }}
  strong {{ font-weight:600; color:var(--ink); }}
  code {{ font-family:ui-monospace,Menlo,monospace; font-size:12.5px; background:#f1f1ee; padding:1px 6px; border-radius:3px; color:var(--ink2); }}
  pre {{ background:#f4f4f1; border:1px solid var(--line); border-radius:6px; padding:20px 24px; overflow-x:auto; margin:20px 0; }}
  pre code {{ background:none; padding:0; font-size:12.5px; line-height:1.7; }}
  table {{ width:100%; border-collapse:collapse; margin:24px 0; font-size:13.5px; }}
  th {{ text-align:left; font-weight:600; font-size:11.5px; letter-spacing:.08em; text-transform:uppercase;
        color:var(--ink3); padding:0 14px 10px 0; border-bottom:1px solid var(--line); }}
  td {{ padding:11px 14px 11px 0; border-bottom:1px solid #eeeeea; color:var(--ink2); vertical-align:top; line-height:1.65; }}
  li {{ margin:6px 0; color:var(--ink2); }}
  ul {{ margin:12px 0 12px 22px; }}
  blockquote {{ border-left:1px solid var(--accent); padding:6px 20px; margin:20px 0; color:var(--ink3); font-size:14px; }}
  hr {{ border:none; border-top:1px solid var(--line); margin:48px 0; }}
  @media (max-width:640px) {{ .wrap {{ padding:56px 20px 96px; }} h1 {{ font-size:24px; }} }}
</style></head><body><div class="wrap">
<div class="doc-meta">{title} · {date}</div>
{body}
</div></body></html>"""

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else "文档"
    md = open(src).read()
    import time
    open(dst, "w").write(TEMPLATE.format(title=html.escape(title), date=time.strftime("%Y-%m-%d"),
                                         body=convert(md)))
    print("written:", dst)
