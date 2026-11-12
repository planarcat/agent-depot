/**
 * 零依赖运行时校验组合子：类型推导与运行时检查同源。
 * 与 core/types/api.ts 配套——schema 定义处即类型来源（infer<typeof Schema>）。
 * 宽松口径（Tier 1 允许加法演进）：对象多余字段忽略，不视为错误。
 */

export class ShapeError extends Error {
  readonly path: string;
  constructor(path: string, expected: string, got: unknown) {
    const preview = (() => {
      try {
        const s = JSON.stringify(got);
        return s === undefined ? String(got) : s.slice(0, 120);
      } catch {
        return String(got);
      }
    })();
    super(`响应形状不符：${path} 期望 ${expected}，实得 ${preview}`);
    this.name = "ShapeError";
    this.path = path;
  }
}

export type Guard<T> = (v: unknown, path: string) => T;

export const str: Guard<string> = (v, p) => {
  if (typeof v !== "string") throw new ShapeError(p, "string", v);
  return v;
};

export const num: Guard<number> = (v, p) => {
  if (typeof v !== "number" || Number.isNaN(v)) throw new ShapeError(p, "number", v);
  return v;
};

export const bool: Guard<boolean> = (v, p) => {
  if (typeof v !== "boolean") throw new ShapeError(p, "boolean", v);
  return v;
};

export const unknownValue: Guard<unknown> = (v) => v;

/** 值可以是 null（后端可空列）。 */
export function nullable<T>(g: Guard<T>): Guard<T | null> {
  return (v, p) => (v === null ? null : g(v, p));
}

/** 值可以是 undefined（可选字段）。注意 exactOptionalPropertyTypes：只能缺省，不能显式 undefined。 */
export function optional<T>(g: Guard<T>): Guard<T | undefined> {
  return (v, p) => (v === undefined ? undefined : g(v, p));
}

/** 值可以是 null 或 undefined。 */
export function maybe<T>(g: Guard<T>): Guard<T | null | undefined> {
  return (v, p) => (v === null || v === undefined ? v : g(v, p));
}

export function oneOf<A, B>(a: Guard<A>, b: Guard<B>): Guard<A | B> {
  return (v, p) => {
    try {
      return a(v, p);
    } catch {
      return b(v, p);
    }
  };
}

export function arr<T>(g: Guard<T>): Guard<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) throw new ShapeError(p, "array", v);
    return v.map((item, i) => g(item, `${p}[${i}]`));
  };
}

export function record<T>(g: Guard<T>): Guard<Record<string, T>> {
  return (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new ShapeError(p, "object", v);
    }
    const out: Record<string, T> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = g(val, `${p}.${k}`);
    }
    return out;
  };
}

type Shape = Record<string, Guard<unknown>>;

/** 对象守卫：逐字段校验；多余字段忽略（加法演进）。 */
export function obj<S extends Shape>(shape: S): Guard<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new ShapeError(p, "object", v);
    }
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const guard = shape[key];
      if (guard !== undefined) out[key] = guard(src[key], `${p}.${key}`);
    }
    return out as { [K in keyof S]: ReturnType<S[K]> };
  };
}

/** 非空数组（列表首行访问安全）。 */
export function nonEmptyArr<T>(g: Guard<T>): Guard<T[]> {
  const inner = arr(g);
  return (v, p) => {
    const list = inner(v, p);
    if (list.length === 0) throw new ShapeError(p, "non-empty array", v);
    return list;
  };
}

export function assertShape<T>(guard: Guard<T>, value: unknown, label: string): T {
  try {
    return guard(value, label);
  } catch (e) {
    if (e instanceof ShapeError) throw e;
    throw new ShapeError(label, "shape", value);
  }
}
