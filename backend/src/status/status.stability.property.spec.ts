import fc from 'fast-check';
import { StatusMachine } from './status.machine';
import { Actor, Status, StatusAction, TransitionResult } from './status.types';

/**
 * **Feature: task-assignment-system, Property 27: Стабильность статуса при недопустимых, неавторизованных и нейтральных событиях**
 *
 * Property 27 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 10.3, 10.11, 10.12, 10.14, 10.15**:
 *
 * Для любого текущего Статуса Статус остаётся неизменным, если:
 *  - Сообщение приходит в Статусе «Выполнено»/«Отменено»/«Требует администратора»
 *    (Req 10.3);
 *  - наступает Дедлайн (нейтральное событие, Req 10.11);
 *  - изменяются параметры Задачи (нейтральное событие, Req 10.12);
 *  - Пользователь без прав пытается сменить Статус — возвращается `NO_PERMISSION`
 *    (Req 10.14);
 *  - запрашивается переход, недопустимый из текущего Статуса — возвращается
 *    `INVALID_TRANSITION` (Req 10.15).
 *
 * Во всех перечисленных случаях наблюдаемый Статус Задачи сохраняется, а в
 * случаях нарушения прав/недопустимого перехода возвращается соответствующая
 * ошибка. Тест чистый (без БД и моков): автомат {@link StatusMachine}
 * детерминирован. Реализовано ровно одно свойство; ≥100 итераций fast-check.
 */
describe('Property 27: Стабильность статуса при недопустимых, неавторизованных и нейтральных событиях (Req 10.3, 10.11, 10.12, 10.14, 10.15)', () => {
  const machine = new StatusMachine();

  const ALL_STATUSES: Status[] = ['IN_PROGRESS', 'WAITING', 'DONE', 'NEEDS_ADMIN', 'CANCELLED'];

  /** Статусы, в которых Сообщение в Чат не меняет Статус (Req 10.3). */
  const CHAT_STABLE_STATUSES: Status[] = ['DONE', 'CANCELLED', 'NEEDS_ADMIN'];

  /** Целевые Статусы, выбираемые Администратором из «Требует администратора» (Req 10.9). */
  const ADMIN_SELECTABLE: ReadonlySet<Status> = new Set<Status>([
    'IN_PROGRESS',
    'WAITING',
    'DONE',
    'CANCELLED',
  ]);

  const statusArb: fc.Arbitrary<Status> = fc.constantFrom(...ALL_STATUSES);
  const actorArb: fc.Arbitrary<Actor> = fc.constantFrom<Actor>('EXECUTOR', 'MANAGER', 'ADMIN');
  const actionArb: fc.Arbitrary<StatusAction> = fc.oneof(
    fc.constant<StatusAction>({ type: 'COMPLETE' }),
    fc.constant<StatusAction>({ type: 'REOPEN' }),
    fc.constant<StatusAction>({ type: 'CANCEL' }),
    fc.constant<StatusAction>({ type: 'RETURN' }),
    fc.constant<StatusAction>({ type: 'REQUEST_ADMIN' }),
    fc.constant<StatusAction>({ type: 'CLEAR_ADMIN' }),
    statusArb.map<StatusAction>((target) => ({ type: 'ADMIN_SET', target })),
  );

  /**
   * Независимый эталон правил из требований (Req 10.4–10.10): целевой Статус для
   * действия, считая, что право на действие уже есть, либо `null`, если переход
   * недопустим из текущего Статуса. Используется только для классификации
   * сценариев в генераторе, а не как реализация автомата.
   */
  function referenceTarget(
    current: Status,
    action: StatusAction,
    reviewedFlag: boolean,
  ): Status | null {
    switch (action.type) {
      case 'COMPLETE':
        return current === 'IN_PROGRESS' || current === 'WAITING' ? 'DONE' : null;
      case 'REOPEN':
        return current === 'DONE' ? 'IN_PROGRESS' : null;
      case 'CANCEL':
        return current === 'IN_PROGRESS' ||
          current === 'WAITING' ||
          current === 'DONE' ||
          current === 'NEEDS_ADMIN'
          ? 'CANCELLED'
          : null;
      case 'RETURN':
        return current === 'CANCELLED' ? 'IN_PROGRESS' : null;
      case 'REQUEST_ADMIN':
        return current === 'IN_PROGRESS' || current === 'WAITING' ? 'NEEDS_ADMIN' : null;
      case 'ADMIN_SET':
        return current === 'NEEDS_ADMIN' && ADMIN_SELECTABLE.has(action.target)
          ? action.target
          : null;
      case 'CLEAR_ADMIN':
        return current === 'NEEDS_ADMIN' && !reviewedFlag ? 'IN_PROGRESS' : null;
    }
  }

  /** Действующее лицо обладает правом на действие (эталон Req 10.14, 10.9). */
  function isAuthorized(action: StatusAction, actor: Actor): boolean {
    if (actor === 'EXECUTOR') {
      return false;
    }
    if (action.type === 'ADMIN_SET' || action.type === 'CANCEL') {
      return actor === 'ADMIN';
    }
    return true; // MANAGER или ADMIN для прочих действий
  }

  /**
   * Сценарий стабильности — одно из событий, которое НЕ должно менять Статус.
   * Каждый вариант несёт текущий Статус и достаточно данных, чтобы вызвать
   * соответствующий метод автомата и проверить инвариант.
   */
  type Scenario =
    | { kind: 'chatStable'; current: Status; sender: Actor } // Req 10.3
    | { kind: 'neutral'; current: Status } // Req 10.11, 10.12
    | {
        kind: 'noPermission'; // Req 10.14
        current: Status;
        action: StatusAction;
        actor: Actor;
        reviewedFlag: boolean;
      }
    | {
        kind: 'invalidTransition'; // Req 10.15
        current: Status;
        action: StatusAction;
        actor: Actor;
        reviewedFlag: boolean;
      };

  // Сообщение в стабильном Статусе (Req 10.3): любой отправитель.
  const chatStableArb: fc.Arbitrary<Scenario> = fc
    .record({ current: fc.constantFrom(...CHAT_STABLE_STATUSES), sender: actorArb })
    .map((r) => ({ kind: 'chatStable', ...r }));

  // Нейтральное событие (Req 10.11 — Дедлайн, Req 10.12 — изменение параметров).
  const neutralArb: fc.Arbitrary<Scenario> = statusArb.map((current) => ({
    kind: 'neutral',
    current,
  }));

  // Неавторизованная попытка смены Статуса (Req 10.14): нет права на действие.
  const noPermissionArb: fc.Arbitrary<Scenario> = fc
    .record({
      current: statusArb,
      action: actionArb,
      actor: actorArb,
      reviewedFlag: fc.boolean(),
    })
    .filter((r) => !isAuthorized(r.action, r.actor))
    .map((r) => ({ kind: 'noPermission', ...r }));

  // Недопустимый из текущего Статуса переход у действующего лица С правом (Req 10.15).
  const invalidTransitionArb: fc.Arbitrary<Scenario> = fc
    .record({
      current: statusArb,
      action: actionArb,
      actor: actorArb,
      reviewedFlag: fc.boolean(),
    })
    .filter(
      (r) =>
        isAuthorized(r.action, r.actor) &&
        referenceTarget(r.current, r.action, r.reviewedFlag) === null,
    )
    .map((r) => ({ kind: 'invalidTransition', ...r }));

  const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
    chatStableArb,
    neutralArb,
    noPermissionArb,
    invalidTransitionArb,
  );

  it('недопустимые, неавторизованные и нейтральные события сохраняют текущий Статус', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        switch (scenario.kind) {
          case 'chatStable': {
            // Req 10.3: Сообщение в «Выполнено»/«Отменено»/«Требует администратора»
            // не меняет Статус для любого отправителя.
            expect(machine.onChatMessage(scenario.current, scenario.sender)).toBe(scenario.current);
            break;
          }
          case 'neutral': {
            // Req 10.11, 10.12: нейтральное событие сохраняет Статус.
            expect(machine.onNeutralEvent(scenario.current)).toBe(scenario.current);
            break;
          }
          case 'noPermission': {
            // Req 10.14: отказ NO_PERMISSION, Статус не возвращается (сохраняется).
            const result: TransitionResult = machine.transition(
              scenario.current,
              scenario.action,
              scenario.actor,
              scenario.reviewedFlag,
            );
            expect(result).toEqual({ error: 'NO_PERMISSION' });
            expect('status' in result).toBe(false);
            break;
          }
          case 'invalidTransition': {
            // Req 10.15: отказ INVALID_TRANSITION, Статус не возвращается (сохраняется).
            const result: TransitionResult = machine.transition(
              scenario.current,
              scenario.action,
              scenario.actor,
              scenario.reviewedFlag,
            );
            expect(result).toEqual({ error: 'INVALID_TRANSITION' });
            expect('status' in result).toBe(false);
            break;
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
