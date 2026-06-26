import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { UserRepository } from '../repositories';
import { hasAdminPrivileges } from '../users/permissions';
import { NotificationDeliveryService } from './delivery/notification-delivery.service';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';

/**
 * Описание события появления нового Сообщения в Чате Задачи (Req 14.1, 14.2).
 *
 * Несёт идентификаторы Задачи и Сообщения, автора Сообщения и состав
 * назначенных Участников Задачи (Исполнители/Менеджеры). Состав получателей
 * Уведомления вычисляется маршрутизатором: объединение Исполнителей и
 * Менеджеров без автора и без Администраторов (Req 14.1, 14.2).
 */
export interface NewChatMessageEvent {
  /** Идентификатор Задачи, к Чату которой относится Сообщение. */
  taskId: string;
  /** Название Задачи для карточки уведомления. */
  taskTitle?: string;
  /** Идентификатор созданного Сообщения. */
  messageId: string;
  /** Идентификатор автора Сообщения (исключается из получателей, Req 14.1). */
  authorId: string;
  /** Идентификаторы Исполнителей Задачи. */
  executorIds: readonly string[];
  /** Идентификаторы Менеджеров Задачи. */
  managerIds: readonly string[];
}

/**
 * Маршрутизатор Уведомлений по событиям Чата (Req 14.1, 14.2, 14.4, 14.5).
 *
 * Связывает события Чата с формированием и очисткой Уведомлений о Сообщениях,
 * оставляя фактическую постановку в очередь, идемпотентность и доставку по
 * каналам (сайт + MAX) обобщённому {@link NotificationsService} и
 * {@link NotificationDeliveryService}. Реализован по образцу
 * {@link import('./task-notification-router').TaskNotificationRouter}.
 *
 * Правила маршрутизации:
 * - **Новое Сообщение** ({@link notifyNewMessage}) — Уведомление о Сообщении
 *   ({@link NotificationType.CHAT_MESSAGE}, `isMessageNotification = true`) всем
 *   Участникам чата, КРОМЕ автора Сообщения и КРОМЕ Администраторов (Req 14.1,
 *   14.2). Получатели = (Исполнители ∪ Менеджеры Задачи) − автор − Администратор(ы).
 *   Уведомление ставится в очередь доставки асинхронно, что удовлетворяет
 *   требованию отправки в течение 5 секунд (Req 14.1).
 * - **Просмотр Сообщения** ({@link clearMessageNotification}) — авто-удаление
 *   соответствующего Уведомления о Сообщении этого Участника на сайте И в Боте
 *   MAX (Req 14.4). Удаление на сайте выполняется в любом случае; при неудаче
 *   удаления в MAX фиксируется признак повторной попытки (Req 14.7). Уведомления
 *   прочих типов по факту просмотра НЕ удаляются (Req 14.5), так как очистка
 *   ограничена Уведомлениями о Сообщениях.
 *
 * Об изменении и удалении Сообщений Уведомления не формируются (Req 14.3) — см.
 * {@link import('./task-notification-router').TaskNotificationRouter.onMessageEditedOrDeleted}.
 */
@Injectable()
export class ChatNotificationRouter {
  private readonly logger = new Logger(ChatNotificationRouter.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly repository: NotificationRepository,
    private readonly delivery: NotificationDeliveryService,
    private readonly users: UserRepository,
  ) {}

  /**
   * Формирует Уведомление о новом Сообщении Чата для всех Участников Задачи,
   * кроме автора и Администраторов (Req 14.1, 14.2).
   *
   * Состав получателей: объединение Исполнителей и Менеджеров Задачи без
   * повторов, из которого исключаются автор Сообщения (Req 14.1) и любые
   * Пользователи с привилегиями Администратора (Req 14.2). Если получателей не
   * остаётся, Уведомление не формируется. Постановка задания доставки в очередь
   * выполняется обобщённым сервисом асинхронно (отправка ≤5с, Req 14.1); ключ
   * идемпотентности привязан к идентификатору Сообщения, поэтому повторная
   * обработка того же Сообщения не порождает дубликатов.
   *
   * @param event Событие появления нового Сообщения (Задача, Сообщение, автор,
   *   состав Участников).
   */
  async notifyNewMessage(event: NewChatMessageEvent): Promise<void> {
    const candidateIds = [...new Set([...event.executorIds, ...event.managerIds])].filter(
      (id) => id !== event.authorId,
    );
    if (candidateIds.length === 0) {
      return;
    }

    // Исключаем Администраторов: Уведомления о Сообщениях Чата им не
    // отправляются (Req 14.2). Роли определяются по активным учётным записям.
    const users = await this.users.findManyActiveByIds(candidateIds);
    const adminIds = new Set(users.filter((u) => hasAdminPrivileges(u.role)).map((u) => u.id));
    const recipientIds = candidateIds.filter((id) => !adminIds.has(id));
    if (recipientIds.length === 0) {
      return;
    }

    await this.notifications.emit({
      type: NotificationType.CHAT_MESSAGE,
      recipientIds,
      taskId: event.taskId,
      messageId: event.messageId,
      payload:
        event.taskTitle === undefined || event.taskTitle.trim() === ''
          ? { authorId: event.authorId }
          : { authorId: event.authorId, taskTitle: event.taskTitle },
      isMessageNotification: true,
      eventKey: `chat-msg:${event.messageId}`,
    });
  }

  /**
   * Удаляет Уведомление о Сообщении для просмотревшего его Участника на сайте и
   * в Боте MAX (Req 14.4).
   *
   * Находит Уведомление о Сообщении ({@link NotificationType.CHAT_MESSAGE},
   * `isMessageNotification = true`) данного Участника по идентификатору
   * Сообщения. Если такого Уведомления нет — операция идемпотентна и ничего не
   * делает (повторный просмотр, уже очищенное Уведомление). При наличии
   * Уведомления:
   * 1. выполняется удаление в Боте MAX через
   *    {@link NotificationDeliveryService.deleteMessageNotificationInMax} — при
   *    неудаче фиксируется признак повторной попытки (Req 14.7);
   * 2. запись Уведомления удаляется на сайте независимо от результата удаления
   *    в MAX (Req 14.7).
   *
   * Уведомления прочих типов не затрагиваются (выборка ограничена Уведомлениями
   * о Сообщениях), поэтому сохранность прочих типов по факту просмотра
   * гарантируется (Req 14.5).
   *
   * @param userId Идентификатор просмотревшего Участника.
   * @param messageId Идентификатор просмотренного Сообщения.
   */
  async clearMessageNotification(userId: string, messageId: string): Promise<void> {
    const notification = await this.repository.findMessageNotification(userId, messageId);
    if (notification === null) {
      // Нет Уведомления о Сообщении — очищать нечего; прочие типы не трогаем (Req 14.5).
      return;
    }

    // Удаление в MAX best-effort: при неудаче фиксируется признак повторной
    // попытки, но удаление на сайте выполняется в любом случае (Req 14.7).
    await this.delivery.deleteMessageNotificationInMax(notification);
    await this.repository.deleteById(notification.id);

    this.logger.debug(
      `Уведомление о Сообщении «${messageId}» для Пользователя «${userId}» очищено ` +
        'по факту просмотра (сайт + MAX, Req 14.4).',
    );
  }
}
