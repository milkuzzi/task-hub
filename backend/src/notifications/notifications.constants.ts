import { JobsOptions } from 'bullmq';

/**
 * Константы и DI-токены модуля уведомлений.
 */

/**
 * Имя задания доставки уведомления по каналам (сайт + MAX) в очереди BullMQ.
 *
 * Само задание ставится в очередь методом {@link NotificationsService.emit}
 * сразу после создания записи уведомления (Req 13.12). Фактическая доставка по
 * каналам и политика ретраев реализуются воркером доставки (задача 12.10).
 */
export const NOTIFICATION_DELIVERY_JOB_NAME = 'deliver-notification';

/**
 * Префикс ключа маркера-идемпотентности уведомления в Redis.
 *
 * Полный ключ имеет вид `{prefix}:{eventKey}:{recipientId}` и захватывается
 * атомарно (`SET … NX`) перед созданием записи уведомления. Это гарантирует,
 * что повторный вызов {@link NotificationsService.emit} с тем же ключом события
 * не создаст дублирующих уведомлений тому же получателю (Req 13.1).
 */
export const NOTIFICATION_IDEMPOTENCY_KEY_PREFIX = 'notifications:idem';

/**
 * Время жизни маркера-идемпотентности, секунды (по умолчанию 24 часа).
 *
 * Окно дедупликации значительно превышает требуемые 60 секунд постановки в
 * очередь (Req 13.12) и типичные интервалы повторных вызовов/ретраев источника
 * события, при этом маркеры не накапливаются в Redis бесконечно.
 */
export const NOTIFICATION_IDEMPOTENCY_TTL_SECONDS = 86_400;

/**
 * Параметры задания доставки уведомления для BullMQ.
 *
 * - `removeOnComplete: true` — успешно доставленные задания не накапливаются;
 * - `removeOnFail: false` — окончательно неуспешные задания сохраняются в
 *   очереди для разбора/повторной попытки.
 *
 * Политика ретраев по каналам (число попыток, интервалы 5 мин / 5 / 30 с)
 * задаётся воркером доставки (задача 12.10) и здесь намеренно не фиксируется,
 * чтобы метод {@link NotificationsService.emit} оставался обобщённым.
 */
export const NOTIFICATION_DELIVERY_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: false,
};

/**
 * Собирает ключ маркера-идемпотентности для пары «событие + получатель».
 *
 * @param eventKey Стабильный ключ доменного события.
 * @param recipientId Идентификатор получателя уведомления.
 * @returns Полный ключ Redis вида `{prefix}:{eventKey}:{recipientId}`.
 */
export function buildIdempotencyKey(eventKey: string, recipientId: string): string {
  return `${NOTIFICATION_IDEMPOTENCY_KEY_PREFIX}:${eventKey}:${recipientId}`;
}

/**
 * Префикс ключа признака неуспешного удаления уведомления о Сообщении в Боте
 * MAX (Req 14.7).
 *
 * Если удаление уведомления в MAX завершилось неуспешно, уведомление на сайте
 * удаляется в любом случае, а по этому ключу фиксируется признак для повторной
 * попытки удаления в MAX. Полный ключ имеет вид
 * `{prefix}:{notificationId}`.
 */
export const NOTIFICATION_MAX_DELETION_RETRY_KEY_PREFIX = 'notifications:max-deletion-retry';

/**
 * Время жизни признака неуспешного удаления в MAX, секунды (по умолчанию 24
 * часа). Окно достаточно велико для повторной попытки удаления, при этом
 * признаки не накапливаются в Redis бесконечно.
 */
export const NOTIFICATION_MAX_DELETION_RETRY_TTL_SECONDS = 86_400;

/**
 * Собирает ключ признака неуспешного удаления уведомления в Боте MAX (Req 14.7).
 *
 * @param notificationId Идентификатор уведомления о Сообщении.
 * @returns Полный ключ Redis вида `{prefix}:{notificationId}`.
 */
export function buildMaxDeletionRetryKey(notificationId: string): string {
  return `${NOTIFICATION_MAX_DELETION_RETRY_KEY_PREFIX}:${notificationId}`;
}
