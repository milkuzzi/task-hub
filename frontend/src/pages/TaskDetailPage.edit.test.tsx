import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailPage } from './TaskDetailPage';
import { AuthContext, type AuthContextValue } from '@/lib/use-auth';
import type { CurrentUser } from '@/lib/auth-api';
import {
  assignTask,
  getTask,
  listDirectory,
  updateTask,
  type TaskDetail,
} from '@/lib/tasks-api';
import { listAttachments, listMessages, listReaders, markRead } from '@/lib/chat-api';
import { listAuditEntries } from '@/lib/audit-api';

vi.mock('@/lib/socket', async () => {
  const actual = await vi.importActual<typeof import('@/lib/socket')>('@/lib/socket');
  return {
    ...actual,
    connectSocket: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    joinTaskRoom: vi.fn(),
    leaveTaskRoom: vi.fn(),
  };
});

vi.mock('@/lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tasks-api')>('@/lib/tasks-api');
  return {
    ...actual,
    assignTask: vi.fn(),
    getTask: vi.fn(),
    listDirectory: vi.fn(),
    updateTask: vi.fn(),
  };
});

vi.mock('@/lib/chat-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat-api')>('@/lib/chat-api');
  return {
    ...actual,
    listMessages: vi.fn(),
    listAttachments: vi.fn(),
    listReaders: vi.fn(),
    markRead: vi.fn(),
  };
});

vi.mock('@/lib/audit-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit-api')>('@/lib/audit-api');
  return { ...actual, listAuditEntries: vi.fn() };
});

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

const mockedAssignTask = vi.mocked(assignTask);
const mockedGetTask = vi.mocked(getTask);
const mockedListDirectory = vi.mocked(listDirectory);
const mockedUpdateTask = vi.mocked(updateTask);
const mockedListMessages = vi.mocked(listMessages);
const mockedListAttachments = vi.mocked(listAttachments);
const mockedListReaders = vi.mocked(listReaders);
const mockedMarkRead = vi.mocked(markRead);
const mockedListAuditEntries = vi.mocked(listAuditEntries);

function taskFixture(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 'task-1',
    title: 'Старая задача',
    description: 'Старое описание',
    deadline: '2025-01-01T09:00:00.000Z',
    status: 'IN_PROGRESS',
    messageCount: 0,
    hasUnread: false,
    isOverdue: false,
    executorIds: ['executor-1'],
    managerIds: ['manager-1'],
    ...overrides,
  };
}

function currentUser(role: CurrentUser['role'], id: string): CurrentUser {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
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

function renderPage(user: CurrentUser): void {
  render(
    <AuthContext.Provider value={authValue(user)}>
      <MemoryRouter initialEntries={['/tasks/task-1']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  mockedGetTask.mockResolvedValue(taskFixture());
  mockedListDirectory.mockResolvedValue([]);
  mockedListMessages.mockResolvedValue([]);
  mockedListAttachments.mockResolvedValue([]);
  mockedListReaders.mockResolvedValue([]);
  mockedMarkRead.mockResolvedValue(undefined as never);
  mockedListAuditEntries.mockResolvedValue([]);
  mockedUpdateTask.mockResolvedValue(taskFixture());
  mockedAssignTask.mockResolvedValue(taskFixture());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TaskDetailPage edit action', () => {
  it('shows the edit action in the task hero for an assigned manager', async () => {
    renderPage(currentUser('MANAGER', 'manager-1'));

    expect(await screen.findByRole('heading', { name: 'Старая задача' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Изменить' })).toBeInTheDocument();
  });

  it('places status actions and edit action under task status metadata', async () => {
    renderPage(currentUser('ADMIN', 'admin-1'));

    expect(await screen.findByRole('heading', { name: 'Старая задача' })).toBeInTheDocument();
    const actionRow = document.querySelector('.task-hero__action-row');

    expect(actionRow).toBeInTheDocument();
    expect(actionRow).toContainElement(screen.getByRole('button', { name: 'Выполнено' }));
    expect(actionRow).toContainElement(screen.getByRole('button', { name: 'Отменить' }));
    expect(actionRow).toContainElement(screen.getByRole('button', { name: 'Изменить' }));
  });

  it('hides the edit action from an executor without manage permission', async () => {
    renderPage(currentUser('EXECUTOR', 'executor-1'));

    expect(await screen.findByRole('heading', { name: 'Старая задача' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument();
  });

  it('shows overdue indicator in the task hero when task is overdue', async () => {
    mockedGetTask.mockResolvedValueOnce(taskFixture({ isOverdue: true }));

    renderPage(currentUser('ADMIN', 'admin-1'));

    expect(await screen.findByRole('heading', { name: 'Старая задача' })).toBeInTheDocument();
    expect(screen.getByText('Просрочено')).toBeInTheDocument();
  });

  it('submits edits through existing task APIs and refreshes the detail view', async () => {
    const user = userEvent.setup();
    const updated = taskFixture({
      title: 'Обновленная задача',
      description: 'Новое описание',
    });
    mockedGetTask.mockResolvedValueOnce(taskFixture()).mockResolvedValueOnce(updated);
    mockedUpdateTask.mockResolvedValueOnce(updated);

    renderPage(currentUser('ADMIN', 'admin-1'));

    await user.click(await screen.findByRole('button', { name: 'Изменить' }));

    await user.clear(screen.getByLabelText('Название'));
    await user.type(screen.getByLabelText('Название'), 'Обновленная задача');
    await user.clear(screen.getByLabelText('Описание'));
    await user.type(screen.getByLabelText('Описание'), 'Новое описание');
    await user.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => {
      expect(mockedUpdateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          title: 'Обновленная задача',
          description: 'Новое описание',
        }),
      );
    });
    expect(mockedAssignTask).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Обновленная задача' })).toBeInTheDocument();
  });
});
