/**
 * Чувствительная операция, к которой применяется ограничение частоты запросов
 * (rate limiting) — вход, установка/смена пароля, отправка сообщения, загрузка
 * файла (Req 19.1).
 */
export type SensitiveOp =
  'login' | 'password_reset' | 'set_password' | 'change_password' | 'send_message' | 'upload';

/**
 * Результат проверки ограничения частоты запросов.
 * `allowed = false` означает превышение допустимой частоты: вызывающая сторона
 * обязана отклонить запрос с {@link RateLimitException} (HTTP 429, Req 19.2).
 */
export interface RateLimitResult {
  /** Допущен ли текущий запрос в пределах скользящего окна. */
  allowed: boolean;
}
