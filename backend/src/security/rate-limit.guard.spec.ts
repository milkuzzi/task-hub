import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitException } from '../common/errors';
import { RateLimiter } from './rate-limiter';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitResult, SensitiveOp } from './security.types';

describe('RateLimitGuard', () => {
  function buildContext(headers: Record<string, unknown> = {}, ip = '9.9.9.9'): ExecutionContext {
    const request = { headers, ip };
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function buildGuard(
    op: SensitiveOp | undefined,
    result: RateLimitResult,
  ): { guard: RateLimitGuard; check: jest.Mock } {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(op),
    } as unknown as Reflector;
    const check = jest.fn().mockResolvedValue(result);
    const rateLimiter = { check } as unknown as RateLimiter;
    return { guard: new RateLimitGuard(reflector, rateLimiter), check };
  }

  it('пропускает маршрут без метаданных @RateLimit без проверки', async () => {
    const { guard, check } = buildGuard(undefined, { allowed: true });
    await expect(guard.canActivate(buildContext())).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it('пропускает запрос, когда лимит не превышен', async () => {
    const { guard, check } = buildGuard('login', { allowed: true });
    await expect(guard.canActivate(buildContext({}, '1.1.1.1'))).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith('1.1.1.1', 'login');
  });

  it('выбрасывает RateLimitException при превышении лимита', async () => {
    const { guard } = buildGuard('upload', { allowed: false });
    await expect(guard.canActivate(buildContext())).rejects.toBeInstanceOf(RateLimitException);
  });

  it('использует левый адрес из X-Forwarded-For как источник', async () => {
    const { guard, check } = buildGuard('send_message', { allowed: true });
    await guard.canActivate(buildContext({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    expect(check).toHaveBeenCalledWith('203.0.113.7', 'send_message');
  });

  it('игнорирует некорректный X-Forwarded-For и использует request.ip', async () => {
    const { guard, check } = buildGuard('login', { allowed: true });
    await guard.canActivate(
      buildContext({ 'x-forwarded-for': 'spoofed-client, 10.0.0.1' }, '10.20.30.40'),
    );
    expect(check).toHaveBeenCalledWith('10.20.30.40', 'login');
  });
});
