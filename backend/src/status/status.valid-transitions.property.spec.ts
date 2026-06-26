import fc from 'fast-check';
import { StatusMachine } from './status.machine';
import { Actor, Status, StatusAction } from './status.types';

/**
 * **Feature: task-assignment-system, Property 26: Корректность валидных переходов конечного автомата**
 *
 * **Validates: Requirements 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10**
 *
 * Для любого текущего статуса, актора и допустимого действия (включая
 * авто-переход по сообщению в Чат) конечный автомат возвращает статус строго
 * по таблице переходов:
 * - сообщение Исполнителя в «В работе»/«Ожидает» → «Ожидает» (Req 10.1);
 * - сообщение Менеджера/Администратора в «В работе»/«Ожидает» → «В работе» (Req 10.2);
 * - явные переходы COMPLETE/REOPEN/CANCEL/RETURN/REQUEST_ADMIN/ADMIN_SET/CLEAR_ADMIN
 *   из допустимых статусов с надлежащими правами актора (Req 10.4–10.10).
 *
 * Тест чистый: автомат не имеет внешних зависимостей (без БД).
 */

/**
 * Описание одного валидного сценария: вход для автомата и ожидаемый результат.
 * `kind` различает авто-переход по сообщению и явный переход смены статуса.
 */
type Scenario =
  | { kind: 'chat'; current: Status; sender: Actor; expected: Status }
  | {
      kind: 'transition';
      current: Status;
      action: StatusAction;
      actor: Actor;
      reviewedFlag: boolean;
      expected: Status;
    };

describe('StatusMachine — Property 26: корректность валидных переходов', () => {
  const machine = new StatusMachine();

  // Акторы, обладающие правами Менеджера на ручную смену статуса; отмена
  // отдельно ограничена Администратором.
  const managerial: Actor[] = ['MANAGER', 'ADMIN'];
  // Реактивные статусы, в которых сообщение меняет статус (Req 10.1, 10.2).
  const reactiveStatuses: Status[] = ['IN_PROGRESS', 'WAITING'];

  // --- Генераторы валидных сценариев авто-перехода по сообщению (Req 10.1, 10.2) ---
  const chatScenario: fc.Arbitrary<Scenario> = fc
    .record({
      current: fc.constantFrom(...reactiveStatuses),
      sender: fc.constantFrom<Actor>('EXECUTOR', 'MANAGER', 'ADMIN'),
    })
    .map(({ current, sender }) => ({
      kind: 'chat' as const,
      current,
      sender,
      // Исполнитель → «Ожидает»; Менеджер/Администратор → «В работе».
      expected: sender === 'EXECUTOR' ? 'WAITING' : 'IN_PROGRESS',
    }));

  // Хелпер построения валидного сценария явного перехода с заданным целевым статусом.
  const transitionScenario = (
    action: StatusAction,
    current: Status,
    actor: Actor,
    reviewedFlag: boolean,
    expected: Status,
  ): Scenario => ({ kind: 'transition', current, action, actor, reviewedFlag, expected });

  // COMPLETE (Req 10.4): «В работе»/«Ожидает» → «Выполнено».
  const completeScenario: fc.Arbitrary<Scenario> = fc
    .record({
      current: fc.constantFrom<Status>('IN_PROGRESS', 'WAITING'),
      actor: fc.constantFrom(...managerial),
      reviewedFlag: fc.boolean(),
    })
    .map(({ current, actor, reviewedFlag }) =>
      transitionScenario({ type: 'COMPLETE' }, current, actor, reviewedFlag, 'DONE'),
    );

  // REOPEN (Req 10.5): «Выполнено» → «В работе».
  const reopenScenario: fc.Arbitrary<Scenario> = fc
    .record({ actor: fc.constantFrom(...managerial), reviewedFlag: fc.boolean() })
    .map(({ actor, reviewedFlag }) =>
      transitionScenario({ type: 'REOPEN' }, 'DONE', actor, reviewedFlag, 'IN_PROGRESS'),
    );

  // CANCEL (Req 10.6): «В работе»/«Ожидает»/«Выполнено»/«Требует администратора» → «Отменено».
  const cancelScenario: fc.Arbitrary<Scenario> = fc
    .record({
      current: fc.constantFrom<Status>('IN_PROGRESS', 'WAITING', 'DONE', 'NEEDS_ADMIN'),
      reviewedFlag: fc.boolean(),
    })
    .map(({ current, reviewedFlag }) =>
      transitionScenario({ type: 'CANCEL' }, current, 'ADMIN', reviewedFlag, 'CANCELLED'),
    );

  // RETURN (Req 10.7): «Отменено» → «В работе».
  const returnScenario: fc.Arbitrary<Scenario> = fc
    .record({ actor: fc.constantFrom(...managerial), reviewedFlag: fc.boolean() })
    .map(({ actor, reviewedFlag }) =>
      transitionScenario({ type: 'RETURN' }, 'CANCELLED', actor, reviewedFlag, 'IN_PROGRESS'),
    );

  // REQUEST_ADMIN (Req 10.8): «В работе»/«Ожидает» → «Требует администратора».
  const requestAdminScenario: fc.Arbitrary<Scenario> = fc
    .record({
      current: fc.constantFrom<Status>('IN_PROGRESS', 'WAITING'),
      actor: fc.constantFrom(...managerial),
      reviewedFlag: fc.boolean(),
    })
    .map(({ current, actor, reviewedFlag }) =>
      transitionScenario({ type: 'REQUEST_ADMIN' }, current, actor, reviewedFlag, 'NEEDS_ADMIN'),
    );

  // ADMIN_SET (Req 10.9): из «Требует администратора» Администратор выбирает целевой статус.
  const adminSetScenario: fc.Arbitrary<Scenario> = fc
    .record({
      target: fc.constantFrom<Status>('IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED'),
      reviewedFlag: fc.boolean(),
    })
    .map(({ target, reviewedFlag }) =>
      transitionScenario(
        { type: 'ADMIN_SET', target },
        'NEEDS_ADMIN',
        'ADMIN',
        reviewedFlag,
        target,
      ),
    );

  // CLEAR_ADMIN (Req 10.10): Менеджер/Администратор снимает «Требует администратора»
  // при неустановленном признаке проверки → «В работе».
  const clearAdminScenario: fc.Arbitrary<Scenario> = fc
    .record({ actor: fc.constantFrom(...managerial) })
    .map(({ actor }) =>
      transitionScenario({ type: 'CLEAR_ADMIN' }, 'NEEDS_ADMIN', actor, false, 'IN_PROGRESS'),
    );

  const anyValidScenario: fc.Arbitrary<Scenario> = fc.oneof(
    chatScenario,
    completeScenario,
    reopenScenario,
    cancelScenario,
    returnScenario,
    requestAdminScenario,
    adminSetScenario,
    clearAdminScenario,
  );

  it('каждый валидный переход даёт целевой статус по таблице переходов', () => {
    fc.assert(
      fc.property(anyValidScenario, (scenario) => {
        if (scenario.kind === 'chat') {
          // Авто-переход по сообщению (Req 10.1, 10.2).
          expect(machine.onChatMessage(scenario.current, scenario.sender)).toBe(scenario.expected);
          return;
        }

        // Явный переход (Req 10.4–10.10): должен вернуть статус, а не ошибку.
        const result = machine.transition(
          scenario.current,
          scenario.action,
          scenario.actor,
          scenario.reviewedFlag,
        );
        expect(result).toEqual({ status: scenario.expected });
      }),
      { numRuns: 300 },
    );
  });
});
