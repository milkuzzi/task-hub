/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL REST API. В dev по умолчанию прокси `/api`. */
  readonly VITE_API_BASE_URL?: string;
  /** URL Socket.IO. По умолчанию тот же источник, что и страница. */
  readonly VITE_SOCKET_URL?: string;
  /** Отключает Socket.IO для preview/smoke окружений без realtime backend. */
  readonly VITE_SOCKET_DISABLED?: string;
  /** URL страницы авторизации OAuth MAX (если интеграция настроена на клиенте). */
  readonly VITE_MAX_AUTHORIZE_URL?: string;
  /** Идентификатор клиента OAuth MAX. */
  readonly VITE_MAX_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
