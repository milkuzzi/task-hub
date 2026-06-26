import { Injectable } from '@nestjs/common';
import { AssignmentKind, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from '../repositories';
import { DateRange, StatMessageRecord, StatTaskRecord } from './statistics.types';

/**
 * Репозиторий выборки данных для расчёта статистики (Req 17).
 *
 * Инкапсулирует запросы к Prisma, возвращая облегчённые записи
 * ({@link StatTaskRecord}, {@link StatMessageRecord}), на которых работают
 * чистые функции расчёта. Фильтрация по периоду применяется по моменту создания
 * сущности и трактуется включительно (Req 17.6): Задача относится к периоду по
 * `createdAt`, Сообщение — по `createdAt`. Выделение запросов в отдельный
 * репозиторий упрощает подмену в модульных тестах {@link StatisticsService}.
 */
@Injectable()
export class StatisticsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Возвращает облегчённые записи Задач, попадающих в период по моменту создания
   * (включительно). Без периода возвращаются все Задачи.
   *
   * @param period Период выборки или `null`.
   * @returns Записи задач с назначениями, разложенными на списки Исполнителей и Менеджеров.
   */
  async findTasksForStatistics(period: DateRange | null): Promise<StatTaskRecord[]> {
    const where: Prisma.TaskWhereInput =
      period === null ? {} : { createdAt: { gte: period.start, lte: period.end } };
    const tasks = await this.prisma.task.findMany({
      where,
      select: {
        status: true,
        deadline: true,
        createdAt: true,
        doneAt: true,
        assignments: { select: { userId: true, kind: true } },
      },
    });
    return tasks.map((task) => ({
      status: task.status,
      deadline: task.deadline,
      createdAt: task.createdAt,
      doneAt: task.doneAt,
      executorIds: task.assignments
        .filter((a) => a.kind === AssignmentKind.EXECUTOR)
        .map((a) => a.userId),
      managerIds: task.assignments
        .filter((a) => a.kind === AssignmentKind.MANAGER)
        .map((a) => a.userId),
    }));
  }

  /**
   * Возвращает облегчённые записи Сообщений, попадающих в период по моменту
   * создания (включительно). Без периода возвращаются все Сообщения.
   *
   * @param period Период выборки или `null`.
   * @returns Записи сообщений с идентификатором Чата.
   */
  async findMessagesForStatistics(period: DateRange | null): Promise<StatMessageRecord[]> {
    const where: Prisma.MessageWhereInput =
      period === null ? {} : { createdAt: { gte: period.start, lte: period.end } };
    const messages = await this.prisma.message.findMany({
      where,
      select: { chatId: true },
    });
    return messages.map((message) => ({ chatId: message.chatId }));
  }
}
