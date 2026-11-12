import { describe, expect, test } from "bun:test";
import {
  esc,
  fmtBytes,
  fmtNum,
  fmtRelative,
  fmtTime,
  INTERVALS,
  stripAttPlaceholders,
  truncate,
} from "../src/core/format.ts";

describe("esc · HTML 转义 / XSS 反例", () => {
  test("null / undefined / 数字", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(0)).toBe("0");
    expect(esc(42)).toBe("42");
  });

  test("标签与实体", () => {
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(esc("a & b")).toBe("a &amp; b");
    expect(esc("&lt;")).toBe("&amp;lt;"); // 双重转义是预期：esc 只做一次
  });

  test("引号（属性逃逸反例）", () => {
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
    expect(esc('x" onmouseover="alert(1)')).toBe("x&quot; onmouseover=&quot;alert(1)");
    expect(esc("'\"><img src=x onerror=alert(1)>")).toBe(
      "&#39;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  test("换行保留（文本内容不受影响）", () => {
    expect(esc("a\nb")).toBe("a\nb");
  });
});

describe("fmtTime", () => {
  test("空值 → em dash", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(undefined)).toBe("—");
    expect(fmtTime("")).toBe("—");
  });

  test("非 ISO（无 T）→ 截取 MM-DD HH:MM", () => {
    expect(fmtTime("2026-11-11 08:30:59")).toBe("11-11 08:30");
  });

  test("ISO → 本地化 MM/DD HH:MM", () => {
    const out = fmtTime("2026-11-11T08:30:00Z");
    expect(out).not.toContain("T");
    expect(out).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/u);
  });

  test("非法 ISO → 降级截取", () => {
    expect(fmtTime("xxxxTxxxxx-----")).toBe("xxxxx-----");
  });
});

describe("fmtBytes", () => {
  test("零 / 空 / 非法 → 空串", () => {
    expect(fmtBytes(0)).toBe("");
    expect(fmtBytes(null)).toBe("");
    expect(fmtBytes(undefined)).toBe("");
    expect(fmtBytes(Number.NaN)).toBe("");
  });

  test("B / KB / MB 边界", () => {
    expect(fmtBytes(1)).toBe("1 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });
});

describe("fmtNum", () => {
  test("空值按 0", () => {
    expect(fmtNum(null)).toBe("0");
    expect(fmtNum(undefined)).toBe("0");
  });

  test("千分位", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1234)).toBe("1,234");
    expect(fmtNum(1234567)).toBe("1,234,567");
  });
});

describe("stripAttPlaceholders", () => {
  test("无附件 → 原文", () => {
    expect(stripAttPlaceholders("hello", [])).toBe("hello");
    expect(stripAttPlaceholders("hello", [{}, {}])).toBe("hello");
    expect(stripAttPlaceholders(null, [])).toBe("");
  });

  test("有附件 → 去掉 [file]/[image] 占位行与前导空行", () => {
    const text = "\n[file] a.png\n正文\n[image] b.jpg\n更多";
    expect(stripAttPlaceholders(text, [{ id: 1 }])).toBe("正文\n更多");
  });

  test("行首空白后的占位也去掉", () => {
    expect(stripAttPlaceholders("  [file] x\nok", [{}])).toBe("ok");
  });

  test("正文中的 [file] 字样不误伤", () => {
    expect(stripAttPlaceholders("说明 [file] 语法", [{}])).toBe("说明 [file] 语法");
  });
});

describe("fmtRelative", () => {
  const now = Date.now();

  test("空值 → em dash，非法 → 原样", () => {
    expect(fmtRelative(null)).toBe("—");
    expect(fmtRelative("not-a-date")).toBe("not-a-date");
  });

  test("刚刚 / 分钟 / 小时 / 天", () => {
    expect(fmtRelative(new Date(now - 10_000).toISOString())).toBe("刚刚");
    expect(fmtRelative(new Date(now - 5 * 60_000).toISOString())).toBe("5 分钟前");
    expect(fmtRelative(new Date(now - 2 * 3600_000).toISOString())).toBe("2 小时前");
    expect(fmtRelative(new Date(now - 3 * 86_400_000).toISOString())).toBe("3 天前");
  });

  test("未来时间不出现负数（clamp 0）", () => {
    expect(fmtRelative(new Date(now + 60_000).toISOString())).toBe("刚刚");
  });
});

describe("truncate", () => {
  test("短文本原样", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  test("超长截断并加省略号", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });

  test("按字符而不是 UTF-16 码元（不劈开代理对）", () => {
    expect(truncate("😀😀😀", 2)).toBe("😀😀…");
    expect(truncate("a😀b", 2)).toBe("a😀…");
  });
});

test("INTERVALS 是只读约定值", () => {
  expect([...INTERVALS]).toEqual([5, 10, 15, 30, 60, 180]);
});
