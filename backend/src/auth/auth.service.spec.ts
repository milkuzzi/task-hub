import { Role, User } from '@prisma/client';
import {
  AccessDeniedException,
  AuthenticationException,
  EntityNotFoundException,
  StateConflictException,
  UnprocessableException,
  ValidationException,
} from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { SessionRegistry } from '../infra';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { SessionDisconnector } from './session-disconnector';
import { AuthSession } from './auth.types';
import { MaxOAuthExchangeError, MaxOAuthPort } from '../max/oauth';

/**
 * Модульные тесты {@link AuthService} (Req 5.1–5.10, 15.1, 19.3–19.7) с
 * подменой репозитория, почты, токенов, хеширования, выпуска сессий и часов —
 * без реальных БД/Redis/SendPulse.
 */
describe('AuthService (Req 5)', () => {
  let findActiveById: jest.Mock;
  let findById: jest.Mock;
  let findByEmail: jest.Mock;
  let findActiveByEmail: jest.Mock;
  let create: jest.Mock;
  let update: jest.Mock;
  let runInTransaction: jest.Mock;
  let enqueue: jest.Mock;
  let issue: jest.Mock;
  let consume: jest.Mock;
  let hash: jest.Mock;
  let verify: jest.Mock;
  let issueSession: jest.Mock;
  let revokeAllForUser: jest.Mock;
  let disconnectUser: jest.Mock;
  let exchangeAuthCode: jest.Mock;
  let findActiveUserByMaxUserId: jest.Mock;
  let now: jest.Mock;
  let service: AuthService;

  const fixedNow = new Date('2024-01-01T12:00:00.000Z');

  const admin = {
    id: 'admin-id',
    email: 'admin@example.com',
    role: Role.ADMIN,
    isActive: true,
    deletedAt: null,
  } as unknown as User;

  const invited = {
    id: 'user-1',
    email: 'invitee@example.com',
    role: Role.EXECUTOR,
    isActive: false,
    deletedAt: null,
  } as unknown as User;

  const activeUser = {
    id: 'user-2',
    email: 'active@example.com',
    role: Role.EXECUTOR,
    isActive: true,
    deletedAt: null,
    passwordHash: 'stored-hash',
    failedLoginCount: 0,
    lockedUntil: null,
  } as unknown as User;

  const issuedSession: AuthSession = {
    accessToken: 'signed.jwt.token',
    tokenId: 'token-id',
    userId: 'user-2',
    role: Role.EXECUTOR,
    expiresAt: new Date('2024-01-01T12:15:00.000Z'),
  };

  beforeEach(() => {
    findActiveById = jest.fn();
    findById = jest.fn();
    findByEmail = jest.fn();
    findActiveByEmail = jest.fn();
    create = jest.fn();
    update = jest.fn();
    runInTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn({}));
    enqueue = jest.fn().mockResolvedValue(undefined);
    issue = jest.fn().mockResolvedValue('raw-token');
    consume = jest.fn();
    hash = jest.fn().mockResolvedValue('hashed-password');
    verify = jest.fn().mockResolvedValue(true);
    issueSession = jest.fn().mockResolvedValue(issuedSession);
    revokeAllForUser = jest.fn().mockResolvedValue(0);
    disconnectUser = jest.fn().mockResolvedValue(undefined);
    exchangeAuthCode = jest.fn();
    findActiveUserByMaxUserId = jest.fn();
    now = jest.fn().mockReturnValue(fixedNow);

    const repository = {
      findActiveById,
      findById,
      findByEmail,
      findActiveByEmail,
      create,
      update,
      runInTransaction,
      findActiveUserByMaxUserId,
    } as unknown as UserRepository;
    const passwords = { hash, verify } as unknown as PasswordService;
    const setupTokens = { issue, consume } as unknown as PasswordSetupTokenService;
    const mailer = { enqueue } as unknown as MailerService;
    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      auth: { jwtSecret: 'secret', accessTokenTtlSeconds: 900 },
      limits: {
        passwordMinLength: 8,
        passwordMaxLength: 128,
        passwordSetupTtlSeconds: 86400,
        loginMaxFailedAttempts: 5,
        loginLockoutSeconds: 900,
      },
    } as unknown as AppConfigService;
    const sessionTokens = { issue: issueSession } as unknown as SessionTokenService;
    const clock = { now } as unknown as ClockService;
    const sessions = { revokeAllForUser } as unknown as SessionRegistry;
    const disconnector = { disconnectUser } as unknown as SessionDisconnector;
    const maxOAuth = { exchangeAuthCode } as unknown as MaxOAuthPort;

    service = new AuthService(
      repository,
      passwords,
      setupTokens,
      mailer,
      config,
      sessionTokens,
      clock,
      sessions,
      disconnector,
      maxOAuth,
    );
  });

  describe('invite (Req 5.1-5.4, 15.1)', () => {
    it('создаёт неактивного пользователя, выпускает токен и ставит письмо в очередь', async () => {
      findActiveById.mockResolvedValue(admin);
      findByEmail.mockResolvedValue(null);
      create.mockResolvedValue(invited);

      const result = await service.invite('admin-id', 'invitee@example.com');

      expect(result).toBe(invited);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'invitee@example.com',
          role: Role.EXECUTOR,
          isActive: false,
        }),
        expect.anything(),
      );
      expect(issue).toHaveBeenCalledWith('user-1');
      expect(enqueue).toHaveBeenCalledTimes(1);
      const message = enqueue.mock.calls[0][0];
      expect(message.to).toBe('invitee@example.com');
      expect(message.text).toContain('raw-token');
    });

    it('отклоняет приглашение от не-администратора (Req 5.1, 5.2)', async () => {
      findActiveById.mockResolvedValue({ ...invited });

      await expect(service.invite('user-1', 'x@example.com')).rejects.toBeInstanceOf(
        AccessDeniedException,
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('отклоняет приглашение от неизвестного инициатора', async () => {
      findActiveById.mockResolvedValue(null);

      await expect(service.invite('ghost', 'x@example.com')).rejects.toBeInstanceOf(
        AccessDeniedException,
      );
    });

    it('отклоняет некорректный адрес электронной почты', async () => {
      findActiveById.mockResolvedValue(admin);

      await expect(service.invite('admin-id', 'bad')).rejects.toBeInstanceOf(ValidationException);
      expect(create).not.toHaveBeenCalled();
    });

    it('отклоняет занятый адрес электронной почты', async () => {
      findActiveById.mockResolvedValue(admin);
      findByEmail.mockResolvedValue(invited);

      await expect(service.invite('admin-id', 'invitee@example.com')).rejects.toBeInstanceOf(
        StateConflictException,
      );
      expect(create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('setPassword (Req 5.5, 5.6, 19.5-19.7)', () => {
    it('активирует учётную запись и сохраняет хеш пароля по действующей ссылке (Req 5.5)', async () => {
      consume.mockResolvedValue('user-1');
      findById.mockResolvedValue(invited);

      await service.setPassword('raw-token', 'valid-password');

      expect(consume).toHaveBeenCalledWith('raw-token');
      expect(hash).toHaveBeenCalledWith('valid-password');
      expect(update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          passwordHash: 'hashed-password',
          isActive: true,
          failedLoginCount: 0,
          lockedUntil: null,
        }),
      );
    });

    it('отклоняет недействительный/просроченный/использованный токен (Req 5.6, 19.6, 19.7)', async () => {
      consume.mockResolvedValue(null);

      await expect(service.setPassword('raw-token', 'valid-password')).rejects.toBeInstanceOf(
        UnprocessableException,
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет пароль вне диапазона до обращения к токену (Req 6.7)', async () => {
      await expect(service.setPassword('raw-token', 'short')).rejects.toBeInstanceOf(
        ValidationException,
      );
      expect(consume).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет установку для удалённой учётной записи', async () => {
      consume.mockResolvedValue('user-1');
      findById.mockResolvedValue({ ...invited, deletedAt: new Date() });

      await expect(service.setPassword('raw-token', 'valid-password')).rejects.toBeInstanceOf(
        UnprocessableException,
      );
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('login (Req 5.7-5.10, 19.3, 19.4)', () => {
    it('выпускает сессию при верных учётных данных и сбрасывает счётчик (Req 5.7)', async () => {
      findActiveByEmail.mockResolvedValue({ ...activeUser, failedLoginCount: 2 });
      verify.mockResolvedValue(true);

      const result = await service.login('active@example.com', 'correct', '127.0.0.1');

      expect(result).toBe(issuedSession);
      expect(verify).toHaveBeenCalledWith('correct', 'stored-hash');
      expect(update).toHaveBeenCalledWith('user-2', { failedLoginCount: 0, lockedUntil: null });
      expect(issueSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-2' }));
    });

    it('не трогает репозиторий при успешном входе без накопленных неудач', async () => {
      findActiveByEmail.mockResolvedValue({ ...activeUser });
      verify.mockResolvedValue(true);

      await service.login('active@example.com', 'correct', '127.0.0.1');

      expect(update).not.toHaveBeenCalled();
    });

    it('возвращает единый ответ для неизвестного адреса (Req 5.8)', async () => {
      findActiveByEmail.mockResolvedValue(null);

      const error = await service.login('ghost@example.com', 'x', '127.0.0.1').catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationException);
      expect(error.message).toBe('Неверный адрес электронной почты или пароль.');
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('возвращает тот же ответ при неверном пароле, не указывая поле (Req 5.8)', async () => {
      findActiveByEmail.mockResolvedValue({ ...activeUser });
      verify.mockResolvedValue(false);

      const error = await service.login('active@example.com', 'wrong', '127.0.0.1').catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationException);
      expect(error.message).toBe('Неверный адрес электронной почты или пароль.');
      expect(update).toHaveBeenCalledWith('user-2', { failedLoginCount: 1, lockedUntil: null });
    });

    it('блокирует учётную запись на 15 минут после 5-й неудачи (Req 5.9, 19.3)', async () => {
      findActiveByEmail.mockResolvedValue({ ...activeUser, failedLoginCount: 4 });
      verify.mockResolvedValue(false);

      await expect(
        service.login('active@example.com', 'wrong', '127.0.0.1'),
      ).rejects.toBeInstanceOf(AuthenticationException);

      const lockedUntil = new Date(fixedNow.getTime() + 900 * 1000);
      expect(update).toHaveBeenCalledWith('user-2', { failedLoginCount: 5, lockedUntil });
    });

    it('отклоняет вход при действующей блокировке даже с верным паролем (Req 5.10, 19.4)', async () => {
      const lockedUntil = new Date(fixedNow.getTime() + 60 * 1000);
      findActiveByEmail.mockResolvedValue({ ...activeUser, failedLoginCount: 5, lockedUntil });
      verify.mockResolvedValue(true);

      const error = await service
        .login('active@example.com', 'correct', '127.0.0.1')
        .catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationException);
      expect(error.message).toContain('временно заблокирована');
      expect(verify).not.toHaveBeenCalled();
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('после истечения блокировки счётчик отсчитывается заново', async () => {
      const expiredLock = new Date(fixedNow.getTime() - 1000);
      findActiveByEmail.mockResolvedValue({
        ...activeUser,
        failedLoginCount: 5,
        lockedUntil: expiredLock,
      });
      verify.mockResolvedValue(false);

      await expect(
        service.login('active@example.com', 'wrong', '127.0.0.1'),
      ).rejects.toBeInstanceOf(AuthenticationException);
      expect(update).toHaveBeenCalledWith('user-2', { failedLoginCount: 1, lockedUntil: null });
    });

    it('возвращает единый ответ для неактивной учётной записи (Req 5.8)', async () => {
      findActiveByEmail.mockResolvedValue({ ...activeUser, isActive: false, passwordHash: null });

      const error = await service.login('active@example.com', 'x', '127.0.0.1').catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationException);
      expect(error.message).toBe('Неверный адрес электронной почты или пароль.');
      expect(issueSession).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions (Req 3.4, 8.6, 8.7, 19.10)', () => {
    it('удаляет сессии из реестра и отправляет сигнал отключения сокетов', async () => {
      revokeAllForUser.mockResolvedValue(3);

      const result = await service.revokeAllSessions('user-2');

      expect(revokeAllForUser).toHaveBeenCalledWith('user-2');
      expect(disconnectUser).toHaveBeenCalledWith('user-2');
      expect(result).toBe(3);
    });

    it('сначала удаляет сессии из Redis, затем отключает сокеты', async () => {
      const order: string[] = [];
      revokeAllForUser.mockImplementation(async () => {
        order.push('revoke');
        return 1;
      });
      disconnectUser.mockImplementation(async () => {
        order.push('disconnect');
      });

      await service.revokeAllSessions('user-2');

      expect(order).toEqual(['revoke', 'disconnect']);
    });

    it('идемпотентен при отсутствии активных сессий', async () => {
      revokeAllForUser.mockResolvedValue(0);

      const result = await service.revokeAllSessions('user-without-sessions');

      expect(result).toBe(0);
      expect(disconnectUser).toHaveBeenCalledWith('user-without-sessions');
    });
  });

  describe('changePassword (Req 6.1, 6.7)', () => {
    it('меняет пароль при верном текущем и валидном новом (Req 6.1)', async () => {
      findActiveById.mockResolvedValue({ ...activeUser });
      verify.mockResolvedValue(true);
      hash.mockResolvedValue('new-hash');

      await service.changePassword('user-2', 'current-password', 'new-password');

      expect(verify).toHaveBeenCalledWith('current-password', 'stored-hash');
      expect(hash).toHaveBeenCalledWith('new-password');
      expect(update).toHaveBeenCalledWith('user-2', { passwordHash: 'new-hash' });
    });

    it('отклоняет новый пароль вне диапазона 8–128 без обращения к БД (Req 6.7)', async () => {
      await expect(
        service.changePassword('user-2', 'current-password', 'short'),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(findActiveById).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет при неверном текущем пароле и сохраняет пароль без изменений (Req 6.1, 6.7)', async () => {
      findActiveById.mockResolvedValue({ ...activeUser });
      verify.mockResolvedValue(false);

      await expect(
        service.changePassword('user-2', 'wrong-current', 'new-password'),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(hash).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет новый пароль, совпадающий с текущим (Req 6.7)', async () => {
      findActiveById.mockResolvedValue({ ...activeUser });
      verify.mockResolvedValue(true);

      await expect(
        service.changePassword('user-2', 'same-password', 'same-password'),
      ).rejects.toBeInstanceOf(ValidationException);
      expect(hash).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет смену пароля для несуществующей учётной записи', async () => {
      findActiveById.mockResolvedValue(null);

      await expect(
        service.changePassword('ghost', 'current-password', 'new-password'),
      ).rejects.toBeInstanceOf(EntityNotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it('отклоняет смену пароля для неактивированной учётной записи без пароля', async () => {
      findActiveById.mockResolvedValue({ ...activeUser, isActive: false, passwordHash: null });

      await expect(
        service.changePassword('user-2', 'current-password', 'new-password'),
      ).rejects.toBeInstanceOf(UnprocessableException);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('loginWithMax (Req 5.11, 16.1, 16.2, 16.3)', () => {
    it('выдаёт сессию при привязке профиля MAX к активному пользователю (Req 16.1)', async () => {
      exchangeAuthCode.mockResolvedValue('max-123');
      findActiveUserByMaxUserId.mockResolvedValue({ ...activeUser });

      const result = await service.loginWithMax('auth-code');

      expect(exchangeAuthCode).toHaveBeenCalledWith('auth-code');
      expect(findActiveUserByMaxUserId).toHaveBeenCalledWith('max-123');
      expect(issueSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-2' }));
      expect(result).toBe(issuedSession);
    });

    it('отклоняет вход, если профиль MAX не привязан ни к одному пользователю (Req 16.3)', async () => {
      exchangeAuthCode.mockResolvedValue('max-unknown');
      findActiveUserByMaxUserId.mockResolvedValue(null);

      await expect(service.loginWithMax('auth-code')).rejects.toBeInstanceOf(
        AuthenticationException,
      );
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('отклоняет вход при ошибке обмена кода авторизации на стороне MAX (Req 16.3)', async () => {
      exchangeAuthCode.mockRejectedValue(new MaxOAuthExchangeError('MAX отклонил авторизацию'));

      await expect(service.loginWithMax('bad-code')).rejects.toBeInstanceOf(
        AuthenticationException,
      );
      expect(findActiveUserByMaxUserId).not.toHaveBeenCalled();
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('не выдаёт сессию для удалённого/неактивированного пользователя (Req 16.1)', async () => {
      // Репозиторий не возвращает удалённые/неактивированные учётные записи —
      // моделируем это возвратом null, вход должен быть отклонён.
      exchangeAuthCode.mockResolvedValue('max-123');
      findActiveUserByMaxUserId.mockResolvedValue(null);

      await expect(service.loginWithMax('auth-code')).rejects.toBeInstanceOf(
        AuthenticationException,
      );
      expect(issueSession).not.toHaveBeenCalled();
    });

    it('никогда не создаёт учётную запись или привязку при входе через MAX (Req 5.11, 16.2)', async () => {
      exchangeAuthCode.mockResolvedValue('max-123');
      findActiveUserByMaxUserId.mockResolvedValue({ ...activeUser });

      await service.loginWithMax('auth-code');

      // Вход через MAX лишь аутентифицирует существующую учётную запись и не
      // выполняет регистрацию/создание привязки.
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });
});
