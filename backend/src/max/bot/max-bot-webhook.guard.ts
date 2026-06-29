import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthenticationException } from '../../common/errors';
import { AppConfigService } from '../../config';

/** HTTP-заголовок с секретом webhook Бота MAX. */
export const MAX_BOT_WEBHOOK_TOKEN_HEADER = 'x-max-bot-api-secret';
const LEGACY_MAX_BOT_WEBHOOK_TOKEN_HEADER = 'x-max-bot-token';

/**
 * Guard аутентификации входящих webhook-запросов Бота MAX (Req 16.4).
 *
 * Эндпоинты Бота MAX доступны извне, поэтому защищаются общим секретом: каждый
 * входящий запрос должен нести заголовок {@link MAX_BOT_WEBHOOK_TOKEN_HEADER},
 * совпадающий с секретом webhook из конфигурации (`max.botWebhookSecret`). Запрос без
 * корректного токена отклоняется {@link AuthenticationException} (401), что не
 * позволяет постороннему источнику инициировать команды Бота от имени
 * Пользователей.
 *
 * Если secret в конфигурации не задан (пустая строка), Guard отклоняет все
 * запросы — это безопасное поведение по умолчанию: webhook не принимает команды,
 * пока интеграция не сконфигурирована, вместо того чтобы оставаться открытым.
 */
@Injectable()
export class MaxBotWebhookGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WebhookRequest>();
    const provided =
      request.headers[MAX_BOT_WEBHOOK_TOKEN_HEADER] ??
      request.headers[LEGACY_MAX_BOT_WEBHOOK_TOKEN_HEADER];
    const expected = this.config.max.botWebhookSecret;

    if (typeof expected !== 'string' || expected.length === 0) {
      throw new AuthenticationException('Webhook Бота MAX не сконфигурирован.');
    }
    if (typeof provided !== 'string' || !this.timingSafeEqual(provided, expected)) {
      throw new AuthenticationException('Недействительный токен webhook Бота MAX.');
    }
    return true;
  }

  /**
   * Сравнивает строки за постоянное время, чтобы исключить утечку секрета через
   * тайминг сравнения. Возвращает `false` при несовпадении длины.
   */
  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}

interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
}
