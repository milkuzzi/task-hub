import fc from 'fast-check';
import { AssignmentKind, NotificationType, TaskStatus } from '@prisma/client';
import { ClockService } from '../clock';
import { NotificationsService } from './notifications.service';
import { DomainEvent, NotificationChannel } from './notifications.types';
import { NOTIFIABLE_TASK_FIELDS, TaskNotificationRouter } from './task-notification-router';

/**
 * **Feature: task-assignment-system, Property 37: События задачи порождают уведомления нужным получателям**
 *
 * Property 37 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 13.2, 13.3, 13.4, 13.6, 13.11**:
 *
 * Для любого события из набора {назначение, снятие, изменение
 * Названия/Описания/Дедлайна, изменение Статуса, переоткрытие/отмена/возврат}
 * {@link TaskNotificationRouter} формирует Уведомление (сайт + MAX) РОВНО для
 * нужных получателей с корректным {@link NotificationType}:
 *
 * - назначение/снятие (Req 13.2, 13.3) — затронутому Пользователю;
 * - изменение Названия/Описания/Дедлайна (Req 13.4), смена Статуса (Req 13.6),
 *   переоткрытие/отмена/возврат (Req 13.11) — объединению Исполнителей и
 *   Менеджеров без повторов;
 * - Уведомление о смене Статуса несёт новый Статус в полезной нагрузке (Req 13.6).
 *
 * {@link NotificationsService} подменяется моком, собирающим сформированные
 * {@link DomainEvent}; {@link ClockService} — моком фиксированного времени.
 * Обращений к реальной БД/Redis нет.
 */

/** Небольшой пул идентификаторов — гарантирует пересечения Исполнителей и Менеджеров. */
const userArb = fc.constantFrom('u1', 'u2', 'u3', 'u4', 'u5', 'u6');
const idArrayArb = fc.array(userArb, { maxLength: 6 });
const taskIdArb = fc.constantFrom('task-1', 'task-2', 'task-3');

/** Произвольный набор изменённых параметров Задачи (включая пустой — он не порождает Уведомления). */
const changedFieldsArb = fc.subarray([...NOTIFIABLE_TASK_FIELDS]);

type Scenario =
  | { tag: 'assigned'; taskId: string; userId: string; kind: AssignmentKind }
  | { tag: 'unassigned'; taskId: string; userId: string }
  | {
      tag: 'fields';
      taskId: string;
      changedFields: string[];
      executorIds: string[];
      managerIds: string[];
    }
  | {
      tag: 'status';
      taskId: string;
      newStatus: TaskStatus;
      executorIds: string[];
      managerIds: string[];
    }
  | {
      tag: 'reopened' | 'cancelled' | 'returned';
      taskId: string;
      executorIds: string[];
      managerIds: string[];
    };

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
  fc.record({
    tag: fc.constant('assigned' as const),
    taskId: taskIdArb,
    userId: userArb,
    kind: fc.constantFrom(AssignmentKind.EXECUTOR, AssignmentKind.MANAGER),
  }),
  fc.record({
    tag: fc.constant('unassigned' as const),
    taskId: taskIdArb,
    userId: userArb,
  }),
  fc.record({
    tag: fc.constant('fields' as const),
    taskId: taskIdArb,
    changedFields: changedFieldsArb,
    executorIds: idArrayArb,
    managerIds: idArrayArb,
  }),
  fc.record({
    tag: fc.constant('status' as const),
    taskId: taskIdArb,
    newStatus: fc.constantFrom(...(Object.values(TaskStatus) as TaskStatus[])),
    executorIds: idArrayArb,
    managerIds: idArrayArb,
  }),
  fc.record({
    tag: fc.constantFrom('reopened' as const, 'cancelled' as const, 'returned' as const),
    taskId: taskIdArb,
    executorIds: idArrayArb,
    managerIds: idArrayArb,
  }),
);

/** Тип Уведомления, ожидаемый для каждого события жизненного цикла (Req 13.11). */
const LIFECYCLE_TYPE: Record<'reopened' | 'cancelled' | 'returned', NotificationType> = {
  reopened: NotificationType.TASK_REOPENED,
  cancelled: NotificationType.TASK_CANCELLED,
  returned: NotificationType.TASK_RETURNED,
};

/** Ожидаемые получатели и тип Уведомления для сценария (`null` тип — Уведомление не формируется). */
function expectationFor(scenario: Scenario): {
  recipients: string[];
  type: NotificationType | null;
} {
  switch (scenario.tag) {
    case 'assigned':
      return { recipients: [scenario.userId], type: NotificationType.TASK_ASSIGNED };
    case 'unassigned':
      return { recipients: [scenario.userId], type: NotificationType.TASK_UNASSIGNED };
    case 'fields': {
      const recipients = [...new Set([...scenario.executorIds, ...scenario.managerIds])];
      // Req 13.4: без получателей или без изменений Уведомление не формируется.
      const emits = recipients.length > 0 && scenario.changedFields.length > 0;
      return { recipients, type: emits ? NotificationType.TASK_FIELD_CHANGED : null };
    }
    case 'status': {
      const recipients = [...new Set([...scenario.executorIds, ...scenario.managerIds])];
      return {
        recipients,
        type: recipients.length > 0 ? NotificationType.TASK_STATUS_CHANGED : null,
      };
    }
    case 'reopened':
    case 'cancelled':
    case 'returned': {
      const recipients = [...new Set([...scenario.executorIds, ...scenario.managerIds])];
      return { recipients, type: recipients.length > 0 ? LIFECYCLE_TYPE[scenario.tag] : null };
    }
  }
}

/** Выполняет сценарий против маршрутизатора. */
async function runScenario(router: TaskNotificationRouter, scenario: Scenario): Promise<void> {
  switch (scenario.tag) {
    case 'assigned':
      return router.notifyAssigned(scenario.taskId, scenario.userId, scenario.kind);
    case 'unassigned':
      return router.notifyUnassigned(scenario.taskId, scenario.userId);
    case 'fields':
      return router.notifyFieldsChanged(
        scenario.taskId,
        scenario.changedFields,
        scenario.executorIds,
        scenario.managerIds,
      );
    case 'status':
      return router.notifyStatusChanged(
        scenario.taskId,
        scenario.newStatus,
        scenario.executorIds,
        scenario.managerIds,
      );
    case 'reopened':
      return router.notifyReopened(scenario.taskId, scenario.executorIds, scenario.managerIds);
    case 'cancelled':
      return router.notifyCancelled(scenario.taskId, scenario.executorIds, scenario.managerIds);
    case 'returned':
      return router.notifyReturned(scenario.taskId, scenario.executorIds, scenario.managerIds);
  }
}

describe('TaskNotificationRouter — Property 37: события задачи порождают уведомления нужным получателям', () => {
  it('маршрутизирует каждое событие задачи ровно нужным получателям с верным типом; статус несёт новый Статус (≥100 итераций)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const emitted: DomainEvent[] = [];
        const emit = jest.fn<Promise<void>, [DomainEvent]>((event) => {
          emitted.push(event);
          return Promise.resolve();
        });
        const notifications = { emit } as unknown as NotificationsService;
        const clock = {
          now: () => new Date('2024-01-01T00:00:00.000Z'),
        } as unknown as ClockService;
        const router = new TaskNotificationRouter(notifications, clock);

        await runScenario(router, scenario);

        const { recipients, type } = expectationFor(scenario);

        if (type === null) {
          // Событие без получателей (или без изменений параметров) Уведомления не порождает.
          expect(emitted).toHaveLength(0);
          return;
        }

        // 1) Ровно одно событие на наступление.
        expect(emitted).toHaveLength(1);
        const event = emitted[0]!;

        // 2) Корректный тип Уведомления для события (Req 13.2, 13.3, 13.4, 13.6, 13.11).
        expect(event.type).toBe(type);

        // 3) Уведомление привязано к нужной Задаче.
        expect(event.taskId).toBe(scenario.taskId);

        // 4) Получатели РОВНО соответствуют ожидаемым, без повторов.
        const actualRecipients = [...event.recipientIds];
        expect(new Set(actualRecipients).size).toBe(actualRecipients.length);
        expect([...new Set(actualRecipients)].sort()).toEqual([...new Set(recipients)].sort());

        // 5) Доставка по умолчанию — сайт + MAX (channels не сужается маршрутизатором).
        if (event.channels !== undefined) {
          expect([...event.channels].sort()).toEqual(
            [NotificationChannel.Site, NotificationChannel.Max].sort(),
          );
        }

        // 6) Уведомление о смене Статуса несёт новый Статус (Req 13.6).
        if (scenario.tag === 'status') {
          expect(event.payload).toEqual({ status: scenario.newStatus });
        }
      }),
      { numRuns: 200 },
    );
  });
});
