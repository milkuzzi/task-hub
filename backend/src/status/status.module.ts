import { Module } from '@nestjs/common';
import { StatusMachine } from './status.machine';

/**
 * Модуль конечного автомата статусов Задачи (Req 10).
 *
 * Предоставляет чистый, не имеющий зависимостей {@link StatusMachine},
 * используемый и при ручной смене статуса (TasksModule), и при авто-переключении
 * статуса из чата (ChatModule).
 */
@Module({
  providers: [StatusMachine],
  exports: [StatusMachine],
})
export class StatusModule {}
