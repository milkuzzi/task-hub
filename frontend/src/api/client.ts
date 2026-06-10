import type { ApiError } from "../shared/schemas";

// Centralized fetch wrapper:
//  - sends cookies (credentials: include)
//  - injects X-CSRF-Token from the csrf_token cookie on mutations
//  - on 401 -> single refresh attempt -> replay; on repeated 401 -> logout event
//  - surfaces the RU {code,message} error envelope as a typed ApiError
//  - exposes ETag helpers (If-None-Match) for cached GETs

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function readCookie(name: string): string | null {
  const m = document.cookie.match("(^|;)\\s*" + name + "=([^;]+)");
  return m ? decodeURIComponent(m[2]) : null;
}

export class ApiException extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, body: ApiError) {
    super(body.message);
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

let refreshing: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: csrfHeader(),
    })
      .then((r) => r.ok)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function csrfHeader(): Record<string, string> {
  const t = readCookie("csrf_token");
  return t ? { "X-CSRF-Token": t } : {};
}

export interface ReqOpts {
  method?: string;
  body?: unknown;
  etag?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ReqOpts = {}): Promise<{ data: T; etag: string | null; notModified: boolean }> {
  const method = (opts.method || "GET").toUpperCase();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!SAFE.has(method)) Object.assign(headers, csrfHeader());
  if (opts.etag) headers["If-None-Match"] = opts.etag;

  const run = () =>
    fetch(path, {
      method,
      credentials: "include",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

  let res = await run();
  if (res.status === 401 && path !== "/api/auth/refresh") {
    const ok = await doRefresh();
    if (ok) {
      res = await run();
    } else {
      window.dispatchEvent(new CustomEvent("auth:logout"));
      throw new ApiException(401, { code: "UNAUTHENTICATED", message: "Сессия истекла" });
    }
  }

  if (res.status === 304) {
    return { data: undefined as unknown as T, etag: opts.etag ?? null, notModified: true };
  }
  const etag = res.headers.get("ETag");
  if (res.status === 204) {
    return { data: undefined as unknown as T, etag, notModified: false };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiException(res.status, json as ApiError);
  }
  return { data: json as T, etag, notModified: false };
}
