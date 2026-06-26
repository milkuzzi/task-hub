import fc from 'fast-check';
import { NotificationType } from '@prisma/client';
import { ClockService } from '../clock';
import { NotificationsService } from './notifications.service';
import { DomainEvent } from './notifications.types';
import { TaskNotificationRouter } from './task-notification-router';

/**
 * **Feature: task-assignment-system, Property 43: Уведомления о смене роли менеджера**
 *
 * Property 43 (см. design.md «Correctness Properties») — **Validates: Requirements 15.5, 15.6**:
 *
 * Для любого события назначения ИЛИ снятия роли Менеджера метод
 * {@link TaskNotificationRouter.notifyManagerRoleChanged} формирует РОВНО одно
 * Уведомление типа {@link NotificationType.MANAGER_ROLE_CHANGED} затронутому
 * Пользователю (он — единственный получатель) с корректной полезной нагрузкой,
 * содержащей признак `assigned` (true — роль назначена, false — снята).
 * Уведомление адресуется на сайт и через Бот MAX (каналы по умолчанию —
 * `channels` не переопределяется), что покрывает Req 15.5 (сайт) и 15.6 (MAX).
 *
 * Тест приводит в действие маршрутизатор с моками {@link NotificationsService}
 * (перехватывает вызовы `emit`) и {@link ClockService} (детерминированное
 * время для ключа идемпотентности) — без обращения к реальным БД/очередям.
 */

/** Создаёт маршрутизатор с мок-сервисом уведомлений и фиксированными часами. */
function createRouter(now: Date): {
  router: TaskNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
} {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;
  const clock = { now: () => now } as unknown as ClockService;
  return { router: new TaskNotificationRouter(notifications, clock), emit };
}

// Идентификатор затронутого Пользователя — непустая строка произвольного вида.
const userIdArb = fc.string({ minLength: 1, maxLength: 40 });
// Произвольный момент наступления события (для ключа идемпотентности).
const nowArb = fc.date({
  min: new Date('2000-01-01T00:00:00.000Z'),
  max: new Date('2100-01-01T00:00:00.000Z'),
});

describe('TaskNotificationRouter.notifyManagerRoleChanged — Property 43: уведомления о смене роли менеджера', () => {
  it('формирует ровно одно уведомление MANAGER_ROLE_CHANGED затронутому пользователю с корректным признаком assigned (≥100 итераций)', async () => {
    await fc.assert(
      fc.asyncProperty(userIdArb, fc.boolean(), nowArb, async (userId, assigned, now) => {
        const { router, emit } = createRouter(now);

        await router.notifyManagerRoleChanged(userId, assigned);

        // 1) Ровно одно событие уведомления (Req 15.5, 15.6).
        expect(emit).toHaveBeenCalledTimes(1);

        const event = emit.mock.calls[0]![0];

        // 2) Тип — смена роли Менеджера.
        expect(event.type).toBe(NotificationType.MANAGER_ROLE_CHANGED);

        // 3) Единственный получатель — затронутый Пользователь.
        expect(event.recipientIds).toEqual([userId]);

        // 4) Полезная нагрузка несёт корректный признак assigned.
        expect(event.payload).toEqual({ assigned });

        // 5) Событие не привязано к Задаче; каналы по умолчанию (сайт + MAX),
        //    то есть явно не переопределяются (Req 15.5 — сайт, 15.6 — MAX).
        expect(event.taskId).toBeNull();
        expect(event.channels).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});
