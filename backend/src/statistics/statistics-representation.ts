import { TaskStatus } from '@prisma/client';
import { Statistics } from './statistics.types';

/**
 * HTTP-представление Статистики для REST-слоя (контракт
 * `frontend/src/lib/statistics-api.ts`).
 *
 * Доменный {@link Statistics} использует машинно-удобные структуры (разрезы по
 * участникам как `Record<userId, count>`, поле `noData`, имена показателей
 * `byStatus`/`averageCompletionHours`). Фронтенд ожидает иной набор имён и
 * формы: счётчики Статусов как `statusCounts`, разрезы как массивы
 * {@link ParticipantStatView} с отображаемым именем участника, активность Чатов
 * с полем `messageCount`, признак наличия данных `hasData`. Этот модуль
 * выполняет чистое сопоставление одной формы в другую (Req 17.1–17.8).
 */

/** Показатель в разрезе участника (Менеджера/Исполнителя, Req 17.4). */
export interface ParticipantStatView {
  /** Идентификатор участника. */
  userId: string;
  /** Отображаемое имя участника (или идентификатор, если имя недоступно). */
  name: string;
  /** Количество Задач, связанных с участником. */
  taskCount: number;
}

/** Показатели активности Чатов (Req 17.5). */
export interface ChatActivityView {
  /** Общее число отправленных Сообщений за период. */
  messageCount: number;
  /** Число Чатов, в которых было хотя бы одно Сообщение. */
  activeChats: number;
}

/** Полный набор показателей Статистики в форме контракта фронтенда (Req 17.1–17.8). */
export interface StatisticsView {
  /** Количество Задач по каждому Статусу, включая нулевые (Req 17.1). */
  statusCounts: Record<TaskStatus, number>;
  /** Общее количество Задач за период. */
  totalTasks: number;
  /** Количество просроченных Задач (Req 17.2). */
  overdueCount: number;
  /** Доля просроченных Задач в процентах, 1 знак (Req 17.2). */
  overduePercent: number;
  /** Среднее время выполнения в часах, 1 знак; 0 при отсутствии (Req 17.3). */
  avgCompletionHours: number;
  /** Разрез по Менеджерам (Req 17.4). */
  byManager: ParticipantStatView[];
  /** Разрез по Исполнителям (Req 17.4). */
  byExecutor: ParticipantStatView[];
  /** Активность Чатов (Req 17.5). */
  chatActivity: ChatActivityView;
  /** Есть ли данные за период (Req 17.8). */
  hasData: boolean;
}

/**
 * Преобразует разрез «идентификатор → количество» в массив
 * {@link ParticipantStatView}, подставляя отображаемое имя участника.
 *
 * @param counts Разрез по участникам (`Record<userId, count>`).
 * @param nameOf Функция получения отображаемого имени по идентификатору; если
 *   имя недоступно, в качестве запасного значения используется сам идентификатор.
 * @returns Массив показателей по участникам.
 */
function toParticipantStats(
  counts: Record<string, number>,
  nameOf: (userId: string) => string | undefined,
): ParticipantStatView[] {
  return Object.entries(counts).map(([userId, taskCount]) => ({
    userId,
    name: nameOf(userId) ?? userId,
    taskCount,
  }));
}

/**
 * Преобразует доменную {@link Statistics} в представление контракта фронтенда
 * (Req 17.1–17.8).
 *
 * Имена участников разрешаются вызывающим кодом (контроллером) и передаются
 * функцией {@link nameOf}, поэтому сам маппер остаётся чистым и тестируемым.
 *
 * @param stats Рассчитанная доменная статистика.
 * @param nameOf Функция получения отображаемого имени участника по идентификатору.
 * @returns Представление статистики для клиента.
 */
export function toStatisticsView(
  stats: Statistics,
  nameOf: (userId: string) => string | undefined,
): StatisticsView {
  return {
    statusCounts: stats.byStatus,
    totalTasks: stats.totalTasks,
    overdueCount: stats.overdueCount,
    overduePercent: stats.overduePercent,
    avgCompletionHours: stats.averageCompletionHours,
    byManager: toParticipantStats(stats.byManager, nameOf),
    byExecutor: toParticipantStats(stats.byExecutor, nameOf),
    chatActivity: {
      messageCount: stats.chatActivity.totalMessages,
      activeChats: stats.chatActivity.activeChats,
    },
    hasData: !stats.noData,
  };
}

/** Собирает множество идентификаторов участников из разрезов статистики. */
export function participantIdsOf(stats: Statistics): string[] {
  return Array.from(new Set([...Object.keys(stats.byManager), ...Object.keys(stats.byExecutor)]));
}
