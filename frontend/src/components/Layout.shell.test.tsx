import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import { Layout } from './Layout';

vi.mock('@/components/NotificationsPopover', () => ({
  NotificationsPopover: () => <div data-testid="topbar-notifications" />,
}));

const originalScrollTo = window.scrollTo;

function user(role: CurrentUser['role']): CurrentUser {
  return {
    id: `${role.toLowerCase()}-1`,
    email: `${role.toLowerCase()}@example.com`,
    name: `${role} User`,
    role,
    avatarPath: null,
    maxLinked: false,
  };
}

function authValue(currentUser: CurrentUser): AuthContextValue {
  return {
    user: currentUser,
    initializing: false,
    isAuthenticated: true,
    signIn: vi.fn(),
    signInWithMax: vi.fn(),
    signOut: vi.fn(),
    setUser: vi.fn(),
  };
}

function renderLayout(currentUser: CurrentUser): HTMLElement {
  const { container } = render(
    <AuthContext.Provider value={authValue(currentUser)}>
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route path="tasks" element={<div>Рабочая область</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return container;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  window.scrollTo = originalScrollTo;
});

describe('Layout app shell', () => {
  it('renders sidebar and provided logo for administrators', () => {
    const container = renderLayout(user('ADMIN'));

    expect(container.querySelector('.app-sidebar')).toBeInTheDocument();
    expect(container.querySelector('.app-main--no-sidebar')).not.toBeInTheDocument();
    const logos = container.querySelectorAll('img.app-logo[src="/logo2090.png"]');
    expect(logos.length).toBeGreaterThan(0);
    expect(screen.queryByText('Администратор')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topbar-notifications')).not.toBeInTheDocument();
  });

  it('hides sidebar and role label for managers', () => {
    const container = renderLayout(user('MANAGER'));

    expect(container.querySelector('.app-sidebar')).not.toBeInTheDocument();
    expect(container.querySelector('.app-shell--topbar')).toBeInTheDocument();
    expect(container.querySelector('.app-header--standalone')).toBeInTheDocument();
    expect(container.querySelector('.app-main--no-sidebar')).toBeInTheDocument();
    expect(screen.queryByText('Менеджер')).not.toBeInTheDocument();
    expect(screen.getByTestId('topbar-notifications')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Профиль' })).toBeInTheDocument();
    expect(screen.getByText('Рабочая область')).toBeInTheDocument();
  });
});
