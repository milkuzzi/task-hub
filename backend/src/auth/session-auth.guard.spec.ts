import { ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AuthPrincipal } from './auth.types';
import { SessionAuthGuard, AuthenticatedRequest } from './session-auth.guard';
import { SessionTokenService } from './session-token.service';

/**
 * Модульные тесты {@link SessionAuthGuard} (Req 5.7, 19.10): извлечение токена
 * из HttpOnly-cookie/legacy `Authorization`, проверка сессии и присоединение субъекта.
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

  /** Формирует поддельный ExecutionContext с заданными auth-заголовками. */
  function contextFor(headers: { authorization?: string; cookie?: string } = {}): {
    context: ExecutionContext;
    request: AuthenticatedRequest;
  } {
    const request = { headers } as unknown as AuthenticatedRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  it('пропускает запрос и присоединяет субъект при валидном токене', async () => {
    verify.mockResolvedValue(principal);
    const { context, request } = contextFor({ authorization: 'Bearer good-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('good-token');
    expect(request.user).toEqual(principal);
  });

  it('пропускает запрос с токеном из HttpOnly-cookie', async () => {
    verify.mockResolvedValue(principal);
    const { context, request } = contextFor({ cookie: 'theme=dark; taskhub_session=cookie-token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('cookie-token');
    expect(request.user).toEqual(principal);
  });

  it('предпочитает явный bearer-токен cookie-сессии', async () => {
    verify.mockResolvedValue(principal);
    const { context } = contextFor({
      authorization: 'Bearer header-token',
      cookie: 'taskhub_session=cookie-token',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('header-token');
  });

  it('отклоняет запрос без заголовка авторизации', async () => {
    const { context } = contextFor();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('отклоняет заголовок с иной схемой (не Bearer)', async () => {
    const { context } = contextFor({ authorization: 'Basic abc123' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('пробрасывает отказ проверки сессии (аннулированный токен, Req 19.10)', async () => {
    verify.mockRejectedValue(new AuthenticationException('Сессия недействительна.'));
    const { context } = contextFor({ authorization: 'Bearer revoked-token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(AuthenticationException);
  });
});
