import fc from 'fast-check';
import { Role, User } from '@prisma/client';
import { UnprocessableException, ValidationException } from '../common/errors';
import { AppConfigService } from '../config';
import { MailerService } from '../mailer';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { SessionDisconnector } from './session-disconnector';
import { MaxOAuthPort } from '../max/oauth';

/**
 * **Feature: task-assignment-system, Property 13: Активация учётной записи**
 *
 * Property 13 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 5.4, 5.5**:
 *
 * Для любой учётной записи: она активируется тогда и только тогда, когда
 * пользователь установил пароль по действующей ссылке; до успешной отправки
 * регистрационного письма (то есть до вызова {@link AuthService.setPassword})
 * учётная запись остаётся неактивной.
 *
 * Тест реализует ровно это одно свойство. Все внешние границы
 * ({@link UserRepository}, {@link PasswordSetupTokenService},
 * {@link PasswordService}, {@link MailerService}) подменяются мок-объектами —
 * обращений к реальным БД/Redis/SendPulse нет. Минимум 100 итераций на
 * fast-check (здесь — 200).
 *
 * Логика проверяемого инварианта (по реализации {@link AuthService}):
 * - {@link AuthService.invite} создаёт учётную запись с `isActive = false` и
 *   ставит письмо в очередь; учётная запись остаётся неактивной независимо от
 *   исхода доставки письма (Req 5.4);
 * - {@link AuthService.setPassword} активирует учётную запись
 *   (`isActive = true`) тогда и только тогда, когда: пароль допустимой длины,
 *   ссылка действительна (токен потребляется успешно) и учётная запись
 *   существует и не удалена (Req 5.5); в любом ином случае операция
 *   отклоняется и учётная запись остаётся неактивной.
 */
describe('Property 13: Активация учётной записи (Req 5.4, 5.5)', () => {
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 128;

  /** Эталонный предикат допустимости длины пароля (Req 6.7, граница активации). */
  const isPasswordAcceptable = (password: string): boolean =>
    password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;

  /**
   * Генератор пароля, покрывающий обе области входного пространства:
   * допустимой длины (8–128) и недопустимой (пустой, слишком короткий,
   * слишком длинный).
   */
  const passwordArb = fc.oneof(
    // Допустимая длина 8–128.
    fc.string({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX }),
    // Слишком короткий (0–7).
    fc.string({ minLength: 0, maxLength: PASSWORD_MIN - 1 }),
    // Слишком длинный (129–200).
    fc.string({ minLength: PASSWORD_MAX + 1, maxLength: 200 }),
  );

  const admin = {
    id: 'admin-id',
    email: 'admin@example.com',
    role: Role.ADMIN,
    isActive: true,
    deletedAt: null,
  } as unknown as User;

  /**
   * Создаёт окружение сервиса со stateful-моками. Учётная запись приглашённого
   * пользователя моделируется изменяемым объектом, чтобы наблюдать факт её
   * активации через `update`.
   *
   * @param tokenValid Действительна ли ссылка установки пароля (токен
   *   потребляется успешно).
   * @param userDeleted Удалена ли учётная запись к моменту установки пароля.
   */
  const makeEnv = (tokenValid: boolean, userDeleted: boolean) => {
    // Изменяемое состояние учётной записи приглашённого пользователя.
    const account = {
      id: 'user-1',
      email: 'invitee@example.com',
      role: Role.EXECUTOR as Role,
      displayName: 'Приглашённый',
      isActive: false,
      passwordHash: null as string | null,
      deletedAt: userDeleted ? new Date() : null,
      failedLoginCount: 0,
      lockedUntil: null as Date | null,
    };

    const findActiveById = jest.fn().mockResolvedValue(admin);
    const findById = jest.fn().mockResolvedValue(account);
    const findByEmail = jest.fn().mockResolvedValue(null);
    const create = jest.fn(async (data: Partial<typeof account>) => {
      account.isActive = data.isActive ?? account.isActive;
      account.email = (data.email as string) ?? account.email;
      account.displayName = (data.displayName as string) ?? account.displayName;
      account.role = (data.role as Role) ?? account.role;
      return account as unknown as User;
    });
    const update = jest.fn(async (_id: string, patch: Partial<typeof account>) => {
      Object.assign(account, patch);
      return account as unknown as User;
    });
    const runInTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn({}));

    const repository = {
      findActiveById,
      findById,
      findByEmail,
      create,
      update,
      addEmailToHistory: jest
        .fn()
        .mockResolvedValue({ userId: 'user-1', email: 'invitee@example.com' }),
      runInTransaction,
    } as unknown as UserRepository;

    const passwords = {
      hash: jest.fn().mockResolvedValue('hashed-password'),
    } as unknown as PasswordService;

    const setupTokens = {
      issue: jest.fn().mockResolvedValue('raw-token'),
      // Действительная ссылка → возвращает userId; недействительная → null.
      consume: jest.fn().mockResolvedValue(tokenValid ? 'user-1' : null),
    } as unknown as PasswordSetupTokenService;

    const enqueue = jest.fn().mockResolvedValue(undefined);
    const mailer = { enqueue } as unknown as MailerService;

    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      limits: {
        passwordMinLength: PASSWORD_MIN,
        passwordMaxLength: PASSWORD_MAX,
        passwordSetupTtlSeconds: 86400,
      },
    } as unknown as AppConfigService;

    const service = new AuthService(
      repository,
      passwords,
      setupTokens,
      mailer,
      config,
      { issue: jest.fn() } as unknown as SessionTokenService,
      { now: jest.fn(() => new Date()) } as unknown as ClockService,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );
    return { service, account, enqueue, update };
  };

  it('учётная запись активна ⇔ пароль установлен по действующей ссылке; до установки — неактивна', async () => {
    await fc.assert(
      fc.asyncProperty(
        passwordArb,
        fc.boolean(),
        fc.boolean(),
        async (password, tokenValid, userDeleted) => {
          const { service, account, enqueue, update } = makeEnv(tokenValid, userDeleted);

          // 1. Приглашение создаёт неактивную учётную запись и ставит письмо в
          //    очередь. До установки пароля учётная запись остаётся неактивной
          //    независимо от факта/исхода отправки письма (Req 5.4).
          await service.invite('admin-id', 'invitee@example.com', 'Приглашённый');
          expect(account.isActive).toBe(false);
          expect(enqueue).toHaveBeenCalledTimes(1);
          expect(account.passwordHash).toBeNull();

          // Ожидаемая активация возможна только при действующей ссылке,
          // допустимом пароле и существующей (не удалённой) учётной записи.
          const expectActivation = isPasswordAcceptable(password) && tokenValid && !userDeleted;

          if (expectActivation) {
            // 2. Установка пароля по действующей ссылке активирует учётную
            //    запись (Req 5.5).
            await service.setPassword('raw-token', password);
            expect(account.isActive).toBe(true);
            expect(account.passwordHash).toBe('hashed-password');
            expect(update).toHaveBeenCalledWith(
              'user-1',
              expect.objectContaining({ isActive: true, passwordHash: 'hashed-password' }),
            );
          } else {
            // 3. Любой иной случай (неверная длина пароля, недействительная
            //    ссылка, удалённая учётная запись) — операция отклоняется, а
            //    учётная запись остаётся неактивной.
            const expectedError = isPasswordAcceptable(password)
              ? UnprocessableException
              : ValidationException;
            await expect(service.setPassword('raw-token', password)).rejects.toBeInstanceOf(
              expectedError,
            );
            expect(account.isActive).toBe(false);
            expect(account.passwordHash).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
