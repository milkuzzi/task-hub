import fc from 'fast-check';
import { AppConfigService } from '../config';
import { MessageRepository, TaskRepository, UserRepository } from '../repositories';
import { TasksService } from './tasks.service';

/**
 * **Feature: task-assignment-system, Property 25: Маркер непрочитанных сообщений**
 *
 * Property 25 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 9.8**:
 *
 * *Для любого* Пользователя и Чата маркер непрочитанного отображается на
 * карточке Задачи тогда и только тогда, когда в Чате есть хотя бы одно
 * Сообщение, не отмеченное прочитанным этим Пользователем.
 *
 * Свойство проверяется на {@link TasksService.hasUnread}, который служит
 * источником флага маркера: маркер показывается ⇔ `hasUnread === true`.
 *
 * Граница БД ({@link MessageRepository}) подменяется детерминированной
 * stateful-моделью в памяти: список Сообщений (каждое привязано к `taskId`) и
 * множество отметок прочтения (пар «Сообщение + Пользователь»). Мок
 * `countUnreadForUserByTask` воспроизводит контракт Prisma-запроса — считает
 * Сообщения Чата Задачи, для которых отсутствует отметка прочтения данным
 * Пользователем. Прочие зависимости сервиса (`TaskRepository`,
 * `UserRepository`, `AppConfigService`) не используются методом `hasUnread` и
 * подменяются пустыми заглушками. Обращений к реальной базе нет.
 *
 * Независимым оракулом «существует непрочитанное» выступает прямая проверка
 * наличия хотя бы одного Сообщения Чата Задачи без отметки прочтения
 * Пользователем; результат `hasUnread` обязан в точности ему соответствовать
 * (биусловие «тогда и только тогда»).
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */
describe('Property 25: Маркер непрочитанных сообщений (Req 9.8)', () => {
  const TASK_POOL = ['task-1', 'task-2', 'task-3'] as const;
  const USER_POOL = ['user-1', 'user-2', 'user-3'] as const;

  /** Сообщение Чата: уникальный идентификатор и Задача, к Чату которой оно относится. */
  interface StoredMessage {
    id: string;
    taskId: string;
  }

  /**
   * Stateful-модель хранилища Сообщений и отметок прочтения в памяти.
   *
   * @param messages Сообщения по всем Чатам.
   * @param reads Множество ключей `${messageId}::${userId}` — факт прочтения.
   * @returns Объект с интерфейсом {@link MessageRepository} (метод
   *   `countUnreadForUserByTask`).
   */
  function buildMessageRepository(
    messages: StoredMessage[],
    reads: ReadonlySet<string>,
  ): MessageRepository {
    const countUnreadForUserByTask = jest.fn(async (userId: string, taskId: string) => {
      // Контракт Prisma-запроса: Сообщения Чата Задачи без записи MessageRead
      // для данного Пользователя (Req 9.8, 11.8).
      return messages.filter((m) => m.taskId === taskId && !reads.has(`${m.id}::${userId}`)).length;
    });
    return { countUnreadForUserByTask } as unknown as MessageRepository;
  }

  /** Создаёт сервис c stateful-моделью Сообщений; прочие границы — пустые заглушки. */
  function buildService(messages: StoredMessage[], reads: ReadonlySet<string>) {
    return new TasksService(
      {} as unknown as TaskRepository,
      {} as unknown as UserRepository,
      {} as unknown as AppConfigService,
      buildMessageRepository(messages, reads),
      { record: async () => undefined },
      { enqueueTaskUpdated: async () => undefined },
    );
  }

  /**
   * Генератор состояния: набор Сообщений по нескольким Задачам и отметки
   * прочтения. Каждое Сообщение получает уникальный идентификатор по индексу,
   * привязано к произвольной Задаче из пула, и для него задаётся множество
   * прочитавших Пользователей (подмножество пула).
   */
  const stateArb = fc
    .array(
      fc.record({
        taskId: fc.constantFrom(...TASK_POOL),
        readers: fc.uniqueArray(fc.constantFrom(...USER_POOL), { maxLength: USER_POOL.length }),
      }),
      { maxLength: 30 },
    )
    .map((rows) => {
      const messages: StoredMessage[] = rows.map((row, index) => ({
        id: `msg-${index}`,
        taskId: row.taskId,
      }));
      const reads = new Set<string>();
      rows.forEach((row, index) => {
        for (const userId of row.readers) {
          reads.add(`msg-${index}::${userId}`);
        }
      });
      return { messages, reads };
    });

  it('hasUnread === true тогда и только тогда, когда есть непрочитанное сообщение чата задачи', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateArb,
        fc.constantFrom(...USER_POOL),
        fc.constantFrom(...TASK_POOL),
        async ({ messages, reads }, userId, taskId) => {
          const service = buildService(messages, reads);

          const marker = await service.hasUnread(userId, taskId);

          // Независимый оракул: существует ли хотя бы одно Сообщение Чата
          // Задачи без отметки прочтения данным Пользователем.
          const existsUnread = messages.some(
            (m) => m.taskId === taskId && !reads.has(`${m.id}::${userId}`),
          );

          // Биусловие Req 9.8: маркер показывается ⇔ есть непрочитанное.
          expect(marker).toBe(existsUnread);
        },
      ),
      { numRuns: 200 },
    );
  });
});
