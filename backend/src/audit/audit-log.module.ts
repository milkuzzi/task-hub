import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { AUDIT_RECORDER } from '../tasks/ports';
import { AuditController } from './audit.controller';
import { AuditEntryRepository } from './audit-entry.repository';
import { AuditLogService } from './audit-log.service';

/**
 * Модуль Журнала изменений Задач (Req 20).
 *
 * Предоставляет {@link AuditLogService} (запись и просмотр Журнала) и
 * {@link AuditEntryRepository} (append-only доступ к данным). Опирается на
 * глобальные модули: {@link RepositoriesModule} ({@link TaskRepository},
 * {@link UserRepository}), {@link PrismaModule} ({@link PrismaService}) и
 * {@link ClockModule} ({@link ClockService} — представление времени в MSK,
 * Req 20.1).
 *
 * Реализует порт журналирования {@link AuditRecorder}: к токену
 * {@link AUDIT_RECORDER} привязывается тот же экземпляр {@link AuditLogService}
 * (через `useExisting`), заменяя реализацию-заглушку `NoopAuditRecorder`. Модуль
 * экспортирует и сам сервис, и привязку токена, поэтому {@link TasksModule}
 * (импортирующий этот модуль) журналирует изменения через реальный Журнал, а не
 * заглушку (Req 20.1).
 */
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [
    AuditEntryRepository,
    AuditLogService,
    { provide: AUDIT_RECORDER, useExisting: AuditLogService },
  ],
  exports: [AuditLogService, AUDIT_RECORDER],
})
export class AuditLogModule {}
