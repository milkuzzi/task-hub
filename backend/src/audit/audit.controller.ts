import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AccessDeniedException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { AuditLogService } from './audit-log.service';
import { AuditEntryView, toAuditEntryView } from './audit-representation';

/**
 * HTTP-слой Журнала изменений Задачи (Req 8.4 спеки; исходное ТЗ Req 20.2, 20.3).
 *
 * Тонкий контроллер над {@link AuditLogService}: маршрутизирует
 * `GET /tasks/:id/audit` на {@link AuditLogService.list} и формирует
 * представление контракта `frontend/src/lib/audit-api.ts`. Права просмотра
 * (только Менеджер Задачи и Администратор) и порядок записей (новые → старые)
 * обеспечивает сервис — контроллер не дублирует проверки. Маршрут требует
 * действующей Сессии ({@link SessionAuthGuard}); глобальный префикс `/api`
 * применяется в `main.ts`. Доменные исключения (в т.ч. отказ доступа без
 * раскрытия содержимого, Req 20.3) преобразуются глобальным фильтром в единый
 * формат `{ code, message }` (Req 1.1).
 */
@Controller()
@UseGuards(SessionAuthGuard)
export class AuditController {
  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * Возвращает Журнал изменений Задачи, упорядоченный от новых к старым
   * (Req 8.4; исходное ТЗ Req 20.2, 20.3). Делегирует
   * {@link AuditLogService.list}; доступ Менеджеру Задачи/Администратору и отказ
   * прочим проверяет сервис. Момент изменения сериализуется в ISO-8601 (UTC) с
   * дополнительным представлением MSK.
   */
  @Get('tasks/:id/audit')
  async list(
    @Param('id') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AuditEntryView[]> {
    const actorId = this.principal(req).userId;
    const entries = await this.auditLogService.list(actorId, taskId);
    return entries.map(toAuditEntryView);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
