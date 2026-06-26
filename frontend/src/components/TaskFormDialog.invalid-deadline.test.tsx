import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskFormDialog } from './TaskFormDialog';
import type { TaskDetail } from '@/lib/tasks-api';

const malformedTask = {
  id: 'task-1',
  title: 'Задача с некорректным ответом API',
  description: null,
  deadline: undefined,
  status: 'IN_PROGRESS',
  messageCount: 0,
  hasUnread: false,
  isOverdue: false,
  executorIds: ['executor-1'],
  managerIds: ['manager-1'],
} as unknown as TaskDetail;

describe('TaskFormDialog — некорректный дедлайн', () => {
  it('не падает и сообщает об ошибке вместо форматирования undefined', async () => {
    render(
      <TaskFormDialog
        open
        task={malformedTask}
        directory={[]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Дедлайн содержит недопустимую дату или время.',
    );
  });
});
