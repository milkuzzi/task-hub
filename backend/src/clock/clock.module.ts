import { Global, Module } from '@nestjs/common';
import { NOW_PROVIDER, systemNowProvider } from './clock.constants';
import { ClockService } from './clock.service';

/**
 * Глобальный модуль времени.
 * Предоставляет {@link ClockService} и провайдер «текущего момента»
 * ({@link NOW_PROVIDER}). По умолчанию используется системное время; в тестах
 * провайдер можно переопределить для детерминированного «сейчас». (Req 1.2)
 */
@Global()
@Module({
  providers: [{ provide: NOW_PROVIDER, useValue: systemNowProvider }, ClockService],
  exports: [ClockService, NOW_PROVIDER],
})
export class ClockModule {}
