import { Injectable } from '@nestjs/common';
import { DeliveryStatus, Notification, NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from '../repositories';

/**
 * Данные для создания одной записи Уведомления (Req 13.1).
 *
 * Соответствуют модели {@link Notification}. Каналы доставки фиксируются
 * статусами {@link Notification.siteStatus} и {@link Notification.maxStatus},
 * которые при создании устанавливаются в {@link DeliveryStatus.PENDING} (запись
 * статусов на каждый канал, Req 13.13). Связанные сущности (получатель, Задача,
 * Сообщение) задаются скалярными внешними ключами.
 */
export interface NotificationCreateData {
  /** Идентификатор получателя Уведомления. */
  recipientId: string;
  /** Идентификатор связанной Задачи (если есть). */
  taskId?: string | null;
  /** Идентификатор связанного Сообщения (для уведомлений о сообщениях, Req 14.4). */
  messageId?: string | null;
  /** Тип Уведомления. */
  type: NotificationType;
  /** Полезная нагрузка Уведомления (JSON). */
  payload: Prisma.InputJsonValue;
  /** Признак уведомления о сообщении Чата (удаляется по просмотру, Req 14.4). */
  isMessageNotification?: boolean;
}

/**
 * Репозиторий-обёртка над сущностью {@link Notification} (Req 13, 14, 15).
 *
 * Инкапсулирует типовые операции доступа к данным Уведомлений: создание записи
 * с исходными статусами доставки `PENDING`, поиск по идентификатору и
 * получателю, обновление статусов доставки по каналам. Используется
 * {@link import('./notifications.service').NotificationsService} (формирование
 * уведомлений, Req 13.1) и воркером доставки (фиксация итоговых статусов,
 * задача 12.10). Все методы поддерживают выполнение в рамках транзакции.
 */
@Injectable()
export class NotificationRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Создаёт одну запись Уведомления с исходными статусами доставки
   * `siteStatus = maxStatus = PENDING` (Req 13.1, 13.13).
   *
   * @param data Данные Уведомления (получатель, тип, полезная нагрузка, связи).
   * @returns Созданная запись Уведомления.
   */
  create(data: NotificationCreateData, tx?: Prisma.TransactionClient): Promise<Notification> {
    return this.client(tx).notification.create({
      data: {
        recipientId: data.recipientId,
        taskId: data.taskId ?? null,
        messageId: data.messageId ?? null,
        type: data.type,
        payload: data.payload,
        isMessageNotification: data.isMessageNotification ?? false,
        siteStatus: DeliveryStatus.PENDING,
        maxStatus: DeliveryStatus.PENDING,
      },
    });
  }

  /** Находит Уведомление по идентификатору. */
  findById(id: string, tx?: Prisma.TransactionClient): Promise<Notification | null> {
    return this.client(tx).notification.findUnique({
      where: { id },
      include: { task: { select: { title: true } } },
    });
  }

  /**
   * Возвращает Уведомления получателя, упорядоченные от новых к старым.
   *
   * @param recipientId Идентификатор получателя.
   * @returns Список Уведомлений (новые → старые); пустой массив при отсутствии.
   */
  listByRecipient(recipientId: string, tx?: Prisma.TransactionClient): Promise<Notification[]> {
    return this.client(tx).notification.findMany({
      where: { recipientId },
      include: { task: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Обновляет произвольные поля Уведомления (например, статусы доставки по
   * каналам при фиксации результата воркером, задача 12.10).
   *
   * @param id Идентификатор Уведомления.
   * @param data Изменяемые поля.
   * @returns Обновлённая запись Уведомления.
   */
  update(
    id: string,
    data: Prisma.NotificationUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification> {
    return this.client(tx).notification.update({ where: { id }, data });
  }

  /**
   * Находит Уведомление о Сообщении Чата для пары «получатель + Сообщение»
   * (Req 14.4).
   *
   * Выбираются только Уведомления о сообщениях
   * ({@link Notification.isMessageNotification} = `true`), поэтому Уведомления
   * прочих типов этим методом не возвращаются и не затрагиваются очисткой по
   * факту просмотра (сохранность прочих типов, Req 14.5). На каждую пару
   * «получатель + Сообщение» приходится не более одного такого Уведомления, но
   * метод намеренно использует `findFirst`, оставаясь устойчивым к возможным
   * историческим дубликатам.
   *
   * @param recipientId Идентификатор получателя (просмотревшего Участника).
   * @param messageId Идентификатор просмотренного Сообщения.
   * @returns Уведомление о Сообщении или `null`, если его нет.
   */
  findMessageNotification(
    recipientId: string,
    messageId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Notification | null> {
    return this.client(tx).notification.findFirst({
      where: { recipientId, messageId, isMessageNotification: true },
    });
  }

  /**
   * Удаляет запись Уведомления по идентификатору (Req 14.4).
   *
   * Используется при очистке Уведомления о Сообщении на сайте по факту его
   * просмотра: удаление на сайте выполняется независимо от результата удаления
   * в Боте MAX (Req 14.7).
   *
   * @param id Идентификатор удаляемого Уведомления.
   */
  async deleteById(id: string, tx?: Prisma.TransactionClient): Promise<void> {
    await this.client(tx).notification.delete({ where: { id } });
  }

  /**
   * Удаляет Уведомление по идентификатору ТОЛЬКО если оно принадлежит указанному
   * получателю (Req 7.3, 7.4, 2.12).
   *
   * Удаление выполняется условием `{ id, recipientId }`, поэтому Уведомление
   * чужого получателя не затрагивается и его существование не раскрывается.
   * Возвращает число удалённых записей: `0` означает, что Уведомления нет либо
   * оно принадлежит другому Пользователю — вызывающий сервис трактует это как
   * «не найдено» без различения причин.
   *
   * @param id Идентификатор скрываемого Уведомления.
   * @param recipientId Идентификатор текущего получателя (владельца).
   * @returns Количество удалённых записей (0 или 1).
   */
  async deleteByIdForRecipient(
    id: string,
    recipientId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await this.client(tx).notification.deleteMany({
      where: { id, recipientId },
    });
    return result.count;
  }
}
