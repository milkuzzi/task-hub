import { Injectable } from '@nestjs/common';
import { AssignmentKind, Prisma, Task, TaskStatus } from '@prisma/client';
import { PrismaService } from '../infra';
import { Page, PaginationQueryDto, buildPage } from '../common/dto';
import { BaseRepository } from './base.repository';

/** Задача вместе с её назначениями. */
export type TaskWithAssignments = Prisma.TaskGetPayload<{ include: { assignments: true } }>;

/**
 * Репозиторий-обёртка над сущностью {@link Task}.
 *
 * Инкапсулирует типовые запросы задач, используемые модулями Tasks, Search и
 * Statistics: поиск по идентификатору (с назначениями), создание/обновление,
 * выборку по множеству идентификаторов, подсчёт по статусу и постраничный
 * список по произвольному условию видимости. Все методы поддерживают выполнение
 * внутри транзакции.
 */
@Injectable()
export class TaskRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Находит задачу по идентификатору. */
  findById(id: string, tx?: Prisma.TransactionClient): Promise<Task | null> {
    return this.client(tx).task.findUnique({ where: { id } });
  }

  /** Находит задачу по идентификатору вместе с её назначениями. */
  findByIdWithAssignments(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<TaskWithAssignments | null> {
    return this.client(tx).task.findUnique({
      where: { id },
      include: { assignments: true },
    });
  }

  /**
   * Авторитетно заменяет состав назначений задачи новыми списками Исполнителей
   * и Менеджеров (Req 2.4–2.7).
   *
   * Удаляет все текущие назначения задачи и создаёт заново по переданным
   * спискам. Выполняется атомарно: либо в переданной транзакции, либо в
   * собственной — чтобы исключить промежуточное состояние без участников.
   * Вызывающий код {@link TasksService.assign} предварительно проверяет права
   * инициатора и правила назначения, поэтому при отказе этот метод не
   * вызывается и текущий состав остаётся без изменений (Req 2.6).
   *
   * @param taskId Идентификатор задачи.
   * @param executorIds Уникальные идентификаторы Исполнителей.
   * @param managerIds Уникальные идентификаторы Менеджеров.
   * @returns Задача с обновлённым составом назначений.
   */
  replaceAssignments(
    taskId: string,
    executorIds: string[],
    managerIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<TaskWithAssignments> {
    const run = async (client: Prisma.TransactionClient): Promise<TaskWithAssignments> => {
      await client.taskAssignment.deleteMany({ where: { taskId } });
      await client.taskAssignment.createMany({
        data: [
          ...executorIds.map((userId) => ({ taskId, userId, kind: AssignmentKind.EXECUTOR })),
          ...managerIds.map((userId) => ({ taskId, userId, kind: AssignmentKind.MANAGER })),
        ],
        skipDuplicates: true,
      });
      return client.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { assignments: true },
      });
    };
    return tx ? run(tx) : this.runInTransaction(run);
  }

  /** Создаёт задачу. */
  create(data: Prisma.TaskCreateInput, tx?: Prisma.TransactionClient): Promise<Task> {
    return this.client(tx).task.create({ data });
  }

  /** Обновляет задачу по идентификатору. */
  update(id: string, data: Prisma.TaskUpdateInput, tx?: Prisma.TransactionClient): Promise<Task> {
    return this.client(tx).task.update({ where: { id }, data });
  }

  /** Устанавливает статус задачи (Req 8.5, 10). */
  setStatus(id: string, status: TaskStatus, tx?: Prisma.TransactionClient): Promise<Task> {
    return this.client(tx).task.update({ where: { id }, data: { status } });
  }

  /**
   * Возвращает идентификаторы задач, в которых указанный пользователь является
   * ЕДИНСТВЕННЫМ исполнителем или ЕДИНСТВЕННЫМ менеджером (Req 8.5).
   *
   * Используется перед удалением пользователя для перевода «осиротевших» задач
   * в статус «Требует администратора»: если после удаления у задачи не осталось
   * бы ни одного исполнителя либо ни одного менеджера, задача считается
   * осиротевшей (свойство 21).
   *
   * Реализация: для каждого назначения пользователя проверяется число
   * назначений соответствующего вида (исполнитель/менеджер) у той же задачи;
   * если оно равно 1, пользователь — единственный носитель этой роли в задаче.
   *
   * @param userId Идентификатор удаляемого пользователя.
   * @returns Множество идентификаторов осиротевших задач (без повторов).
   */
  async findTaskIdsWhereUserIsSoleAssignee(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = this.client(tx);
    const assignments = await client.taskAssignment.findMany({
      where: { userId },
      select: { taskId: true, kind: true },
    });
    if (assignments.length === 0) {
      return [];
    }

    const taskIds = [...new Set(assignments.map((a) => a.taskId))];
    const counts = await client.taskAssignment.groupBy({
      by: ['taskId', 'kind'],
      where: { taskId: { in: taskIds } },
      _count: { _all: true },
    });

    const countByKey = new Map<string, number>();
    for (const c of counts) {
      countByKey.set(`${c.taskId}:${c.kind}`, c._count._all);
    }

    const orphaned = new Set<string>();
    for (const a of assignments) {
      const total = countByKey.get(`${a.taskId}:${a.kind}`) ?? 0;
      if (total === 1) {
        // Пользователь — единственный носитель данной роли (исполнитель или
        // менеджер) в задаче: после удаления задача осиротеет (Req 8.5).
        orphaned.add(a.taskId);
      }
    }
    return [...orphaned];
  }

  /** Возвращает задачи по множеству идентификаторов. */
  findManyByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<Task[]> {
    return this.client(tx).task.findMany({ where: { id: { in: ids } } });
  }

  /**
   * Возвращает задачи (вместе с назначениями), Дедлайн которых попадает в
   * заданный диапазон `[from, to]` (Req 13.7, 13.8).
   *
   * Используется периодической проверкой напоминаний о Дедлайне для отбора
   * задач-кандидатов, остаток до Дедлайна которых может попадать в окно
   * дальнего/ближнего порога. Терминальные статусы «Выполнено» и «Отменено»
   * исключаются: напоминания о приближении Дедлайна для завершённых и отменённых
   * задач не отправляются.
   *
   * @param from Нижняя граница Дедлайна (включительно).
   * @param to Верхняя граница Дедлайна (включительно).
   * @returns Задачи с назначениями, упорядоченные по Дедлайну (раньше → позже).
   */
  findManyWithAssignmentsByDeadlineRange(
    from: Date,
    to: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<TaskWithAssignments[]> {
    return this.client(tx).task.findMany({
      where: {
        deadline: { gte: from, lte: to },
        status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
      },
      include: { assignments: true },
      orderBy: { deadline: 'asc' },
    });
  }

  /** Подсчитывает число задач в заданном статусе. */
  countByStatus(status: TaskStatus, tx?: Prisma.TransactionClient): Promise<number> {
    return this.client(tx).task.count({ where: { status } });
  }

  /**
   * Возвращает постраничный список задач по произвольному условию видимости,
   * отсортированный по дате создания (новые → старые).
   */
  async list(
    pagination: PaginationQueryDto,
    where: Prisma.TaskWhereInput = {},
    orderBy: Prisma.TaskOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'asc' }],
    tx?: Prisma.TransactionClient,
  ): Promise<Page<TaskWithAssignments>> {
    const client = this.client(tx);
    const [items, total] = await Promise.all([
      client.task.findMany({
        where,
        include: { assignments: true },
        orderBy,
        skip: pagination.skip,
        take: pagination.take,
      }),
      client.task.count({ where }),
    ]);
    return buildPage(items, total, pagination.page, pagination.pageSize);
  }
}
