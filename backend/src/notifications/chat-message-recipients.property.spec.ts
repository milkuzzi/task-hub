import fc from 'fast-check';
import { NotificationType, Role, User } from '@prisma/client';
import { UserRepository } from '../repositories';
import { NotificationDeliveryService } from './delivery/notification-delivery.service';
import { ChatNotificationRouter } from './chat-notification-router';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';
import { DomainEvent } from './notifications.types';

/**
 * **Feature: task-assignment-system, Property 40: Получатели уведомления о новом сообщении чата**
 *
 * Property 40 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 14.1, 14.2**:
 *
 * Для любого нового Сообщения Чата Уведомление о нём
 * ({@link NotificationType.CHAT_MESSAGE}) формируется ровно для Участников чата
 * за исключением автора Сообщения (Req 14.1) и любого Администратора (Req 14.2).
 * Иными словами, состав получателей равен
 * `(Исполнители ∪ Менеджеры Задачи) − автор − Администраторы`.
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Маршрутизатор
 * {@link ChatNotificationRouter.notifyNewMessage} приводится в действие с
 * подменённым {@link NotificationsService} (захватывается состав получателей
 * испущенного события) и подменённым {@link UserRepository.findManyActiveByIds}
 * (возвращает роли, по которым определяются Администраторы). Живой БД нет.
 */

/** Все роли системы — используются для генерации профилей участников. */
const ROLES: readonly Role[] = [Role.EXECUTOR, Role.MANAGER, Role.ADMIN];

/**
 * Генерируемый профиль кандидата в получатели: идентификатор, активная роль и
 * принадлежность к множествам Исполнителей/Менеджеров Задачи. Также может быть
 * автором Сообщения.
 */
interface Participant {
  id: string;
  role: Role;
  isExecutor: boolean;
  isManager: boolean;
}

/**
 * Создаёт маршрутизатор с подменёнными зависимостями.
 *
 * @param activeUsers Активные Пользователи (с ролями), возвращаемые
 *   `findManyActiveByIds` для запрошенных идентификаторов.
 * @returns Маршрутизатор и mock `emit` для захвата испущенного события.
 */
function createRouter(activeUsers: readonly User[]): {
  router: ChatNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
} {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;

  const repository = {} as unknown as NotificationRepository;
  const delivery = {} as unknown as NotificationDeliveryService;

  // Возвращаем только запрошенные активные учётные записи (с ролями), как это
  // делает реальный репозиторий при определении Администраторов (Req 14.2).
  const byId = new Map(activeUsers.map((u) => [u.id, u]));
  const findManyActiveByIds = jest
    .fn<Promise<User[]>, [readonly string[]]>()
    .mockImplementation((ids) =>
      Promise.resolve(ids.map((id) => byId.get(id)).filter((u): u is User => u !== undefined)),
    );
  const users = { findManyActiveByIds } as unknown as UserRepository;

  return {
    router: new ChatNotificationRouter(notifications, repository, delivery, users),
    emit,
  };
}

describe('Property 40: Получатели уведомления о новом сообщении чата', () => {
  it('получатели = (Исполнители ∪ Менеджеры) − автор − Администраторы (Req 14.1, 14.2)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Уникальные идентификаторы участников + индекс автора среди них.
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 })
          .chain((ids) =>
            fc.record({
              ids: fc.constant(ids),
              participants: fc.tuple(
                ...ids.map((id) =>
                  fc.record({
                    id: fc.constant(id),
                    role: fc.constantFrom(...ROLES),
                    // Каждый кандидат назначен Исполнителем и/или Менеджером
                    // (как минимум одним), иначе он не участник чата по событию.
                    membership: fc.constantFrom('executor', 'manager', 'both'),
                  }),
                ),
              ),
              authorIndex: fc.integer({ min: 0, max: ids.length - 1 }),
            }),
          ),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        async (gen, taskId, messageId) => {
          const participants: Participant[] = gen.participants.map((p) => ({
            id: p.id,
            role: p.role,
            isExecutor: p.membership === 'executor' || p.membership === 'both',
            isManager: p.membership === 'manager' || p.membership === 'both',
          }));

          const authorId = participants[gen.authorIndex]!.id;
          const executorIds = participants.filter((p) => p.isExecutor).map((p) => p.id);
          const managerIds = participants.filter((p) => p.isManager).map((p) => p.id);

          // Активные учётные записи (с ролями) для запрошенных кандидатов.
          const activeUsers: User[] = participants.map((p) => ({ id: p.id, role: p.role }) as User);

          const { router, emit } = createRouter(activeUsers);

          await router.notifyNewMessage({ taskId, messageId, authorId, executorIds, managerIds });

          // Ожидаемый состав: (Исполнители ∪ Менеджеры) − автор − Администраторы.
          const expected = new Set(
            participants
              .filter((p) => (p.isExecutor || p.isManager) && p.id !== authorId)
              .filter((p) => p.role !== Role.ADMIN)
              .map((p) => p.id),
          );

          if (expected.size === 0) {
            // Получателей нет — Уведомление не формируется (Req 14.1, 14.2).
            expect(emit).not.toHaveBeenCalled();
            return;
          }

          expect(emit).toHaveBeenCalledTimes(1);
          const event = emit.mock.calls[0]![0];
          expect(event.type).toBe(NotificationType.CHAT_MESSAGE);
          expect(event.isMessageNotification).toBe(true);

          const actual = new Set(event.recipientIds);
          // Множества совпадают: без дублей, без автора, без Администраторов.
          expect(actual).toEqual(expected);
          expect(event.recipientIds.length).toBe(expected.size);
        },
      ),
      { numRuns: 200 },
    );
  });
});
