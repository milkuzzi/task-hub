import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from './base.repository';

/**
 * Репозиторий-обёртка над сущностью {@link Prisma.ChatMuteGetPayload}
 * (заглушение Чата Задачи для Пользователя, Req 16.9).
 *
 * Инкапсулирует идемпотентное включение/выключение заглушения для пары
 * «Пользователь + Задача» (защита уникальным ограничением `[userId, taskId]`) и
 * проверку текущего состояния. По наличию записи {@link ChatMute} канал MAX
 * фильтрует доставку Уведомлений Задачи (Req 16.9). Методы поддерживают
 * выполнение внутри транзакции.
 */
@Injectable()
export class ChatMuteRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Идемпотентно устанавливает состояние заглушения Чата Задачи для
   * Пользователя (Req 16.9).
   *
   * При `muted = true` создаёт запись заглушения, если её ещё нет (повторный
   * вызов не приводит к ошибке за счёт пропуска дубликатов по уникальному
   * ограничению `[userId, taskId]`). При `muted = false` удаляет запись
   * заглушения, если она есть; повторное снятие на отсутствующей записи
   * безопасно. Возвращает итоговое состояние заглушения (`true` — заглушено).
   *
   * @param userId Идентификатор Пользователя.
   * @param taskId Идентификатор Задачи.
   * @param muted Желаемое состояние: `true` — заглушить, `false` — снять.
   * @returns Итоговое состояние заглушения после операции.
   */
  async setMute(
    userId: string,
    taskId: string,
    muted: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = this.client(tx);
    if (muted) {
      await client.chatMute.createMany({
        data: [{ userId, taskId }],
        skipDuplicates: true,
      });
      return true;
    }
    await client.chatMute.deleteMany({ where: { userId, taskId } });
    return false;
  }

  /**
   * Возвращает признак заглушения Чата Задачи для Пользователя (Req 16.9).
   *
   * @param userId Идентификатор Пользователя.
   * @param taskId Идентификатор Задачи.
   * @returns `true`, если Чат Задачи заглушён Пользователем; иначе `false`.
   */
  async isMuted(userId: string, taskId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const row = await this.client(tx).chatMute.findUnique({
      where: { userId_taskId: { userId, taskId } },
    });
    return row !== null;
  }
}
