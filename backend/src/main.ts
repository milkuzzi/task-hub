import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config';

/**
 * Точка входа HTTP-приложения «Система поручений».
 *
 * - Маршрутизация `/api`: префикс НЕ задаётся на уровне Nest. И в продакшене
 *   (nginx `location /api/` с trailing-slash proxy_pass), и в dev (Vite rewrite)
 *   префикс `/api` срезается прокси до попадания в backend, поэтому контроллеры
 *   обслуживают «голые» пути (`/auth/login`, `/users`, …). Базовый URL клиента
 *   (`VITE_API_BASE_URL=/api`) согласуется именно через прокси, а не через
 *   глобальный префикс Nest (иначе пути удвоились бы → 404).
 * - CORS включён с передачей учётных данных: в режиме разработки фронтенд и
 *   backend обслуживаются с разных источников; в продакшене — один источник
 *   через Nginx (Req 1.4).
 * - Глобальные `ValidationPipe` и `AllExceptionsFilter` регистрируются
 *   `CommonModule` (APP_PIPE/APP_FILTER) и здесь не дублируются (Req 1.2).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);

  // CORS с передачей сессионных учётных данных (Req 1.4).
  app.enableCors({
    origin: config.isProduction ? config.app.publicUrl : true,
    credentials: true,
  });

  await app.listen(config.app.port);
}

void bootstrap();
