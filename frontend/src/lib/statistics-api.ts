import axios, { AxiosError } from 'axios';
import { ApiError, http, type ApiErrorBody } from './api';
import type { TaskStatus } from './tasks-api';

/**
 * Типы и REST-вызовы Статистики для Администратора «Системы поручений» (Req 17).
 *
 * Контракты соответствуют StatisticsModule дизайна и серверному
 * `StatisticsService`:
 * - `computeStatistics(period?)` — расчёт показателей за период (Req 17.1–17.8, ≤5с).
 * - `exportStatistics(period, format)` — выгрузка файла CSV/Excel (Req 17.9, ≤10с).
 *
 * Период задаётся датами (включительно, Req 17.6). Начало позже конца —
 * недопустимый диапазон: запрос отклоняется, ранее отображённая статистика не
 * меняется (Req 17.7); проверку выполняем и на клиенте через {@link isValidRange}.
 */

/** Формат экспортируемого файла Статистики (Req 17.9). */
export type ExportFormat = 'csv' | 'xlsx';

/** Период расчёта Статистики (даты включительно, Req 17.6). ISO-8601 (UTC). */
export interface StatisticsPeriod {
  from: string;
  to: string;
}

/** Количество Задач по одному Статусу (включая нулевые, Req 17.1). */
export type StatusCounts = Record<TaskStatus, number>;

/** Показатель в разрезе участника (Менеджера/Исполнителя, Req 17.4). */
export interface ParticipantStat {
  userId: string;
  /** Отображаемое имя участника (если доступно серверу). */
  name: string;
  /** Количество Задач, связанных с участником. */
  taskCount: number;
}

/** Показатели активности Чатов (Req 17.5). */
export interface ChatActivity {
  /** Общее число отправленных Сообщений за период. */
  messageCount: number;
  /** Число Чатов, в которых было хотя бы одно Сообщение. */
  activeChats: number;
}

/**
 * Полный набор показателей Статистики (Req 17.1–17.5, 17.8).
 *
 * `hasData === false` означает отсутствие данных за период: все показатели
 * нулевые, интерфейс показывает уведомление об отсутствии данных (Req 17.8).
 */
export interface Statistics {
  /** Количество Задач по каждому Статусу, включая нулевые (Req 17.1). */
  statusCounts: StatusCounts;
  /** Общее количество Задач за период. */
  totalTasks: number;
  /** Количество просроченных Задач (Req 17.2). */
  overdueCount: number;
  /** Доля просроченных Задач в процентах, 1 знак после запятой (Req 17.2). */
  overduePercent: number;
  /** Среднее время выполнения в часах, 1 знак; 0 при отсутствии (Req 17.3). */
  avgCompletionHours: number;
  /** Разрез по Менеджерам (Req 17.4). */
  byManager: ParticipantStat[];
  /** Разрез по Исполнителям (Req 17.4). */
  byExecutor: ParticipantStat[];
  /** Активность Чатов (Req 17.5). */
  chatActivity: ChatActivity;
  /** Есть ли данные за период (Req 17.8). */
  hasData: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireParticipants(value: unknown): ParticipantStat[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) &&
        typeof item.userId === 'string' &&
        typeof item.name === 'string' &&
        typeof item.taskCount === 'number',
    )
  ) {
    throw new TypeError('Некорректный ответ API: ожидалась статистика участников');
  }
  return value as ParticipantStat[];
}

function requireStatistics(value: unknown): Statistics {
  const statusCounts = isRecord(value) && isRecord(value.statusCounts) ? value.statusCounts : null;
  const chatActivity =
    isRecord(value) && isRecord(value.chatActivity) ? value.chatActivity : null;
  if (
    !isRecord(value) ||
    statusCounts === null ||
    !['IN_PROGRESS', 'WAITING', 'DONE', 'NEEDS_ADMIN', 'CANCELLED'].every(
      (status) => typeof statusCounts[status] === 'number',
    ) ||
    !['totalTasks', 'overdueCount', 'overduePercent', 'avgCompletionHours'].every(
      (field) => typeof value[field] === 'number',
    ) ||
    chatActivity === null ||
    typeof chatActivity.messageCount !== 'number' ||
    typeof chatActivity.activeChats !== 'number' ||
    typeof value.hasData !== 'boolean'
  ) {
    throw new TypeError('Некорректный ответ API: ожидалась статистика');
  }
  requireParticipants(value.byManager);
  requireParticipants(value.byExecutor);
  return value as unknown as Statistics;
}

/**
 * Проверяет корректность диапазона: начало не позже конца (Req 17.7).
 *
 * Пустые границы считаются корректными (период не задан — статистика за всё
 * время). Используется интерфейсом до запроса, чтобы не сбрасывать ранее
 * отображённую статистику при заведомо некорректном диапазоне (Req 17.7).
 */
export function isValidRange(period: Partial<StatisticsPeriod>): boolean {
  if (period.from === undefined || period.to === undefined) {
    return true;
  }
  if (period.from === '' || period.to === '') {
    return true;
  }
  return new Date(period.from).getTime() <= new Date(period.to).getTime();
}

/** Сериализует период в query-параметры (опуская пустые границы). */
function periodParams(period?: StatisticsPeriod): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (period?.from !== undefined && period.from !== '') {
    params.from = period.from;
  }
  if (period?.to !== undefined && period.to !== '') {
    params.to = period.to;
  }
  return params;
}

/**
 * Рассчитывает Статистику за указанный период (Req 17.1–17.8).
 *
 * Сервер выполняет расчёт ≤5с (Req 17.6) и при некорректном диапазоне
 * отклоняет запрос ошибкой (Req 17.7). Доступно только Администратору.
 */
export function computeStatistics(period?: StatisticsPeriod): Promise<Statistics> {
  return http
    .get<unknown>('/statistics', { params: periodParams(period) })
    .then((r) => requireStatistics(r.data));
}

/**
 * Запрашивает экспорт Статистики и возвращает файл как `Blob` (Req 17.9).
 *
 * Файл содержит все отображаемые показатели за период; сервер формирует его
 * ≤10с (Req 17.9). Ошибка формирования прерывает экспорт с сообщением, не меняя
 * отображённую статистику (Req 17.10) — нормализуется в {@link ApiError}.
 */
export async function exportStatistics(
  period: StatisticsPeriod,
  format: ExportFormat,
): Promise<Blob> {
  try {
    const response = await http.get<Blob>('/statistics/export', {
      params: { ...periodParams(period), format },
      responseType: 'blob',
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<ApiErrorBody>;
      const status = axiosError.response?.status ?? 0;
      // Тело ошибки приходит как Blob (responseType=blob) — пытаемся прочитать JSON.
      const data = axiosError.response?.data;
      let body: ApiErrorBody | undefined;
      if (data instanceof Blob) {
        try {
          body = JSON.parse(await data.text()) as ApiErrorBody;
        } catch {
          body = undefined;
        }
      } else if (data !== undefined) {
        body = data;
      }
      throw new ApiError(
        body?.message ?? axiosError.message,
        body?.code ?? 'EXPORT_FAILED',
        status,
        body?.details,
      );
    }
    throw error;
  }
}

/** Имя файла экспорта Статистики по формату. */
export function exportFileName(format: ExportFormat): string {
  return format === 'csv' ? 'statistics.csv' : 'statistics.xlsx';
}

/**
 * Инициирует скачивание `Blob` в браузере, создавая временную ссылку.
 * Выделено для тестируемости компонента Статистики.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
