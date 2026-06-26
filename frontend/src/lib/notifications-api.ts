import { api } from './api';

/**
 * Типы и REST-вызовы Центра уведомлений «Системы поручений» (Req 13, 14).
 *
 * Контракты соответствуют NotificationsModule дизайна и серверному
 * `NotificationsService`:
 * - `listNotifications()` — уведомления текущего Пользователя на сайте (Req 13.1).
 * - `markNotificationSeen(messageId)` — просмотр уведомления о Сообщении ведёт к
 *   его удалению на сайте и в Боте MAX в течение 3 секунд (Req 14.4, 16.12);
 *   соответствует `clearMessageNotification(userId, messageId)`.
 * - `dismissNotification(id)` — ручное снятие уведомления Пользователем.
 *
 * Живые уведомления приходят также через Socket.IO (`ChatEvents.Notification`),
 * имена событий синхронизированы с серверным `chat.events.ts`. Моменты времени
 * приходят в ISO-8601 (UTC); клиент отображает их в MSK (Req 1.2).
 */

/**
 * Тип уведомления (зеркалит серверное перечисление).
 *
 * Уведомления о Сообщениях Чата (`NEW_MESSAGE`) автоматически очищаются по
 * факту просмотра ≤3с (Req 14.4); прочие типы по просмотру не удаляются
 * (Req 14.5).
 */
export type NotificationType =
  | 'TASK_ASSIGNED'
  | 'TASK_UNASSIGNED'
  | 'TASK_UPDATED'
  | 'STATUS_CHANGED'
  | 'TASK_REOPENED'
  | 'TASK_CANCELLED'
  | 'TASK_RETURNED'
  | 'DEADLINE_REMINDER'
  | 'ROLE_CHANGED'
  | 'NEW_MESSAGE';

/** Статус доставки по каналу (сайт/MAX), зеркалит серверное перечисление. */
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

/**
 * Уведомление на сайте (зеркалит серверный `Notification`).
 *
 * `isMessageNotification` отмечает уведомления о Сообщениях Чата, подлежащие
 * автоочистке по просмотру (Req 14.4). `messageId` указывает Сообщение, по
 * просмотру которого уведомление очищается. `payload` несёт уже
 * локализованные на сервере текстовые поля (Req 1.1).
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  /** Уведомление о Сообщении Чата — очищается по просмотру (Req 14.4). */
  isMessageNotification: boolean;
  /** Связанная Задача (если применимо). */
  taskId: string | null;
  /** Связанное Сообщение (для уведомлений о Сообщениях, Req 14.4). */
  messageId: string | null;
  /** Заголовок уведомления (локализован на сервере, Req 1.1). */
  title: string;
  /** Текст уведомления (локализован на сервере, Req 1.1). */
  body: string;
  /** Момент формирования (ISO-8601, UTC) — отображается в MSK (Req 1.2). */
  createdAt: string;
  /** Статус доставки на сайт. */
  siteStatus: DeliveryStatus;
  /** Статус доставки через Бот MAX (независим от сайта, Req 14.6, 16.13). */
  maxStatus: DeliveryStatus;
}

const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'TASK_ASSIGNED',
  'TASK_UNASSIGNED',
  'TASK_UPDATED',
  'STATUS_CHANGED',
  'TASK_REOPENED',
  'TASK_CANCELLED',
  'TASK_RETURNED',
  'DEADLINE_REMINDER',
  'ROLE_CHANGED',
  'NEW_MESSAGE',
];
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['PENDING', 'DELIVERED', 'FAILED'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireNotification(value: unknown): AppNotification {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !NOTIFICATION_TYPES.includes(value.type as NotificationType) ||
    typeof value.isMessageNotification !== 'boolean' ||
    !(value.taskId === null || typeof value.taskId === 'string') ||
    !(value.messageId === null || typeof value.messageId === 'string') ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(new Date(value.createdAt).getTime()) ||
    !DELIVERY_STATUSES.includes(value.siteStatus as DeliveryStatus) ||
    !DELIVERY_STATUSES.includes(value.maxStatus as DeliveryStatus)
  ) {
    throw new TypeError('Некорректный ответ API: ожидалось уведомление');
  }
  return value as unknown as AppNotification;
}

/** Возвращает уведомления текущего Пользователя (новые → старые, Req 13.1). */
export async function listNotifications(): Promise<AppNotification[]> {
  const value = await api.get<unknown>('/notifications');
  if (!Array.isArray(value)) {
    throw new TypeError('Некорректный ответ API: ожидался список уведомлений');
  }
  return value.map(requireNotification);
}

/**
 * Сообщает серверу о просмотре уведомления о Сообщении Чата (Req 14.4).
 *
 * Сервер удаляет соответствующее уведомление на сайте и инициирует удаление в
 * Боте MAX (`clearMessageNotification`); при неуспехе в MAX фиксирует признак
 * для повторной попытки (Req 14.7). Идемпотентно: повторный вызов безопасен.
 */
export function markNotificationSeen(messageId: string): Promise<void> {
  return api.post<void>('/notifications/messages/seen', { messageId });
}

/** Снимает (скрывает) уведомление по идентификатору вручную. */
export function dismissNotification(notificationId: string): Promise<void> {
  return api.delete<void>(`/notifications/${notificationId}`);
}
