import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from './base.repository';

/**
 * Отметка о прочтении вместе с прочитавшим её Пользователем (Req 11.8).
 *
 * Несёт денормализуемые для отображения поля Пользователя (идентификатор и имя)
 * и момент прочтения, по которым формируется список прочитавших Сообщение.
 */
export type MessageReadWithUser = Prisma.MessageReadGetPayload<{ include: { user: true } }>;

/**
 * Репозиторий-обёртка над сущностью {@link Prisma.MessageReadGetPayload}
 * (отметки о прочтении Сообщений, Req 11.8, 14.4).
 *
 * Инкапсулирует учёт прочтений: идемпотентную отметку Сообщения прочитанным
 * Пользователем (защита уникальным ограничением `[messageId, userId]`) и
 * выборку списка прочитавших конкретное Сообщение Пользователей для
 * отображения всем Участникам чата. Методы поддерживают выполнение внутри
 * транзакции.
 */
@Injectable()
export class MessageReadRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Идемпотентно отмечает Сообщение прочитанным Пользователем (Req 11.8, 14.4).
   *
   * Повторная отметка не создаёт дубликата и не приводит к ошибке: вставка
   * выполняется с пропуском дубликатов по уникальному ограничению
   * `[messageId, userId]`. Возвращает признак того, что отметка была создана
   * впервые (`true`) либо уже существовала (`false`) — полезно, чтобы избегать
   * лишней рассылки при отсутствии изменений.
   *
   * @param messageId Идентификатор Сообщения.
   * @param userId Идентификатор прочитавшего Пользователя.
   * @returns `true`, если отметка создана впервые; `false`, если уже была.
   */
  async markRead(
    messageId: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await this.client(tx).messageRead.createMany({
      data: [{ messageId, userId }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  /**
   * Возвращает прочитавших Сообщение Пользователей вместе с моментом прочтения,
   * отсортированных по времени прочтения (ранние → поздние) (Req 11.8).
   *
   * @param messageId Идентификатор Сообщения.
   * @returns Список отметок о прочтении с включённым Пользователем.
   */
  listReaders(messageId: string, tx?: Prisma.TransactionClient): Promise<MessageReadWithUser[]> {
    return this.client(tx).messageRead.findMany({
      where: { messageId },
      include: { user: true },
      orderBy: { readAt: 'asc' },
    });
  }
}
