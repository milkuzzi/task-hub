import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersPage } from './AdminUsersPage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import {
  listDeletedUsers,
  listUsers,
  type AdminUser,
  type DeletedUser,
} from '@/lib/users-api';

vi.mock('@/lib/users-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/users-api')>('@/lib/users-api');
  return { ...actual, listUsers: vi.fn(), listDeletedUsers: vi.fn() };
});

const mockedListUsers = vi.mocked(listUsers);
const mockedListDeletedUsers = vi.mocked(listDeletedUsers);

const currentAdmin: CurrentUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Администратор',
  role: 'ADMIN',
  avatarPath: null,
  maxLinked: false,
};

const authValue: AuthContextValue = {
  user: currentAdmin,
  initializing: false,
  isAuthenticated: true,
  signIn: vi.fn(),
  signInWithMax: vi.fn(),
  signOut: vi.fn(),
  setUser: vi.fn(),
};

beforeEach(() => {
  mockedListUsers.mockResolvedValue({} as never);
  mockedListDeletedUsers.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminUsersPage — защита API-контракта', () => {
  it('показывает контролируемую ошибку, если список пользователей не является массивом', async () => {
    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('рендерит активных и удалённых пользователей адаптивными списками без таблиц', async () => {
    const activeUser: AdminUser = {
      id: 'user-1',
      email: 'user@example.com',
      name: 'Иван Петров',
      role: 'EXECUTOR',
      avatarPath: null,
      active: true,
      locked: false,
      maxLinked: false,
    };
    const deletedUser: DeletedUser = {
      id: 'deleted-1',
      name: 'Удалённый пользователь',
      emails: ['deleted@example.com'],
      deletedAt: '2026-06-10T09:15:00.000Z',
    };
    mockedListUsers.mockResolvedValue([activeUser]);
    mockedListDeletedUsers.mockResolvedValue([deletedUser]);

    render(
      <AuthContext.Provider value={authValue}>
        <AdminUsersPage />
      </AuthContext.Provider>,
    );

    expect(await screen.findByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('deleted@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
