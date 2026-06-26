import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';

type NotificationSource = Notification & { task?: { title: string } | null };

/**
 * HTTP-представление Уведомления для REST-слоя (контракт
 * `frontend/src/lib/notifications-api.ts`, тип `AppNotification`).
 *
 * Сопоставляет доменную сущность {@link Notification} с формой, ожидаемой
 * Центром уведомлений клиента (Req 7.1, 13.1, 14.4):
 * - тип уведомления приводится к перечислению фронтенда
 *   ({@link toFrontendType});
 * - статусы доставки по каналам приводятся к перечислению фронтенда
 *   ({@link toFrontendDeliveryStatus});
 * - момент формирования сериализуется в ISO-8601 (UTC); клиент отображает его в
 *   MSK (Req 1.2);
 * - локализованные на сервере `title`/`body` формируются по типу уведомления и
 *   полезной нагрузке (Req 1.1).
 *
 * Внутренние поля (`maxRetryCount`, `recipientId`, сырой `payload`) во внешнее
 * представление не попадают — наружу отдаются только поля контракта.
 */

/** Тип уведомления в перечислении фронтенда (зеркалит `NotificationType` клиента). */
export type FrontendNotificationType =
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

/** Статус доставки по каналу в перечислении фронтенда. */
export type FrontendDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

/**
 * Уведомление на сайте в форме контракта `frontend/src/lib/notifications-api.ts`
 * (`AppNotification`).
 */
export interface NotificationView {
  id: string;
  type: FrontendNotificationType;
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
  siteStatus: FrontendDeliveryStatus;
  /** Статус доставки через Бот MAX (независим от сайта, Req 14.6, 16.13). */
  maxStatus: FrontendDeliveryStatus;
}

/**
 * Сопоставление доменного {@link NotificationType} с типом фронтенда.
 *
 * Серверное перечисление детальнее клиентского (например, два порога
 * напоминания и два события смены роли), поэтому несколько доменных типов
 * сводятся к одному типу контракта (Req 13, 14, 15).
 */
const TYPE_MAP: Record<NotificationType, FrontendNotificationType> = {
  [NotificationType.TASK_ASSIGNED]: 'TASK_ASSIGNED',
  [NotificationType.TASK_UNASSIGNED]: 'TASK_UNASSIGNED',
  [NotificationType.TASK_FIELD_CHANGED]: 'TASK_UPDATED',
  [NotificationType.TASK_STATUS_CHANGED]: 'STATUS_CHANGED',
  [NotificationType.TASK_REOPENED]: 'TASK_REOPENED',
  [NotificationType.TASK_CANCELLED]: 'TASK_CANCELLED',
  [NotificationType.TASK_RETURNED]: 'TASK_RETURNED',
  [NotificationType.DEADLINE_REMINDER_FAR]: 'DEADLINE_REMINDER',
  [NotificationType.DEADLINE_REMINDER_NEAR]: 'DEADLINE_REMINDER',
  [NotificationType.CHAT_MESSAGE]: 'NEW_MESSAGE',
  [NotificationType.MANAGER_ROLE_CHANGED]: 'ROLE_CHANGED',
  [NotificationType.ADMIN_TRANSFER]: 'ROLE_CHANGED',
  // Приглашение/регистрация — событие уровня учётной записи; в перечислении
  // фронтенда отдельного типа нет, поэтому относим к смене роли/статуса доступа.
  [NotificationType.ACCOUNT_REGISTRATION]: 'ROLE_CHANGED',
};

/**
 * Сопоставление доменного {@link DeliveryStatus} со статусом фронтенда.
 *
 * Клиент различает только три состояния: `PENDING`/`DELIVERED`/`FAILED`.
 * Промежуточный `RETRY` отображается как «в процессе» (`PENDING`), намеренно
 * пропущенный `SKIPPED` — как неуспех канала (`FAILED`).
 */
const DELIVERY_STATUS_MAP: Record<DeliveryStatus, FrontendDeliveryStatus> = {
  [DeliveryStatus.PENDING]: 'PENDING',
  [DeliveryStatus.DELIVERED]: 'DELIVERED',
  [DeliveryStatus.RETRY]: 'PENDING',
  [DeliveryStatus.FAILED]: 'FAILED',
  [DeliveryStatus.SKIPPED]: 'FAILED',
};

/** Локализованные заголовки уведомлений по типу контракта (Req 1.1). */
const TITLE_MAP: Record<FrontendNotificationType, string> = {
  TASK_ASSIGNED: 'Назначение на задачу',
  TASK_UNASSIGNED: 'Снятие с задачи',
  TASK_UPDATED: 'Изменение задачи',
  STATUS_CHANGED: 'Статус задачи изменён',
  TASK_REOPENED: 'Задача переоткрыта',
  TASK_CANCELLED: 'Задача отменена',
  TASK_RETURNED: 'Задача возвращена',
  DEADLINE_REMINDER: 'Напоминание о дедлайне',
  ROLE_CHANGED: 'Изменение роли',
  NEW_MESSAGE: 'В чате новое сообщение',
};

/** Локализованные тексты уведомлений по типу контракта (Req 1.1). */
const BODY_MAP: Record<FrontendNotificationType, string> = {
  TASK_ASSIGNED: 'Вас назначили на задачу.',
  TASK_UNASSIGNED: 'Вас сняли с задачи.',
  TASK_UPDATED: 'Параметры задачи изменены.',
  STATUS_CHANGED: 'Статус задачи изменён.',
  TASK_REOPENED: 'Задача была переоткрыта.',
  TASK_CANCELLED: 'Задача была отменена.',
  TASK_RETURNED: 'Задача возвращена из отменённых.',
  DEADLINE_REMINDER: 'Приближается срок выполнения задачи.',
  ROLE_CHANGED: 'Ваша роль в системе изменена.',
  NEW_MESSAGE: 'В чате задачи появилось новое сообщение.',
};

/** Приводит доменный {@link NotificationType} к типу фронтенда (Req 13, 14, 15). */
export function toFrontendType(type: NotificationType): FrontendNotificationType {
  return TYPE_MAP[type];
}

/** Приводит доменный {@link DeliveryStatus} к статусу фронтенда. */
export function toFrontendDeliveryStatus(status: DeliveryStatus): FrontendDeliveryStatus {
  return DELIVERY_STATUS_MAP[status];
}

function payloadTaskTitle(notification: Notification): string | null {
  const payload = notification.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).taskTitle;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function notificationBody(notification: NotificationSource, type: FrontendNotificationType): string {
  return notification.task?.title ?? payloadTaskTitle(notification) ?? BODY_MAP[type];
}

/**
 * Преобразует доменное Уведомление в представление контракта `AppNotification`.
 *
 * Тип и статусы доставки приводятся к перечислениям фронтенда, момент
 * формирования сериализуется в ISO-8601, заголовок и текст локализуются по типу
 * (Req 1.1, 1.2, 7.1). Внутренние поля наружу не отдаются.
 *
 * @param notification Доменная запись Уведомления.
 * @returns Представление Уведомления для клиента.
 */
export function toNotificationView(notification: NotificationSource): NotificationView {
  const type = toFrontendType(notification.type);
  return {
    id: notification.id,
    type,
    isMessageNotification: notification.isMessageNotification,
    taskId: notification.taskId,
    messageId: notification.messageId,
    title: TITLE_MAP[type],
    body: notificationBody(notification, type),
    createdAt: notification.createdAt.toISOString(),
    siteStatus: toFrontendDeliveryStatus(notification.siteStatus),
    maxStatus: toFrontendDeliveryStatus(notification.maxStatus),
  };
}
