import { DeliveryStatus, NotificationType } from '@prisma/client';

/**
 * Чистая (без побочных эффектов) политика ретраев внешней доставки уведомлений
 * через Бот MAX (Req 13.13, 14.6, 15.7).
 *
 * Модуль не зависит от инфраструктуры (БД, очереди, Redis) и полностью
 * детерминирован, что делает его пригодным для модульного и property-тести-
 * рования (свойство 3 «Число попыток внешней доставки ограничено», задача
 * 12.11). Воркер доставки ({@link import('./notification-delivery.service')})
 * принимает решения только на основе функций этого модуля.
 *
 * Семантика числа попыток выровнена с очередью email (см.
 * {@link import('../../mailer/mailer.constants').MAX_EMAIL_ATTEMPTS}) и с
 * формулировкой свойства корректности 3: число попыток доставки одного
 * уведомления через MAX не превышает {@link MAX_DELIVERY_MAX_ATTEMPTS}.
 */

/**
 * Максимальное число попыток доставки одного уведомления через Бот MAX
 * (включая первую попытку) — не более 3 (свойство 3; Req 13.13, 14.6, 15.7).
 *
 * Поле `maxRetryCount` записи уведомления трактуется как число уже выполненных
 * (неуспешных) попыток доставки в MAX. По достижении этого предела канал MAX
 * переводится в окончательный статус {@link DeliveryStatus.FAILED}, а
 * уведомление на сайте сохраняется независимо (Req 14.6, 15.7).
 */
export const MAX_DELIVERY_MAX_ATTEMPTS = 3;

/** Интервал между ретраями доставки уведомлений о Задаче, мс — 5 минут (Req 13.13). */
export const TASK_RETRY_INTERVAL_MS = 5 * 60 * 1_000;

/** Интервал между ретраями доставки уведомлений о Сообщении Чата, мс — 5 секунд (Req 14.6). */
export const MESSAGE_RETRY_INTERVAL_MS = 5 * 1_000;

/** Интервал между ретраями доставки уведомлений по аккаунту/роли, мс — 30 секунд (Req 15.7). */
export const ACCOUNT_RETRY_INTERVAL_MS = 30 * 1_000;

/**
 * Класс уведомления, определяющий интервал ретраев внешней доставки.
 *
 * - `task` — события Задачи и напоминания о дедлайне: интервал 5 минут (Req 13.13);
 * - `message` — уведомления о новом Сообщении Чата: интервал 5 секунд (Req 14.6);
 * - `account` — уведомления по аккаунту/смене роли: интервал 30 секунд (Req 15.7).
 */
export type NotificationDeliveryClass = 'task' | 'message' | 'account';

/**
 * Классифицирует тип уведомления для выбора интервала ретраев.
 *
 * @param type Тип уведомления.
 * @returns Класс доставки ({@link NotificationDeliveryClass}).
 */
export function classifyNotification(type: NotificationType): NotificationDeliveryClass {
  switch (type) {
    case NotificationType.CHAT_MESSAGE:
      return 'message';
    case NotificationType.MANAGER_ROLE_CHANGED:
    case NotificationType.ADMIN_TRANSFER:
    case NotificationType.ACCOUNT_REGISTRATION:
      return 'account';
    case NotificationType.TASK_ASSIGNED:
    case NotificationType.TASK_UNASSIGNED:
    case NotificationType.TASK_FIELD_CHANGED:
    case NotificationType.TASK_STATUS_CHANGED:
    case NotificationType.TASK_REOPENED:
    case NotificationType.TASK_CANCELLED:
    case NotificationType.TASK_RETURNED:
    case NotificationType.DEADLINE_REMINDER_FAR:
    case NotificationType.DEADLINE_REMINDER_NEAR:
      return 'task';
    default:
      // Безопасное значение по умолчанию: интервал задач (наиболее консервативный).
      return 'task';
  }
}

/**
 * Возвращает интервал ретраев доставки в MAX (мс) для типа уведомления
 * (Req 13.13, 14.6, 15.7).
 *
 * @param type Тип уведомления.
 * @returns Интервал между повторными попытками доставки в миллисекундах.
 */
export function maxRetryIntervalMs(type: NotificationType): number {
  switch (classifyNotification(type)) {
    case 'message':
      return MESSAGE_RETRY_INTERVAL_MS;
    case 'account':
      return ACCOUNT_RETRY_INTERVAL_MS;
    case 'task':
      return TASK_RETRY_INTERVAL_MS;
  }
}

/**
 * Признак исчерпания всех попыток доставки в MAX (свойство 3; Req 13.13, 14.6,
 * 15.7).
 *
 * Возвращает `true`, когда число выполненных попыток достигло максимально
 * допустимого — то есть уведомление окончательно не доставлено через MAX
 * (статус канала переводится в {@link DeliveryStatus.FAILED}). Семантика
 * совпадает с очередью email
 * ({@link import('../../mailer/mailer.constants').hasExhaustedAttempts}).
 */
export function hasExhaustedMaxAttempts(
  attemptsMade: number,
  maxAttempts: number = MAX_DELIVERY_MAX_ATTEMPTS,
): boolean {
  return attemptsMade >= maxAttempts;
}

/**
 * Решение о дальнейшей судьбе доставки в MAX после очередной НЕУСПЕШНОЙ попытки.
 *
 * Чистый результат, на основе которого воркер обновляет запись уведомления и
 * (при необходимости) ставит отложенный ретрай в очередь.
 */
export interface MaxDeliveryDecision {
  /** Итоговое число выполненных (неуспешных) попыток доставки в MAX. */
  attemptsMade: number;
  /** Следует ли запланировать ещё одну попытку доставки. */
  shouldRetry: boolean;
  /**
   * Новый статус канала MAX: {@link DeliveryStatus.RETRY}, пока попытки не
   * исчерпаны, иначе {@link DeliveryStatus.FAILED}.
   */
  status: DeliveryStatus;
  /** Задержка перед следующей попыткой (мс) либо `null`, если ретрай не нужен. */
  retryDelayMs: number | null;
}

/**
 * Вычисляет решение о ретрае доставки в MAX после неуспешной попытки
 * (Req 13.13, 14.6, 15.7; свойство 3).
 *
 * Число попыток ограничено {@link MAX_DELIVERY_MAX_ATTEMPTS}: пока предел не
 * достигнут, назначается статус {@link DeliveryStatus.RETRY} и интервал ретрая
 * по типу уведомления; по достижении предела — {@link DeliveryStatus.FAILED}
 * без планирования новой попытки. Функция детерминирована и не имеет побочных
 * эффектов.
 *
 * @param type Тип уведомления (определяет интервал ретрая).
 * @param previousAttempts Число попыток, выполненных ДО текущей (поле
 *   `maxRetryCount` записи уведомления; 0 для первой попытки).
 * @returns Решение {@link MaxDeliveryDecision}.
 */
export function decideMaxDeliveryOnFailure(
  type: NotificationType,
  previousAttempts: number,
): MaxDeliveryDecision {
  const attemptsMade = previousAttempts + 1;
  const exhausted = hasExhaustedMaxAttempts(attemptsMade);
  return {
    attemptsMade,
    shouldRetry: !exhausted,
    status: exhausted ? DeliveryStatus.FAILED : DeliveryStatus.RETRY,
    retryDelayMs: exhausted ? null : maxRetryIntervalMs(type),
  };
}
