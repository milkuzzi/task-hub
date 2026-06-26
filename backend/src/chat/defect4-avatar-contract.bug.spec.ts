import { Role } from '@prisma/client';
import { toChatMessage } from './chat-representation';
import { MessageWithAttachments, UserWithMaxLink } from '../repositories';
import { toAdminUser } from '../users/user-representation';

/**
 * Exploratory-тест условия дефекта 4 — КОНТРАКТЫ (задача 10, backend-часть).
 *
 * **Property 7: Bug Condition** — Аватар автора Сообщения и Пользователя в
 * администрировании.
 *
 * Формальное условие дефекта:
 * ```
 * isBugCondition_4(input):
 *   RETURN контракт (ChatMessageHttpView | AdminUserView) НЕ содержит данных
 *          аватара AND UI не отображает аватар автора Сообщения / Пользователя
 * ```
 *
 * Здесь проверяется первая половина условия — серверные контракты. Согласно
 * Property 7 исправленный код ДОЛЖЕН предоставлять данные аватара в
 * `ChatMessageHttpView` (аватар автора Сообщения) и в `AdminUserView` (аватар
 * Пользователя). Тесты утверждают это ожидаемое (корректное) поведение.
 *
 * **CRITICAL**: тесты запускаются на НЕИСПРАВЛЕННОМ коде и ДОЛЖНЫ ПАДАТЬ —
 * падение подтверждает дефект 4 (контракты не несут данных аватара). Чинить
 * тест/код на этом этапе НЕЛЬЗЯ.
 */

/** Истинно, если у объекта есть хоть одно поле, относящееся к аватару. */
function carriesAvatarData(view: Record<string, unknown>): boolean {
  return Object.keys(view).some((key) => /avatar/i.test(key));
}

/**
 * Сообщение Чата, автор которого имеет сохранённый аватар (`avatarPath` задан) —
 * вход, для которого Property 7 требует наличия данных аватара автора в контракте.
 */
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
    // Автор с сохранённым аватаром (модель входа isBugCondition_4).
    author: {
      id: 'user-1',
      avatarPath: 'avatars/user-1.png',
    },
  } as unknown as MessageWithAttachments;
}

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

describe('Дефект 4 — контракты не несут данных аватара (Property 7: Bug Condition)', () => {
  it('ChatMessageHttpView содержит данные аватара автора Сообщения', () => {
    const view = toChatMessage(messageWithAuthorAvatar(), 'task-1') as unknown as Record<
      string,
      unknown
    >;

    // Property 7: контракт Сообщения должен нести данные аватара автора
    // (например, `authorAvatarPath`/признак наличия). На НЕИСПРАВЛЕННОМ коде
    // таких полей нет — утверждение падает, подтверждая дефект 4.
    expect(carriesAvatarData(view)).toBe(true);
  });

  it('AdminUserView содержит данные аватара Пользователя', () => {
    const view = toAdminUser(
      adminUserWithAvatar(),
      new Date('2024-01-02T00:00:00.000Z'),
    ) as unknown as Record<string, unknown>;

    // Property 7: запись администрирования должна нести `avatarPath`
    // Пользователя. На НЕИСПРАВЛЕННОМ коде поле отсутствует — падение
    // подтверждает дефект 4.
    expect(carriesAvatarData(view)).toBe(true);
  });
});
