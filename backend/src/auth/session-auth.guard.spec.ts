import { ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AuthPrincipal } from './auth.types';
import { SessionAuthGuard, AuthenticatedRequest } from './session-auth.guard';
import { SessionTokenService } from './session-token.service';

/**
 * Модульные тесты {@link SessionAuthGuard} (Req 5.7, 19.10): извлечение токена
 * из заголовка `Authorization`, проверка сессии и присоединение субъекта.
 */
describe('SessionAuthGuard (Req 5.7, 19.10)', () => {
  let verify: jest.Mock;
  let guard: SessionAuthGuard;

  const principal: AuthPrincipal = {
    userId: 'user-1',
    tokenId: 'token-1',
    role: Role.EXECUTOR,
  };

  beforeEach(() => {
    verify = jest.fn();
    const sessionTokens = { verify } as unknown as SessionTokenService;
    guard = new SessionAuthGuard(sessionTokens);
  });

  /** Формирует поддельный ExecutionContext с заданным заголовком авторизации. */
  function contextFor(authorization?: string): {
    context: ExecutionContext;
    request: AuthenticatedRequest;
  } {
    const request = { headers: { authorization } } as unknown as AuthenticatedRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  it('пропускает запрос и присоединяет субъект при валидном токене', async () => {
    verify.mockResolvedValue(principal);
    const { context, request } = contextFor('Bearer good-token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good-token');
    expect(request.user).toEqual(principal);
  });

  it('отклоняет запрос без заголовка авторизации', async () => {
    const { context } = contextFor(undefined);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('отклоняет заголовок с иной схемой (не Bearer)', async () => {
    const { context } = contextFor('Basic abc123');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('пробрасывает отказ проверки сессии (аннулированный токен, Req 19.10)', async () => {
    verify.mockRejectedValue(new AuthenticationException('Сессия недействительна.'));
    const { context } = contextFor('Bearer revoked-token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
  });
});
