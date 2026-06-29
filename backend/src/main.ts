import { NestFactory } from '@nestjs/core';
import multipart from '@fastify/multipart';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module';
import { AppConfigService } from './config';
import { buildHttpsRedirectUrl, isSecureRequest } from './http-redirect';

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
  const adapter = new FastifyAdapter({ trustProxy: true });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);
  const config = app.get(AppConfigService);

  await app.register(multipart, {
    limits: {
      fieldNameSize: 100,
      fieldSize: 0,
      fields: 0,
      files: 1,
      fileSize: 25 * 1024 * 1024,
      parts: 1,
      headerPairs: 20,
    },
    throwFileSizeLimit: true,
  });

  adapter.setOnRequestHook((request: FastifyRequest, reply: FastifyReply, done) => {
    const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
    if (isSecureRequest({ protocol: request.protocol, forwardedProto })) {
      done();
      return;
    }

    const host = firstHeaderValue(request.headers.host);
    if (host === undefined || host.trim() === '') {
      done();
      return;
    }

    reply.redirect(buildHttpsRedirectUrl({ host, originalUrl: request.url }), 301);
  });

  // CORS с передачей сессионных учётных данных (Req 1.4).
  app.enableCors({
    origin: config.isProduction ? config.app.publicUrl : true,
    credentials: true,
  });

  await app.listen(config.app.port, '0.0.0.0');
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

void bootstrap();
