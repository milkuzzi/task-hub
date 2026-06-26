import fc from 'fast-check';
import { Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { ValidationException } from '../common/errors';
import { UserRepository } from '../repositories';
import { computeStatistics } from './statistics.math';
import { StatisticsRepository } from './statistics.repository';
import { StatisticsService } from './statistics.service';
import { DateRange, StatMessageRecord, StatTaskRecord, Statistics } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 50: Фильтрация статистики по периоду и валидация диапазона**
 *
 * Property 50 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.6, 17.7**:
 *
 * Для любого периода [начало, конец] статистика рассчитывается только по
 * задачам и сообщениям, попадающим в период включительно; если начало позже
 * конца, запрос отклоняется с ошибкой, а ранее отображённая статистика не
 * меняется.
 *
 * Свойство охватывает два аспекта и проверяет реальный код:
 *
 *  - **Фильтрация по периоду (Req 17.6).** Прогоняется настоящий
 *    {@link StatisticsService.compute} с фейковым репозиторием, который
 *    воспроизводит включительную фильтрацию по моменту создания
 *    (`start ≤ createdAt ≤ end`), как делает {@link StatisticsRepository}
 *    через Prisma `gte/lte`. Результат сверяется с независимым эталонным
 *    расчётом {@link computeStatistics} по подмножеству записей, отобранному
 *    напрямую из определения свойства. Генераторы намеренно порождают записи
 *    ровно на границах периода, на единицу до начала и после конца, чтобы
 *    проверить именно включительность.
 *  - **Валидация диапазона (Req 17.7).** Если начало строго позже конца,
 *    реальный сервис отклоняет запрос {@link ValidationException}, при этом
 *    выборка данных не выполняется (репозиторий не вызывается) — состояние не
 *    меняется, ранее отображённая статистика сохраняется.
 *
 * Реализует ровно ОДНО свойство; ≥100 итераций fast-check (здесь — 200).
 */

const FIXED_NOW = new Date('2030-06-01T12:00:00Z');

// Базис временной шкалы и единица шага. Метки времени берутся как
// BASE + k * UNIT, что сохраняет точное совпадение значений на границах
// периода (важно для проверки включительности).
const BASE_MS = Date.UTC(2030, 0, 1);
const UNIT_MS = 3_600_000; // один час

const ALL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.IN_PROGRESS,
  TaskStatus.WAITING,
  TaskStatus.DONE,
  TaskStatus.NEEDS_ADMIN,
  TaskStatus.CANCELLED,
];

/** Способ размещения момента создания относительно границ периода. */
type CreatedPlacement =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'beforeStart' }
  | { kind: 'afterEnd' }
  | { kind: 'between'; ratio: number }
  | { kind: 'free'; offset: number };

/** Исходная (нефильтрованная) задача с моментом создания. */
interface SourceTask {
  placement: CreatedPlacement;
  status: TaskStatus;
  doneAfter: number; // часы до завершения для DONE-задач
  executorIds: string[];
  managerIds: string[];
}

/** Исходное (нефильтрованное) сообщение с моментом создания. */
interface SourceMessage {
  placement: CreatedPlacement;
  chatId: string;
}

/** Преобразует тик шкалы в абсолютный момент времени. */
function tickToDate(tick: number): Date {
  return new Date(BASE_MS + tick * UNIT_MS);
}

/**
 * Разрешает момент создания записи относительно границ периода. Возвращает тик
 * (целое число шагов), который затем переводится в {@link Date}.
 */
function resolveCreatedTick(
  placement: CreatedPlacement,
  startTick: number,
  endTick: number,
): number {
  const lo = Math.min(startTick, endTick);
  const hi = Math.max(startTick, endTick);
  switch (placement.kind) {
    case 'start':
      return startTick;
    case 'end':
      return endTick;
    case 'beforeStart':
      return lo - 1;
    case 'afterEnd':
      return hi + 1;
    case 'between':
      return lo + Math.round(placement.ratio * (hi - lo));
    case 'free':
      return placement.offset;
  }
}

/** Строит полную запись задачи из исходной и момента создания. */
function toTaskRecord(source: SourceTask, createdAt: Date): StatTaskRecord {
  return {
    status: source.status,
    deadline: createdAt,
    createdAt,
    doneAt:
      source.status === TaskStatus.DONE
        ? new Date(createdAt.getTime() + source.doneAfter * UNIT_MS)
        : null,
    executorIds: source.executorIds,
    managerIds: source.managerIds,
  };
}

const placementArb: fc.Arbitrary<CreatedPlacement> = fc.oneof(
  fc.constant<CreatedPlacement>({ kind: 'start' }),
  fc.constant<CreatedPlacement>({ kind: 'end' }),
  fc.constant<CreatedPlacement>({ kind: 'beforeStart' }),
  fc.constant<CreatedPlacement>({ kind: 'afterEnd' }),
  fc
    .double({ min: 0, max: 1, noNaN: true })
    .map((ratio): CreatedPlacement => ({ kind: 'between', ratio })),
  fc.integer({ min: -10, max: 1010 }).map((offset): CreatedPlacement => ({ kind: 'free', offset })),
);

const idArb = fc.constantFrom('u1', 'u2', 'u3');

const sourceTaskArb: fc.Arbitrary<SourceTask> = fc.record({
  placement: placementArb,
  status: fc.constantFrom(...ALL_STATUSES),
  doneAfter: fc.integer({ min: 0, max: 240 }),
  executorIds: fc.uniqueArray(idArb, { maxLength: 3 }),
  managerIds: fc.uniqueArray(idArb, { maxLength: 3 }),
});

const sourceMessageArb: fc.Arbitrary<SourceMessage> = fc.record({
  placement: placementArb,
  chatId: fc.constantFrom('c1', 'c2', 'c3'),
});

function makeAdmin(id: string): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role: Role.ADMIN,
    isActive: true,
    deletedAt: null,
  } as unknown as User;
}

/**
 * Собирает сервис с фейковым репозиторием, который воспроизводит включительную
 * фильтрацию по моменту создания (как настоящий {@link StatisticsRepository}).
 * Источники данных задаются заранее; репозиторий применяет к ним переданный
 * период.
 */
function buildService(
  sourceTasks: StatTaskRecord[],
  sourceMessages: { createdAt: Date; chatId: string }[],
) {
  const findTasksForStatistics = jest.fn(
    async (period: DateRange | null): Promise<StatTaskRecord[]> => {
      if (period === null) {
        return sourceTasks;
      }
      return sourceTasks.filter(
        (t) =>
          t.createdAt.getTime() >= period.start.getTime() &&
          t.createdAt.getTime() <= period.end.getTime(),
      );
    },
  );
  const findMessagesForStatistics = jest.fn(
    async (period: DateRange | null): Promise<StatMessageRecord[]> => {
      const selected =
        period === null
          ? sourceMessages
          : sourceMessages.filter(
              (m) =>
                m.createdAt.getTime() >= period.start.getTime() &&
                m.createdAt.getTime() <= period.end.getTime(),
            );
      return selected.map((m) => ({ chatId: m.chatId }));
    },
  );

  const statisticsRepository = {
    findTasksForStatistics,
    findMessagesForStatistics,
  } as unknown as StatisticsRepository;

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => (id === 'adm' ? makeAdmin('adm') : null)),
  } as unknown as UserRepository;

  const clock = new ClockService({ now: () => FIXED_NOW });
  const service = new StatisticsService(statisticsRepository, userRepository, clock);
  return { service, findTasksForStatistics, findMessagesForStatistics };
}

/** Эталонная статистика по подмножеству записей, попадающих в период включительно. */
function referenceStatistics(
  tasks: StatTaskRecord[],
  messages: { createdAt: Date; chatId: string }[],
  period: DateRange,
): Statistics {
  const inRange = (d: Date): boolean =>
    d.getTime() >= period.start.getTime() && d.getTime() <= period.end.getTime();
  const filteredTasks = tasks.filter((t) => inRange(t.createdAt));
  const filteredMessages = messages
    .filter((m) => inRange(m.createdAt))
    .map((m) => ({ chatId: m.chatId }));
  return computeStatistics({
    tasks: filteredTasks,
    messages: filteredMessages,
    period,
    now: FIXED_NOW,
  });
}

describe('Property 50: Фильтрация статистики по периоду и валидация диапазона (Req 17.6, 17.7)', () => {
  it('считает только записи периода включительно и отклоняет диапазон с началом позже конца, не меняя состояние', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.array(sourceTaskArb, { maxLength: 30 }),
        fc.array(sourceMessageArb, { maxLength: 30 }),
        async (startTick, endTick, sourceTasks, sourceMessages) => {
          // Материализуем источники: моменты создания относительно границ.
          const tasks: StatTaskRecord[] = sourceTasks.map((s) =>
            toTaskRecord(s, tickToDate(resolveCreatedTick(s.placement, startTick, endTick))),
          );
          const messages = sourceMessages.map((s) => ({
            createdAt: tickToDate(resolveCreatedTick(s.placement, startTick, endTick)),
            chatId: s.chatId,
          }));

          const period: DateRange = { start: tickToDate(startTick), end: tickToDate(endTick) };

          const { service, findTasksForStatistics, findMessagesForStatistics } = buildService(
            tasks,
            messages,
          );

          if (startTick > endTick) {
            // Req 17.7: некорректный диапазон отклоняется без выборки данных —
            // ранее отображённая статистика не пересчитывается.
            await expect(service.compute('adm', period)).rejects.toBeInstanceOf(
              ValidationException,
            );
            expect(findTasksForStatistics).not.toHaveBeenCalled();
            expect(findMessagesForStatistics).not.toHaveBeenCalled();
            return;
          }

          // Req 17.6: статистика считается только по записям периода (границы
          // включительно). Сверяем с независимым эталоном.
          const actual = await service.compute('adm', period);
          const expected = referenceStatistics(tasks, messages, period);
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
