import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './errors';
import { createValidationPipe } from './validation';

/**
 * Глобальный общий модуль.
 *
 * Регистрирует сквозные элементы границы приложения:
 * - {@link AllExceptionsFilter} как глобальный фильтр исключений, благодаря чему
 *   все ошибки возвращаются в едином формате `{ code, message, details? }` с
 *   локализованными русскими сообщениями (Req 1.1);
 * - глобальный `ValidationPipe` (whitelist + transform) для валидации DTO на
 *   границе контроллеров; нарушения приводятся фильтром к единому формату ошибок.
 *
 * Здесь же доступны общие типы пагинации и ответов (см. `common/dto`).
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_PIPE,
      useFactory: createValidationPipe,
    },
  ],
})
export class CommonModule {}
