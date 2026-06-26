import fc from 'fast-check';
import { TaskStatus } from '@prisma/client';
import { ALL_TASK_STATUSES, computeStatistics, countByStatus } from './statistics.math';
import { StatMessageRecord, StatTaskRecord } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 46: Согласованность статистики по статусам**
 *
 * Property 46 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.1**:
 *
 * Для любого набора видимых Задач статистика по Статусам содержит ВСЕ
 * существующие Статусы (включая Статусы с нулевым количеством), а сумма
 * количеств по Статусам равна общему числу Задач.
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Расчёт по Статусам — чистая функция
 * ({@link countByStatus}, агрегируемая {@link computeStatistics}), не зависящая
 * от инфраструктуры; внешних границ (БД/Redis/время) здесь нет, поэтому моки не
 * требуются. Генератор строит произвольные наборы Задач с равновероятным
 * выбором любого существующего Статуса, что покрывает в том числе случаи, когда
 * отдельные Статусы вовсе не встречаются (проверка включения нулевых).
 */
describe('Property 46: Согласованность статистики по статусам (Req 17.1)', () => {
  /** Произвольная облегчённая запись Задачи; значимо только поле `status`. */
  const taskArb: fc.Arbitrary<StatTaskRecord> = fc
    .constantFrom<TaskStatus>(...ALL_TASK_STATUSES)
    .map((status) => ({
      status,
      deadline: new Date('2030-07-01T00:00:00Z'),
      createdAt: new Date('2030-05-01T00:00:00Z'),
      doneAt: null,
      executorIds: [],
      managerIds: [],
    }));

  it('включает все существующие статусы, а сумма по статусам равна числу задач', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { maxLength: 200 }), (tasks) => {
        const byStatus = countByStatus(tasks);

        // Все существующие статусы присутствуют (включая нулевые).
        for (const status of ALL_TASK_STATUSES) {
          expect(byStatus[status]).toBeDefined();
          expect(byStatus[status]).toBeGreaterThanOrEqual(0);
        }

        // Никаких лишних ключей сверх существующих статусов.
        expect(Object.keys(byStatus).sort()).toEqual([...ALL_TASK_STATUSES].sort());

        // Сумма количеств по статусам равна общему числу задач.
        const sum = ALL_TASK_STATUSES.reduce((acc, status) => acc + byStatus[status], 0);
        expect(sum).toBe(tasks.length);
      }),
      { numRuns: 200 },
    );
  });

  it('агрегированная статистика согласована по статусам с общим числом задач', () => {
    const messageArb: fc.Arbitrary<StatMessageRecord> = fc
      .string({ minLength: 1, maxLength: 8 })
      .map((chatId) => ({ chatId }));

    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 200 }),
        fc.array(messageArb, { maxLength: 50 }),
        (tasks, messages) => {
          const stats = computeStatistics({
            tasks,
            messages,
            period: null,
            now: new Date('2030-06-01T12:00:00Z'),
          });

          for (const status of ALL_TASK_STATUSES) {
            expect(stats.byStatus[status]).toBeDefined();
          }
          const sum = ALL_TASK_STATUSES.reduce((acc, status) => acc + stats.byStatus[status], 0);
          expect(sum).toBe(stats.totalTasks);
          expect(stats.totalTasks).toBe(tasks.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
