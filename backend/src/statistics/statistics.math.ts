import { TaskStatus } from '@prisma/client';
import {
  ChatActivity,
  StatMessageRecord,
  StatTaskRecord,
  Statistics,
  StatisticsInput,
} from './statistics.types';

/**
 * Чистые функции расчёта статистики (Req 17.1–17.5, 17.8).
 *
 * Вынесены отдельно от прикладного сервиса намеренно: расчёт долей, средних,
 * округлений и агрегатов не зависит от инфраструктуры (БД, время, права) и
 * полностью детерминирован, что делает его пригодным для модульных и
 * property-based-тестов (свойства 46–50). {@link StatisticsService} лишь
 * выбирает данные и передаёт их сюда.
 */

/** Полный перечень Статусов в стабильном порядке — для включения нулевых (Req 17.1). */
export const ALL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.IN_PROGRESS,
  TaskStatus.WAITING,
  TaskStatus.DONE,
  TaskStatus.NEEDS_ADMIN,
  TaskStatus.CANCELLED,
];

/** Миллисекунд в часе — для перевода интервалов в часы (Req 17.3). */
const MS_PER_HOUR = 3_600_000;

/**
 * Округляет число до одного знака после запятой (Req 17.2, 17.3).
 *
 * Использует масштабирование с {@link Math.round}; знак сохраняется
 * (отрицательные значения в показателях не возникают, но функция корректна и
 * для них). Результат — конечное число; `NaN`/`Infinity` на вход не ожидаются.
 *
 * @param value Исходное значение.
 * @returns Значение, округлённое до десятых.
 */
export function roundToOneDecimal(value: number): number {
  // Коррекция эпсилоном уменьшает ошибки двоичного представления (например,
  // 0.05 → 0.1), сохраняя округление «половина вверх».
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * Подсчитывает количество Задач по каждому Статусу, включая Статусы с нулевым
 * количеством (Req 17.1).
 *
 * Гарантирует наличие ключа для каждого из {@link ALL_TASK_STATUSES}, поэтому
 * сумма значений всегда равна общему числу задач.
 *
 * @param tasks Задачи периода.
 * @returns Отображение «Статус → количество» по всем существующим Статусам.
 */
export function countByStatus(tasks: readonly StatTaskRecord[]): Record<TaskStatus, number> {
  const counts = {} as Record<TaskStatus, number>;
  for (const status of ALL_TASK_STATUSES) {
    counts[status] = 0;
  }
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

/**
 * Определяет, является ли Задача просроченной (Req 17.2).
 *
 * Задача просрочена тогда и только тогда, когда текущий момент строго превышает
 * её Дедлайн и она не находится в Статусе «Выполнено». Прочие статусы
 * (включая «Отменено») при превышении Дедлайна считаются просроченными согласно
 * формулировке требования.
 *
 * @param task Задача.
 * @param now Текущий момент времени.
 * @returns `true`, если Задача просрочена.
 */
export function isOverdue(task: StatTaskRecord, now: Date): boolean {
  return now.getTime() > task.deadline.getTime() && task.status !== TaskStatus.DONE;
}

/**
 * Подсчитывает число просроченных Задач и их долю в процентах, округлённую до
 * одного знака (Req 17.2).
 *
 * Доля рассчитывается как (число просроченных / общее число) × 100. При пустом
 * наборе задач доля равна 0 (деление на ноль исключено).
 *
 * @param tasks Задачи периода.
 * @param now Текущий момент времени.
 * @returns Количество просроченных и их доля в процентах (до десятых).
 */
export function computeOverdue(
  tasks: readonly StatTaskRecord[],
  now: Date,
): { overdueCount: number; overduePercent: number } {
  const overdueCount = tasks.reduce((acc, task) => acc + (isOverdue(task, now) ? 1 : 0), 0);
  const overduePercent =
    tasks.length === 0 ? 0 : roundToOneDecimal((overdueCount / tasks.length) * 100);
  return { overdueCount, overduePercent };
}

/**
 * Вычисляет среднее время выполнения Задачи в часах, округлённое до одного знака
 * (Req 17.3).
 *
 * Учитываются только выполненные Задачи — со Статусом «Выполнено» и
 * проставленным моментом завершения `doneAt`. Среднее равно среднему
 * арифметическому интервалов (`doneAt − createdAt`), переведённых в часы. При
 * отсутствии выполненных Задач результат равен 0.
 *
 * @param tasks Задачи периода.
 * @returns Среднее время выполнения в часах (до десятых) или 0.
 */
export function computeAverageCompletionHours(tasks: readonly StatTaskRecord[]): number {
  const completed = tasks.filter((task) => task.status === TaskStatus.DONE && task.doneAt !== null);
  if (completed.length === 0) {
    return 0;
  }
  const totalHours = completed.reduce((acc, task) => {
    const intervalMs = (task.doneAt as Date).getTime() - task.createdAt.getTime();
    return acc + intervalMs / MS_PER_HOUR;
  }, 0);
  return roundToOneDecimal(totalHours / completed.length);
}

/**
 * Подсчитывает количество Задач в разрезе каждого Менеджера и каждого
 * Исполнителя (Req 17.4).
 *
 * Каждая Задача учитывается по одному разу для каждого назначенного на неё
 * Менеджера и Исполнителя. Пользователи без назначений в наборе не появляются.
 *
 * @param tasks Задачи периода.
 * @returns Разрезы «идентификатор → количество задач» по Менеджерам и Исполнителям.
 */
export function countByParticipant(tasks: readonly StatTaskRecord[]): {
  byManager: Record<string, number>;
  byExecutor: Record<string, number>;
} {
  const byManager: Record<string, number> = {};
  const byExecutor: Record<string, number> = {};
  for (const task of tasks) {
    for (const managerId of new Set(task.managerIds)) {
      byManager[managerId] = (byManager[managerId] ?? 0) + 1;
    }
    for (const executorId of new Set(task.executorIds)) {
      byExecutor[executorId] = (byExecutor[executorId] ?? 0) + 1;
    }
  }
  return { byManager, byExecutor };
}

/**
 * Вычисляет показатели активности Чатов (Req 17.5): общее число отправленных
 * Сообщений и число Чатов, содержащих не менее одного Сообщения.
 *
 * @param messages Сообщения периода.
 * @returns Общее количество Сообщений и число активных Чатов.
 */
export function computeChatActivity(messages: readonly StatMessageRecord[]): ChatActivity {
  const chats = new Set<string>();
  for (const message of messages) {
    chats.add(message.chatId);
  }
  return { totalMessages: messages.length, activeChats: chats.size };
}

/**
 * Собирает полную статистику из исходных данных (Req 17.1–17.5, 17.8).
 *
 * Чистая оркестрация частных расчётов. Признак отсутствия данных (Req 17.8)
 * устанавливается, когда за период нет ни Задач, ни Сообщений; при этом все
 * показатели и без того нулевые (пустые наборы дают нулевые агрегаты).
 *
 * @param input Исходные данные: задачи, сообщения, период и текущий момент.
 * @returns Готовая к отображению статистика.
 */
export function computeStatistics(input: StatisticsInput): Statistics {
  const { tasks, messages, period, now } = input;
  const byStatus = countByStatus(tasks);
  const { overdueCount, overduePercent } = computeOverdue(tasks, now);
  const { byManager, byExecutor } = countByParticipant(tasks);
  return {
    byStatus,
    totalTasks: tasks.length,
    overdueCount,
    overduePercent,
    averageCompletionHours: computeAverageCompletionHours(tasks),
    byManager,
    byExecutor,
    chatActivity: computeChatActivity(messages),
    period,
    noData: tasks.length === 0 && messages.length === 0,
  };
}
