import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppConfigModule } from './config';
import { ClockModule } from './clock';
import { CommonModule } from './common';
import { PrismaModule, RedisModule, QueueModule } from './infra';
import { RepositoriesModule } from './repositories';
import { MailerModule } from './mailer';
import { StatusModule } from './status';
import { UsersModule } from './users';
import { TasksModule } from './tasks';
import { AuditLogModule } from './audit';
import { AuthModule } from './auth';
import { ChatModule } from './chat';
import { StorageModule } from './storage';
import { AttachmentsModule } from './attachments';
import { NotificationsModule } from './notifications';
import { StatisticsModule } from './statistics';
import { SearchModule } from './search';
import { SecurityModule } from './security';
import { BackupModule } from './backup';
import { MaxIntegrationModule } from './max';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpsRedirectMiddleware } from './http-redirect';

/**
 * Корневой модуль приложения «Система поручений».
 *
 * Связывает все слои и доменные модули системы (задача 21.1, Req 10.13, 13.12,
 * 14.1):
 * - инфраструктура и общий слой: {@link CommonModule} (единый формат ошибок,
 *   Req 1.1), {@link AppConfigModule}, {@link ClockModule}, {@link PrismaModule},
 *   {@link RedisModule}, {@link QueueModule}, {@link RepositoriesModule},
 *   {@link MailerModule}, {@link StorageModule};
 * - доменные модули: {@link StatusModule}, {@link UsersModule},
 *   {@link TasksModule}, {@link AuditLogModule}, {@link AuthModule},
 *   {@link ChatModule}, {@link AttachmentsModule}, {@link NotificationsModule},
 *   {@link StatisticsModule}, {@link SearchModule}, {@link SecurityModule},
 *   {@link BackupModule}, {@link MaxIntegrationModule}.
 *
 * Сквозные потоки замыкаются через порты и прямые зависимости модулей:
 * Tasks/Chat → Notifications (`TASK_NOTIFIER`, `ChatNotificationRouter`,
 * Req 10.13, 13.12, 14.1) и Tasks/Chat → AuditLog (`AUDIT_RECORDER`, Req 20.1);
 * Gateway ↔ ChatService ↔ StatusMachine — внутри {@link ChatModule}.
 * Middleware перенаправления HTTP→HTTPS применяется ко всем маршрутам
 * (Req 1.3, 1.4).
 */
@Module({
  imports: [
    CommonModule,
    AppConfigModule,
    ClockModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    RepositoriesModule,
    MailerModule,
    StorageModule,
    StatusModule,
    UsersModule,
    TasksModule,
    AuditLogModule,
    AuthModule,
    ChatModule,
    AttachmentsModule,
    NotificationsModule,
    StatisticsModule,
    SearchModule,
    SecurityModule,
    BackupModule,
    MaxIntegrationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Перенаправление HTTP→HTTPS применяется ко всем входящим маршрутам.
    consumer.apply(HttpsRedirectMiddleware).forRoutes('*');
  }
}
