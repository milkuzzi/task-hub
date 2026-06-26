import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit';
import { AuthModule } from '../auth';
import { NotificationsModule } from '../notifications';
import { SearchModule } from '../search';
import { StatusModule } from '../status';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Модуль управления Задачами (Req 9, 10.12, 10.13, 20).
 *
 * Предоставляет {@link TasksService}. Опирается на глобальные модули:
 * {@link RepositoriesModule} (инъекция {@link TaskRepository},
 * {@link UserRepository} и {@link MessageRepository}) и {@link AppConfigModule}
 * ({@link AppConfigService} — границы параметров Задачи, Req 9.1).
 *
 * Журналирование изменений и уведомления о правках вынесены за порты
 * {@link AUDIT_RECORDER} и {@link TASK_NOTIFIER} (Req 10.13, 20.1).
 * Журналирование обеспечивает реальный {@link AuditLogModule} (задача 8.1):
 * импорт этого модуля привязывает токен {@link AUDIT_RECORDER} к
 * `AuditLogService`, поэтому изменения параметров/состава/статуса Задачи
 * попадают в неизменяемый Журнал (Req 20.1). Уведомления о правках обеспечивает
 * реальный {@link NotificationsModule} (задача 12.3): его импорт привязывает
 * токен {@link TASK_NOTIFIER} к `TaskNotifierAdapter`, поэтому при изменении
 * Названия/Описания/Дедлайна Исполнители и Менеджеры Задачи получают Уведомления
 * на сайт и через Бот MAX (Req 10.13, 13.4) — без изменения {@link TasksService}.
 */
@Module({
  imports: [AuditLogModule, NotificationsModule, AuthModule, SearchModule, StatusModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
