import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { MaxBotHttpApiAdapter } from '../max/bot/max-bot-http.adapter';
import { TASK_NOTIFIER } from '../tasks/ports';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { ChatNotificationRouter } from './chat-notification-router';
import { TaskNotificationRouter } from './task-notification-router';
import { TaskNotifierAdapter } from './task-notifier.adapter';
import { MAX_DELIVERY_PORT } from './delivery/max-delivery.port';
import { MaxDeliveryFilter } from './delivery/max-delivery-filter';
import { NotificationDeliveryService } from './delivery/notification-delivery.service';
import { NotificationDeliveryWorker } from './delivery/notification-delivery.worker';
import { SiteNotificationDispatcher } from './delivery/site-notification.dispatcher';
import { DeadlineReminderRepository } from './deadline-reminder.repository';
import { DeadlineReminderService } from './deadline-reminder.service';
import { DeadlineReminderWorker } from './deadline-reminder.worker';

/**
 * Модуль уведомлений (Req 13, 14, 15).
 *
 * Предоставляет формирование уведомлений по доменным событиям
 * {@link NotificationsService.emit} (отдельное уведомление на каждого
 * получателя без дайджеста и постановка в очередь доставки, Req 13.1, 13.12),
 * репозиторий-обёртку {@link NotificationRepository} над сущностью
 * `Notification` и маршрутизатор событий Задачи {@link TaskNotificationRouter}
 * (определение типа, получателей и полезной нагрузки Уведомлений по событиям
 * Задачи и смене роли Менеджера, Req 13.2–13.6, 13.11, 15.5, 15.6). Опирается
 * на глобальные инфраструктурные модули: {@link PrismaModule}
 * ({@link PrismaService}), {@link QueueModule} ({@link QueueService}),
 * {@link RedisModule} ({@link RedisService} — маркеры идемпотентности),
 * {@link ClockModule} ({@link ClockService} — моменты событий) и
 * {@link RepositoriesModule} ({@link TaskRepository} — состав участников).
 *
 * Реализует порт уведомлений о правках Задачи {@link TaskNotifier}: к токену
 * {@link TASK_NOTIFIER} привязывается {@link TaskNotifierAdapter}, заменяя
 * реализацию-заглушку `NoopTaskNotifier`. Модуль экспортирует сервис,
 * маршрутизатор и привязку токена, поэтому {@link TasksModule} (импортирующий
 * этот модуль) формирует реальные Уведомления Исполнителям и Менеджерам о
 * правках параметров Задачи (Req 10.13, 13.4), а не заглушку.
 *
 * Доставка по каналам с ретраями и независимостью сайта (задача 12.10)
 * реализована воркером {@link NotificationDeliveryWorker} поверх
 * {@link NotificationDeliveryService}: доставка на сайт через
 * {@link SiteNotificationDispatcher} фиксируется независимо от MAX (Req 14.6,
 * 15.7); доставка в MAX абстрагирована портом {@link MAX_DELIVERY_PORT} и
 * выполняется HTTP-адаптером Bot API MAX с ограничением попыток (≤3) и интервалами 5 мин /
 * 5 с / 30 с (Req 13.13, 14.6, 15.7). {@link SiteNotificationDispatcher}
 * экспортируется, чтобы ChatGateway зарегистрировал в нём realtime-доставку без
 * циклической зависимости модулей.
 *
 * Пороги напоминаний (задача 12.13) добавляются последующими задачами и
 * используют этот же обобщённый сервис.
 */
@Module({
  imports: [AuthModule],
  providers: [
    NotificationRepository,
    NotificationsService,
    TaskNotificationRouter,
    ChatNotificationRouter,
    TaskNotifierAdapter,
    { provide: TASK_NOTIFIER, useExisting: TaskNotifierAdapter },
    SiteNotificationDispatcher,
    MaxBotHttpApiAdapter,
    { provide: MAX_DELIVERY_PORT, useExisting: MaxBotHttpApiAdapter },
    MaxDeliveryFilter,
    NotificationDeliveryService,
    NotificationDeliveryWorker,
    DeadlineReminderRepository,
    DeadlineReminderService,
    DeadlineReminderWorker,
  ],
  controllers: [NotificationsController],
  exports: [
    NotificationsService,
    NotificationRepository,
    TaskNotificationRouter,
    ChatNotificationRouter,
    TASK_NOTIFIER,
    SiteNotificationDispatcher,
    NotificationDeliveryService,
    DeadlineReminderService,
    DeadlineReminderRepository,
  ],
})
export class NotificationsModule {}
