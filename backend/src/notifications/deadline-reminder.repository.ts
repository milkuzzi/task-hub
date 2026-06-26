import { Injectable } from '@nestjs/common';
import { Prisma, ReminderThreshold } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from '../repositories';

/**
 * Состояние отправки порогов напоминания о Дедлайне для одной Задачи
 * (Req 13.7–13.10).
 *
 * Признаки `far`/`near` равны `true`, если соответствующий порог уже был
 * отправлен; это обеспечивает отправку каждого порога не более одного раза.
 */
export interface ReminderSentState {
  /** Дальний порог уже отправлялся. */
  far: boolean;
  /** Ближний порог уже отправлялся. */
  near: boolean;
}

/**
 * Репозиторий-обёртка над сущностью {@link DeadlineReminder} (Req 13.7–13.10).
 *
 * Инкапсулирует доступ к состоянию отправки порогов напоминания о Дедлайне:
 * чтение текущего состояния («отправлен ли дальний/ближний порог») и атомарную
 * фиксацию факта отправки порога ({@link markSent}). Уникальное ограничение
 * `@@unique([taskId, threshold])` и флаг `sent` модели обеспечивают защиту от
 * повторной отправки одного и того же порога (Req 13.7–13.10). Все методы
 * поддерживают выполнение в рамках транзакции.
 */
@Injectable()
export class DeadlineReminderRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Возвращает состояние отправки порогов напоминания для Задачи
   * (Req 13.7–13.10).
   *
   * @param taskId Идентификатор Задачи.
   * @returns Признаки отправки дальнего и ближнего порогов; для отсутствующих
   *   записей — `false`.
   */
  async getSentState(taskId: string, tx?: Prisma.TransactionClient): Promise<ReminderSentState> {
    const rows = await this.client(tx).deadlineReminder.findMany({ where: { taskId } });
    return {
      far: rows.some((r) => r.threshold === ReminderThreshold.FAR && r.sent),
      near: rows.some((r) => r.threshold === ReminderThreshold.NEAR && r.sent),
    };
  }

  /**
   * Атомарно фиксирует факт отправки порога напоминания для Задачи
   * (защита от повторной отправки, Req 13.7–13.10).
   *
   * Идемпотентен: повторный вызов для той же пары «Задача + порог» сохраняет
   * флаг `sent = true`. Опирается на уникальное ограничение
   * `@@unique([taskId, threshold])`.
   *
   * @param taskId Идентификатор Задачи.
   * @param threshold Порог напоминания (дальний/ближний).
   */
  async markSent(
    taskId: string,
    threshold: ReminderThreshold,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.client(tx).deadlineReminder.upsert({
      where: { taskId_threshold: { taskId, threshold } },
      create: { taskId, threshold, sent: true },
      update: { sent: true },
    });
  }
}
