import fc from 'fast-check';
import { Role } from '@prisma/client';
import { hasAdminPrivileges, hasManagerPrivileges, roleAtLeast } from './permissions';

/**
 * Preservation-тест дефекта 6 (задача 17).
 *
 * **Property 12: Preservation** — Серверное использование роли сохраняется.
 *
 * Формулировка (Req 3.6): _For any_ роли Пользователя сервер ДОЛЖЕН продолжать
 * использовать роль для контроля доступа без изменений. Исправление дефекта 6
 * (задача 18) убирает метку «Роль: …» из `ProfilePage` и колонку роли из
 * `AdminUsersPage` — это изменение касается ТОЛЬКО фронтенд-представления и не
 * должно затрагивать серверную авторизацию по роли.
 *
 * Методология «сначала наблюдение»: тест фиксирует БАЗОВОЕ поведение серверного
 * контроля доступа на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПРОХОДИТЬ. Задача 18.3
 * перезапустит этот же тест и подтвердит отсутствие регрессий после удаления
 * метки роли из интерфейса.
 *
 * Единый источник истины о полномочиях — чистые помощники из {@link ./permissions}
 * (`hasManagerPrivileges`, `hasAdminPrivileges`, `roleAtLeast`), которые
 * используются прикладными сервисами (Statistics, Tasks, Audit, Chat,
 * Attachments, Notifications). Тест проверяет поведение этих помощников и
 * репрезентативные серверные решения о доступе по всем ролям
 * EXECUTOR/MANAGER/ADMIN.
 */

const ROLES: readonly Role[] = [Role.EXECUTOR, Role.MANAGER, Role.ADMIN];
const roleArb = fc.constantFrom(...ROLES);

/** Числовой уровень роли — независимая эталонная модель порядка привилегий. */
const PRIVILEGE_LEVEL: Record<Role, number> = {
  [Role.EXECUTOR]: 0,
  [Role.MANAGER]: 1,
  [Role.ADMIN]: 2,
};

describe('Дефект 6 — preservation серверного контроля доступа по роли (Property 12)', () => {
  describe('Чистые помощники прав сохраняют поведение по ролям (Req 3.6)', () => {
    it('hasManagerPrivileges истинно только для MANAGER и ADMIN', () => {
      fc.assert(
        fc.property(roleArb, (role) => {
          const expected = role === Role.MANAGER || role === Role.ADMIN;
          expect(hasManagerPrivileges(role)).toBe(expected);
        }),
      );
    });

    it('hasAdminPrivileges истинно только для ADMIN', () => {
      fc.assert(
        fc.property(roleArb, (role) => {
          expect(hasAdminPrivileges(role)).toBe(role === Role.ADMIN);
        }),
      );
    });

    it('roleAtLeast сохраняет порядок привилегий EXECUTOR < MANAGER < ADMIN', () => {
      fc.assert(
        fc.property(roleArb, roleArb, (actor, required) => {
          expect(roleAtLeast(actor, required)).toBe(
            PRIVILEGE_LEVEL[actor] >= PRIVILEGE_LEVEL[required],
          );
        }),
      );
    });

    it('права администратора — надмножество прав менеджера (admin ⊇ manager)', () => {
      fc.assert(
        fc.property(roleArb, (role) => {
          // Любое действие, разрешённое менеджеру, разрешено и администратору.
          if (hasManagerPrivileges(role)) {
            expect(hasManagerPrivileges(Role.ADMIN)).toBe(true);
          }
          if (hasAdminPrivileges(role)) {
            expect(hasManagerPrivileges(role)).toBe(true);
          }
        }),
      );
    });
  });

  describe('Репрезентативные серверные решения о доступе по роли (Req 3.6)', () => {
    it('просмотр статистики разрешён только Администратору', () => {
      // StatisticsService.compute: !hasAdminPrivileges(actor.role) → AccessDenied.
      fc.assert(
        fc.property(roleArb, (role) => {
          const allowed = hasAdminPrivileges(role);
          expect(allowed).toBe(role === Role.ADMIN);
        }),
      );
    });

    it('создание Задачи доступно только Менеджеру и Администратору', () => {
      // TasksService.create: !hasManagerPrivileges(actor.role) → AccessDenied.
      fc.assert(
        fc.property(roleArb, (role) => {
          const allowed = hasManagerPrivileges(role);
          expect(allowed).toBe(role === Role.MANAGER || role === Role.ADMIN);
        }),
      );
    });

    it('Администратор видит все Задачи; прочие роли — ограниченную видимость', () => {
      // TasksService/search buildVisibilityWhere: hasAdminPrivileges(role) → {} (все).
      fc.assert(
        fc.property(roleArb, (role) => {
          const seesEverything = hasAdminPrivileges(role);
          expect(seesEverything).toBe(role === Role.ADMIN);
          // EXECUTOR и MANAGER не получают неограниченный доступ.
          if (role !== Role.ADMIN) {
            expect(seesEverything).toBe(false);
          }
        }),
      );
    });

    it('Уведомления о Сообщении не адресуются Администраторам', () => {
      // ChatNotificationRouter: получатели-Администраторы исключаются (Req 14.2).
      fc.assert(
        fc.property(roleArb, (role) => {
          const excludedAsRecipient = hasAdminPrivileges(role);
          expect(excludedAsRecipient).toBe(role === Role.ADMIN);
        }),
      );
    });
  });
});
