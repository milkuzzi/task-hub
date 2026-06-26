import { TaskStatus } from '@prisma/client';
import {
  ALL_TASK_STATUSES,
  computeAverageCompletionHours,
  computeChatActivity,
  computeOverdue,
  computeStatistics,
  countByParticipant,
  countByStatus,
  isOverdue,
  roundToOneDecimal,
} from './statistics.math';
import { StatMessageRecord, StatTaskRecord } from './statistics.types';

/**
 * Модульные тесты чистых функций расчёта статистики (Req 17.1–17.5, 17.8).
 *
 * Проверяются конкретные примеры и граничные случаи: подсчёт по статусам с
 * включением нулевых, классификация и доля просрочек с округлением, среднее
 * время выполнения (включая отсутствие выполненных), разрезы по участникам с
 * дедупликацией, активность чатов и сборка итоговой статистики с признаком
 * отсутствия данных.
 */

const NOW = new Date('2030-06-01T12:00:00Z');

function makeTask(overrides: Partial<StatTaskRecord> = {}): StatTaskRecord {
  return {
    status: TaskStatus.IN_PROGRESS,
    deadline: new Date('2030-07-01T00:00:00Z'),
    createdAt: new Date('2030-05-01T00:00:00Z'),
    doneAt: null,
    executorIds: [],
    managerIds: [],
    ...overrides,
  };
}

describe('roundToOneDecimal (Req 17.2, 17.3)', () => {
  it('округляет до одного знака после запятой по правилу «половина вверх»', () => {
    expect(roundToOneDecimal(33.333_333)).toBe(33.3);
    expect(roundToOneDecimal(66.666_666)).toBe(66.7);
    expect(roundToOneDecimal(0.05)).toBe(0.1);
    expect(roundToOneDecimal(0)).toBe(0);
  });
});

describe('countByStatus (Req 17.1)', () => {
  it('включает все существующие статусы, в том числе с нулевым количеством', () => {
    const counts = countByStatus([
      makeTask({ status: TaskStatus.IN_PROGRESS }),
      makeTask({ status: TaskStatus.IN_PROGRESS }),
      makeTask({ status: TaskStatus.DONE }),
    ]);

    for (const status of ALL_TASK_STATUSES) {
      expect(counts[status]).toBeDefined();
    }
    expect(counts[TaskStatus.IN_PROGRESS]).toBe(2);
    expect(counts[TaskStatus.DONE]).toBe(1);
    expect(counts[TaskStatus.CANCELLED]).toBe(0);
  });

  it('сумма по статусам равна общему числу задач', () => {
    const tasks = [makeTask(), makeTask({ status: TaskStatus.WAITING }), makeTask()];
    const counts = countByStatus(tasks);
    const sum = ALL_TASK_STATUSES.reduce((acc, s) => acc + counts[s], 0);
    expect(sum).toBe(tasks.length);
  });
});

describe('isOverdue / computeOverdue (Req 17.2)', () => {
  it('считает задачу просроченной, если дедлайн прошёл и статус не «Выполнено»', () => {
    const task = makeTask({
      deadline: new Date('2030-05-01T00:00:00Z'),
      status: TaskStatus.WAITING,
    });
    expect(isOverdue(task, NOW)).toBe(true);
  });

  it('не считает просроченной выполненную задачу с прошедшим дедлайном', () => {
    const task = makeTask({ deadline: new Date('2030-05-01T00:00:00Z'), status: TaskStatus.DONE });
    expect(isOverdue(task, NOW)).toBe(false);
  });

  it('не считает просроченной задачу с будущим дедлайном', () => {
    const task = makeTask({ deadline: new Date('2030-12-01T00:00:00Z') });
    expect(isOverdue(task, NOW)).toBe(false);
  });

  it('считает долю просроченных в процентах с округлением до десятых', () => {
    const tasks = [
      makeTask({ deadline: new Date('2030-05-01T00:00:00Z') }), // просрочена
      makeTask({ deadline: new Date('2030-12-01T00:00:00Z') }),
      makeTask({ deadline: new Date('2030-12-01T00:00:00Z') }),
    ];
    const { overdueCount, overduePercent } = computeOverdue(tasks, NOW);
    expect(overdueCount).toBe(1);
    expect(overduePercent).toBe(33.3);
  });

  it('возвращает нулевую долю при отсутствии задач (без деления на ноль)', () => {
    expect(computeOverdue([], NOW)).toEqual({ overdueCount: 0, overduePercent: 0 });
  });
});

describe('computeAverageCompletionHours (Req 17.3)', () => {
  it('возвращает 0 при отсутствии выполненных задач', () => {
    expect(
      computeAverageCompletionHours([makeTask(), makeTask({ status: TaskStatus.WAITING })]),
    ).toBe(0);
  });

  it('усредняет интервалы создание→выполнение в часах с округлением', () => {
    const tasks = [
      makeTask({
        status: TaskStatus.DONE,
        createdAt: new Date('2030-05-01T00:00:00Z'),
        doneAt: new Date('2030-05-01T02:00:00Z'), // 2 ч
      }),
      makeTask({
        status: TaskStatus.DONE,
        createdAt: new Date('2030-05-01T00:00:00Z'),
        doneAt: new Date('2030-05-01T05:00:00Z'), // 5 ч
      }),
    ];
    expect(computeAverageCompletionHours(tasks)).toBe(3.5);
  });

  it('игнорирует задачи со статусом «Выполнено», но без момента завершения', () => {
    const tasks = [
      makeTask({ status: TaskStatus.DONE, doneAt: null }),
      makeTask({
        status: TaskStatus.DONE,
        createdAt: new Date('2030-05-01T00:00:00Z'),
        doneAt: new Date('2030-05-01T04:00:00Z'),
      }),
    ];
    expect(computeAverageCompletionHours(tasks)).toBe(4);
  });
});

describe('countByParticipant (Req 17.4)', () => {
  it('считает задачи в разрезе менеджеров и исполнителей', () => {
    const tasks = [
      makeTask({ managerIds: ['m1'], executorIds: ['e1', 'e2'] }),
      makeTask({ managerIds: ['m1', 'm2'], executorIds: ['e1'] }),
    ];
    const { byManager, byExecutor } = countByParticipant(tasks);
    expect(byManager).toEqual({ m1: 2, m2: 1 });
    expect(byExecutor).toEqual({ e1: 2, e2: 1 });
  });

  it('учитывает задачу по участнику один раз даже при дублирующихся идентификаторах', () => {
    const tasks = [makeTask({ managerIds: ['m1', 'm1'], executorIds: ['e1', 'e1'] })];
    const { byManager, byExecutor } = countByParticipant(tasks);
    expect(byManager).toEqual({ m1: 1 });
    expect(byExecutor).toEqual({ e1: 1 });
  });
});

describe('computeChatActivity (Req 17.5)', () => {
  it('считает общее число сообщений и число чатов с сообщениями', () => {
    const messages: StatMessageRecord[] = [{ chatId: 'c1' }, { chatId: 'c1' }, { chatId: 'c2' }];
    expect(computeChatActivity(messages)).toEqual({ totalMessages: 3, activeChats: 2 });
  });

  it('возвращает нули при отсутствии сообщений', () => {
    expect(computeChatActivity([])).toEqual({ totalMessages: 0, activeChats: 0 });
  });
});

describe('computeStatistics (Req 17.8)', () => {
  it('выставляет признак отсутствия данных и нулевые показатели для пустого набора', () => {
    const stats = computeStatistics({ tasks: [], messages: [], period: null, now: NOW });
    expect(stats.noData).toBe(true);
    expect(stats.totalTasks).toBe(0);
    expect(stats.overdueCount).toBe(0);
    expect(stats.overduePercent).toBe(0);
    expect(stats.averageCompletionHours).toBe(0);
    expect(stats.chatActivity).toEqual({ totalMessages: 0, activeChats: 0 });
  });

  it('не выставляет признак отсутствия данных при наличии задач или сообщений', () => {
    const withTasks = computeStatistics({
      tasks: [makeTask()],
      messages: [],
      period: null,
      now: NOW,
    });
    expect(withTasks.noData).toBe(false);

    const withMessages = computeStatistics({
      tasks: [],
      messages: [{ chatId: 'c1' }],
      period: null,
      now: NOW,
    });
    expect(withMessages.noData).toBe(false);
  });
});
