import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import {
  createTask,
  listDirectory,
  listTasks,
  PAGINATION,
  type Page,
  type TaskCard,
} from '@/lib/tasks-api';

vi.mock('@/components/NotificationsPopover', () => ({
  NotificationsPopover: () => <div data-testid="notifications-popover" />,
}));

vi.mock('@/lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks-api')>('@/lib/tasks-api');
  return {
    ...actual,
    createTask: vi.fn(),
    listDirectory: vi.fn(),
    listTasks: vi.fn(),
  };
});

const mockedCreateTask = vi.mocked(createTask);
const mockedListDirectory = vi.mocked(listDirectory);
const mockedListTasks = vi.mocked(listTasks);

function page(items: TaskCard[] = []): Page<TaskCard> {
  return {
    items,
    meta: {
      page: 1,
      pageSize: PAGINATION.defaultPageSize,
      total: items.length,
      totalPages: items.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrevious: false,
    },
  };
}

function currentUser(role: CurrentUser['role']): CurrentUser {
  return {
    id: `${role.toLowerCase()}-1`,
    email: `${role.toLowerCase()}@example.com`,
    name: role,
    role,
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

function renderPage(role: CurrentUser['role']): void {
  render(
    <AuthContext.Provider value={authValue(currentUser(role))}>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  mockedCreateTask.mockResolvedValue({
    id: 'created-task',
    title: 'Созданная задача',
    description: null,
    deadline: '2030-01-01T00:00:00.000Z',
    status: 'IN_PROGRESS',
    messageCount: 0,
    hasUnread: false,
    isOverdue: false,
    executorIds: ['executor-1'],
    managerIds: ['manager-1'],
  });
  mockedListDirectory.mockResolvedValue([]);
  mockedListTasks.mockResolvedValue(page());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TasksPage cancelled task view', () => {
  it.each(['MANAGER', 'ADMIN'] as const)(
    'lets %s request cancelled tasks through the existing status filter',
    async (role) => {
      const user = userEvent.setup();
      renderPage(role);

      await screen.findByText('Задачи не найдены.');
      mockedListTasks.mockClear();

      await user.click(screen.getByRole('button', { name: 'Отмененные задачи' }));

      await waitFor(() => {
        expect(mockedListTasks).toHaveBeenCalledWith(
          expect.objectContaining({
            filters: expect.objectContaining({ statuses: ['CANCELLED'] }),
            page: PAGINATION.defaultPage,
          }),
        );
      });
      expect(screen.getByRole('button', { name: 'К активным задачам' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    },
  );

  it('removes the cancelled status filter when manager disables cancelled view', async () => {
    const user = userEvent.setup();
    renderPage('MANAGER');

    await screen.findByText('Задачи не найдены.');
    await user.click(screen.getByRole('button', { name: 'Отмененные задачи' }));
    await waitFor(() => {
      expect(mockedListTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({ statuses: ['CANCELLED'] }),
        }),
      );
    });

    mockedListTasks.mockClear();
    await user.click(screen.getByRole('button', { name: 'К активным задачам' }));

    await waitFor(() => {
      expect(mockedListTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.not.objectContaining({ statuses: ['CANCELLED'] }),
          page: PAGINATION.defaultPage,
        }),
      );
    });
  });

  it('does not render cancelled task view control for executors', async () => {
    renderPage('EXECUTOR');

    await screen.findByText('Задачи не найдены.');

    expect(screen.queryByRole('button', { name: 'Отмененные задачи' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'К активным задачам' })).not.toBeInTheDocument();
  });
});
