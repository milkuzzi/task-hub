import { JobsOptions } from 'bullmq';

/**
 * Константы и DI-токены слоя отправки почты.
 */

/** DI-токен реализации адаптера отправки почты ({@link MailerProvider}). */
export const MAILER_PROVIDER = Symbol('MAILER_PROVIDER');

/** Имя задания отправки письма в очереди email. */
export const EMAIL_JOB_NAME = 'send-email';

/** Максимальное число попыток отправки одного письма — не более 3 (Req 1.7). */
export const MAX_EMAIL_ATTEMPTS = 3;

/** Базовая задержка экспоненциального backoff между попытками, мс. */
export const EMAIL_BACKOFF_DELAY_MS = 5_000;

/** Таймаут одного сетевого вызова к SendPulse, мс (Req 1.7 — окно 30с). */
export const SENDPULSE_REQUEST_TIMEOUT_MS = 30_000;

/** Базовый URL HTTP API SendPulse. */
export const SENDPULSE_API_BASE_URL = 'https://api.sendpulse.com';

/**
 * Параметры задания отправки письма для BullMQ.
 *
 * - `attempts`: не более 3 попыток доставки (Req 1.7);
 * - `backoff`: экспоненциальная задержка между попытками;
 * - `removeOnFail: false`: окончательно неуспешные задания сохраняются в
 *   очереди для последующей отправки (Req 1.7);
 * - `removeOnComplete: true`: успешно отправленные задания не накапливаются.
 */
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: MAX_EMAIL_ATTEMPTS,
  backoff: { type: 'exponential', delay: EMAIL_BACKOFF_DELAY_MS },
  removeOnFail: false,
  removeOnComplete: true,
};

/**
 * Признак исчерпания всех попыток доставки.
 * Возвращает `true`, когда выполненных попыток не меньше максимально
 * допустимого числа — то есть письмо окончательно не доставлено (Req 1.7).
 */
export function hasExhaustedAttempts(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade >= maxAttempts;
}
