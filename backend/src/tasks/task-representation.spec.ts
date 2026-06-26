import { TaskStatus, type Task } from '@prisma/client';
import { isTaskOverdue, toTaskCard, toTaskDetail } from './task-representation';
import type { TaskWithAssignments } from '../repositories';

const NOW = new Date('2030-06-01T12:00:00.000Z');

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Задача',
    description: null,
    deadline: new Date('2030-06-01T10:00:00.000Z'),
    status: TaskStatus.IN_PROGRESS,
    adminReviewed: false,
    messageCount: 0,
    createdAt: new Date('2030-05-01T00:00:00.000Z'),
    doneAt: null,
    updatedAt: new Date('2030-05-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('task-representation overdue flag', () => {
  it('marks a task as overdue when now is after deadline and status is not DONE', () => {
    const source = task({ status: TaskStatus.WAITING });

    expect(isTaskOverdue(source, NOW)).toBe(true);
    expect(toTaskCard(source, 3, false, NOW).isOverdue).toBe(true);
  });

  it('does not mark a DONE task as overdue even when deadline is in the past', () => {
    const source = task({
      status: TaskStatus.DONE,
      deadline: new Date('2030-06-01T10:00:00.000Z'),
    });

    expect(isTaskOverdue(source, NOW)).toBe(false);
    expect(toTaskCard(source, 0, false, NOW).isOverdue).toBe(false);
  });

  it('does not mark a task as overdue when deadline is not before now', () => {
    const source = task({ deadline: new Date('2030-06-01T12:00:00.000Z') });
    const future = task({ deadline: new Date('2030-06-01T12:00:00.001Z') });

    expect(isTaskOverdue(source, NOW)).toBe(false);
    expect(isTaskOverdue(future, NOW)).toBe(false);
  });

  it('includes isOverdue in detail responses', () => {
    const source: TaskWithAssignments = {
      ...task(),
      assignments: [],
    };

    expect(toTaskDetail(source, 0, false, NOW)).toEqual(
      expect.objectContaining({ id: 'task-1', isOverdue: true, executorIds: [], managerIds: [] }),
    );
  });
});
