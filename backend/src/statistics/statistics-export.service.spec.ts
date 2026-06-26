import { TaskStatus } from '@prisma/client';
import {
  AccessDeniedException,
  AppException,
  ErrorCode,
  ValidationException,
} from '../common/errors';
import { StatisticsExportService } from './statistics-export.service';
import { StatisticsService } from './statistics.service';
import { DateRange, Statistics } from './statistics.types';

/**
 * Модульные тесты прикладного сервиса экспорта статистики (Req 17.9, 17.10).
 *
 * Проверяют переиспользование расчёта/прав через {@link StatisticsService.compute},
 * корректное формирование файла и обработку ошибок формирования с сохранением
 * рассчитанной статистики.
 */

const PERIOD: DateRange = {
  start: new Date('2024-01-01T00:00:00.000Z'),
  end: new Date('2024-01-31T23:59:00.000Z'),
};

function makeStatistics(): Statistics {
  return {
    byStatus: {
      [TaskStatus.IN_PROGRESS]: 1,
      [TaskStatus.WAITING]: 0,
      [TaskStatus.DONE]: 2,
      [TaskStatus.NEEDS_ADMIN]: 0,
      [TaskStatus.CANCELLED]: 0,
    } as Record<TaskStatus, number>,
    totalTasks: 3,
    overdueCount: 0,
    overduePercent: 0,
    averageCompletionHours: 1.5,
    byManager: { 'mgr-1': 3 },
    byExecutor: { 'exec-1': 3 },
    chatActivity: { totalMessages: 10, activeChats: 2 },
    period: PERIOD,
    noData: false,
  };
}

interface Harness {
  service: StatisticsExportService;
  compute: jest.Mock;
  formatMsk: jest.Mock;
}

function buildHarness(options: { compute?: jest.Mock; formatMsk?: jest.Mock } = {}): Harness {
  const compute = options.compute ?? jest.fn().mockResolvedValue(makeStatistics());
  const formatMsk = options.formatMsk ?? jest.fn((date: Date) => date.toISOString());
  const statisticsService = { compute } as unknown as StatisticsService;
  const clock = { formatMsk } as unknown as { formatMsk: (d: Date) => string };
  const service = new StatisticsExportService(statisticsService, clock as never);
  return { service, compute, formatMsk };
}

describe('StatisticsExportService.export (Req 17.9, 17.10)', () => {
  it('рассчитывает статистику за период и возвращает CSV-файл', async () => {
    const { service, compute } = buildHarness();
    const file = await service.export('admin-1', PERIOD, 'csv');

    expect(compute).toHaveBeenCalledWith('admin-1', PERIOD);
    expect(file.filename).toBe('statistics.csv');
    expect(file.content.length).toBeGreaterThan(0);
  });

  it('возвращает XLSX-файл при выборе формата xlsx', async () => {
    const { service } = buildHarness();
    const file = await service.export('admin-1', PERIOD, 'xlsx');
    expect(file.filename).toBe('statistics.xlsx');
    // Контейнер XLSX — ZIP (сигнатура PK).
    expect(file.content.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  });

  it('пробрасывает отказ в доступе из compute (только Администратор)', async () => {
    const compute = jest.fn().mockRejectedValue(new AccessDeniedException());
    const { service } = buildHarness({ compute });
    await expect(service.export('user-1', PERIOD, 'csv')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('пробрасывает ошибку валидации диапазона из compute (Req 17.7)', async () => {
    const compute = jest.fn().mockRejectedValue(new ValidationException('Некорректный диапазон.'));
    const { service } = buildHarness({ compute });
    await expect(service.export('admin-1', PERIOD, 'csv')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('при ошибке формирования файла прерывает экспорт ошибкой формирования (Req 17.10)', async () => {
    const formatMsk = jest.fn(() => {
      throw new Error('boom');
    });
    const { service } = buildHarness({ formatMsk });
    // Период не пуст, поэтому форматтер будет вызван при построении строки периода.
    await expect(service.export('admin-1', PERIOD, 'csv')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    await expect(service.export('admin-1', PERIOD, 'csv')).rejects.toBeInstanceOf(AppException);
  });
});
