import { Injectable } from '@nestjs/common';
import { Message, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { Page, PaginationQueryDto, buildPage } from '../common/dto';
import { BaseRepository } from './base.repository';

/**
 * Сообщение Чата вместе с его Вложениями и минимальными данными автора
 * (Req 11.3, 11.10, 2.4).
 *
 * Используется REST-слоем истории Чата: лента Сообщений отдаётся клиенту с
 * прикреплёнными Вложениями за один запрос, без дополнительных обращений к
 * хранилищу на каждое Сообщение. Дополнительно подгружается признак аватара
 * автора (`author.avatarPath`), чтобы лента могла показать аватар автора рядом
 * с Сообщением (дефект 4). Из автора выбираются только `id` и `avatarPath` —
 * прочие поля профиля наружу не нужны и не запрашиваются.
 */
export type MessageWithAttachments = Prisma.MessageGetPayload<{
  include: {
    attachments: true;
    author: { select: { id: true; avatarPath: true } };
    _count: { select: { reads: true } };
  };
}>;

/** Подгрузка Сообщения вместе с Вложениями, данными аватара автора и числом прочитавших. */
const MESSAGE_WITH_ATTACHMENTS_INCLUDE = {
  attachments: true,
  author: { select: { id: true, avatarPath: true } },
  _count: { select: { reads: true } },
} satisfies Prisma.MessageInclude;

/**
 * Репозиторий-обёртка над сущностью {@link Message}.
 *
 * Инкапсулирует типовые запросы сообщений чата, используемые модулями Chat и
 * Notifications: поиск по идентификатору, создание/обновление и постраничную
 * выборку сообщений чата (старые → новые для ленты). Все методы поддерживают
 * выполнение внутри транзакции — например, при атомарной вставке сообщения с
 * пересчётом счётчика и сменой статуса задачи (Req 11.3, 10.1, 10.2).
 */
@Injectable()
export class MessageRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Находит сообщение по идентификатору. */
  findById(id: string, tx?: Prisma.TransactionClient): Promise<Message | null> {
    return this.client(tx).message.findUnique({ where: { id } });
  }

  /** Находит сообщение по идентификатору вместе с его вложениями. */
  findByIdWithAttachments(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MessageWithAttachments | null> {
    return this.client(tx).message.findUnique({
      where: { id },
      include: MESSAGE_WITH_ATTACHMENTS_INCLUDE,
    });
  }

  /** Создаёт сообщение. */
  create(data: Prisma.MessageCreateInput, tx?: Prisma.TransactionClient): Promise<Message> {
    return this.client(tx).message.create({ data });
  }

  /**
   * Подсчитывает фактическое число Сообщений в Чате указанной Задачи (Req 9.6,
   * 9.7).
   *
   * Учитываются все Сообщения Чата, включая помеченные удалёнными (они остаются
   * в ленте как метка «Сообщение удалено», Req 11.7). Связь Чат↔Задача —
   * один к одному (Req 9.5), поэтому отбор выполняется по `chat.taskId` без
   * предварительного получения идентификатора Чата.
   *
   * @param taskId Идентификатор Задачи.
   * @returns Фактическое количество Сообщений (может превышать потолок счётчика).
   */
  countByTask(taskId: string, tx?: Prisma.TransactionClient): Promise<number> {
    return this.client(tx).message.count({ where: { chat: { taskId } } });
  }

  /**
   * Подсчитывает число Сообщений в Чате Задачи, ещё не отмеченных прочитанными
   * указанным Пользователем (Req 9.8, 11.8).
   *
   * Сообщение считается непрочитанным Пользователем, если для пары
   * «Сообщение + Пользователь» отсутствует запись {@link MessageRead}. Связь
   * Чат↔Задача — один к одному, поэтому отбор идёт по `chat.taskId`.
   *
   * Из подсчёта исключаются собственные Сообщения Пользователя (их он не
   * «прочитывает», поэтому иначе они вечно считались бы непрочитанными после
   * отправки) и удалённые Сообщения (на их месте лишь метка «Сообщение
   * удалено»). Маркер непрочитанного сбрасывается, как только все чужие
   * Сообщения отмечены прочитанными (Req 9.8, 11.8).
   *
   * @param userId Идентификатор Пользователя.
   * @param taskId Идентификатор Задачи.
   * @returns Количество непрочитанных Пользователем Сообщений Чата Задачи.
   */
  countUnreadForUserByTask(
    userId: string,
    taskId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    return this.client(tx).message.count({
      where: {
        chat: { taskId },
        deleted: false,
        authorId: { not: userId },
        reads: { none: { userId } },
      },
    });
  }

  /** Обновляет сообщение по идентификатору. */
  update(
    id: string,
    data: Prisma.MessageUpdateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Message> {
    return this.client(tx).message.update({ where: { id }, data });
  }

  /**
   * Возвращает все Сообщения Чата Задачи вместе с Вложениями, отсортированные
   * по дате создания (старые → новые) для отображения ленты истории (Req 11.3,
   * 11.10).
   *
   * Связь Чат↔Задача — один к одному (Req 9.5), поэтому отбор выполняется по
   * `chat.taskId` без предварительного получения идентификатора Чата.
   * Удалённые Сообщения остаются в ленте (отображаются как метка «Сообщение
   * удалено», Req 11.7) и потому включаются в выборку.
   *
   * @param taskId Идентификатор Задачи.
   * @returns Сообщения Чата с Вложениями (старые → новые).
   */
  listByTaskWithAttachments(
    taskId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<MessageWithAttachments[]> {
    return this.client(tx).message.findMany({
      where: { chat: { taskId } },
      include: MESSAGE_WITH_ATTACHMENTS_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Возвращает постраничный список сообщений чата, отсортированный по дате
   * создания (старые → новые) для отображения ленты сообщений.
   */
  async listByChat(
    chatId: string,
    pagination: PaginationQueryDto,
    tx?: Prisma.TransactionClient,
  ): Promise<Page<Message>> {
    const client = this.client(tx);
    const where: Prisma.MessageWhereInput = { chatId };
    const [items, total] = await Promise.all([
      client.message.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      client.message.count({ where }),
    ]);
    return buildPage(items, total, pagination.page, pagination.pageSize);
  }
}
