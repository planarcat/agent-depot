import { describe, expect, test } from "bun:test";
import {
  arr,
  assertShape,
  bool,
  maybe,
  nonEmptyArr,
  nullable,
  num,
  obj,
  oneOf,
  optional,
  record,
  ShapeError,
  str,
  unknownValue,
} from "../src/core/validate.ts";

/** 取守卫抛出的 ShapeError（断言类型 + path）。 */
function shapeError(fn: () => unknown): ShapeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ShapeError);
    return e as ShapeError;
  }
  throw new Error("预期抛出 ShapeError，实际未抛");
}

describe("基础守卫 · 正例", () => {
  test("str / num / bool / unknownValue", () => {
    expect(str("x", "$")).toBe("x");
    expect(str("", "$")).toBe("");
    expect(num(0, "$")).toBe(0);
    expect(num(-1.5, "$")).toBe(-1.5);
    expect(bool(true, "$")).toBe(true);
    expect(bool(false, "$")).toBe(false);
    expect(unknownValue({ a: 1 }, "$")).toEqual({ a: 1 });
  });
});

describe("基础守卫 · 反例与 path", () => {
  test("str 拒绝数字/null/对象", () => {
    expect(shapeError(() => str(1, "$.name")).path).toBe("$.name");
    expect(() => str(null, "$")).toThrow(ShapeError);
    expect(() => str({}, "$")).toThrow(ShapeError);
  });

  test("num 拒绝 NaN 与字符串", () => {
    expect(() => num(Number.NaN, "$.n")).toThrow(/期望 number/u);
    expect(() => num("1", "$.n")).toThrow(ShapeError);
  });

  test("bool 拒绝 0/1", () => {
    expect(() => bool(0, "$.b")).toThrow(ShapeError);
    expect(() => bool("true", "$.b")).toThrow(ShapeError);
  });
});

describe("nullable / optional / maybe", () => {
  test("nullable 放行 null，其余交给内层", () => {
    expect(nullable(str)(null, "$")).toBeNull();
    expect(nullable(str)("a", "$")).toBe("a");
    expect(() => nullable(str)(1, "$")).toThrow(ShapeError);
  });

  test("optional 放行 undefined，不放行 null", () => {
    expect(optional(str)(undefined, "$")).toBeUndefined();
    expect(optional(str)("a", "$")).toBe("a");
    expect(() => optional(str)(null, "$")).toThrow(ShapeError);
  });

  test("maybe 同时放行 null / undefined", () => {
    expect(maybe(num)(null, "$")).toBeNull();
    expect(maybe(num)(undefined, "$")).toBeUndefined();
    expect(maybe(num)(3, "$")).toBe(3);
  });
});

describe("oneOf", () => {
  test("第一个守卫通过即返回", () => {
    const g = oneOf(str, num);
    expect(g("x", "$")).toBe("x");
    expect(g(1, "$")).toBe(1);
  });

  test("都失败时抛第二个守卫的错误（path 保留）", () => {
    const e = shapeError(() => oneOf(str, bool)(1, "$.v"));
    expect(e.path).toBe("$.v");
    expect(e.message).toContain("boolean");
  });
});

describe("arr / nonEmptyArr", () => {
  test("逐项校验并带下标 path", () => {
    expect(arr(num)([1, 2], "$.xs")).toEqual([1, 2]);
    const e = shapeError(() => arr(num)([1, "x"], "$.xs"));
    expect(e.path).toBe("$.xs[1]");
  });

  test("非数组报 array", () => {
    expect(() => arr(str)({}, "$.xs")).toThrow(/期望 array/u);
    expect(() => arr(str)("no", "$.xs")).toThrow(ShapeError);
  });

  test("nonEmptyArr 空数组报错、非空放行", () => {
    expect(nonEmptyArr(num)([0], "$.xs")).toEqual([0]);
    expect(() => nonEmptyArr(num)([], "$.xs")).toThrow(/non-empty array/u);
  });
});

describe("record / obj", () => {
  test("record 逐值校验", () => {
    expect(record(num)({ a: 1, b: 2 }, "$")).toEqual({ a: 1, b: 2 });
    expect(() => record(num)({ a: "x" }, "$.r")).toThrow(ShapeError);
    expect(shapeError(() => record(num)({ a: "x" }, "$.r")).path).toBe("$.r.a");
  });

  test("record 拒绝 null / 数组 / 原始值", () => {
    expect(() => record(num)(null, "$")).toThrow(/期望 object/u);
    expect(() => record(num)([], "$")).toThrow(ShapeError);
    expect(() => record(num)(1, "$")).toThrow(ShapeError);
  });

  test("obj 忽略多余字段（加法演进）", () => {
    const g = obj({ id: num, name: str });
    expect(g({ id: 1, name: "a", extra: true }, "$")).toEqual({ id: 1, name: "a" });
  });

  test("obj 缺字段 / 类型错 → 字段级 path", () => {
    const g = obj({ id: num, name: str });
    expect(shapeError(() => g({ id: 1 }, "$.row")).path).toBe("$.row.name");
    expect(shapeError(() => g({ id: "1", name: "a" }, "$.row")).path).toBe("$.row.id");
  });

  test("obj 拒绝数组 / null", () => {
    expect(() => obj({})([], "$")).toThrow(/期望 object/u);
    expect(() => obj({})(null, "$")).toThrow(ShapeError);
  });

  test("嵌套 obj + arr 的 path 可定位", () => {
    const g = obj({ rows: arr(obj({ id: num })) });
    const e = shapeError(() => g({ rows: [{ id: 1 }, { id: "x" }] }, "$"));
    expect(e.path).toBe("$.rows[1].id");
  });
});

describe("ShapeError 消息", () => {
  test("包含 path / expected / 值预览", () => {
    const e = new ShapeError("$.a", "string", 42);
    expect(e.name).toBe("ShapeError");
    expect(e.path).toBe("$.a");
    expect(e.message).toContain("$.a");
    expect(e.message).toContain("string");
    expect(e.message).toContain("42");
  });

  test("长值预览截断到 120 字符", () => {
    const e = new ShapeError("$", "string", "x".repeat(500));
    expect(e.message.length).toBeLessThan(200);
    expect(e.message.endsWith("…")).toBe(false);
  });

  test("循环对象不炸（JSON.stringify 抛错走 String）", () => {
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    const e = new ShapeError("$", "object", cyc);
    expect(e.message).toContain("[object Object]");
  });
});

describe("assertShape", () => {
  test("通过时返回值", () => {
    expect(assertShape(num, 1, "$")).toBe(1);
  });

  test("ShapeError 原样抛出", () => {
    const e = shapeError(() => assertShape(str, 1, "$.x"));
    expect(e.path).toBe("$.x");
  });

  test("非 ShapeError 包装为 shape 错误", () => {
    const boom = (): never => {
      throw new TypeError("boom");
    };
    const e = shapeError(() => assertShape(boom as never, 1, "$.y"));
    expect(e.path).toBe("$.y");
  });
});
