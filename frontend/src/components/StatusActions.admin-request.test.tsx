import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusActions } from './StatusActions';
import { ApiError } from '@/lib/api';
import { changeStatus } from '@/lib/status-api';
import type { TaskDetail, TaskStatus } from '@/lib/tasks-api';

vi.mock('@/lib/status-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/status-api')>('@/lib/status-api');
  return { ...actual, changeStatus: vi.fn() };
});

const mockedChangeStatus = vi.mocked(changeStatus);

function taskResult(status: TaskStatus): TaskDetail {
  return {
    id: 'task-1',
    title: 'Задача',
    description: null,
    deadline: '2025-01-01T00:00:00.000Z',
    status,
    messageCount: 0,
    hasUnread: false,
    isOverdue: false,
    executorIds: [],
    managerIds: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('StatusActions administrator escalation action', () => {
  it('does not show "К администратору" to administrators', () => {
    render(
      <StatusActions
        taskId="task-1"
        status="IN_PROGRESS"
        actor="ADMIN"
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'К администратору' })).not.toBeInTheDocument();
  });

  it('keeps "К администратору" available to managers', () => {
    render(
      <StatusActions
        taskId="task-1"
        status="IN_PROGRESS"
        actor="MANAGER"
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'К администратору' })).toBeInTheDocument();
  });

  it('uses one combobox instead of separate admin-set buttons for administrator target statuses', async () => {
    render(
      <StatusActions
        taskId="task-1"
        status="NEEDS_ADMIN"
        actor="ADMIN"
        onChanged={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Выберите статус' });
    await waitFor(() => expect(select).toHaveValue('IN_PROGRESS'));

    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(within(select).getByRole('option', { name: 'В работе' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Ожидает' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Выполнено' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Отменено' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Установить статус:/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Выберите статус')).not.toBeInTheDocument();
  });

  it('does not show cancel action to managers', () => {
    render(
      <StatusActions
        taskId="task-1"
        status="IN_PROGRESS"
        actor="MANAGER"
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();
  });

  it('submits the selected administrator target status', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockedChangeStatus.mockResolvedValueOnce(taskResult('CANCELLED'));

    render(
      <StatusActions
        taskId="task-1"
        status="NEEDS_ADMIN"
        actor="ADMIN"
        onChanged={onChanged}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Выберите статус' }), 'CANCELLED');
    await user.click(screen.getByRole('button', { name: 'Применить статус' }));

    await waitFor(() => {
      expect(mockedChangeStatus).toHaveBeenCalledWith('task-1', {
        type: 'ADMIN_SET',
        target: 'CANCELLED',
      });
    });
    expect(onChanged).toHaveBeenCalledWith('CANCELLED');
  });

  it('disables administrator status controls while the selected status is pending', async () => {
    const user = userEvent.setup();
    let resolveChange!: (value: TaskDetail) => void;
    mockedChangeStatus.mockReturnValueOnce(
      new Promise<TaskDetail>((resolve) => {
        resolveChange = resolve;
      }),
    );

    render(
      <StatusActions
        taskId="task-1"
        status="NEEDS_ADMIN"
        actor="ADMIN"
        onChanged={vi.fn()}
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Выберите статус' });
    const apply = screen.getByRole('button', { name: 'Применить статус' });
    await user.click(apply);

    await waitFor(() => {
      expect(select).toBeDisabled();
      expect(apply).toBeDisabled();
      expect(apply).toHaveAttribute('aria-busy', 'true');
    });

    resolveChange(taskResult('IN_PROGRESS'));
    await waitFor(() => expect(apply).not.toBeDisabled());
  });

  it('shows an alert when administrator status selection fails', async () => {
    const user = userEvent.setup();
    mockedChangeStatus.mockRejectedValueOnce(
      new ApiError('Сервер отказал', 'NO_PERMISSION', 403, null),
    );

    render(
      <StatusActions
        taskId="task-1"
        status="NEEDS_ADMIN"
        actor="ADMIN"
        onChanged={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Применить статус' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер отказал');
  });
});
