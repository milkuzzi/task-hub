import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { configuration } from './configuration';
import { envValidationSchema } from './env.validation';
import { AppConfigService } from './app-config.service';

/**
 * Глобальный модуль конфигурации.
 * Загружает и валидирует переменные окружения (БД, Redis, SendPulse, MAX, S3,
 * пороги напоминаний, лимиты) и экспортирует типизированный {@link AppConfigService}.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
      envFilePath: ['.env.local', '.env'],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
