import { Task } from '@prisma/client';
import { EntityNotFoundException } from '../common/errors';
import { AppConfigService } from '../config';
import { MessageRepository, TaskRepository, UserRepository } from '../repositories';
import { saturateMessageCount } from './message-counter';
import { TasksService } from './tasks.service';

/**
 * Модульные тесты счётчика Сообщений и маркера непрочитанного (Req 9.6–9.9):
 * чистая функция насыщения {@link saturateMessageCount}, путь инкремента и
 * пересчёта счётчика, а также вычисление маркера непрочитанного
 * {@link TasksService.hasUnread}. Репозитории подменяются моками, обращений к
 * реальной базе данных нет.
 */

const CAP = 9999;

function makeTask(partial: Partial<Task> & { id: string }): Task {
  return {
    title: 't',
    description: null,
    deadline: new Date('2030-01-01T00:00:00Z'),
    status: 'IN_PROGRESS',
    adminReviewed: false,
    messageCount: 0,
    createdAt: new Date('2029-12-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2029-12-01T00:00:00Z'),
    ...partial,
  } as unknown as Task;
}

function buildService(taskById: Record<string, Task> = {}) {
  const findById = jest.fn(async (id: string) => taskById[id] ?? null);
  const update = jest.fn(async (id: string, data: { messageCount?: number }) =>
    makeTask({ id, messageCount: data.messageCount ?? taskById[id]?.messageCount ?? 0 }),
  );
  const countByTask = jest.fn(async () => 0);
  const countUnreadForUserByTask = jest.fn(async () => 0);

  const taskRepository = { findById, update } as unknown as TaskRepository;
  const messageRepository = {
    countByTask,
    countUnreadForUserByTask,
  } as unknown as MessageRepository;
  const userRepository = {} as unknown as UserRepository;
  const config = { limits: { messageCounterCap: CAP } } as unknown as AppConfigService;

  const service = new TasksService(
    taskRepository,
    userRepository,
    config,
    messageRepository,
    { record: async () => undefined },
    { enqueueTaskUpdated: async () => undefined },
  );
  return { service, findById, update, countByTask, countUnreadForUserByTask };
}

describe('saturateMessageCount — чистая функция насыщения (Req 9.7, 9.9)', () => {
  it('возвращает само значение, пока оно ниже потолка', () => {
    expect(saturateMessageCount(0, CAP)).toBe(0);
    expect(saturateMessageCount(1, CAP)).toBe(1);
    expect(saturateMessageCount(500, CAP)).toBe(500);
    expect(saturateMessageCount(9998, CAP)).toBe(9998);
  });

  it('возвращает потолок при значении, равном потолку (граница, Req 9.7)', () => {
    expect(saturateMessageCount(CAP, CAP)).toBe(CAP);
  });

  it('насыщается на потолке при значении 10000 и более (Req 9.9)', () => {
    expect(saturateMessageCount(10000, CAP)).toBe(CAP);
    expect(saturateMessageCount(99999, CAP)).toBe(CAP);
    expect(saturateMessageCount(Number.MAX_SAFE_INTEGER, CAP)).toBe(CAP);
  });

  it('никогда не возвращает отрицательное значение', () => {
    expect(saturateMessageCount(-1, CAP)).toBe(0);
    expect(saturateMessageCount(-9999, CAP)).toBe(0);
  });

  it('отбрасывает дробную часть', () => {
    expect(saturateMessageCount(3.9, CAP)).toBe(3);
  });

  it('всегда остаётся в диапазоне 0..потолок', () => {
    for (const n of [0, 1, 5000, 9999, 10000, 250000]) {
      const r = saturateMessageCount(n, CAP);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(CAP);
    }
  });
});

describe('TasksService.incrementMessageCount (Req 9.6, 9.7, 9.9)', () => {
  it('увеличивает счётчик на единицу', async () => {
    const { service, update } = buildService({ t: makeTask({ id: 't', messageCount: 41 }) });

    const task = await service.incrementMessageCount('t');

    expect(update).toHaveBeenCalledWith('t', { messageCount: 42 });
    expect(task.messageCount).toBe(42);
  });

  it('насыщается на 9999 при переходе через потолок (Req 9.9)', async () => {
    const { service, update } = buildService({ t: makeTask({ id: 't', messageCount: 9998 }) });

    await service.incrementMessageCount('t');
    expect(update).toHaveBeenCalledWith('t', { messageCount: 9999 });
  });

  it('не обновляет хранилище и прекращает рост при достигнутом потолке (Req 9.9)', async () => {
    const { service, update } = buildService({ t: makeTask({ id: 't', messageCount: 9999 }) });

    const task = await service.incrementMessageCount('t');

    expect(update).not.toHaveBeenCalled();
    expect(task.messageCount).toBe(9999);
  });

  it('отклоняет несуществующую Задачу', async () => {
    const { service } = buildService();
    await expect(service.incrementMessageCount('ghost')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('TasksService.refreshMessageCount (Req 9.6, 9.7, 9.9)', () => {
  it('сохраняет насыщенное фактическое число Сообщений', async () => {
    const { service, update, countByTask } = buildService({
      t: makeTask({ id: 't', messageCount: 10 }),
    });
    countByTask.mockResolvedValueOnce(15000);

    await service.refreshMessageCount('t');
    expect(update).toHaveBeenCalledWith('t', { messageCount: 9999 });
  });

  it('не пишет, если отображаемое значение не изменилось', async () => {
    const { service, update, countByTask } = buildService({
      t: makeTask({ id: 't', messageCount: 7 }),
    });
    countByTask.mockResolvedValueOnce(7);

    await service.refreshMessageCount('t');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('TasksService.hasUnread — маркер непрочитанного (Req 9.8)', () => {
  it('true, когда есть непрочитанные Сообщения', async () => {
    const { service, countUnreadForUserByTask } = buildService();
    countUnreadForUserByTask.mockResolvedValueOnce(3);

    await expect(service.hasUnread('u1', 't1')).resolves.toBe(true);
    expect(countUnreadForUserByTask).toHaveBeenCalledWith('u1', 't1');
  });

  it('false, когда непрочитанных Сообщений нет', async () => {
    const { service, countUnreadForUserByTask } = buildService();
    countUnreadForUserByTask.mockResolvedValueOnce(0);

    await expect(service.hasUnread('u1', 't1')).resolves.toBe(false);
  });
});
