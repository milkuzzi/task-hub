import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { SessionTokenService } from './session-token.service';
import { AccessTokenPayload } from './auth.types';

/**
 * Модульные тесты {@link SessionTokenService} (Req 5.7, 19.10) с подменой JWT,
 * реестра сессий и часов — без реальных Redis/подписи.
 */
describe('SessionTokenService (Req 5.7, 19.10)', () => {
  let signAsync: jest.Mock;
  let verifyAsync: jest.Mock;
  let register: jest.Mock;
  let isValid: jest.Mock;
  let now: jest.Mock;
  let service: SessionTokenService;

  const fixedNow = new Date('2024-01-01T12:00:00.000Z');

  beforeEach(() => {
    signAsync = jest.fn().mockResolvedValue('signed.jwt.token');
    verifyAsync = jest.fn();
    register = jest.fn().mockResolvedValue(undefined);
    isValid = jest.fn();
    now = jest.fn().mockReturnValue(fixedNow);

    const jwt = { signAsync, verifyAsync } as unknown as JwtService;
    const sessions = { register, isValid } as unknown as SessionRegistry;
    const clock = { now } as unknown as ClockService;
    const config = {
      auth: { jwtSecret: 'secret', accessTokenTtlSeconds: 900 },
    } as unknown as AppConfigService;

    service = new SessionTokenService(jwt, sessions, clock, config);
  });

  describe('issue', () => {
    it('подписывает токен и регистрирует сессию с корректным сроком (Req 5.7)', async () => {
      const result = await service.issue({ id: 'user-1', role: Role.MANAGER });

      const expiresAt = new Date(fixedNow.getTime() + 900 * 1000);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.userId).toBe('user-1');
      expect(result.role).toBe(Role.MANAGER);
      expect(result.expiresAt).toEqual(expiresAt);
      expect(typeof result.tokenId).toBe('string');

      const payload = signAsync.mock.calls[0][0] as AccessTokenPayload;
      expect(payload.sub).toBe('user-1');
      expect(payload.jti).toBe(result.tokenId);
      expect(payload.role).toBe(Role.MANAGER);

      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: result.tokenId,
          userId: 'user-1',
          expiresAt: expiresAt.toISOString(),
          createdAt: fixedNow.toISOString(),
        }),
      );
    });

    it('использует 24-часовой срок, когда конфигурация передаёт дефолт 86400 секунд', async () => {
      const jwt = { signAsync, verifyAsync } as unknown as JwtService;
      const sessions = { register, isValid } as unknown as SessionRegistry;
      const clock = { now } as unknown as ClockService;
      const config = {
        auth: { jwtSecret: 'secret', accessTokenTtlSeconds: 86400 },
      } as unknown as AppConfigService;
      const dayService = new SessionTokenService(jwt, sessions, clock, config);

      const result = await dayService.issue({ id: 'user-1', role: Role.MANAGER });

      const expiresAt = new Date(fixedNow.getTime() + 86400 * 1000);
      expect(result.expiresAt).toEqual(expiresAt);
      expect(signAsync).toHaveBeenCalledWith(expect.any(Object), { expiresIn: 86400 });
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expiresAt.toISOString(),
        }),
      );
    });
  });

  describe('verify', () => {
    it('возвращает субъект при валидном токене и активной сессии', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'token-1', role: Role.EXECUTOR });
      isValid.mockResolvedValue(true);

      const principal = await service.verify('token');

      expect(principal).toEqual({ userId: 'user-1', tokenId: 'token-1', role: Role.EXECUTOR });
      expect(isValid).toHaveBeenCalledWith('token-1');
    });

    it('отклоняет токен с недействительной подписью (Req 19.10)', async () => {
      verifyAsync.mockRejectedValue(new Error('invalid signature'));

      await expect(service.verify('bad')).rejects.toBeInstanceOf(AuthenticationException);
      expect(isValid).not.toHaveBeenCalled();
    });

    it('отклоняет токен с аннулированной сессией (Req 19.10)', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'token-1', role: Role.EXECUTOR });
      isValid.mockResolvedValue(false);

      await expect(service.verify('token')).rejects.toBeInstanceOf(AuthenticationException);
    });

    it('отклоняет токен с некорректной полезной нагрузкой', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'token-1', role: 'NOT_A_ROLE' });

      await expect(service.verify('token')).rejects.toBeInstanceOf(AuthenticationException);
      expect(isValid).not.toHaveBeenCalled();
    });
  });
});
