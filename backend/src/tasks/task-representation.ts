import { AssignmentKind, Task, TaskStatus } from '@prisma/client';
import { TaskWithAssignments } from '../repositories';

/**
 * HTTP-представления Задачи для REST-слоя (контракт `frontend/src/lib/tasks-api.ts`).
 *
 * Сопоставляют доменную сущность {@link Task} (и её назначения,
 * {@link TaskWithAssignments}) с формами, ожидаемыми клиентом:
 * - {@link TaskCardView} — карточка Задачи в списке (Req 2.8, 9.7, 9.8);
 * - {@link TaskDetailView} — детальная Задача с составом участников (Req 2.12, 10.12).
 *
 * Дедлайн сериализуется в ISO-8601 (UTC); клиент отображает его в MSK (Req 1.2).
 * Значения {@link TaskStatus} (IN_PROGRESS/WAITING/DONE/NEEDS_ADMIN/CANCELLED)
 * совпадают со строковым объединением `TaskStatus` фронтенда — дополнительного
 * сопоставления не требуется.
 */

/**
 * Карточка Задачи в списке (Req 2.8, 9.7, 9.8).
 *
 * Содержит насыщенный счётчик Сообщений (0–9999, Req 9.7, 9.9) и маркер
 * непрочитанных Сообщений текущим Пользователем (Req 9.8).
 */
export interface TaskCardView {
  id: string;
  title: string;
  description: string | null;
  /** Дедлайн (ISO-8601, UTC). */
  deadline: string;
  status: TaskStatus;
  /** Счётчик Сообщений 0–9999 с насыщением на 9999 (Req 9.7, 9.9). */
  messageCount: number;
  /** Есть ли непрочитанные текущим Пользователем Сообщения (Req 9.8). */
  hasUnread: boolean;
  /** Просрочена ли Задача относительно серверного текущего времени. */
  isOverdue: boolean;
}

/** Детальная Задача с составом участников (Req 2.12, 10.12). */
export interface TaskDetailView extends TaskCardView {
  executorIds: string[];
  managerIds: string[];
}

/**
 * Преобразует Задачу в карточку списка (`TaskCard`).
 *
 * Счётчик Сообщений и маркер непрочитанного вычисляются вызывающим контроллером
 * (насыщение через {@link import('./tasks.service').TasksService.saturateMessageCount},
 * Req 9.7, 9.9; непрочитанное — через
 * {@link import('./tasks.service').TasksService.hasUnread}, Req 9.8) и передаются
 * готовыми значениями, чтобы маппер оставался чистым.
 *
 * @param task Доменная Задача.
 * @param messageCount Насыщенный счётчик Сообщений (0–9999).
 * @param hasUnread Признак наличия непрочитанных Сообщений у текущего Пользователя.
 * @returns Карточка Задачи для списка.
 */
export function isTaskOverdue(
  task: Pick<Task, 'deadline' | 'status'>,
  now: Date,
): boolean {
  return now.getTime() > task.deadline.getTime() && task.status !== TaskStatus.DONE;
}

export function toTaskCard(
  task: Task,
  messageCount: number,
  hasUnread: boolean,
  now: Date,
): TaskCardView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    deadline: task.deadline.toISOString(),
    status: task.status,
    messageCount,
    hasUnread,
    isOverdue: isTaskOverdue(task, now),
  };
}

/**
 * Преобразует Задачу с назначениями в детальное представление (`TaskDetail`).
 *
 * Состав Исполнителей и Менеджеров извлекается из назначений Задачи; порядок
 * сохраняется как в хранилище. Счётчик Сообщений и маркер непрочитанного
 * передаются готовыми (см. {@link toTaskCard}).
 *
 * @param task Задача с подгруженными назначениями.
 * @param messageCount Насыщенный счётчик Сообщений (0–9999).
 * @param hasUnread Признак наличия непрочитанных Сообщений у текущего Пользователя.
 * @returns Детальное представление Задачи.
 */
export function toTaskDetail(
  task: TaskWithAssignments,
  messageCount: number,
  hasUnread: boolean,
  now: Date,
): TaskDetailView {
  const executorIds = task.assignments
    .filter((a) => a.kind === AssignmentKind.EXECUTOR)
    .map((a) => a.userId);
  const managerIds = task.assignments
    .filter((a) => a.kind === AssignmentKind.MANAGER)
    .map((a) => a.userId);
  return {
    ...toTaskCard(task, messageCount, hasUnread, now),
    executorIds,
    managerIds,
  };
}
