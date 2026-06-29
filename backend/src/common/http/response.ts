type HeaderValue = string | number | string[];

export type ResponseHeaders = Record<string, HeaderValue>;

export interface HttpResponseLike {
  code?: (statusCode: number) => unknown;
  status?: (statusCode: number) => unknown;
  headers?: (headers: ResponseHeaders) => unknown;
  set?: (headers: ResponseHeaders) => unknown;
  header?: (name: string, value: HeaderValue) => unknown;
  setHeader?: (name: string, value: HeaderValue) => unknown;
  getHeader?: (name: string) => HeaderValue | undefined;
  send?: (body: unknown) => unknown;
  json?: (body: unknown) => unknown;
  redirect?: (url: string, statusCode?: number) => unknown;
  cookie?: (
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax';
      path: string;
      maxAge?: number;
    },
  ) => unknown;
  clearCookie?: (
    name: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax';
      path: string;
    },
  ) => unknown;
}

export function setResponseStatus(response: HttpResponseLike, statusCode: number): void {
  if (typeof response.code === 'function') {
    response.code(statusCode);
    return;
  }
  if (typeof response.status === 'function') {
    response.status(statusCode);
  }
}

export function setResponseHeaders(response: HttpResponseLike, headers: ResponseHeaders): void {
  if (typeof response.headers === 'function') {
    response.headers(headers);
    return;
  }
  if (typeof response.set === 'function') {
    response.set(headers);
    return;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (typeof response.header === 'function') {
      response.header(name, value);
    } else if (typeof response.setHeader === 'function') {
      response.setHeader(name, value);
    }
  }
}

export function sendJson(response: HttpResponseLike, body: unknown): void {
  if (typeof response.json === 'function') {
    response.json(body);
    return;
  }
  response.send?.(body);
}

export function redirectResponse(
  response: HttpResponseLike,
  statusCode: number,
  url: string,
): void {
  if (typeof response.redirect !== 'function') {
    setResponseStatus(response, statusCode);
    response.send?.({ location: url });
    return;
  }

  if (typeof response.code === 'function' || typeof response.status !== 'function') {
    response.redirect(url, statusCode);
    return;
  }

  (response.redirect as unknown as (statusCode: number, url: string) => unknown)(statusCode, url);
}

export function appendResponseHeader(
  response: HttpResponseLike,
  name: string,
  value: string,
): void {
  const existing = response.getHeader?.(name);
  const next =
    existing === undefined
      ? value
      : Array.isArray(existing)
        ? [...existing, value]
        : [String(existing), value];

  if (typeof response.header === 'function') {
    response.header(name, next);
    return;
  }
  response.setHeader?.(name, next);
}
