import { ExecutionContext } from '@nestjs/common';
import { AuthenticationException } from '../../common/errors';
import { AppConfigService } from '../../config';
import { MAX_BOT_WEBHOOK_TOKEN_HEADER, MaxBotWebhookGuard } from './max-bot-webhook.guard';

/** Создаёт guard с заданным ожидаемым токеном Бота из конфигурации. */
function createGuard(botToken: string): MaxBotWebhookGuard {
  const config = { max: { botToken } } as unknown as AppConfigService;
  return new MaxBotWebhookGuard(config);
}

/** Формирует контекст исполнения с заданным значением заголовка токена. */
function contextWithHeader(value?: string): ExecutionContext {
  const headers: Record<string, string> = {};
  if (value !== undefined) {
    headers[MAX_BOT_WEBHOOK_TOKEN_HEADER] = value;
  }
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('MaxBotWebhookGuard (Req 16.4)', () => {
  it('пропускает запрос с корректным токеном', () => {
    const guard = createGuard('secret-token');
    expect(guard.canActivate(contextWithHeader('secret-token'))).toBe(true);
  });

  it('отклоняет запрос с неверным токеном', () => {
    const guard = createGuard('secret-token');
    expect(() => guard.canActivate(contextWithHeader('wrong'))).toThrow(AuthenticationException);
  });

  it('отклоняет запрос без токена', () => {
    const guard = createGuard('secret-token');
    expect(() => guard.canActivate(contextWithHeader())).toThrow(AuthenticationException);
  });

  it('отклоняет все запросы при незаданном токене в конфигурации', () => {
    const guard = createGuard('');
    expect(() => guard.canActivate(contextWithHeader('anything'))).toThrow(AuthenticationException);
  });
});
