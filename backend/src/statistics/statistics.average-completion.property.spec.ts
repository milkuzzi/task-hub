import fc from 'fast-check';
import { TaskStatus } from '@prisma/client';
import { computeAverageCompletionHours } from './statistics.math';
import { StatTaskRecord } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 48: Среднее время выполнения**
 *
 * Property 48 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.3**:
 *
 * Для любого набора задач среднее время выполнения равно среднему
 * арифметическому интервалов (doneAt − createdAt) по всем выполненным задачам,
 * выраженному в часах и округлённому до одного знака; при отсутствии
 * выполненных задач значение равно 0.
 *
 * Тест прогоняет реальную чистую функцию
 * {@link computeAverageCompletionHours} на случайных наборах задач и сверяет её
 * результат с независимым эталонным расчётом, вычисленным непосредственно из
 * определения свойства. Выполненной считается задача со Статусом «Выполнено» и
 * непустым `doneAt`. Реализует ровно ОДНО свойство; ≥100 итераций fast-check
 * (здесь — 300).
 */

const MS_PER_HOUR = 3_600_000;
const NON_DONE_STATUSES: readonly TaskStatus[] = [
  TaskStatus.IN_PROGRESS,
  TaskStatus.WAITING,
  TaskStatus.NEEDS_ADMIN,
  TaskStatus.CANCELLED,
];

/** Эталонное округление до десятых, независимое от реализации под тестом. */
function referenceRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** Считается ли задача выполненной для целей среднего времени (Req 17.3). */
function isCompleted(task: StatTaskRecord): boolean {
  return task.status === TaskStatus.DONE && task.doneAt !== null;
}

/**
 * Эталонный расчёт среднего времени выполнения прямо из формулировки Property 48:
 * среднее арифметическое интервалов (doneAt − createdAt) в часах по выполненным
 * задачам; 0 — если выполненных нет.
 */
function referenceAverageHours(tasks: readonly StatTaskRecord[]): number {
  const completed = tasks.filter(isCompleted);
  if (completed.length === 0) {
    return 0;
  }
  const totalHours = completed.reduce((acc, task) => {
    const intervalMs = (task.doneAt as Date).getTime() - task.createdAt.getTime();
    return acc + intervalMs / MS_PER_HOUR;
  }, 0);
  return referenceRound(totalHours / completed.length);
}

// Момент создания: широкий диапазон абсолютных меток времени (UTC).
const createdAtArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
  .map((ms) => new Date(ms));

// Генератор задачи. Для выполненных задач doneAt получается прибавлением
// неотрицательного интервала к createdAt (моделирует реальный порядок событий
// и охватывает граничный нулевой интервал).
const taskArb: fc.Arbitrary<StatTaskRecord> = fc
  .record({
    createdAt: createdAtArb,
    completed: fc.boolean(),
    // Интервал до завершения: от 0 до ~3 лет в миллисекундах.
    intervalMs: fc.integer({ min: 0, max: 1000 * MS_PER_HOUR * 24 }),
    // doneAt без статуса DONE и DONE без doneAt не должны учитываться.
    nonDoneStatus: fc.constantFrom(...NON_DONE_STATUSES),
    danglingDoneAt: fc.boolean(),
  })
  .map(({ createdAt, completed, intervalMs, nonDoneStatus, danglingDoneAt }) => {
    if (completed) {
      return {
        status: TaskStatus.DONE,
        deadline: createdAt,
        createdAt,
        doneAt: new Date(createdAt.getTime() + intervalMs),
        executorIds: [],
        managerIds: [],
      } satisfies StatTaskRecord;
    }
    return {
      // Невыполненная: либо не-DONE статус, либо DONE без doneAt — оба случая
      // не должны попадать в расчёт среднего.
      status: danglingDoneAt ? TaskStatus.DONE : nonDoneStatus,
      deadline: createdAt,
      createdAt,
      doneAt: null,
      executorIds: [],
      managerIds: [],
    } satisfies StatTaskRecord;
  });

describe('Property 48: Среднее время выполнения (Req 17.3)', () => {
  it('равно среднему арифметическому интервалов выполненных задач в часах (до десятых); 0 без выполненных', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 50 }), (tasks) => {
        const actual = computeAverageCompletionHours(tasks);
        const expected = referenceAverageHours(tasks);
        expect(actual).toBe(expected);

        // Дополнительно фиксируем граничное условие отсутствия выполненных задач.
        if (!tasks.some(isCompleted)) {
          expect(actual).toBe(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
