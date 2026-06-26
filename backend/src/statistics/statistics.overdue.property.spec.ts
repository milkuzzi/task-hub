import { TaskStatus } from '@prisma/client';
import fc from 'fast-check';
import { computeOverdue, isOverdue, roundToOneDecimal } from './statistics.math';
import { StatTaskRecord } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 47: Классификация просроченных задач и доля**
 *
 * Property 47 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.2**:
 *
 * Для любого набора задач задача классифицируется как просроченная тогда и
 * только тогда, когда текущее время превышает её дедлайн и она не в статусе
 * «Выполнено»; отображаемая доля просроченных равна
 * (число просроченных / общее число) × 100, округлённой до одного знака.
 *
 * Тест проверяет ровно ОДНО свойство на чистых функциях расчёта
 * ({@link isOverdue}, {@link computeOverdue}) — инфраструктура (БД, время, права)
 * не задействована, текущий момент инъецируется как параметр. Минимум 100
 * итераций fast-check (здесь — 200).
 */

/** Фиксированный «текущий момент» для детерминированной классификации просрочек. */
const NOW = new Date('2030-06-01T12:00:00Z');
const NOW_MS = NOW.getTime();

/**
 * Дедлайн вокруг NOW: намеренно покрывает прошедшие, будущие и точно
 * совпадающие с NOW моменты, чтобы проверять строгость сравнения «текущее время
 * превышает дедлайн».
 */
const deadlineArb = fc.oneof(
  // Точно равен NOW (граница: не просрочено, т.к. сравнение строгое).
  fc.constant(new Date(NOW_MS)),
  // В пределах ±60 дней от NOW.
  fc
    .integer({ min: -60 * 24 * 3600 * 1000, max: 60 * 24 * 3600 * 1000 })
    .map((deltaMs) => new Date(NOW_MS + deltaMs)),
);

const taskArb: fc.Arbitrary<StatTaskRecord> = fc.record({
  status: fc.constantFrom(
    TaskStatus.IN_PROGRESS,
    TaskStatus.WAITING,
    TaskStatus.DONE,
    TaskStatus.NEEDS_ADMIN,
    TaskStatus.CANCELLED,
  ),
  deadline: deadlineArb,
  createdAt: fc.constant(new Date('2030-05-01T00:00:00Z')),
  doneAt: fc.constant<Date | null>(null),
  executorIds: fc.constant<string[]>([]),
  managerIds: fc.constant<string[]>([]),
});

describe('Property 47: Классификация просроченных задач и доля (Req 17.2)', () => {
  it('задача просрочена ⇔ NOW > дедлайн и статус ≠ «Выполнено»; доля = round((overdue/total)×100, 1)', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 50 }), (tasks) => {
        // 1) Классификация: строгое «тогда и только тогда».
        for (const task of tasks) {
          const expectedOverdue =
            NOW_MS > task.deadline.getTime() && task.status !== TaskStatus.DONE;
          expect(isOverdue(task, NOW)).toBe(expectedOverdue);
        }

        // 2) Подсчёт и доля.
        const expectedCount = tasks.filter((t) => isOverdue(t, NOW)).length;
        const expectedPercent =
          tasks.length === 0 ? 0 : roundToOneDecimal((expectedCount / tasks.length) * 100);

        const { overdueCount, overduePercent } = computeOverdue(tasks, NOW);
        expect(overdueCount).toBe(expectedCount);
        expect(overduePercent).toBe(expectedPercent);

        // Доля — корректный процент, округлённый до одного знака, в [0, 100].
        expect(overduePercent).toBeGreaterThanOrEqual(0);
        expect(overduePercent).toBeLessThanOrEqual(100);
        expect(roundToOneDecimal(overduePercent)).toBe(overduePercent);
      }),
      { numRuns: 200 },
    );
  });
});
