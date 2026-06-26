import fc from 'fast-check';
import { ClockService } from '../clock';
import { NotificationsService } from './notifications.service';
import { DomainEvent } from './notifications.types';
import { TaskNotificationRouter } from './task-notification-router';

/**
 * **Feature: task-assignment-system, Property 38: Отсутствие уведомлений для исключённых событий**
 *
 * Property 38 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 13.5, 14.3, 15.9, 15.10**:
 *
 * Для любого события изменения состава участников (Req 13.5), изменения профиля
 * Администратором (Req 15.9), удаления учётной записи (Req 15.10), а также
 * изменения или удаления Сообщения (Req 14.3) — соответствующие Уведомления НЕ
 * создаются и НЕ отправляются ни по одному каналу.
 *
 * Тест воспроизводит ПРОИЗВОЛЬНЫЕ последовательности вызовов методов-обработчиков
 * исключённых событий маршрутизатора {@link TaskNotificationRouter} (в любом
 * порядке и любом количестве) и проверяет, что обобщённый сервис формирования
 * Уведомлений {@link NotificationsService.emit} НИ РАЗУ не вызывается. Сервис
 * подменён моком — обращения к реальным БД/очередям отсутствуют.
 */

/** Имена методов-обработчиков исключённых событий маршрутизатора. */
type ExcludedHandler =
  | 'onParticipantsChanged'
  | 'onAdminProfileChanged'
  | 'onAccountDeleted'
  | 'onMessageEditedOrDeleted';

/**
 * Собирает маршрутизатор с моком {@link NotificationsService.emit}. Возвращает
 * сам мок, чтобы можно было утверждать факт отсутствия его вызовов.
 */
function buildHarness(now = new Date('2024-01-01T00:00:00.000Z')): {
  router: TaskNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
} {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;
  const clock = { now: () => now } as unknown as ClockService;
  return { router: new TaskNotificationRouter(notifications, clock), emit };
}

// Произвольная последовательность исключённых событий (любой порядок/количество),
// включая пустую последовательность.
const excludedHandlerArb = fc.constantFrom<ExcludedHandler>(
  'onParticipantsChanged',
  'onAdminProfileChanged',
  'onAccountDeleted',
  'onMessageEditedOrDeleted',
);

const sequenceArb = fc.array(excludedHandlerArb, { minLength: 0, maxLength: 20 });

describe('TaskNotificationRouter — Property 38: отсутствие уведомлений для исключённых событий', () => {
  it('никакая последовательность исключённых событий не формирует Уведомлений (≥100 итераций)', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (handlers) => {
        const { router, emit } = buildHarness();

        for (const handler of handlers) {
          await router[handler]();
        }

        // Ни одно исключённое событие не порождает Уведомления (Req 13.5, 14.3,
        // 15.9, 15.10): обобщённый сервис формирования не вызывается ни разу.
        expect(emit).not.toHaveBeenCalled();
      }),
      { numRuns: 200 },
    );
  });
});
