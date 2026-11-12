/**
 * fetch 封装：超时、错误归一（ApiError）、慢请求上报钩子、可选的响应形状校验。
 * 所有接口调用经由此处——视图层不直接 fetch。
 */

import { type Guard, ShapeError } from "./validate.ts";

export type ApiErrorKind = "network" | "timeout" | "http" | "shape";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | null;
  readonly path: string;
  override readonly cause?: unknown;

  constructor(init: {
    kind: ApiErrorKind;
    message: string;
    status: number;
    path: string;
    code?: string | null;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.path = init.path;
    this.code = init.code ?? null;
    if (init.cause !== undefined) this.cause = init.cause;
  }
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

/** 慢请求上报（core/report.ts 注册；未注册则静默）。 */
export type SlowRequestReporter = (path: string, ms: number, status: number) => void;
let slowReporter: SlowRequestReporter | null = null;
export function setSlowRequestReporter(fn: SlowRequestReporter | null): void {
  slowReporter = fn;
}

/** 写入型请求的 "自身写入" 时间戳（SSE 静默窗口用）。 */
export const live = { lastWrite: 0 };

const DEFAULT_TIMEOUT_MS = 20_000;
const SLOW_THRESHOLD_MS = 2000;

interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 响应形状校验（失败即抛 ShapeError → ApiError(shape)）。 */
  validate?: Guard<unknown>;
  /** 请求超时（毫秒）；默认 20s。 */
  timeoutMs?: number;
  /** 静默失败（不打印、不抛错，返回 status 0 + 空对象）——仅用于非关键背景请求。 */
  silent?: boolean;
}

/** 统一请求：任何失败都归一为 ApiError，返回值形状保持 {status, data}。 */
export async function request<T>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const isWrite = !!opts.method && opts.method !== "GET";
  if (isWrite) live.lastWrite = Date.now();
  const started = performance.now();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (opts.method !== undefined) init.method = opts.method;
    if (opts.headers !== undefined) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body;
    const res = await fetch(path, init);
    const text = await res.text();
    let parsed: unknown = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new ApiError({
          kind: "shape",
          message: `响应不是合法 JSON（${path}）`,
          status: res.status,
          path,
          cause: e,
        });
      }
    }
    if (opts.validate) {
      try {
        opts.validate(parsed, "$");
      } catch (e) {
        const message = e instanceof ShapeError ? e.message : `响应形状不符（${path}）`;
        throw new ApiError({
          kind: "shape",
          message,
          status: res.status,
          path,
          cause: e,
        });
      }
    }
    const ms = performance.now() - started;
    if (ms > SLOW_THRESHOLD_MS && slowReporter) slowReporter(path, Math.round(ms), res.status);
    return { status: res.status, data: parsed as T };
  } catch (e) {
    const ms = performance.now() - started;
    if (e instanceof ApiError) {
      if (ms > SLOW_THRESHOLD_MS && slowReporter) slowReporter(path, Math.round(ms), e.status);
      throw e;
    }
    const aborted = e instanceof DOMException && e.name === "AbortError";
    const err = new ApiError({
      kind: aborted ? "timeout" : "network",
      message: aborted
        ? `请求超时（${timeoutMs / 1000}s）：${path}`
        : `网络错误：${e instanceof Error ? e.message : String(e)}`,
      status: 0,
      path,
      cause: e,
    });
    if (!opts.silent) throw err;
    return { status: 0, data: {} as T };
  } finally {
    clearTimeout(timer);
  }
}

/** GET 便捷封装。 */
export function api<T>(path: string, opts: Omit<ApiOptions, "method"> = {}): Promise<ApiResult<T>> {
  return request<T>(path, { ...opts, method: "GET" });
}

/** POST JSON 便捷封装。 */
export function post<T>(
  path: string,
  body: unknown = {},
  opts: Omit<ApiOptions, "method" | "body"> = {},
): Promise<ApiResult<T>> {
  return request<T>(path, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** 带自定义 method 的 JSON 请求（PATCH/PUT/DELETE 等）。 */
export function send<T>(
  path: string,
  method: string,
  body: unknown = {},
  opts: Omit<ApiOptions, "method" | "body"> = {},
): Promise<ApiResult<T>> {
  return request<T>(path, {
    ...opts,
    method,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(body ?? {}),
  });
}
