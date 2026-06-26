import { Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { UserRepository } from '../repositories';
import { StatisticsRepository } from './statistics.repository';
import { StatisticsService } from './statistics.service';
import { DateRange, StatMessageRecord, StatTaskRecord } from './statistics.types';

/**
 * Модульные тесты {@link StatisticsService} (Req 17.1–17.8) с подменой
 * репозиториев и сервиса времени.
 *
 * Проверяются: ограничение доступа Администратором (Req 17), валидация
 * диапазона дат с сохранением состояния через выброс ошибки (Req 17.7),
 * включительная передача периода в репозиторий (Req 17.6) и делегирование
 * расчёта чистым функциям с признаком отсутствия данных (Req 17.8).
 */

const FIXED_NOW = new Date('2030-06-01T12:00:00Z');

function makeUser(id: string, role: Role): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role,
    isActive: true,
    deletedAt: null,
  } as unknown as User;
}

interface Fixture {
  users?: Record<string, User>;
  tasks?: StatTaskRecord[];
  messages?: StatMessageRecord[];
}

function buildService(fixture: Fixture = {}) {
  const users = fixture.users ?? {};

  const findTasksForStatistics = jest.fn(async () => fixture.tasks ?? []);
  const findMessagesForStatistics = jest.fn(async () => fixture.messages ?? []);
  const statisticsRepository = {
    findTasksForStatistics,
    findMessagesForStatistics,
  } as unknown as StatisticsRepository;

  const findActiveById = jest.fn(async (id: string) => users[id] ?? null);
  const userRepository = { findActiveById } as unknown as UserRepository;

  const clock = new ClockService({ now: () => FIXED_NOW });

  const service = new StatisticsService(statisticsRepository, userRepository, clock);
  return { service, findTasksForStatistics, findMessagesForStatistics };
}

describe('StatisticsService.compute — доступ (Req 17)', () => {
  it('отклоняет инициатора, который не найден или удалён', async () => {
    const { service } = buildService({ users: {} });
    await expect(service.compute('ghost')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('отклоняет Менеджера (не Администратора)', async () => {
    const { service } = buildService({ users: { mgr: makeUser('mgr', Role.MANAGER) } });
    await expect(service.compute('mgr')).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('разрешает Администратору', async () => {
    const { service } = buildService({ users: { adm: makeUser('adm', Role.ADMIN) } });
    await expect(service.compute('adm')).resolves.toBeDefined();
  });
});

describe('StatisticsService.compute — валидация периода (Req 17.7)', () => {
  it('отклоняет период, в котором дата начала позже даты окончания', async () => {
    const { service, findTasksForStatistics } = buildService({
      users: { adm: makeUser('adm', Role.ADMIN) },
    });
    const period: DateRange = {
      start: new Date('2030-02-01T00:00:00Z'),
      end: new Date('2030-01-01T00:00:00Z'),
    };

    await expect(service.compute('adm', period)).rejects.toBeInstanceOf(ValidationException);
    // Состояние не меняется: выборка данных не выполняется (Req 17.7).
    expect(findTasksForStatistics).not.toHaveBeenCalled();
  });

  it('принимает период, в котором начало равно окончанию', async () => {
    const sameInstant = new Date('2030-03-01T00:00:00Z');
    const { service } = buildService({ users: { adm: makeUser('adm', Role.ADMIN) } });
    await expect(
      service.compute('adm', { start: sameInstant, end: sameInstant }),
    ).resolves.toBeDefined();
  });
});

describe('StatisticsService.compute — расчёт и период (Req 17.1–17.8)', () => {
  it('передаёт период в репозитории и возвращает рассчитанную статистику', async () => {
    const period: DateRange = {
      start: new Date('2030-05-01T00:00:00Z'),
      end: new Date('2030-06-30T00:00:00Z'),
    };
    const tasks: StatTaskRecord[] = [
      {
        status: TaskStatus.DONE,
        deadline: new Date('2030-06-15T00:00:00Z'),
        createdAt: new Date('2030-05-01T00:00:00Z'),
        doneAt: new Date('2030-05-01T03:00:00Z'),
        executorIds: ['e1'],
        managerIds: ['m1'],
      },
      {
        status: TaskStatus.WAITING,
        deadline: new Date('2030-05-15T00:00:00Z'), // просрочена относительно FIXED_NOW
        createdAt: new Date('2030-05-02T00:00:00Z'),
        doneAt: null,
        executorIds: ['e1'],
        managerIds: ['m1'],
      },
    ];
    const { service, findTasksForStatistics, findMessagesForStatistics } = buildService({
      users: { adm: makeUser('adm', Role.ADMIN) },
      tasks,
      messages: [{ chatId: 'c1' }, { chatId: 'c1' }, { chatId: 'c2' }],
    });

    const stats = await service.compute('adm', period);

    expect(findTasksForStatistics).toHaveBeenCalledWith(period);
    expect(findMessagesForStatistics).toHaveBeenCalledWith(period);
    expect(stats.totalTasks).toBe(2);
    expect(stats.byStatus[TaskStatus.DONE]).toBe(1);
    expect(stats.byStatus[TaskStatus.WAITING]).toBe(1);
    expect(stats.overdueCount).toBe(1);
    expect(stats.overduePercent).toBe(50);
    expect(stats.averageCompletionHours).toBe(3);
    expect(stats.byManager).toEqual({ m1: 2 });
    expect(stats.byExecutor).toEqual({ e1: 2 });
    expect(stats.chatActivity).toEqual({ totalMessages: 3, activeChats: 2 });
    expect(stats.period).toEqual(period);
    expect(stats.noData).toBe(false);
  });

  it('без периода передаёт null в репозитории и считает по всем данным', async () => {
    const { service, findTasksForStatistics } = buildService({
      users: { adm: makeUser('adm', Role.ADMIN) },
    });

    const stats = await service.compute('adm');

    expect(findTasksForStatistics).toHaveBeenCalledWith(null);
    expect(stats.period).toBeNull();
    expect(stats.noData).toBe(true);
  });
});
