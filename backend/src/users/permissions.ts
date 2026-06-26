import { Role } from '@prisma/client';

/**
 * Модель прав ролей (Req 2.3).
 *
 * Ключевой инвариант: множество прав Администратора является надмножеством прав
 * Менеджера — всё, что разрешено Менеджеру, разрешено и Администратору. Эти
 * чистые функции инкапсулируют проверку привилегий и используются прикладными
 * сервисами (Users, Tasks, Chat, Audit) как единый источник истины о
 * полномочиях, чтобы поведение было согласованным и тестируемым.
 */

/**
 * Проверяет, обладает ли роль привилегиями уровня Менеджера (Req 2.3).
 *
 * Истинно для {@link Role.MANAGER} и для {@link Role.ADMIN} (Администратор
 * обладает всеми правами Менеджера). Ложно для {@link Role.EXECUTOR}.
 *
 * @param role Роль пользователя.
 * @returns `true`, если роль имеет права Менеджера или выше.
 */
export function hasManagerPrivileges(role: Role): boolean {
  return role === Role.MANAGER || role === Role.ADMIN;
}

/**
 * Проверяет, обладает ли роль привилегиями уровня Администратора.
 *
 * Истинно только для {@link Role.ADMIN}.
 *
 * @param role Роль пользователя.
 * @returns `true`, если роль является Администратором.
 */
export function hasAdminPrivileges(role: Role): boolean {
  return role === Role.ADMIN;
}

/**
 * Числовой уровень роли для сравнения привилегий: чем выше значение, тем шире
 * полномочия. Используется для проверки «роль обладает не меньшими правами, чем
 * требуется» (Req 2.3): администратор (2) ⊇ менеджер (1) ⊇ исполнитель (0).
 */
const ROLE_PRIVILEGE_LEVEL: Readonly<Record<Role, number>> = {
  [Role.EXECUTOR]: 0,
  [Role.MANAGER]: 1,
  [Role.ADMIN]: 2,
};

/**
 * Проверяет, что роль `actor` обладает не меньшими привилегиями, чем `required`
 * (Req 2.3).
 *
 * Поскольку уровни упорядочены (исполнитель < менеджер < администратор), любое
 * действие, разрешённое для `required`, разрешено и для роли с не меньшим
 * уровнем. В частности, для всякого действия, доступного Менеджеру, выполняется
 * `roleAtLeast(ADMIN, MANAGER) === true`.
 *
 * @param actor Роль действующего пользователя.
 * @param required Минимально необходимая роль для действия.
 * @returns `true`, если `actor` имеет права уровня `required` или выше.
 */
export function roleAtLeast(actor: Role, required: Role): boolean {
  return ROLE_PRIVILEGE_LEVEL[actor] >= ROLE_PRIVILEGE_LEVEL[required];
}
