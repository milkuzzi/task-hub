import axios, { AxiosError, type AxiosInstance } from 'axios';

// Помечаем повторно отправленный после продления Сессии запрос, чтобы не зациклить
// обновление токена при повторном 401.
declare module 'axios' {
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
 * - `withCredentials` включён: сессия передаётся cookie/заголовком (Req 5.7).
 * - Bearer-токен сессии подставляется из `tokenStore`, если задан.
 * - Ответы об ошибках backend имеют форму `{ code, message, details? }` с
 *   локализованными русскими сообщениями (Req 1.1) — нормализуем их в
 *   `ApiError` для единообразной обработки в UI.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

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
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Хранилище токена сессии (в памяти). Источник — экран входа (задача 20.2). */
let sessionToken: string | null = null;

export const tokenStore = {
  get(): string | null {
    return sessionToken;
  },
  set(token: string | null): void {
    sessionToken = token;
  },
  clear(): void {
    sessionToken = null;
  },
};

/**
 * Обработчик продления Сессии для авто-восстановления при 401 (скользящая
 * сессия, исправление дефекта 9). Регистрируется провайдером аутентификации
 * ({@link AuthProvider}) и вызывается интерсептором при первом 401, чтобы
 * прозрачно продлить Сессию и повторить исходный запрос. Возвращает новый токен
 * при успехе либо `null`, если продление невозможно (Сессия действительно
 * аннулирована/истекла — Req 3.9).
 */
type AuthRefreshHandler = () => Promise<string | null>;
let authRefreshHandler: AuthRefreshHandler | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setAuthRefreshHandler(handler: AuthRefreshHandler | null): void {
  authRefreshHandler = handler;
}

/** Дедуплицирует параллельные продления: при шквале 401 продлеваем один раз. */
function refreshSessionOnce(): Promise<string | null> {
  if (authRefreshHandler === null) {
    return Promise.resolve(null);
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
    url.includes('/auth/refresh') ||
    url.includes('/auth/login') ||
    url.includes('/auth/max')
  );
}

/** Базовый экземпляр axios с общими настройками. */
export const http: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Для multipart-запросов (например, загрузка аватара) убираем JSON-заголовок,
  // чтобы axios сам выставил `multipart/form-data` с корректным boundary.
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    const headers = config.headers as typeof config.headers & {
      delete?: (header: string) => boolean;
      set?: (header: string, value: false) => unknown;
    };
    if (typeof headers.set === 'function') {
      // Axios adds application/x-www-form-urlencoded after deletion; false
      // suppresses the default so the browser can provide multipart boundary.
      headers.set('Content-Type', false);
      headers.set('content-type', false);
    } else if (typeof headers.delete === 'function') {
      headers.delete('Content-Type');
      headers.delete('content-type');
    } else {
      config.headers['Content-Type'] = false;
      config.headers['content-type'] = false;
    }
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0;
    const original = error.config;

    // Авто-продление Сессии при 401: один раз пытаемся продлить действующую
    // Сессию и повторить исходный запрос с новым токеном (скользящая сессия,
    // исправление дефекта 9). Не применяется к самим запросам аутентификации и
    // к уже повторённому запросу (защита от цикла). Если продление невозможно
    // (Сессия аннулирована/истекла) — пробрасываем ошибку как обычно (Req 3.9).
    if (
      status === 401 &&
      original !== undefined &&
      original._retry !== true &&
      !isAuthFlowRequest(original.url) &&
      authRefreshHandler !== null
    ) {
      original._retry = true;
      const newToken = await refreshSessionOnce();
      if (newToken !== null) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return http(original);
      }
    }

    const body = error.response?.data;
    const message =
      body?.message ?? error.message ?? 'Произошла ошибка. Повторите попытку позже.';
    const code = body?.code ?? 'UNKNOWN';
    return Promise.reject(new ApiError(message, code, status, body?.details));
  },
);

/** Тонкие типобезопасные обёртки над HTTP-методами. */
export const api = {
  get: <T>(url: string, params?: Record<string, unknown>): Promise<T> =>
    http.get<T>(url, { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
  post: <T>(url: string, body?: unknown): Promise<T> =>
    http.post<T>(url, body).then((r) => r.data),
  patch: <T>(url: string, body?: unknown): Promise<T> =>
    http.patch<T>(url, body).then((r) => r.data),
  put: <T>(url: string, body?: unknown): Promise<T> =>
    http.put<T>(url, body).then((r) => r.data),
  delete: <T>(url: string): Promise<T> => http.delete<T>(url).then((r) => r.data),
};
