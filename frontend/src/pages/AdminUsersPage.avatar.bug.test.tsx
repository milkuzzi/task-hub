import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersPage } from './AdminUsersPage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import { fetchAvatarBlob } from '@/lib/avatar';
import { listUsers, listDeletedUsers, type AdminUser } from '@/lib/users-api';
import type { CurrentUser } from '@/lib/auth-api';

/**
 * Exploratory-тест условия дефекта 4 — таблица администрирования (задача 10).
 *
 * **Property 7: Bug Condition** — Аватар автора Сообщения и Пользователя в
 * администрировании.
 *
 * Здесь проверяется вторая половина `isBugCondition_4` для списка
 * администрирования: каждая строка Пользователя должна показывать его аватар
 * (через защищённый `fetchAvatarBlob(userId)`), с корректной заглушкой при
 * отсутствии.
 *
 * **CRITICAL**: тест запускается на НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПАДАТЬ —
 * таблица `AdminUsersPage` не содержит элемента аватара и не запрашивает байты
 * аватара. Падение подтверждает дефект 4. Чинить тест/код нельзя.
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

function adminUser(): AdminUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Иван Петров',
    role: 'EXECUTOR',
    active: true,
    locked: false,
    maxLinked: false,
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

function renderPage(): void {
  render(
    <AuthContext.Provider value={authValue(currentAdmin())}>
      <AdminUsersPage />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  mockedFetchAvatar.mockResolvedValue(new Blob(['avatar'], { type: 'image/png' }));
  mockedListUsers.mockResolvedValue([adminUser()]);
  mockedListDeleted.mockResolvedValue([]);
});

afterEach(() => {
  mockedFetchAvatar.mockReset();
  mockedListUsers.mockReset();
  mockedListDeleted.mockReset();
});

describe('AdminUsersPage — дефект 4 (аватар Пользователя в администрировании)', () => {
  it('Property 7: строка Пользователя показывает его аватар', async () => {
    renderPage();

    // Дожидаемся загрузки списка Пользователей.
    await screen.findByText('user@example.com');

    // Property 7: для строки Пользователя должен запрашиваться защищённый аватар
    // по его id и отображаться изображение. На НЕИСПРАВЛЕННОМ коде элемента
    // аватара нет — запрос не выполняется (падение подтверждает дефект).
    await waitFor(() => expect(mockedFetchAvatar).toHaveBeenCalledWith('user-1'));

    const avatarImg = await screen.findByRole('img', { name: 'Аватар пользователя' });
    expect(avatarImg.getAttribute('src')).toMatch(/^blob:/);
  });
});
