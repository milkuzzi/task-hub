import { Role } from '@prisma/client';
import { hasAdminPrivileges, hasManagerPrivileges, roleAtLeast } from './permissions';

/**
 * Модульные тесты модели прав (Req 2.3): администратор обладает надмножеством
 * прав менеджера.
 */
describe('permissions (Req 2.3)', () => {
  describe('hasManagerPrivileges', () => {
    it('истинно для администратора и менеджера, ложно для исполнителя', () => {
      expect(hasManagerPrivileges(Role.ADMIN)).toBe(true);
      expect(hasManagerPrivileges(Role.MANAGER)).toBe(true);
      expect(hasManagerPrivileges(Role.EXECUTOR)).toBe(false);
    });
  });

  describe('hasAdminPrivileges', () => {
    it('истинно только для администратора', () => {
      expect(hasAdminPrivileges(Role.ADMIN)).toBe(true);
      expect(hasAdminPrivileges(Role.MANAGER)).toBe(false);
      expect(hasAdminPrivileges(Role.EXECUTOR)).toBe(false);
    });
  });

  describe('roleAtLeast — администратор ⊇ менеджер', () => {
    it('любое действие, разрешённое менеджеру, разрешено и администратору', () => {
      // Для всякого требования менеджера администратор также проходит проверку.
      expect(roleAtLeast(Role.MANAGER, Role.MANAGER)).toBe(true);
      expect(roleAtLeast(Role.ADMIN, Role.MANAGER)).toBe(true);
    });

    it('исполнитель не обладает правами менеджера', () => {
      expect(roleAtLeast(Role.EXECUTOR, Role.MANAGER)).toBe(false);
    });

    it('администратор обладает правами всех нижестоящих ролей', () => {
      expect(roleAtLeast(Role.ADMIN, Role.EXECUTOR)).toBe(true);
      expect(roleAtLeast(Role.ADMIN, Role.ADMIN)).toBe(true);
    });
  });
});
