import { Role } from '@prisma/client';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { AuditController } from './audit.controller';
import { AuditLogService } from './audit-log.service';
import { AuditLogEntryView } from './audit-log.types';

/**
 * Контроллерные тесты {@link AuditController} (задача 8.3).
 *
 * Проверяют тонкую маршрутизацию `GET /tasks/:id/audit` →
 * {@link AuditLogService.list}: проброс инициатора и идентификатора Задачи,
 * сохранение порядка записей (новые → старые), сопоставление момента изменения
 * в ISO-8601 (UTC) для контракта фронтенда (Req 8.4, 20.1, 20.2) и проброс
 * отказа доступа без раскрытия содержимого (Req 20.3). Права просмотра и порядок
 * записей обеспечивает сервис — здесь моделируется только поведение контроллера.
 */
describe('AuditController', () => {
  const TASK_ID = 'task-1';
  const NEWER = new Date('2026-06-19T12:00:00.000Z');
  const OLDER = new Date('2026-06-18T09:30:00.000Z');

  function makeEntries(): AuditLogEntryView[] {
    return [
      {
        id: 'a2',
        taskId: TASK_ID,
        authorId: 'user-1',
        field: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: 'DONE',
        changedAt: NEWER,
        changedAtMsk: '19.06.2026 15:00',
      },
      {
        id: 'a1',
        taskId: TASK_ID,
        authorId: null,
        field: 'title',
        oldValue: 'Старое',
        newValue: 'Новое',
        changedAt: OLDER,
        changedAtMsk: '18.06.2026 12:30',
      },
    ];
  }

  function buildController(opts: { userId?: string; role?: Role } = {}): {
    controller: AuditController;
    auditLogService: { list: jest.Mock };
    req: AuthenticatedRequest;
  } {
    const auditLogService = {
      list: jest.fn().mockResolvedValue(makeEntries()),
    };
    const controller = new AuditController(auditLogService as unknown as AuditLogService);
    const req = {
      user: { userId: opts.userId ?? 'manager-1', tokenId: 't1', role: opts.role ?? Role.MANAGER },
    } as AuthenticatedRequest;
    return { controller, auditLogService, req };
  }

  it('делегирует list и сопоставляет записи в контракт с ISO-моментом (Req 8.4, 20.1, 20.2)', async () => {
    const { controller, auditLogService, req } = buildController();
    const result = await controller.list(TASK_ID, req);

    expect(auditLogService.list).toHaveBeenCalledWith('manager-1', TASK_ID);
    expect(result).toEqual([
      {
        id: 'a2',
        taskId: TASK_ID,
        authorId: 'user-1',
        field: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: 'DONE',
        changedAt: NEWER.toISOString(),
        changedAtMsk: '19.06.2026 15:00',
      },
      {
        id: 'a1',
        taskId: TASK_ID,
        authorId: null,
        field: 'title',
        oldValue: 'Старое',
        newValue: 'Новое',
        changedAt: OLDER.toISOString(),
        changedAtMsk: '18.06.2026 12:30',
      },
    ]);
  });

  it('сохраняет порядок записей сервиса (новые → старые) (Req 20.2)', async () => {
    const { controller, req } = buildController();
    const result = await controller.list(TASK_ID, req);
    expect(result.map((e) => e.id)).toEqual(['a2', 'a1']);
  });

  it('пробрасывает отказ доступа без раскрытия содержимого (Req 20.3)', async () => {
    const { controller, auditLogService, req } = buildController({ userId: 'outsider-1' });
    auditLogService.list.mockRejectedValueOnce(
      new AccessDeniedException('Недостаточно прав для просмотра журнала изменений задачи.'),
    );
    await expect(controller.list(TASK_ID, req)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('пробрасывает отсутствие Задачи как доменную ошибку (Req 8.4)', async () => {
    const { controller, auditLogService, req } = buildController();
    auditLogService.list.mockRejectedValueOnce(new EntityNotFoundException('Задача не найдена.'));
    await expect(controller.list('missing', req)).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('требует входа, если субъект не установлен (Req 1.5)', async () => {
    const { controller } = buildController();
    const anon = {} as AuthenticatedRequest;
    await expect(controller.list(TASK_ID, anon)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', AuditController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
