import {
  AssignmentKind,
  DeliveryStatus,
  Notification,
  NotificationType,
  ReminderThreshold,
  TaskStatus,
} from '@prisma/client';

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

const ASSIGNMENT_KIND_LABELS: Record<AssignmentKind, string> = {
  [AssignmentKind.EXECUTOR]: 'исполнитель',
  [AssignmentKind.MANAGER]: 'менеджер',
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.IN_PROGRESS]: 'В работе',
  [TaskStatus.WAITING]: 'Ожидает',
  [TaskStatus.DONE]: 'Выполнено',
  [TaskStatus.NEEDS_ADMIN]: 'Требует администратора',
  [TaskStatus.CANCELLED]: 'Отменено',
};

const TASK_FIELD_LABELS: Record<string, string> = {
  title: 'название',
  description: 'описание',
  deadline: 'дедлайн',
};

/** Приводит доменный {@link NotificationType} к типу фронтенда (Req 13, 14, 15). */
export function toFrontendType(type: NotificationType): FrontendNotificationType {
  return TYPE_MAP[type];
}

/** Приводит доменный {@link DeliveryStatus} к статусу фронтенда. */
export function toFrontendDeliveryStatus(status: DeliveryStatus): FrontendDeliveryStatus {
  return DELIVERY_STATUS_MAP[status];
}

type PayloadRecord = Record<string, unknown>;

function payloadRecord(notification: Notification): PayloadRecord {
  const payload = notification.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {};
  }
  return payload as PayloadRecord;
}

function payloadString(payload: PayloadRecord, key: string): string | null {
  const value = payload[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function taskTitle(notification: NotificationSource, payload: PayloadRecord): string | null {
  return notification.task?.title ?? payloadString(payload, 'taskTitle');
}

function quotedTask(title: string | null): string {
  return title === null ? 'Задача без загруженного названия' : `Задача «${title}»`;
}

function assignmentKind(payload: PayloadRecord): string {
  const kind = payloadString(payload, 'kind');
  if (kind === AssignmentKind.EXECUTOR || kind === AssignmentKind.MANAGER) {
    return ASSIGNMENT_KIND_LABELS[kind];
  }
  return 'участник';
}

function statusLabel(payload: PayloadRecord): string | null {
  const status = payloadString(payload, 'status');
  if (status !== null && status in TASK_STATUS_LABELS) {
    return TASK_STATUS_LABELS[status as TaskStatus];
  }
  return status;
}

function changedFieldLabels(payload: PayloadRecord): string {
  const value = payload.changedFields;
  if (!Array.isArray(value)) {
    return 'параметры задачи';
  }
  const labels = value
    .filter((field): field is string => typeof field === 'string' && field.trim() !== '')
    .map((field) => TASK_FIELD_LABELS[field] ?? field);
  if (labels.length === 0) {
    return 'параметры задачи';
  }
  return labels.join(', ');
}

function deadlineThreshold(notification: Notification, payload: PayloadRecord): string {
  const threshold = payloadString(payload, 'threshold');
  if (
    threshold === ReminderThreshold.NEAR ||
    notification.type === NotificationType.DEADLINE_REMINDER_NEAR
  ) {
    return 'ближний порог напоминания';
  }
  if (
    threshold === ReminderThreshold.FAR ||
    notification.type === NotificationType.DEADLINE_REMINDER_FAR
  ) {
    return 'дальний порог напоминания';
  }
  return 'порог напоминания';
}

function roleChangeBody(notification: Notification, payload: PayloadRecord): string {
  if (notification.type === NotificationType.MANAGER_ROLE_CHANGED) {
    if (payload.assigned === true) {
      return 'Вам назначена роль Менеджера. Доступны задачи, где вы указаны менеджером, и действия по управлению такими задачами.';
    }
    if (payload.assigned === false) {
      return 'С вас снята роль Менеджера. Управление задачами Менеджера больше недоступно, если нет отдельного назначения.';
    }
  }
  if (notification.type === NotificationType.ADMIN_TRANSFER) {
    return 'Изменены права Администратора. Проверьте актуальную роль и доступные разделы системы.';
  }
  if (notification.type === NotificationType.ACCOUNT_REGISTRATION) {
    return 'Для вашей учётной записи создано приглашение или завершена регистрация. Доступ зависит от текущей роли пользователя.';
  }
  return BODY_MAP.ROLE_CHANGED;
}

function notificationBody(
  notification: NotificationSource,
  type: FrontendNotificationType,
): string {
  const payload = payloadRecord(notification);
  const task = quotedTask(taskTitle(notification, payload));

  switch (notification.type) {
    case NotificationType.TASK_ASSIGNED:
      return `${task}. Вас назначили на задачу как ${assignmentKind(payload)}.`;
    case NotificationType.TASK_UNASSIGNED:
      return `${task}. Вас сняли с участия в задаче.`;
    case NotificationType.TASK_FIELD_CHANGED:
      return `${task}. Изменены поля: ${changedFieldLabels(payload)}.`;
    case NotificationType.TASK_STATUS_CHANGED: {
      const status = statusLabel(payload);
      return status === null
        ? `${task}. Статус задачи изменён.`
        : `${task}. Новый статус: «${status}».`;
    }
    case NotificationType.TASK_REOPENED:
      return `${task}. Задача переоткрыта и снова требует работы.`;
    case NotificationType.TASK_CANCELLED:
      return `${task}. Задача отменена.`;
    case NotificationType.TASK_RETURNED:
      return `${task}. Задача возвращена из отменённых в работу.`;
    case NotificationType.DEADLINE_REMINDER_FAR:
    case NotificationType.DEADLINE_REMINDER_NEAR:
      return `${task}. Приближается дедлайн: ${deadlineThreshold(notification, payload)}.`;
    case NotificationType.CHAT_MESSAGE: {
      const authorDisplayName = payloadString(payload, 'authorDisplayName');
      if (authorDisplayName !== null) {
        return `${task}. В чате задачи опубликовано новое сообщение от ${authorDisplayName}.`;
      }
      const authorId = payloadString(payload, 'authorId');
      return authorId === null
        ? `${task}. В чате задачи опубликовано новое сообщение.`
        : `${task}. В чате задачи опубликовано новое сообщение от участника ${authorId}.`;
    }
    case NotificationType.MANAGER_ROLE_CHANGED:
    case NotificationType.ADMIN_TRANSFER:
    case NotificationType.ACCOUNT_REGISTRATION:
      return roleChangeBody(notification, payload);
    default:
      return BODY_MAP[type];
  }
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
