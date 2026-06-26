/**
 * Построение URL авторизации OAuth MAX для входа и привязки профиля
 * (Req 16.1, 6.6).
 *
 * Поток: клиент перенаправляет Пользователя на страницу авторизации MAX; после
 * согласия MAX возвращает на `redirect_uri` с параметром `code` (authCode),
 * который клиент отправляет на backend (`POST /auth/max` либо `POST /profile/max`).
 *
 * Параметры берутся из переменных окружения сборки Vite. Если они не заданы
 * (например, в окружении без интеграции MAX), используется серверный
 * эндпоинт-инициатор `${API_BASE}/auth/max/start`, который сам перенаправит на MAX.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const MAX_AUTHORIZE_URL = import.meta.env.VITE_MAX_AUTHORIZE_URL;
const MAX_CLIENT_ID = import.meta.env.VITE_MAX_CLIENT_ID;

/** Назначение OAuth-перехода: вход в Систему или привязка профиля. */
export type MaxOAuthPurpose = 'login' | 'link';

/** Путь обратного вызова на клиенте для соответствующего назначения. */
export function maxCallbackPath(purpose: MaxOAuthPurpose): string {
  return purpose === 'login' ? '/auth/max/callback' : '/profile/max/callback';
}

/**
 * Возвращает абсолютный URL, на который следует перенаправить браузер для
 * авторизации в MAX. `state` используется как защита от CSRF и для различения
 * назначения перехода.
 */
export function buildMaxOAuthUrl(purpose: MaxOAuthPurpose, state: string): string {
  const redirectUri = `${window.location.origin}${maxCallbackPath(purpose)}`;

  if (typeof MAX_AUTHORIZE_URL === 'string' && typeof MAX_CLIENT_ID === 'string') {
    const url = new URL(MAX_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', MAX_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  // Фолбэк: серверный инициатор OAuth (backend знает client_id/secret).
  const fallback = new URL(`${API_BASE_URL}/auth/max/start`, window.location.origin);
  fallback.searchParams.set('purpose', purpose);
  fallback.searchParams.set('redirect_uri', redirectUri);
  fallback.searchParams.set('state', state);
  return fallback.toString();
}

/** Генерирует случайное значение `state` (CSRF) для OAuth-перехода. */
export function generateOAuthState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ключ в sessionStorage для проверки `state` после возврата из MAX. */
export const MAX_OAUTH_STATE_KEY = 'max_oauth_state';
