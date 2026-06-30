import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfilePage } from '@/pages/ProfilePage';
import { AdminUsersPage } from '@/pages/AdminUsersPage';
import { ChatMessageItem } from '@/components/ChatMessageItem';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import { fetchAvatarBlob } from '@/lib/avatar';
import {
  listUsers,
  listDeletedUsers,
  type AdminUser,
  type DeletedUser,
} from '@/lib/users-api';
import type { CurrentUser } from '@/lib/auth-api';
import type { ChatMessage } from '@/lib/chat-api';

/**
 * **Bugfix: task-hub-bug-fixes — сквозной интеграционный тест потока аватаров
 * (задача 28, фронтенд-часть).**
 *
 * **Validates: Requirements 2.4** (а также корневое исправление дефекта 1 —
 * показ сохранённого аватара в профиле, Req 2.1; preservation Req 3.1).
 *
 * Проверяет поток аватаров целиком на стороне клиента, переиспользуя harness
 * per-defect тестов:
 *
 * - **Профиль** (дефект 1): когда аватар реально сохранён на сервере
 *   (защищённый `GET /avatars/:userId` отдаёт 200 + blob), профиль показывает
 *   изображение; при 404 — заглушку без «битой» картинки (Req 2.1, 3.1).
 * - **Лента Чата** (дефект 4): `ChatMessageItem` показывает аватар автора через
 *   переиспользуемый `UserAvatar`; при отсутствии аватара — заглушку (Req 2.4).
 * - **Администрирование** (дефект 4): строки `AdminUsersPage` показывают аватар
 *   Пользователя или заглушку при его отсутствии (Req 2.4).
 *
 * Аватар защищён авторизацией и грузится «fetch-as-blob», поэтому модуль
 * `@/lib/avatar` мокается так, чтобы детерминированно моделировать ответ
 * эндпоинта (200 + blob либо 404).
 */

vi.mock('@/lib/avatar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/avatar')>('@/lib/avatar');
  return { ...actual, fetchAvatarBlob: vi.fn() };
});

vi.mock('@/lib/users-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/users-api')>('@/lib/users-api');
  return { ...actual, listUsers: vi.fn(), listDeletedUsers: vi.fn() };
});

const mockedFetchAvatar = vi.mocked(fetchAvatarBlob);
const mockedListUsers = vi.mocked(listUsers);
const mockedListDeleted = vi.mocked(listDeletedUsers);

function authValue(user: CurrentUser): AuthContextValue {
  return {
    user,
    initializing: false,
    isAuthenticated: true,
    signIn: vi.fn(),
    signInWithMax: vi.fn(),
    signOut: vi.fn(),
    setUser: vi.fn(),
  };
}

afterEach(() => {
  mockedFetchAvatar.mockReset();
  mockedListUsers.mockReset();
  mockedListDeleted.mockReset();
});

// =============================================================================
// Профиль (дефект 1)
// =============================================================================

describe('Поток аватаров: профиль показывает сохранённый аватар (дефект 1)', () => {
  function profileUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
    return {
      id: 'user-1',
      email: 'user@example.com',
      name: 'Иван Петров',
      role: 'EXECUTOR',
      avatarPath: null,
      maxLinked: false,
      ...overrides,
    };
  }

  function renderProfile(user: CurrentUser): void {
    render(
      <AuthContext.Provider value={authValue(user)}>
        <ProfilePage />
      </AuthContext.Provider>,
    );
  }

  it('при сохранённом на сервере аватаре профиль показывает изображение', async () => {
    mockedFetchAvatar.mockResolvedValue(new Blob(['avatar-bytes'], { type: 'image/png' }));

    renderProfile(profileUser());

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

    const avatarImg = await screen.findByRole('img', { name: 'Аватар пользователя' });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);
    expect(screen.queryByText('Нет аватара')).not.toBeInTheDocument();
  });

  it('при 404 от эндпоинта профиль показывает заглушку без «битой» картинки', async () => {
    mockedFetchAvatar.mockRejectedValue(new Error('404 Not Found'));

    renderProfile(profileUser({ avatarPath: 'avatars/user-1/missing.png' }));

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

    expect(await screen.findByText('Нет аватара')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Аватар пользователя' })).not.toBeInTheDocument();
  });
});

// =============================================================================
// Лента Чата (дефект 4)
// =============================================================================

describe('Поток аватаров: лента Чата показывает аватар автора/заглушку (дефект 4)', () => {
  function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'msg-1',
      taskId: 'task-1',
      chatId: 'chat-1',
      authorId: 'author-1',
      authorDisplayName: 'Иван Петров',
      text: 'Привет команде',
      createdAt: '2024-01-01T00:00:00.000Z',
      editedAt: null,
      deleted: false,
      ...overrides,
    };
  }

  function renderItem(msg: ChatMessage): void {
    render(
      <ChatMessageItem
        message={msg}
        canModify={false}
        readers={undefined}
        onLoadReaders={vi.fn()}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
        onOpenAttachment={vi.fn()}
      />,
    );
  }

  it('показывает аватар автора Сообщения, когда он сохранён', async () => {
    mockedFetchAvatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }));

    renderItem(message());

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('author-1'));

    const avatarImg = await screen.findByRole('img', { name: 'Аватар пользователя' });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);
  });

  it('показывает заглушку, когда у автора нет аватара (404)', async () => {
    mockedFetchAvatar.mockRejectedValue(new Error('404'));

    renderItem(message());

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('author-1'));

    // Заглушка декоративна (нет элемента изображения с доступным именем).
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'Аватар пользователя' })).not.toBeInTheDocument(),
    );
  });
});

// =============================================================================
// Администрирование (дефект 4)
// =============================================================================

describe('Поток аватаров: администрирование показывает аватары/заглушки (дефект 4)', () => {
  function adminUser(overrides: Partial<AdminUser> = {}): AdminUser {
    return {
      id: 'user-with-avatar',
      email: 'has-avatar@example.com',
      name: 'С аватаром',
      role: 'EXECUTOR',
      active: true,
      locked: false,
      maxLinked: false,
      ...overrides,
    };
  }

  function deletedUser(overrides: Partial<DeletedUser> = {}): DeletedUser {
    return {
      id: 'deleted-with-avatar',
      name: 'Удалённый с аватаром',
      avatarPath: 'avatars/deleted-with-avatar/avatar.png',
      emails: ['deleted@example.com'],
      deletedAt: '2026-06-10T09:15:00.000Z',
      ...overrides,
    };
  }

  function currentAdmin(): CurrentUser {
    return {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Администратор',
      role: 'ADMIN',
      avatarPath: null,
      maxLinked: false,
    };
  }

  function renderPage(): void {
    render(
      <AuthContext.Provider value={authValue(currentAdmin())}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );
  }

  it('строка Пользователя с аватаром показывает изображение, без аватара — заглушку', async () => {
    const withAvatar = adminUser({ id: 'user-with-avatar', email: 'has-avatar@example.com' });
    const withoutAvatar = adminUser({
      id: 'user-without-avatar',
      email: 'no-avatar@example.com',
      name: 'Без аватара',
    });

    // Аватар есть только у первого Пользователя; у второго эндпоинт отдаёт 404.
    mockedFetchAvatar.mockImplementation(async (userId: string) => {
      if (userId === 'user-with-avatar') {
        return new Blob(['avatar'], { type: 'image/png' });
      }
      throw new Error('404');
    });
    mockedListUsers.mockResolvedValue([withAvatar, withoutAvatar]);
    mockedListDeleted.mockResolvedValue([]);

    renderPage();

    // Дожидаемся загрузки списка Пользователей.
    const withAvatarRow = (await screen.findByText('has-avatar@example.com')).closest('li');
    const withoutAvatarRow = (await screen.findByText('no-avatar@example.com')).closest('li');
    expect(withAvatarRow).not.toBeNull();
    expect(withoutAvatarRow).not.toBeNull();

    // Аватар запрашивается по идентификатору каждого Пользователя строки.
    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-with-avatar'));
    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-without-avatar'));

    // Строка Пользователя с аватаром показывает изображение...
    const avatarImg = await within(withAvatarRow as HTMLElement).findByRole('img', {
      name: 'Аватар пользователя',
    });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);

    // ...а строка без аватара показывает заглушку (без элемента изображения).
    await waitFor(() =>
      expect(
        within(withoutAvatarRow as HTMLElement).queryByRole('img', {
          name: 'Аватар пользователя',
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it('строка удалённого Пользователя показывает сохранённый аватар', async () => {
    mockedFetchAvatar.mockResolvedValue(new Blob(['deleted-avatar'], { type: 'image/png' }));
    mockedListUsers.mockResolvedValue([]);
    mockedListDeleted.mockResolvedValue([deletedUser()]);

    renderPage();

    const deletedRow = (await screen.findByText('deleted@example.com')).closest('li');
    expect(deletedRow).not.toBeNull();

    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('deleted-with-avatar'));
    const avatarImg = await within(deletedRow as HTMLElement).findByRole('img', {
      name: 'Аватар пользователя',
    });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);
  });
});
