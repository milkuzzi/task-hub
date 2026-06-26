/**
 * Константы интеграции OAuth MAX.
 */

/** Таймаут одного сетевого вызова к сервису OAuth MAX (мс). */
export const MAX_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Относительный путь эндпоинта обмена кода авторизации на токен доступа
 * (OAuth2 `authorization_code`). Базовый адрес берётся из конфигурации MAX
 * ({@link import('../../config').MaxConfig.botApiBaseUrl}).
 */
export const MAX_OAUTH_TOKEN_PATH = '/oauth/token';

/**
 * Относительный путь эндпоинта получения сведений о профиле MAX по токену
 * доступа. Используется для извлечения стабильного идентификатора профиля
 * (`maxUserId`).
 */
export const MAX_OAUTH_USERINFO_PATH = '/oauth/userinfo';
