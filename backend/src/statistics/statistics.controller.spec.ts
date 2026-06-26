import { Role, TaskStatus } from '@prisma/client';
import { Response } from 'express';
import { StreamableFile } from '@nestjs/common';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { UserRepository } from '../repositories';
import { StatisticsController } from './statistics.controller';
import { StatisticsExportService } from './statistics-export.service';
import { StatisticsService } from './statistics.service';
import { StatisticsFile } from './statistics.export';
import { Statistics } from './statistics.types';

/**
 * Контроллерные тесты {@link StatisticsController} (задача 8.3).
 *
 * Проверяют тонкую маршрутизацию HTTP → {@link StatisticsService}/{@link StatisticsExportService}:
 * проброс инициатора и разбор периода (Req 17.6), сопоставление доменной
 * {@link Statistics} в контракт фронтенда (имена участников, поля `statusCounts`/
 * `avgCompletionHours`/`hasData`), доступ только Администратора через проброс
 * отказа сервиса (Req 8.1, 17), отклонение некорректного диапазона без изменения
 * состояния (Req 8.3, 17.7) и отдачу файла экспорта потоком с заголовками
 * `Content-Type`/`Content-Disposition` (Req 8.2, 17.9). Доступ, валидация
 * диапазона и расчёт проверяются в тестах сервисов; здесь моделируется только
 * поведение контроллера.
 */
describe('StatisticsController', () => {
  function makeStatistics(): Statistics {
    return {
      byStatus: {
        [TaskStatus.IN_PROGRESS]: 3,
        [TaskStatus.WAITING]: 1,
        [TaskStatus.DONE]: 5,
        [TaskStatus.NEEDS_ADMIN]: 0,
        [TaskStatus.CANCELLED]: 2,
      },
      totalTasks: 11,
      overdueCount: 2,
      overduePercent: 18.2,
      averageCompletionHours: 12.5,
      byManager: { 'mgr-1': 4, 'mgr-2': 7 },
      byExecutor: { 'exec-1': 11 },
      chatActivity: { totalMessages: 42, activeChats: 6 },
      period: null,
      noData: false,
    };
  }

  function buildController(opts: { userId?: string; role?: Role } = {}): {
    controller: StatisticsController;
    statisticsService: { compute: jest.Mock };
    exportService: { export: jest.Mock };
    userRepository: { findById: jest.Mock };
    req: AuthenticatedRequest;
    res: Response;
    headers: Record<string, string>;
  } {
    const statisticsService = {
      compute: jest.fn().mockResolvedValue(makeStatistics()),
    };

    const exportService = {
      export: jest.fn(
        async (
          _adminId: string,
          _period: unknown,
          format: 'csv' | 'xlsx',
        ): Promise<StatisticsFile> => ({
          filename: `statistics.${format}`,
          mimeType:
            format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          content: Buffer.from('export-bytes'),
        }),
      ),
    };

    const displayNames: Record<string, string> = {
      'mgr-1': 'Менеджер Один',
      'mgr-2': 'Менеджер Два',
      'exec-1': 'Исполнитель Один',
    };
    const userRepository = {
      findById: jest.fn(async (id: string) => {
        const name = displayNames[id];
        return name === undefined ? null : ({ id, displayName: name } as unknown);
      }),
    };

    const controller = new StatisticsController(
      statisticsService as unknown as StatisticsService,
      exportService as unknown as StatisticsExportService,
      userRepository as unknown as UserRepository,
    );

    const req = {
      user: { userId: opts.userId ?? 'admin-1', tokenId: 't1', role: opts.role ?? Role.ADMIN },
    } as AuthenticatedRequest;

    const headers: Record<string, string> = {};
    const res = {
      set: jest.fn((value: Record<string, string>) => Object.assign(headers, value)),
    } as unknown as Response;

    return { controller, statisticsService, exportService, userRepository, req, res, headers };
  }

  it('рассчитывает статистику без периода и сопоставляет контракт фронтенда (Req 8.1, 17.1–17.8)', async () => {
    const { controller, statisticsService, req } = buildController();
    const view = await controller.compute({}, req);

    expect(statisticsService.compute).toHaveBeenCalledWith('admin-1', undefined);
    expect(view).toEqual({
      statusCounts: {
        [TaskStatus.IN_PROGRESS]: 3,
        [TaskStatus.WAITING]: 1,
        [TaskStatus.DONE]: 5,
        [TaskStatus.NEEDS_ADMIN]: 0,
        [TaskStatus.CANCELLED]: 2,
      },
      totalTasks: 11,
      overdueCount: 2,
      overduePercent: 18.2,
      avgCompletionHours: 12.5,
      byManager: [
        { userId: 'mgr-1', name: 'Менеджер Один', taskCount: 4 },
        { userId: 'mgr-2', name: 'Менеджер Два', taskCount: 7 },
      ],
      byExecutor: [{ userId: 'exec-1', name: 'Исполнитель Один', taskCount: 11 }],
      chatActivity: { messageCount: 42, activeChats: 6 },
      hasData: true,
    });
  });

  it('передаёт период из обеих границ в сервис (Req 17.6)', async () => {
    const { controller, statisticsService, req } = buildController();
    await controller.compute(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      req,
    );

    const [, period] = statisticsService.compute.mock.calls[0] as [
      string,
      { start: Date; end: Date },
    ];
    expect(period.start).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(period.end).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('отклоняет одиночную границу периода без обращения к сервису (Req 17.6)', async () => {
    const { controller, statisticsService, req } = buildController();
    await expect(
      controller.compute({ from: '2026-01-01T00:00:00.000Z' }, req),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(statisticsService.compute).not.toHaveBeenCalled();
  });

  it('подставляет идентификатор как имя, если участник не найден', async () => {
    const { controller, statisticsService, req } = buildController();
    statisticsService.compute.mockResolvedValueOnce({
      ...makeStatistics(),
      byManager: { 'ghost-1': 2 },
      byExecutor: {},
    });
    const view = await controller.compute({}, req);
    expect(view.byManager).toEqual([{ userId: 'ghost-1', name: 'ghost-1', taskCount: 2 }]);
  });

  it('пробрасывает отказ доступа не-Администратору без раскрытия (Req 8.1, 17)', async () => {
    const { controller, statisticsService, req } = buildController({ role: Role.MANAGER });
    statisticsService.compute.mockRejectedValueOnce(
      new AccessDeniedException('Просмотр статистики доступен только администратору.'),
    );
    await expect(controller.compute({}, req)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('пробрасывает ошибку некорректного диапазона из сервиса (Req 8.3, 17.7)', async () => {
    const { controller, statisticsService, req } = buildController();
    statisticsService.compute.mockRejectedValueOnce(
      new ValidationException('Дата начала периода не может быть позже даты окончания.'),
    );
    await expect(
      controller.compute({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, req),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('отдаёт CSV-файл потоком с заголовками типа и имени (Req 8.2, 17.9)', async () => {
    const { controller, exportService, req, res, headers } = buildController();
    const result = await controller.export(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'csv' },
      req,
      res,
    );
    expect(exportService.export).toHaveBeenCalledWith(
      'admin-1',
      { start: new Date('2026-01-01T00:00:00.000Z'), end: new Date('2026-02-01T00:00:00.000Z') },
      'csv',
    );
    expect(result).toBeInstanceOf(StreamableFile);
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['Content-Disposition']).toBe('attachment; filename="statistics.csv"');
  });

  it('отдаёт XLSX-файл с корректным именем (Req 8.2, 17.9)', async () => {
    const { controller, req, res, headers } = buildController();
    await controller.export(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'xlsx' },
      req,
      res,
    );
    expect(headers['Content-Disposition']).toBe('attachment; filename="statistics.xlsx"');
  });

  it('по умолчанию экспортирует в CSV при отсутствии формата (Req 17.9)', async () => {
    const { controller, exportService, req, res } = buildController();
    await controller.export(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      req,
      res,
    );
    expect(exportService.export).toHaveBeenCalledWith('admin-1', expect.anything(), 'csv');
  });

  it('требует период для экспорта без обращения к сервису (Req 17.9)', async () => {
    const { controller, exportService, req, res } = buildController();
    await expect(controller.export({ format: 'csv' }, req, res)).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(exportService.export).not.toHaveBeenCalled();
  });

  it('не выставляет заголовки файла при отказе экспорта (Req 17.7, 17.10)', async () => {
    const { controller, exportService, req, res, headers } = buildController({
      role: Role.MANAGER,
    });
    exportService.export.mockRejectedValueOnce(
      new AccessDeniedException('Просмотр статистики доступен только администратору.'),
    );
    await expect(
      controller.export(
        { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'csv' },
        req,
        res,
      ),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(headers['Content-Disposition']).toBeUndefined();
  });

  it('требует входа, если субъект не установлен (Req 1.5)', async () => {
    const { controller } = buildController();
    const anon = {} as AuthenticatedRequest;
    await expect(controller.compute({}, anon)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', StatisticsController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
