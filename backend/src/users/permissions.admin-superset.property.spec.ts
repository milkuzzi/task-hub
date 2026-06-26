import fc from 'fast-check';
import { Role } from '@prisma/client';
import { hasAdminPrivileges, hasManagerPrivileges, roleAtLeast } from './permissions';

/**
 * **Feature: task-assignment-system, Property 5: Администратор обладает надмножеством прав менеджера**
 *
 * Property 5 (см. design.md «Correctness Properties») — **Validates: Requirements 2.3**:
 *
 * Для любого действия, разрешённого Менеджеру в заданном контексте, это же
 * действие разрешено и Администратору.
 *
 * Источником истины о полномочиях служат чистые помощники из
 * {@link ./permissions}: {@link hasManagerPrivileges}, {@link hasAdminPrivileges}
 * и {@link roleAtLeast}. Тест реализует ровно одно свойство — надмножество прав —
 * проверяя его сразу на нескольких семействах «действий» (моделей проверки прав),
 * которые встречаются в прикладных сервисах (Users, Tasks, Chat, Audit). Чистая
 * проверка, без БД и моков. Минимум 100 итераций fast-check (здесь — 300).
 */
describe('Property 5: Администратор обладает надмножеством прав менеджера (Req 2.3)', () => {
  /** Все роли системы (Req 2.1). */
  const anyRole = fc.constantFrom(Role.EXECUTOR, Role.MANAGER, Role.ADMIN);

  /**
   * «Действие в заданном контексте» моделируется как предикат разрешения
   * `allowed(role): boolean`, выраженный исключительно через помощники прав —
   * единый источник истины о полномочиях. Генерируем разные семейства действий,
   * чтобы свойство проверялось широко:
   *  - действие с минимально требуемой ролью `required` (проверка roleAtLeast);
   *  - действие, требующее привилегий менеджера (hasManagerPrivileges);
   *  - действие, требующее привилегий администратора (hasAdminPrivileges).
   */
  const action: fc.Arbitrary<(role: Role) => boolean> = fc.oneof(
    anyRole.map((required) => (role: Role) => roleAtLeast(role, required)),
    fc.constant((role: Role) => hasManagerPrivileges(role)),
    fc.constant((role: Role) => hasAdminPrivileges(role)),
  );

  it('любое действие, разрешённое менеджеру, разрешено и администратору', () => {
    fc.assert(
      fc.property(action, (allowed) => {
        // Ключевая импликация Req 2.3: разрешено Менеджеру ⟹ разрешено Администратору.
        if (allowed(Role.MANAGER)) {
          expect(allowed(Role.ADMIN)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
