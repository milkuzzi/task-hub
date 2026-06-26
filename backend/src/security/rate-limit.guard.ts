import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { isIP } from 'node:net';
import { RateLimitException } from '../common/errors';
import { RateLimiter } from './rate-limiter';
import { RATE_LIMIT_OP_KEY } from './rate-limit.decorator';
import { SensitiveOp } from './security.types';

/**
 * Guard, применяющий ограничение частоты запросов к HTTP-обработчикам
 * чувствительных операций, помеченным декоратором `@RateLimit(op)` (Req 19.1,
 * 19.2).
 *
 * Источником считается IP-адрес клиента; при превышении лимита запрос
 * отклоняется {@link RateLimitException} (HTTP 429) до выполнения обработчика.
 * Маршруты без метаданных `@RateLimit` пропускаются без проверки.
 *
 * Подключается точечно к контроллерам чувствительных операций
 * (`@UseGuards(RateLimitGuard)`). Для Socket.IO Gateway (отправка сообщения)
 * и иных не-HTTP путей используется прямой вызов {@link RateLimiter.check} с
 * операцией `'send_message'`, поскольку guard'ы маршрутов к ним неприменимы.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const op = this.reflector.getAllAndOverride<SensitiveOp | undefined>(RATE_LIMIT_OP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Маршрут не помечен как чувствительная операция — ограничение не применяется.
    if (op === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const source = this.resolveSource(request);

    const { allowed } = await this.rateLimiter.check(source, op);
    if (!allowed) {
      throw new RateLimitException();
    }
    return true;
  }

  /**
   * Определяет источник запроса. Предпочитается левый адрес из
   * `X-Forwarded-For` (за обратным прокси Nginx), иначе — `request.ip`.
   */
  private resolveSource(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    const headerValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof headerValue === 'string' && headerValue.trim() !== '') {
      const [first] = headerValue.split(',');
      const candidate = first?.trim() ?? '';
      if (isIP(candidate) !== 0) {
        return candidate;
      }
    }
    return request.ip ?? 'unknown';
  }
}
