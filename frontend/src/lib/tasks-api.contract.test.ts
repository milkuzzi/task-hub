import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { createTask, getTask, listTasks } from './tasks-api';

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockedGet = vi.mocked(api.get);

afterEach(() => {
  mockedGet.mockReset();
});

describe('tasks-api — проверка runtime-контракта', () => {
  it('принимает карточку задачи с признаком просрочки', async () => {
    mockedGet.mockResolvedValue({
      items: [
        {
          id: 'task-1',
          title: 'Просроченная задача',
          description: null,
          deadline: '2030-01-01T00:00:00.000Z',
          status: 'WAITING',
          messageCount: 0,
          hasUnread: false,
          isOverdue: true,
        },
      ],
      meta: {
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      },
    });

    await expect(listTasks()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'task-1', isOverdue: true })],
    });
  });

  it('отклоняет неполную задачу до передачи данных в UI', async () => {
    mockedGet.mockResolvedValue({ id: 'task-1', title: 'Неполная задача' });

    await expect(getTask('task-1')).rejects.toThrow('Некорректный ответ API');
  });

  it('отклоняет malformed страницу задач', async () => {
    mockedGet.mockResolvedValue({
      items: [{ id: 'task-1', title: 'Без обязательных полей' }],
      meta: {
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      },
    });

    await expect(listTasks()).rejects.toThrow('Некорректный ответ API');
  });

  it('отклоняет malformed ответ мутации задачи', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 'task-1' });

    await expect(
      createTask({
        title: 'Задача',
        deadline: '2030-01-01T00:00:00.000Z',
        executorIds: ['u1'],
        managerIds: ['u2'],
      }),
    ).rejects.toThrow('Некорректный ответ API');
  });
});
