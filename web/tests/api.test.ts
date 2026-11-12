import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, api, live, post, request, send, setSlowRequestReporter } from "../src/core/api.ts";
import { arr, num, obj, str, unknownValue } from "../src/core/validate.ts";

const realFetch = globalThis.fetch;
const realNow = performance.now.bind(performance);

afterEach(() => {
  globalThis.fetch = realFetch;
  performance.now = realNow;
  setSlowRequestReporter(null);
});

type Call = { path: string; init: RequestInit | undefined };
function mockFetch(
  impl: (path: string, init?: RequestInit) => Promise<Response> | Response,
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return Promise.resolve(impl(path, init));
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("request · 成功路径", () => {
  test("200 JSON → status + data", async () => {
    mockFetch(() => json({ ok: true, n: 3 }));
    const r = await api<{ ok: boolean; n: number }>("/api/x");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, n: 3 });
  });

  test("空 body → {}", async () => {
    mockFetch(() => new Response("", { status: 204 }));
    const r = await request<Record<string, never>>("/api/empty");
    expect(r.status).toBe(204);
    expect(r.data).toEqual({});
  });

  test("HTTP 500 不抛错（错误码交给业务判定 data.ok）", async () => {
    mockFetch(() => json({ ok: false, error: "boom" }, 500));
    const r = await api<{ ok: boolean; error: string }>("/api/x");
    expect(r.status).toBe(500);
    expect(r.data.error).toBe("boom");
  });

  test("validate 通过时原样返回", async () => {
    mockFetch(() => json({ ok: true, rows: [{ id: 1, name: "a" }] }));
    const Schema = obj({ ok: unknownValue, rows: arr(obj({ id: num, name: str })) });
    const r = await api<unknown>("/api/x", { validate: Schema });
    expect((r.data as { rows: unknown[] }).rows).toHaveLength(1);
    expect(num(1, "$")).toBe(1);
    expect(str("a", "$")).toBe("a");
  });
});

describe("request · shape 错误", () => {
  test("非法 JSON → kind=shape，status 保留", async () => {
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const err = (await api("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("shape");
    expect(err.status).toBe(200);
    expect(err.path).toBe("/api/x");
    expect(err.message).toContain("不是合法 JSON");
  });

  test("形状不符 → kind=shape，带 ShapeError 文案", async () => {
    mockFetch(() => json({ ok: true, n: "not-a-number" }));
    const err = (await api("/api/x", { validate: obj({ n: num }) }).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("shape");
    expect(err.message).toContain("响应形状不符");
    expect(err.cause).toBeDefined();
  });

  test("守卫抛非 ShapeError → 通用文案兜底", async () => {
    mockFetch(() => json({ ok: true }));
    const boom = (): never => {
      throw new TypeError("boom");
    };
    const err = (await api("/api/x", { validate: boom as never }).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("shape");
    expect(err.message).toContain("响应形状不符");
  });
});

describe("request · 网络与超时", () => {
  test("fetch 拒绝 → kind=network / status 0 / cause 保留", async () => {
    const netErr = new Error("offline");
    mockFetch(() => Promise.reject(netErr));
    const err = (await api("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("network");
    expect(err.status).toBe(0);
    expect(err.cause).toBe(netErr);
    expect(err.message).toContain("网络错误");
  });

  test("AbortError → kind=timeout，message 含超时秒数", async () => {
    mockFetch(
      (_p, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const err = (await api("/api/slow", { timeoutMs: 15 }).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("请求超时");
    expect(err.message).toContain("0.015s");
  });

  test("silent：网络错误吞掉，返回 status 0 + 空对象", async () => {
    mockFetch(() => Promise.reject(new Error("offline")));
    const r = await api<{ ok?: boolean }>("/api/background", { silent: true });
    expect(r).toEqual({ status: 0, data: {} });
  });

  test("silent：shape 错误仍抛出（数据不可信不能静默）", async () => {
    mockFetch(() => new Response("nope", { status: 200 }));
    const err = (await api("/api/background", { silent: true }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe("shape");
  });
});

describe("慢请求上报", () => {
  test("超过阈值 → reporter(path, ms, status)", async () => {
    mockFetch(() => json({ ok: true }));
    let fake = 0;
    performance.now = () => (fake += 2500);
    const seen: Array<[string, number, number]> = [];
    setSlowRequestReporter((path, ms, status) => seen.push([path, ms, status]));
    await api("/api/slow");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("/api/slow");
    expect(seen[0]?.[2]).toBe(200);
  });

  test("未超阈值 → 不上报", async () => {
    mockFetch(() => json({ ok: true }));
    let fake = 0;
    performance.now = () => (fake += 100);
    let called = 0;
    setSlowRequestReporter(() => {
      called += 1;
    });
    await api("/api/fast");
    expect(called).toBe(0);
  });

  test("ApiError 路径也上报（带错误 status）", async () => {
    mockFetch(() => new Response("bad", { status: 502 }));
    let fake = 0;
    performance.now = () => (fake += 5000);
    const seen: number[] = [];
    setSlowRequestReporter((_p, _ms, status) => seen.push(status));
    await api("/api/bad").catch(() => undefined);
    expect(seen).toEqual([502]);
  });

  test("reporter 未注册 / 置空 → 不崩", async () => {
    mockFetch(() => json({ ok: true }));
    let fake = 0;
    performance.now = () => (fake += 5000);
    setSlowRequestReporter(null);
    const r = await api("/api/x");
    expect(r.status).toBe(200);
  });
});

describe("便捷封装", () => {
  test("api 显式 GET，非写请求不改 live.lastWrite", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    live.lastWrite = 0;
    await api("/api/x");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(live.lastWrite).toBe(0);
  });

  test("post 设置 JSON header / body / lastWrite", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    live.lastWrite = 0;
    await post("/api/x", { a: 1 });
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(calls[0]?.init?.body).toBe('{"a":1}');
    expect(live.lastWrite).toBeGreaterThan(0);
  });

  test("post 的 null body 归一为 {}", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    await post("/api/x", null);
    expect(calls[0]?.init?.body).toBe("{}");
  });

  test("send 透传 PATCH/PUT/DELETE", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    await send("/api/x", "PATCH", { b: 2 });
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(calls[0]?.init?.body).toBe('{"b":2}');
  });

  test("自定义 header 与 Content-Type 合并", async () => {
    const calls = mockFetch(() => json({ ok: true }));
    await post("/api/x", {}, { headers: { "X-Test": "1" } });
    const h = calls[0]?.init?.headers as Record<string, string>;
    expect(h["X-Test"]).toBe("1");
    expect(h["Content-Type"]).toBe("application/json");
  });
});

describe("ApiError 结构", () => {
  test("字段默认值：code=null、cause 可缺省", () => {
    const e = new ApiError({ kind: "http", message: "m", status: 500, path: "/p" });
    expect(e.name).toBe("ApiError");
    expect(e.code).toBeNull();
    expect(e.cause).toBeUndefined();
  });

  test("显式 code / cause 保留", () => {
    const cause = new Error("root");
    const e = new ApiError({ kind: "shape", message: "m", status: 1, path: "/p", code: "E1", cause });
    expect(e.code).toBe("E1");
    expect(e.cause).toBe(cause);
  });
});
