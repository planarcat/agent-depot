import { beforeEach, describe, expect, test } from "bun:test";
import {
  accBody,
  type AccOptions,
  bindGroups,
  card,
  chip,
  chipBar,
  cls,
  growIn,
  hdrToggle,
  ic,
  item,
  ledger,
  MV,
  pill,
  recentLedger,
  shell,
  short,
  side,
  syncCards,
  swap,
  targetPicker,
  type TopOptions,
  top,
} from "../src/core/mv.ts";
import { state } from "../src/core/state.ts";
import { setTools } from "../src/core/tools.ts";
import type { LedgerRow, ToolPublic } from "../src/core/types/api.ts";

function tool(id: string, name: string, color = 4): ToolPublic {
  return {
    id,
    name,
    adapter: null,
    skills_dir: null,
    mcp_config: null,
    mcp_format: null,
    builtin: false,
    enabled: true,
    color,
    root: "/tmp/r",
    root_exists: true,
    count: 0,
    latest: null,
    adapter_label: "",
    root_hint: "",
  };
}

const opts: TopOptions = { prefix: "sk", sources: [], counts: {} };

beforeEach(() => {
  document.body.innerHTML = "";
  setTools([tool("claude", "Claude Code", 4)]);
  state.ledger = [];
});

describe("基础片段", () => {
  test("pill 默认 muted + 各 tone", () => {
    expect(pill(undefined, "x")).toBe('<span class="pill pill--muted">x</span>');
    expect(pill("ok", "x")).toContain("pill--ok");
    expect(pill("warn", "x")).toContain("pill--warn");
    expect(pill("err", "x")).toContain("pill--err");
    expect(pill("accent", "x")).toContain("pill--accent");
  });

  test("pill 转义动态文本", () => {
    expect(pill("ok", "<b>")).toContain("&lt;b&gt;");
  });

  test("short / cls：虚拟来源", () => {
    expect(short("notes")).toBe("NB");
    expect(cls("notes")).toBe("chip--accent");
    expect(short("local")).toBe("LO");
    expect(cls("remote")).toBe("chip--muted");
    expect(short("all")).toBe("全");
    expect(short("manual")).toBe("手动");
  });

  test("short / cls：注册工具与未知工具", () => {
    expect(short("claude")).toBe("CC");
    expect(cls("claude")).toBe("tool-dot--p4");
    expect(short("who")).toBe("WH");
    expect(cls("who")).toBe("tool-dot--p1");
  });

  test("chip 默认 class 与自定义", () => {
    expect(chip("AB", undefined)).toBe('<span class="mvi__src chip--muted">AB</span>');
    expect(chip("AB", "chip--accent")).toContain("chip--accent");
    expect(chip("", undefined)).toContain("></span>");
  });

  test("ic 已知返回 svg，未知返回空串", () => {
    expect(ic("search")).toContain("<svg");
    expect(ic("nope")).toBe("");
  });
});

describe("card / top", () => {
  test("card：选中态 / 关闭态 / 计数 / testid", () => {
    const html = card(
      { id: "claude", name: "Claude", short: "CC", cls: "chip--x", count: 12, tag: "<b>t</b>" },
      { ...opts, activeId: "claude" },
    );
    expect(html).toContain("is-on");
    expect(html).toContain('data-testid="sk-card-claude"');
    expect(html).toContain('data-testid="sk-cnt-claude"');
    expect(html).toContain(">12<");
    expect(html).toContain("chip--x");
    expect(html).toContain("<b>t</b>"); // tag 为受信 HTML（内部常量）
  });

  test("card：off + title 回退 + 空 short", () => {
    const html = card({ id: "x", name: "X", off: true, title: "T" }, opts);
    expect(html).toContain("is-off");
    expect(html).toContain('title="T"');
    expect(html).toContain("</span>");
  });

  test("cardHead：6 位以上显示 ∞，5/4/3 位挂字号类", () => {
    expect(card({ id: "a", name: "A", count: 123456 }, opts)).toContain("∞");
    expect(card({ id: "a", name: "A", count: 12345 }, opts)).toContain("is-n5");
    expect(card({ id: "a", name: "A", count: 1234 }, opts)).toContain("is-n4");
    expect(card({ id: "a", name: "A", count: 123 }, opts)).toContain("is-n3");
    expect(card({ id: "a", name: "A", count: 12 }, opts)).not.toContain("is-n");
  });

  test("cardHead：counts 映射 + pull 动作渲染为拉取按钮", () => {
    const html = card(
      { id: "a", name: "A", acts: [{ key: "pull", label: "拉", icon: "<svg/>" }] },
      { ...opts, counts: { a: 7 } },
    );
    expect(html).toContain("tcard__pull");
    expect(html).toContain(">7<");
  });

  test("cardHead：普通动作带 danger/testid/title/aria", () => {
    const html = card(
      {
        id: "a",
        name: "A",
        acts: [{ key: "del", label: "删", danger: true, testid: "a-del", title: "删除源" }],
      },
      opts,
    );
    expect(html).toContain("is-danger");
    expect(html).toContain('data-testid="a-del"');
    expect(html).toContain('aria-label="删除源"');
  });

  test("top：平铺模式（bulk/stats warn/hint）", () => {
    const html = top({
      ...opts,
      bulk: "<button>批量</button>",
      stats: [{ n: 3, label: "条目" }, { n: 1, label: "冲突", tone: "warn" }],
      hint: "提示",
      sources: [
        { id: "a", name: "A", count: 1 },
        { id: "b", name: "B", count: 2 },
      ],
    });
    expect(html).toContain('data-testid="sk-sources"');
    expect(html).toContain("mv-top__acts");
    expect(html).toContain("is-warn");
    expect(html).toContain("mv-hint");
    expect(html.match(/data-src=/gu)).toHaveLength(2);
  });

  test("top：分组模式过滤空组并渲染组动作", () => {
    const html = top({
      ...opts,
      sources: [{ id: "a", name: "A" }],
      groups: [
        { kind: "local", label: "本地", ids: ["a"], actions: ["新建"], desc: "d" },
        { kind: "remote", label: "远程", ids: ["ghost"] },
      ],
    });
    expect(html).toContain('data-g="local"');
    expect(html).not.toContain('data-g="remote"');
    expect(html).toContain("data-gact=\"local:新建\"");
    expect(html).toContain("1 源 · 0 条");
  });

  test("top：无分组无来源仍渲染空网格", () => {
    expect(top(opts)).toContain('class="tgrid"');
  });
});

describe("syncCards / growIn / swap", () => {
  test("syncCards：host 为空 → false", () => {
    expect(syncCards(null, "<div/>", "s1", "a")).toBe(false);
  });

  test("syncCards：签名相同 → 只切选中态", () => {
    document.body.innerHTML =
      '<div id="h"><span class="tcard" data-src="a"></span><span class="tcard" data-src="b"></span></div>';
    const h = document.getElementById("h") as HTMLElement;
    h.dataset["cardsig"] = "sig";
    expect(syncCards(h, "<i>new</i>", "sig", "b")).toBe(true);
    expect(h.innerHTML).not.toContain("<i>");
    expect(h.querySelector('[data-src="b"]')?.classList.contains("is-on")).toBe(true);
    expect(h.querySelector('[data-src="a"]')?.classList.contains("is-on")).toBe(false);
  });

  test("syncCards：签名不同 → 重建并记录签名", () => {
    document.body.innerHTML = '<div id="h"></div>';
    const h = document.getElementById("h") as HTMLElement;
    expect(syncCards(h, '<span class="tcard" data-src="a"></span>', "s2", "a")).toBe(false);
    expect(h.dataset["cardsig"]).toBe("s2");
    expect(h.innerHTML).toContain('data-src="a"');
  });

  test("syncCards：activeId null 时全部取消选中", () => {
    document.body.innerHTML =
      '<div id="h" data-cardsig="x"><span class="tcard is-on" data-src="a"></span></div>';
    const h = document.getElementById("h") as HTMLElement;
    expect(syncCards(h, "", "x", null)).toBe(true);
    expect(h.querySelector(".tcard")?.classList.contains("is-on")).toBe(false);
  });

  test("growIn：无 .is-on 或无 root → 不抛", () => {
    growIn(null);
    const host = document.createElement("div");
    host.innerHTML = "<span></span>";
    growIn(host);
  });

  test("growIn：已有 is-on 补播后仍保持 is-on", () => {
    const host = document.createElement("div");
    host.innerHTML = '<span class="is-on"></span>';
    growIn(host);
    expect(host.querySelector(".is-on")).not.toBeNull();
  });

  test("swap：无宿主 → 不抛；key 变化才重播", () => {
    swap(document.createElement("div"), "a");
    const root = document.createElement("div");
    root.innerHTML = '<div class="nv-list" id="rows"></div>';
    swap(root, "a", "#rows");
    const host = root.querySelector("#rows") as HTMLElement;
    expect(host.dataset["mvKey"]).toBe("a");
    expect(host.classList.contains("mv-swap")).toBe(true);
  });

  test("swap：默认宿主回退 .nv-list", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="nv-list"></div>';
    swap(root, null);
    expect(root.querySelector(".nv-list")?.getAttribute("data-mv-key")).toBe("all");
  });
});

describe("targetPicker", () => {
  const items = [
    { id: "a", name: "A", dotCls: "d1", sub: "s", meta: "m", testid: "t-a" },
    { id: "b", name: "B" },
  ];

  test("html：已选中态 / aria / 自定义文本", () => {
    const p = targetPicker({ prefix: "sk", items, chosen: ["a"], selLine: "已选 1", goText: "应用" });
    expect(p.html).toContain('data-testid="sk-picker-sel"');
    expect(p.html).toContain('data-testid="sk-picker-targets"');
    expect(p.html).toContain('aria-pressed="true"');
    expect(p.html).toContain('data-testid="t-a"');
    expect(p.html).toContain("stgt__sub");
    expect(p.html).toContain("已选 1");
    expect(p.html).toContain("应用");
  });

  test("html：无目标时禁用全选并显示空提示", () => {
    const p = targetPicker({ prefix: "x", items: [], chosen: [], emptyHint: "先配置" });
    expect(p.html).toContain("没有可选的目标");
    expect(p.html).toContain("先配置");
    expect(p.html).toContain("disabled");
  });

  test("bind：点击切换选中 + onChange 回调", () => {
    const seen: string[][] = [];
    const p = targetPicker({
      prefix: "sk",
      items,
      chosen: ["a"],
      onChange: (ids) => seen.push(ids),
    });
    const host = document.createElement("div");
    host.innerHTML = p.html;
    p.bind(host);
    const a = host.querySelector('[data-target="a"]') as HTMLElement;
    const b = host.querySelector('[data-target="b"]') as HTMLElement;
    a.click();
    b.click();
    expect(a.getAttribute("aria-pressed")).toBe("false");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(seen.at(-1)).toEqual(["b"]);
  });

  test("bind：全选 / 清空 + go 回调 + 文案函数", () => {
    const gone: string[][] = [];
    const p = targetPicker({
      prefix: "sk",
      items,
      chosen: [],
      goTextFn: (s) => `应用(${s.size})`,
      selLineFn: (s) => `选中 ${s.size}`,
      onGo: (ids) => gone.push(ids),
    });
    const host = document.createElement("div");
    host.innerHTML = p.html;
    p.bind(host);
    const quick = host.querySelector('[data-testid="sk-picker-quick"]') as HTMLButtonElement;
    const go = host.querySelector('[data-testid="sk-picker-go"]') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    quick.click();
    expect(quick.textContent).toBe("清空");
    expect(go.textContent).toBe("应用(2)");
    expect(host.querySelector('[data-testid="sk-picker-sel"]')?.textContent).toBe("选中 2");
    go.click();
    expect(gone).toEqual([["a", "b"]]);
    quick.click();
    expect(quick.textContent).toBe("全选");
    expect(go.disabled).toBe(true);
  });

  test("bind：host 为空 → 不抛", () => {
    targetPicker({ prefix: "x", items, chosen: [] }).bind(null);
  });
});

describe("hdrToggle / bindGroups", () => {
  test("hdrToggle：null → null；重复调用复用同一按钮", () => {
    expect(hdrToggle(null, "sk", () => undefined)).toBeNull();
    const hdr = document.createElement("div");
    const fn = (): void => undefined;
    const b1 = hdrToggle(hdr, "sk", fn);
    const b2 = hdrToggle(hdr, "sk", fn);
    expect(b1).toBe(b2);
    expect(hdr.querySelectorAll("#sk-hdrtoggle")).toHaveLength(1);
    expect(b1?.hidden).toBe(false);
    expect(b1?.getAttribute("aria-label")).toBe("切换到简略布局");
  });

  test("bindGroups：点击切换折叠，按钮内点击不触发", () => {
    document.body.innerHTML =
      '<div class="srcgroup" id="g"><div data-gfold="local"><button id="btn"></button></div></div>';
    bindGroups(document.body);
    const sideEl = document.querySelector("[data-gfold]") as HTMLElement;
    const grp = document.getElementById("g") as HTMLElement;
    sideEl.click();
    expect(grp.classList.contains("is-closed")).toBe(true);
    document.getElementById("btn")?.click();
    expect(grp.classList.contains("is-closed")).toBe(true);
  });

  test("bindGroups：Enter / Space 可切换，且幂等绑定", () => {
    document.body.innerHTML = '<div class="srcgroup" id="g"><div data-gfold="x"></div></div>';
    const sideEl = document.querySelector("[data-gfold]") as HTMLElement;
    const grp = document.getElementById("g") as HTMLElement;
    bindGroups(document.body);
    bindGroups(document.body);
    sideEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(grp.classList.contains("is-closed")).toBe(true);
    sideEl.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(grp.classList.contains("is-closed")).toBe(false);
    sideEl.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(grp.classList.contains("is-closed")).toBe(false);
  });

  test("bindGroups：null / 无节点 → 不抛", () => {
    bindGroups(null);
    bindGroups(document.createElement("div"));
  });
});

describe("side / chipBar", () => {
  test("side：平铺 + active + 计数为 0 不显示", () => {
    const html = side({
      prefix: "sk",
      items: [
        { id: "a", name: "A", short: "AA", cls: "c", count: 3 },
        { id: "b", name: "B", count: 0 },
      ],
      activeId: "a",
    });
    expect(html).toContain('id="sk-back"');
    expect(html).toContain("is-on");
    expect(html).toContain(">3<");
    expect(html).toContain("sside__n\"></span>");
  });

  test("side：分组过滤空组", () => {
    const html = side({
      prefix: "sk",
      items: [{ id: "a", name: "A" }],
      groups: [
        { kind: "local", label: "本地", ids: ["a"] },
        { kind: "remote", label: "远程", ids: ["x"] },
      ],
    });
    expect(html).toContain("本地");
    expect(html).not.toContain("远程");
  });

  test("chipBar：组标题 / 动作 / chip / 返回按钮", () => {
    const html = chipBar({
      prefix: "sk",
      items: [
        { id: "a", name: "A", short: "AA", count: 2 },
        { id: "b", name: "B" },
      ],
      activeId: "b",
      groups: [{ kind: "local", label: "本地", ids: ["a", "b"], actions: ["新建"] }],
    });
    expect(html).toContain('id="sk-barback"');
    expect(html).toContain("本地");
    expect(html).toContain('data-gact="local:新建"');
    expect(html).toContain("is-on");
    expect(html).toContain(">2<");
    expect(html).toContain(">0<");
  });
});

describe("item / accBody", () => {
  test("item：基础字段 + 属性 + 测试 id", () => {
    const html = item({
      id: 7,
      testid: "row",
      chkTestid: "row-check",
      title: "标题",
      titleTitle: "悬停",
      sub: "副标题",
      meta: "元信息",
      pillText: "新",
      pillTone: "accent",
      chipText: "CC",
      chipCls: "chip--x",
      attrs: 'data-x="1"',
    });
    expect(html).toContain('data-id="7"');
    expect(html).toContain('data-testid="row"');
    expect(html).toContain('data-testid="row-check"');
    expect(html).toContain('title="悬停"');
    expect(html).toContain("副标题");
    expect(html).toContain("元信息");
    expect(html).toContain("pill--accent");
    expect(html).toContain("has-chip");
    expect(html).toContain("data-x=\"1\"");
  });

  test("item：选中/展开态；展开时 meta 隐藏、body 渲染", () => {
    const html = item({ id: "a", title: "T", sel: true, open: true, meta: "M", body: "<p>B</p>" });
    expect(html).toContain("is-sel");
    expect(html).toContain("is-open");
    expect(html).not.toContain("mvi__meta");
    expect(html).toContain("<p>B</p>");
  });

  test("item：展开但无 body → 加载中占位", () => {
    expect(item({ id: 1, title: "T", open: true })).toContain("加载中…");
  });

  test("item：转义标题（XSS 反例）", () => {
    const html = item({ id: 1, title: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("accBody：meta/source/actions/text 与默认值", () => {
    const o: AccOptions = {
      meta: "v1",
      source: "src",
      text: "内容",
      actions: [
        { key: "edit", label: "编辑", testid: "e" },
        { key: "del", label: "删", disabled: true, title: "删除" },
      ],
    };
    const html = accBody(o);
    expect(html).toContain("v1");
    expect(html).toContain("来源 src");
    expect(html).toContain('data-acc="edit"');
    expect(html).toContain('data-testid="e"');
    expect(html).toContain("disabled");
    expect(html).toContain('title="删除"');
    expect(html).toContain("内容");
  });

  test("accBody：无 meta/source 不渲染头部；默认加载文案", () => {
    const html = accBody({});
    expect(html).not.toContain("mvi__bh");
    expect(html).toContain("加载中…");
  });
});

describe("ledger / recentLedger", () => {
  test("ledger：空 → 提示；有值 → 行 + bad 类", () => {
    expect(ledger(null)).toContain("暂无记录");
    expect(ledger([])).toContain("暂无记录");
    const html = ledger([{ time: "11-11 08:00", op: "sync · failed", name: "n", bad: true }]);
    expect(html).toContain("is-bad");
    expect(html).toContain("11-11 08:00");
  });

  test("recentLedger：关键词过滤、字段优先级、失败识别", () => {
    const rows: LedgerRow[] = [
      { id: 1, ts: "2026-11-11T08:00:00Z", action: "skills.sync", detail: '{"item_name":"a"}' },
      { id: 2, ts: "2026-11-11T09:00:00Z", action: "skills.push", detail: '{"sid":"s"}' },
      { id: 3, ts: "2026-11-11T10:00:00Z", action: "mcp.sync", detail: '{"tools":["x","y"]}' },
      { id: 4, ts: "2026-11-11T11:00:00Z", action: "skills.fail", detail: "fail conflict happened" },
    ];
    state.ledger = rows;
    const out = recentLedger(["skills"], 5);
    expect(out).toHaveLength(3);
    expect(out[0]?.name).toBe("a");
    expect(out[1]?.name).toBe("s");
    expect(out[2]?.name).toBe("fail conflict happened".slice(0, 40));
    expect(out[2]?.bad).toBe(true);
    expect(out[2]?.op).toContain("failed");
  });

  test("recentLedger：非 JSON 里的 error/fail 关键词也识别", () => {
    state.ledger = [{ id: 1, ts: "t", action: "x", detail: '{"error":"boom"}' }];
    const out = recentLedger(["x"]);
    expect(out[0]?.bad).toBe(true);
  });

  test("recentLedger：n 限制 + 空 detail", () => {
    state.ledger = [
      { id: 1, ts: "2026-11-11T00:00:00Z", action: "a", detail: null },
      { id: 2, ts: "2026-11-11T00:00:00Z", action: "a", detail: "{}" },
      { id: 3, ts: "2026-11-11T00:00:00Z", action: "a", detail: "{}" },
    ];
    expect(recentLedger(["a"], 2)).toHaveLength(2);
    expect(recentLedger(["a"])[0]?.name).toBe("");
  });
});

describe("shell / MV 输出面", () => {
  test("shell：prefix 派生 id、搜索值与占位", () => {
    const html = shell({ prefix: "sk", top: "<div>TOP</div>", q: "abc", placeholder: "搜" });
    expect(html).toContain('id="sk-top"');
    expect(html).toContain('id="sk-q"');
    expect(html).toContain('value="abc"');
    expect(html).toContain('placeholder="搜"');
    expect(html).toContain('id="sk-rows"');
    expect(html).toContain("TOP");
  });

  test("MV 聚合对象暴露全部组件", () => {
    for (const key of [
      "pill",
      "chip",
      "ic",
      "head",
      "chipBar",
      "syncCards",
      "growIn",
      "hdrToggle",
      "targetPicker",
      "bindGroups",
      "accBody",
      "card",
      "chev",
      "short",
      "cls",
      "top",
      "side",
      "item",
      "ledger",
      "recentLedger",
      "shell",
      "swap",
    ] as const) {
      expect(MV[key]).toBeDefined();
    }
    expect(MV.chev()).toContain("<svg");
  });
});
