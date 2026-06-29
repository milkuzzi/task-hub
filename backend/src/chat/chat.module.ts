import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit';
import { AuthModule } from '../auth';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecurityModule } from '../security';
import { StatusModule } from '../status';
import { TasksModule } from '../tasks/tasks.module';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

/**
 * Модуль realtime-чата (Req 11.1–11.7, 10.1–10.3).
 *
 * Предоставляет:
 * - {@link ChatGateway} — Socket.IO Gateway с авторизацией подключения по
 *   сессии, комнатами по `userId` и `taskId` и примитивами рассылки Сообщений,
 *   Статусов и счётчиков, а также адресных уведомлений (задача 9.1);
 * - {@link ChatService} — отправку/редактирование/удаление Сообщений с правами
 *   Участников чата и авто-переходом Статуса Задачи по сообщению (задача 9.2,
 *   Req 11.3–11.7, 10.1–10.3).
 *
 * Зависимости:
 * - {@link AuthModule} — {@link SessionTokenService} (авторизация подключений)
 *   и общий {@link SocketSessionDisconnector} для аннулирования сессий ≤5с;
 * - {@link TasksModule} — {@link TasksService} (проверка принадлежности к
 *   Участникам чата, Req 11.2) и доступ к Задачам/счётчику Сообщений;
 * - {@link StatusModule} — чистый {@link StatusMachine} для авто-перехода
 *   Статуса по сообщению (Req 10.1–10.3);
 * - {@link AuditLogModule} — привязка порта {@link AUDIT_RECORDER} к реальному
 *   Журналу изменений: смена Статуса по сообщению фиксируется в неизменяемом
 *   Журнале (Req 20.1);
 * - {@link SecurityModule} — {@link RateLimiter} для ограничения частоты
 *   отправки Сообщений (чувствительная операция `send_message`): не более
 *   10 запросов с источника за скользящее окно 60с, избыточные отклоняются
 *   {@link RateLimitException} (Req 19.1, 19.2).
 *
 * Репозитории, {@link PrismaService}, {@link ClockService} и
 * {@link AppConfigService} доступны через глобальные модули без повторного
 * импорта.
 */
@Module({
  imports: [
    AuthModule,
    TasksModule,
    StatusModule,
    AuditLogModule,
    NotificationsModule,
    SecurityModule,
  ],
  providers: [ChatGateway, ChatService],
  controllers: [ChatController],
  exports: [ChatGateway, ChatService],
})
export class ChatModule {}
