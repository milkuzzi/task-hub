import fc from 'fast-check';
import { Role } from '@prisma/client';
import { toChatMessage } from './chat-representation';
import { MessageWithAttachments, UserWithMaxLink } from '../repositories';
import { toAdminUser } from '../users/user-representation';
import { hasAdminPrivileges, hasManagerPrivileges, roleAtLeast } from '../users/permissions';

/**
 * Preservation-тест дефекта 4 (задача 11).
 *
 * **Property 8: Preservation** — Прочие сведения и серверный контроль доступа.
 *
 * Формулировка (Req 3.6): _For any_ рендеринга профиля/администрирования
 * исправленный код ДОЛЖЕН сохранять отображение прочих сведений (имя, e-mail,
 * статус, действия) без изменений, а сервер ДОЛЖЕН продолжать использовать роль
 * для контроля доступа.
 *
 * Методология «сначала наблюдение»: тест фиксирует БАЗОВОЕ поведение на
 * НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПРОХОДИТЬ. Будущее исправление дефекта 4
 * (задача 12) добавит в контракты `ChatMessageHttpView`/`AdminUserView` данные
 * аватара, но НЕ должно менять прочие поля и серверный контроль доступа по роли
 * — задача 12.3 перезапустит этот же тест и подтвердит отсутствие регрессий.
 *
 * Здесь зафиксированы три инварианта ¬C для дефекта 4:
 *   1. `AdminUserView` несёт прежние сведения Пользователя без изменений —
 *      имя (`name`), e-mail (`email`), статус активации/блокировки
 *      (`active`/`locked`), а также `role`/`maxLinked`, на которых строятся
 *      доступные действия в администрировании.
 *   2. `ChatMessageHttpView` несёт прежние сведения Сообщения без изменений —
 *      автор, отображаемое имя автора, текст, метки времени и состояние.
 *   3. Серверный контроль доступа по роли (`permissions.ts`) ведёт себя как
 *      прежде для всех ролей.
 */

/** Активный Пользователь администрирования с сохранённым аватаром. */
function adminUserWithAvatar(): UserWithMaxLink {
  return {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'Иван Петров',
    passwordHash: 'hash',
    role: Role.EXECUTOR,
    avatarPath: 'avatars/user-1.png',
    isActive: true,
    deletedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    maxLink: null,
  } as UserWithMaxLink;
}

/** Заблокированный после неудачных входов Пользователь (статус `locked`). */
function lockedAdminUser(now: Date): UserWithMaxLink {
  return {
    ...adminUserWithAvatar(),
    id: 'user-2',
    email: 'locked@example.com',
    displayName: 'Пётр Сидоров',
    role: Role.MANAGER,
    isActive: false,
    lockedUntil: new Date(now.getTime() + 60_000),
  } as UserWithMaxLink;
}

/** Сообщение Чата с автором, у которого сохранён аватар. */
function messageWithAuthorAvatar(): MessageWithAttachments {
  return {
    id: 'msg-1',
    chatId: 'chat-1',
    authorId: 'user-1',
    authorDisplayName: 'Иван Петров',
    text: 'Привет',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    editedAt: null,
    deleted: false,
    attachments: [],
    author: {
      id: 'user-1',
      avatarPath: 'avatars/user-1.png',
    },
  } as unknown as MessageWithAttachments;
}

describe('Дефект 4 — preservation прочих сведений и контроля доступа (Property 8)', () => {
  describe('AdminUserView сохраняет прочие сведения Пользователя (Req 3.6)', () => {
    it('активный Пользователь: имя, e-mail, роль, статус и maxLinked без изменений', () => {
      const now = new Date('2024-01-02T00:00:00.000Z');
      const view = toAdminUser(adminUserWithAvatar(), now);

      expect(view.id).toBe('user-1');
      expect(view.name).toBe('Иван Петров');
      expect(view.email).toBe('user@example.com');
      expect(view.role).toBe(Role.EXECUTOR);
      expect(view.active).toBe(true);
      expect(view.locked).toBe(false);
      expect(view.maxLinked).toBe(false);
    });

    it('заблокированный/неактивный Пользователь: статус отражается без изменений', () => {
      const now = new Date('2024-01-02T00:00:00.000Z');
      const view = toAdminUser(lockedAdminUser(now), now);

      expect(view.name).toBe('Пётр Сидоров');
      expect(view.email).toBe('locked@example.com');
      expect(view.role).toBe(Role.MANAGER);
      // Статус активации/блокировки — основа доступных действий в админке.
      expect(view.active).toBe(false);
      expect(view.locked).toBe(true);
    });
  });

  describe('ChatMessageHttpView сохраняет прочие сведения Сообщения (Req 3.6)', () => {
    it('автор, имя автора, текст, метки времени и состояние без изменений', () => {
      const view = toChatMessage(messageWithAuthorAvatar(), 'task-1');

      expect(view.id).toBe('msg-1');
      expect(view.taskId).toBe('task-1');
      expect(view.chatId).toBe('chat-1');
      expect(view.authorId).toBe('user-1');
      expect(view.authorDisplayName).toBe('Иван Петров');
      expect(view.text).toBe('Привет');
      expect(view.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(view.editedAt).toBeNull();
      expect(view.deleted).toBe(false);
    });
  });

  describe('Серверный контроль доступа по роли сохраняется (Req 3.6)', () => {
    const ROLES: readonly Role[] = [Role.EXECUTOR, Role.MANAGER, Role.ADMIN];
    const roleArb = fc.constantFrom(...ROLES);

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
      const level: Record<Role, number> = {
        [Role.EXECUTOR]: 0,
        [Role.MANAGER]: 1,
        [Role.ADMIN]: 2,
      };
      fc.assert(
        fc.property(roleArb, roleArb, (actor, required) => {
          expect(roleAtLeast(actor, required)).toBe(level[actor] >= level[required]);
        }),
      );
    });
  });
});
