import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxLinkSection } from './MaxLinkSection';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import { unlinkMax, type CurrentUser } from '@/lib/auth-api';

vi.mock('@/lib/auth-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-api')>('@/lib/auth-api');
  return { ...actual, unlinkMax: vi.fn() };
});

const mockedUnlinkMax = vi.mocked(unlinkMax);

function currentUser(maxLinked = true): CurrentUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Пользователь',
    role: 'EXECUTOR',
    avatarPath: null,
    maxLinked,
  };
}

function authValue(user: CurrentUser, setUser = vi.fn()): AuthContextValue {
  return {
    user,
    initializing: false,
    isAuthenticated: true,
    signIn: vi.fn(),
    signInWithMax: vi.fn(),
    signOut: vi.fn(),
    setUser,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('MaxLinkSection — отвязка MAX', () => {
  it('показывает кнопку отвязки для привязанного MAX и обновляет профиль', async () => {
    const user = userEvent.setup();
    const setUser = vi.fn();
    const updated = currentUser(false);
    mockedUnlinkMax.mockResolvedValueOnce(updated);

    render(
      <AuthContext.Provider value={authValue(currentUser(true), setUser)}>
        <MaxLinkSection />
      </AuthContext.Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Отвязать MAX' }));

    await waitFor(() => {
      expect(mockedUnlinkMax).toHaveBeenCalledTimes(1);
      expect(setUser).toHaveBeenCalledWith(updated);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Профиль MAX отвязан.');
  });

  it('не показывает кнопку отвязки, если MAX не привязан', () => {
    render(
      <AuthContext.Provider value={authValue(currentUser(false))}>
        <MaxLinkSection />
      </AuthContext.Provider>,
    );

    expect(screen.queryByRole('button', { name: 'Отвязать MAX' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Привязать MAX' })).toBeInTheDocument();
  });
});
