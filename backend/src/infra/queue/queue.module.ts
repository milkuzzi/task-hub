import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * Глобальный модуль фоновых очередей.
 * Экспортирует {@link QueueService} — фабрику очередей BullMQ
 * (email, MAX-уведомления, напоминания о дедлайнах, резервное копирование).
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
