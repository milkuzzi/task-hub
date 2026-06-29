import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskFormDialog } from './TaskFormDialog';
import type { DirectoryUser } from '@/lib/tasks-api';

const directory: DirectoryUser[] = [
  { id: 'admin-1', name: 'Анна Администратор', role: 'ADMIN' },
  { id: 'manager-1', name: 'Мария Менеджер', role: 'MANAGER' },
  { id: 'executor-1', name: 'Егор Исполнитель', role: 'EXECUTOR' },
];

describe('TaskFormDialog — списки участников', () => {
  it('по умолчанию использует site-surface, а MAX включает отдельные классы', () => {
    const { container, rerender } = render(
      <TaskFormDialog
        open
        task={null}
        directory={directory}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.querySelector('.task-form-dialog')).toHaveClass(
      'task-form-dialog--site',
    );
    expect(
      container.querySelector('.modal-overlay--task-form-site'),
    ).not.toBeNull();

    rerender(
      <TaskFormDialog
        open
        surface="max"
        task={null}
        directory={directory}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.querySelector('.task-form-dialog')).toHaveClass(
      'task-form-dialog--max',
    );
    expect(
      container.querySelector('.modal-overlay--task-form-max'),
    ).not.toBeNull();
  });

  it('не показывает администраторов в списках назначения', () => {
    render(
      <TaskFormDialog
        open
        task={null}
        directory={directory}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const executors = screen.getByRole('group', { name: 'Исполнители' });
    const managers = screen.getByRole('group', { name: 'Менеджеры' });

    expect(within(executors).queryByText('Анна Администратор')).not.toBeInTheDocument();
    expect(within(executors).getByText('Егор Исполнитель')).toBeInTheDocument();
    expect(within(managers).queryByText('Анна Администратор')).not.toBeInTheDocument();
    expect(within(managers).getByText('Мария Менеджер')).toBeInTheDocument();
    expect(screen.queryByText(/Администратор не назначается менеджером задачи/u)).not.toBeInTheDocument();
  });
});
