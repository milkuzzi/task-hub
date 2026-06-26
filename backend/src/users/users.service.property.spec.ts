import fc from 'fast-check';
import { isEmail } from 'class-validator';
import { Role, User } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { EMAIL_MAX_LENGTH, EMAIL_MIN_LENGTH, validatePrimaryAdminEmail } from './email-validation';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 11: Валидация адреса электронной почты при создании администратора**
 *
 * Property 11 (см. design.md «Correctness Properties») — **Validates: Requirements 4.1, 4.3**:
 *
 * Для любой строки длиной вне диапазона 6–254 ИЛИ не соответствующей формату
 * email команда создания первичного администратора отклоняется и администратор
 * не создаётся; для корректного email при отсутствии существующего
 * администратора создаётся ровно один администратор.
 *
 * Тест реализует ровно это одно свойство. Граница БД ({@link UserRepository})
 * подменяется мок-объектом — обращений к реальной базе нет. Минимум 100 итераций
 * на fast-check (здесь — 200).
 */
describe('Property 11: Валидация адреса электронной почты при создании администратора (Req 4.1, 4.3)', () => {
  /**
   * Эталонный предикат корректности по требованиям 4.1 (длина 6–254) и 4.3
   * (формат email). Используется как независимый «оракул» ожидаемого результата.
   */
  const isAcceptable = (value: string): boolean =>
    value.length >= EMAIL_MIN_LENGTH && value.length <= EMAIL_MAX_LENGTH && isEmail(value);

  /**
   * Широкий генератор строк, покрывающий все интересующие области входного
   * пространства: слишком короткие, слишком длинные, корректной длины но не
   * email, а также валидные адреса. Предикат {@link isAcceptable} затем
   * разбивает выборку на принимаемые/отклоняемые случаи.
   */
  const candidateString = fc.oneof(
    // Произвольные строки любой длины.
    fc.string({ minLength: 0, maxLength: 300 }),
    // Заведомо слишком короткие (0–5 символов).
    fc.string({ minLength: 0, maxLength: EMAIL_MIN_LENGTH - 1 }),
    // Заведомо слишком длинные (255–320 символов).
    fc.string({ minLength: EMAIL_MAX_LENGTH + 1, maxLength: 320 }),
    // Корректной длины, но почти наверняка не email (без структуры адреса).
    fc.string({ minLength: EMAIL_MIN_LENGTH, maxLength: 40 }),
    // Валидные адреса электронной почты (часть из них может пройти проверку).
    fc.emailAddress(),
    // Сконструированные валидные адреса гарантированной структуры.
    fc
      .tuple(
        fc.stringMatching(/^[a-z0-9]{1,20}$/),
        fc.stringMatching(/^[a-z0-9]{1,20}$/),
        fc.constantFrom('com', 'org', 'ru', 'net', 'io'),
      )
      .map(([local, domain, tld]) => `${local}@${domain}.${tld}`),
  );

  /** Создаёт мок-репозиторий «чистой» системы без существующего администратора. */
  const makeRepository = (createdAdmin: User) => {
    const countActiveAdmins = jest.fn().mockResolvedValue(0);
    const findByEmail = jest.fn().mockResolvedValue(null);
    const create = jest.fn().mockResolvedValue(createdAdmin);
    const runInTransaction = jest.fn((fn: (tx: unknown) => unknown) => fn({}));
    const repository = {
      countActiveAdmins,
      findByEmail,
      create,
      runInTransaction,
    } as unknown as UserRepository;
    return { repository, countActiveAdmins, findByEmail, create };
  };

  it('принимает ⇔ длина 6–254 И корректный формат; иначе отклоняет без создания администратора', async () => {
    await fc.assert(
      fc.asyncProperty(candidateString, async (value) => {
        const expectedAcceptable = isAcceptable(value);

        // Чистая функция валидации согласована с эталонным предикатом (Req 4.1, 4.3).
        expect(validatePrimaryAdminEmail(value).valid).toBe(expectedAcceptable);

        const createdAdmin = {
          id: 'admin-id',
          email: value,
          role: Role.ADMIN,
          isActive: false,
        } as unknown as User;
        const { repository, create } = makeRepository(createdAdmin);
        const service = new UsersService(
          repository,
          {
            findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
            setStatus: jest.fn(),
          } as unknown as TaskRepository,
          { revokeAllSessions: jest.fn() } as unknown as AuthService,
          { enqueue: jest.fn() } as unknown as MailerService,
          { now: jest.fn(() => new Date()) } as unknown as ClockService,
          { limits: { avatarMaxBytes: 5 * 1024 * 1024 } } as unknown as AppConfigService,
          { store: jest.fn() } as unknown as AvatarStorage,
        );

        if (!expectedAcceptable) {
          // Невалидная строка: операция отклонена, администратор не создан (Req 4.3).
          await expect(service.createPrimaryAdmin(value)).rejects.toBeInstanceOf(
            ValidationException,
          );
          expect(create).not.toHaveBeenCalled();
        } else {
          // Валидный email при отсутствии администратора: создан ровно один (Req 4.1).
          const result = await service.createPrimaryAdmin(value);
          expect(result).toBe(createdAdmin);
          expect(create).toHaveBeenCalledTimes(1);
          expect(create).toHaveBeenCalledWith(
            expect.objectContaining({ email: value, role: Role.ADMIN }),
            expect.anything(),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
