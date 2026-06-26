import fc from 'fast-check';
import { TaskStatus } from '@prisma/client';
import { countByParticipant, computeChatActivity } from './statistics.math';
import { StatMessageRecord, StatTaskRecord } from './statistics.types';

/**
 * **Feature: task-assignment-system, Property 49: Статистика по участникам и активности чатов**
 *
 * Property 49 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 17.4, 17.5**:
 *
 * Для любого набора задач и сообщений количество задач в разрезе каждого
 * Менеджера/Исполнителя согласовано с фактическими назначениями, а показатели
 * активности Чатов равны числу отправленных Сообщений и числу Чатов,
 * содержащих не менее одного Сообщения.
 *
 * Тест прогоняет реальные чистые функции {@link countByParticipant} и
 * {@link computeChatActivity} на случайных наборах задач/сообщений и сверяет их
 * результаты с независимыми эталонными расчётами, выведенными прямо из
 * формулировки свойства:
 *  - для каждого участника (Менеджера/Исполнителя) количество задач равно числу
 *    задач, где он назначен (каждая задача учитывается один раз, даже если
 *    идентификатор продублирован в назначениях);
 *  - `totalMessages` равно числу всех Сообщений;
 *  - `activeChats` равно числу различных идентификаторов Чатов.
 *
 * Реализует ровно ОДНО свойство; ≥100 итераций fast-check (здесь — 300).
 */

const ALL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.IN_PROGRESS,
  TaskStatus.WAITING,
  TaskStatus.DONE,
  TaskStatus.NEEDS_ADMIN,
  TaskStatus.CANCELLED,
];

// Небольшой пул идентификаторов, чтобы участники повторялись между задачами и
// агрегаты были содержательными (а не «по одной задаче на участника»).
const userIdArb = fc.constantFrom('u1', 'u2', 'u3', 'u4', 'u5');
const chatIdArb = fc.constantFrom('c1', 'c2', 'c3', 'c4');

const dateArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 0, 1) })
  .map((ms) => new Date(ms));

// Генератор задачи: списки Менеджеров/Исполнителей могут содержать дубликаты,
// чтобы проверить, что задача учитывается по участнику ровно один раз.
const taskArb: fc.Arbitrary<StatTaskRecord> = fc
  .record({
    status: fc.constantFrom(...ALL_STATUSES),
    createdAt: dateArb,
    managerIds: fc.array(userIdArb, { maxLength: 5 }),
    executorIds: fc.array(userIdArb, { maxLength: 5 }),
  })
  .map(({ status, createdAt, managerIds, executorIds }) => ({
    status,
    deadline: createdAt,
    createdAt,
    doneAt: null,
    executorIds,
    managerIds,
  }));

const messageArb: fc.Arbitrary<StatMessageRecord> = fc.record({ chatId: chatIdArb });

/** Эталонный разрез «участник → число задач», где задача учтена один раз. */
function referenceCount(
  tasks: readonly StatTaskRecord[],
  pick: (task: StatTaskRecord) => string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    for (const id of new Set(pick(task))) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

describe('Property 49: Статистика по участникам и активности чатов (Req 17.4, 17.5)', () => {
  it('разрезы по Менеджерам/Исполнителям согласованы с назначениями, а активность чатов равна числу сообщений и активных чатов', () => {
    fc.assert(
      fc.property(
        fc.array(taskArb, { maxLength: 40 }),
        fc.array(messageArb, { maxLength: 60 }),
        (tasks, messages) => {
          const { byManager, byExecutor } = countByParticipant(tasks);

          // Req 17.4 — разрезы совпадают с эталоном, выведенным из назначений.
          expect(byManager).toEqual(referenceCount(tasks, (t) => t.managerIds));
          expect(byExecutor).toEqual(referenceCount(tasks, (t) => t.executorIds));

          // Каждое значение не превышает общего числа задач и положительно
          // (участники без назначений не появляются в разрезе).
          for (const value of [...Object.values(byManager), ...Object.values(byExecutor)]) {
            expect(value).toBeGreaterThan(0);
            expect(value).toBeLessThanOrEqual(tasks.length);
          }

          // Req 17.5 — активность чатов.
          const activity = computeChatActivity(messages);
          expect(activity.totalMessages).toBe(messages.length);
          expect(activity.activeChats).toBe(new Set(messages.map((m) => m.chatId)).size);
          // Число активных чатов не превышает общего числа сообщений.
          expect(activity.activeChats).toBeLessThanOrEqual(activity.totalMessages);
        },
      ),
      { numRuns: 300 },
    );
  });
});
