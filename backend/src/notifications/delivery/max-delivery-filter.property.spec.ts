import fc from 'fast-check';
import { MaxLink } from '@prisma/client';
import { ChatMuteRepository, UserRepository } from '../../repositories';
import { MaxDeliveryFilter, MaxDeliveryTarget } from './max-delivery-filter';

/**
 * **Feature: task-assignment-system, Property 45: Фильтрация доставки MAX по отпискам и mute**
 *
 * Property 45 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 16.5, 16.6, 16.9**:
 *
 * Для любого Пользователя и Задачи:
 * - при включённой полной отписке от всех Уведомлений (`MaxLink.mutedAll = true`)
 *   ни одно MAX-Уведомление не доставляется (Req 16.5) — независимо от Задачи и
 *   от наличия точечного заглушения;
 * - при отписке/заглушении Чата конкретной Задачи не доставляются MAX-Уведомления
 *   этой Задачи (Req 16.6, 16.9), при этом Уведомления других Задач продолжают
 *   доставляться;
 * - повторное включение (снятие полной отписки и/или снятие заглушения Задачи)
 *   восстанавливает доставку (round-trip): итоговое решение фильтра совпадает с
 *   решением для исходного незаглушённого состояния.
 *
 * Тест реализует ровно ЭТО ОДНО свойство через прикладную логику фильтрации
 * доставки в канал MAX — {@link MaxDeliveryFilter.isSuppressed}, единственную
 * точку решения о подавлении доставки Уведомления через Бот MAX перед отправкой.
 *
 * Внешние границы ({@link UserRepository}, {@link ChatMuteRepository} поверх
 * PostgreSQL) подменяются СТАТЕФУЛ in-memory моками поверх общего хранилища
 * состояния отписок/заглушений — обращений к реальной БД нет. Production-код не
 * изменяется.
 */
describe('Property 45: Фильтрация доставки MAX по отпискам и mute (Req 16.5, 16.6, 16.9)', () => {
  /**
   * Статэфул in-memory модель состояния отписок/заглушений.
   *
   * - `links` — наличие привязки MAX у Пользователя и флаг полной отписки
   *   (`mutedAll`). Отсутствие записи означает «привязки MAX нет».
   * - `muted` — множество заглушённых пар «получатель|Задача» (Req 16.6, 16.9).
   */
  interface Store {
    links: Map<string, { mutedAll: boolean }>;
    muted: Set<string>;
  }

  const muteKey = (userId: string, taskId: string): string => `${userId}\u0000${taskId}`;

  /** Создаёт фильтр поверх статэфул in-memory хранилища. */
  function buildFilter(store: Store): MaxDeliveryFilter {
    const userRepository = {
      findMaxLinkByUserId: jest.fn(async (userId: string) => {
        const link = store.links.get(userId);
        return link === undefined
          ? null
          : ({ userId, mutedAll: link.mutedAll } as unknown as MaxLink);
      }),
    } as unknown as UserRepository;

    const chatMuteRepository = {
      isMuted: jest.fn(async (userId: string, taskId: string) =>
        store.muted.has(muteKey(userId, taskId)),
      ),
    } as unknown as ChatMuteRepository;

    return new MaxDeliveryFilter(userRepository, chatMuteRepository);
  }

  /**
   * Эталонное (oracle) решение о подавлении доставки согласно Req 16.5, 16.6, 16.9.
   */
  function oracleSuppressed(store: Store, target: MaxDeliveryTarget): boolean {
    const link = store.links.get(target.recipientId);
    if (link !== undefined && link.mutedAll) {
      return true; // Полная отписка (Req 16.5).
    }
    if (target.taskId !== null && target.taskId !== undefined) {
      if (store.muted.has(muteKey(target.recipientId, target.taskId))) {
        return true; // Заглушение/отписка от Задачи (Req 16.6, 16.9).
      }
    }
    return false;
  }

  // --- Арбитрари ---

  const userIdArb = fc.constantFrom('user-1', 'user-2', 'user-3');
  /** taskId Уведомления: конкретная Задача либо отсутствие Задачи (null). */
  const taskIdArb = fc.constantFrom<string | null>('task-1', 'task-2', 'task-3', null);

  /** Состояние привязки MAX Пользователя. */
  const linkStateArb = fc.oneof(
    fc.constant<{ present: false }>({ present: false }),
    fc.record({ present: fc.constant(true as const), mutedAll: fc.boolean() }),
  );

  /** Генерирует произвольное состояние хранилища отписок/заглушений. */
  const storeArb: fc.Arbitrary<Store> = fc
    .record({
      links: fc.array(fc.tuple(userIdArb, linkStateArb), { maxLength: 6 }),
      mutedPairs: fc.array(fc.tuple(userIdArb, fc.constantFrom('task-1', 'task-2', 'task-3')), {
        maxLength: 9,
      }),
    })
    .map(({ links, mutedPairs }) => {
      const store: Store = { links: new Map(), muted: new Set() };
      for (const [userId, state] of links) {
        if (state.present) {
          store.links.set(userId, { mutedAll: state.mutedAll });
        }
      }
      for (const [userId, taskId] of mutedPairs) {
        store.muted.add(muteKey(userId, taskId));
      }
      return store;
    });

  const targetArb: fc.Arbitrary<MaxDeliveryTarget> = fc.record({
    recipientId: userIdArb,
    taskId: taskIdArb,
  });

  it('решение фильтра совпадает с правилами отписок/заглушений для любых состояний', async () => {
    await fc.assert(
      fc.asyncProperty(storeArb, targetArb, async (store, target) => {
        const filter = buildFilter(store);
        const suppressed = await filter.isSuppressed(target);
        expect(suppressed).toBe(oracleSuppressed(store, target));
      }),
      { numRuns: 200 },
    );
  });

  it('полная отписка (mutedAll) подавляет доставку любых MAX-уведомлений — Req 16.5', async () => {
    await fc.assert(
      fc.asyncProperty(userIdArb, taskIdArb, async (recipientId, taskId) => {
        const store: Store = {
          links: new Map([[recipientId, { mutedAll: true }]]),
          muted: new Set(),
        };
        const filter = buildFilter(store);
        // Независимо от Задачи (включая её отсутствие) доставка подавлена.
        await expect(filter.isSuppressed({ recipientId, taskId })).resolves.toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('заглушение Задачи подавляет её уведомления, не затрагивая другие — Req 16.6, 16.9', async () => {
    const otherTasks = ['task-1', 'task-2', 'task-3'];
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        fc.constantFrom('task-1', 'task-2', 'task-3'),
        fc.boolean(),
        async (recipientId, mutedTaskId, hasLink) => {
          const store: Store = {
            links: hasLink ? new Map([[recipientId, { mutedAll: false }]]) : new Map(),
            muted: new Set([muteKey(recipientId, mutedTaskId)]),
          };
          const filter = buildFilter(store);

          // Уведомление заглушённой Задачи подавлено.
          await expect(filter.isSuppressed({ recipientId, taskId: mutedTaskId })).resolves.toBe(
            true,
          );

          // Уведомления остальных Задач (и без Задачи) доставляются.
          for (const taskId of otherTasks.filter((t) => t !== mutedTaskId)) {
            await expect(filter.isSuppressed({ recipientId, taskId })).resolves.toBe(false);
          }
          await expect(filter.isSuppressed({ recipientId, taskId: null })).resolves.toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trip: повторное включение восстанавливает доставку — Req 16.5, 16.6, 16.9', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        fc.constantFrom('task-1', 'task-2', 'task-3'),
        fc.boolean(),
        fc.boolean(),
        async (recipientId, taskId, muteAll, muteTask) => {
          const store: Store = {
            links: new Map([[recipientId, { mutedAll: false }]]),
            muted: new Set(),
          };
          const filter = buildFilter(store);
          const target: MaxDeliveryTarget = { recipientId, taskId };

          // Базовое состояние без отписок/заглушения — доставка не подавлена.
          await expect(filter.isSuppressed(target)).resolves.toBe(false);

          // Включаем отписку и/или заглушение.
          if (muteAll) {
            store.links.set(recipientId, { mutedAll: true });
          }
          if (muteTask) {
            store.muted.add(muteKey(recipientId, taskId));
          }
          await expect(filter.isSuppressed(target)).resolves.toBe(muteAll || muteTask);

          // Повторное включение (снятие отписки и заглушения) восстанавливает доставку.
          store.links.set(recipientId, { mutedAll: false });
          store.muted.delete(muteKey(recipientId, taskId));
          await expect(filter.isSuppressed(target)).resolves.toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
