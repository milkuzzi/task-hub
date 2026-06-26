import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import { ProfilePage } from './ProfilePage';

function authValue(): AuthContextValue {
  const user: CurrentUser = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'Иван Петров',
    role: 'EXECUTOR',
    avatarPath: null,
    maxLinked: false,
  };
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

describe('ProfilePage role label', () => {
  it('shows account identity without role badge or role name', () => {
    const { container } = render(
      <AuthContext.Provider value={authValue()}>
        <ProfilePage />
      </AuthContext.Provider>,
    );

    expect(screen.getByText('Иван Петров')).toBeInTheDocument();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Исполнитель')).not.toBeInTheDocument();
    expect(container.querySelector('.account-summary__role')).not.toBeInTheDocument();
  });
});
