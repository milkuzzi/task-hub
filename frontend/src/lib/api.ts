import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

// Помечаем повторно отправленный после продления Сессии запрос, чтобы не зациклить
// обновление токена при повторном 401.
declare module "axios" {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  export interface InternalAxiosRequestConfig {
    _retry?: boolean;
  }
}

/**
 * Единый REST-клиент «Системы поручений».
 *
 * - Базовый URL берётся из `VITE_API_BASE_URL`; по умолчанию `/api`
 *   (dev-прокси Vite → backend, в продакшене — через Nginx, Req 1.3).
 * - `withCredentials` включён: HttpOnly-cookie сессии передаётся браузером
 *   автоматически (Req 5.7).
 * - Ответы об ошибках backend имеют форму `{ code, message, details? }` с
 *   локализованными русскими сообщениями (Req 1.1) — нормализуем их в
 *   `ApiError` для единообразной обработки в UI.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";
const IS_TEST = import.meta.env.MODE === "test";

/** Структура ошибки доменного слоя backend (Req 1.1, 2.12). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Нормализованная ошибка API для слоя представления. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Обработчик продления Сессии для авто-восстановления при 401 (скользящая
 * сессия, исправление дефекта 9). Регистрируется провайдером аутентификации
 * ({@link AuthProvider}) и вызывается интерсептором при первом 401, чтобы
 * прозрачно продлить HttpOnly-cookie Сессии и повторить исходный запрос.
 */
type AuthRefreshHandler = () => Promise<boolean>;
let authRefreshHandler: AuthRefreshHandler | null = null;
let refreshInFlight: Promise<boolean> | null = null;
let sessionBearerToken: string | null = null;

export function setAuthRefreshHandler(
  handler: AuthRefreshHandler | null,
): void {
  authRefreshHandler = handler;
}

export function setSessionBearerToken(token: string | null): void {
  const value = token?.trim();
  sessionBearerToken = value === undefined || value === "" ? null : value;
}

export function hasSessionBearerToken(): boolean {
  return sessionBearerToken !== null;
}

/** Дедуплицирует параллельные продления: при шквале 401 продлеваем один раз. */
function refreshSessionOnce(): Promise<boolean> {
  if (authRefreshHandler === null) {
    return Promise.resolve(false);
  }
  if (refreshInFlight === null) {
    const handler = authRefreshHandler;
    refreshInFlight = handler().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Запросы аутентификации, для которых авто-продление при 401 не применяется. */
function isAuthFlowRequest(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }
  return (
    url.includes("/auth/refresh") ||
    url.includes("/auth/login") ||
    url.includes("/auth/max") ||
    url.includes("/auth/set-password") ||
    url.includes("/auth/password-reset")
  );
}

const testNetworkAdapter: AxiosAdapter = async (config) => {
  const status = isAuthFlowRequest(config.url) ? 401 : 404;
  const body: ApiErrorBody = {
    code: status === 401 ? "UNAUTHENTICATED" : "NOT_FOUND",
    message:
      status === 401
        ? "Требуется вход в систему."
        : "Тестовый API-ответ не настроен.",
  };
  const response = {
    data: body,
    status,
    statusText: status === 401 ? "Unauthorized" : "Not Found",
    headers: {},
    config: config as InternalAxiosRequestConfig,
    request: {},
  };
  throw new AxiosError(
    body.message,
    undefined,
    response.config,
    response.request,
    response,
  );
};

/** Базовый экземпляр axios с общими настройками. */
export const http: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
  ...(IS_TEST ? { adapter: testNetworkAdapter } : {}),
});

http.interceptors.request.use((config) => {
  if (sessionBearerToken !== null) {
    const headers = config.headers as typeof config.headers & {
      get?: (header: string) => unknown;
      set?: (header: string, value: string) => unknown;
    };
    const existing =
      typeof headers.get === "function"
        ? headers.get("Authorization")
        : (headers as unknown as Record<string, unknown>)["Authorization"] ??
          (headers as unknown as Record<string, unknown>)["authorization"];
    if (existing === undefined || existing === null || existing === "") {
      if (typeof headers.set === "function") {
        headers.set("Authorization", `Bearer ${sessionBearerToken}`);
      } else {
        config.headers.Authorization = `Bearer ${sessionBearerToken}`;
      }
    }
  }

  // Для multipart-запросов (например, загрузка аватара) убираем JSON-заголовок,
  // чтобы axios сам выставил `multipart/form-data` с корректным boundary.
  if (typeof FormData !== "undefined" && config.data instanceof FormData) {
    const headers = config.headers as typeof config.headers & {
      delete?: (header: string) => boolean;
      set?: (header: string, value: false) => unknown;
    };
    if (typeof headers.set === "function") {
      // Axios adds application/x-www-form-urlencoded after deletion; false
      // suppresses the default so the browser can provide multipart boundary.
      headers.set("Content-Type", false);
      headers.set("content-type", false);
    } else if (typeof headers.delete === "function") {
      headers.delete("Content-Type");
      headers.delete("content-type");
    } else {
      config.headers["Content-Type"] = false;
      config.headers["content-type"] = false;
    }
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0;
    const original = error.config;

    // Авто-продление Сессии при 401: один раз обновляем HttpOnly-cookie и
    // повторяем исходный запрос. Не применяется к самим запросам аутентификации
    // и к уже повторённому запросу (защита от цикла).
    if (
      status === 401 &&
      original !== undefined &&
      original._retry !== true &&
      !isAuthFlowRequest(original.url) &&
      authRefreshHandler !== null
    ) {
      original._retry = true;
      const refreshed = await refreshSessionOnce();
      if (refreshed) {
        return http(original);
      }
    }

    const body = error.response?.data;
    const message =
      body?.message ??
      error.message ??
      "Произошла ошибка. Повторите попытку позже.";
    const code = body?.code ?? "UNKNOWN";
    return Promise.reject(new ApiError(message, code, status, body?.details));
  },
);

/** Тонкие типобезопасные обёртки над HTTP-методами. */
export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    http
      .get<T>(url, { params, paramsSerializer: { indexes: null } })
      .then((r) => r.data),
  post: <T>(url: string, body?: unknown): Promise<T> =>
    http.post<T>(url, body).then((r) => r.data),
  patch: <T>(url: string, body?: unknown): Promise<T> =>
    http.patch<T>(url, body).then((r) => r.data),
  put: <T>(url: string, body?: unknown): Promise<T> =>
    http.put<T>(url, body).then((r) => r.data),
  delete: <T>(url: string): Promise<T> =>
    http.delete<T>(url).then((r) => r.data),
};
