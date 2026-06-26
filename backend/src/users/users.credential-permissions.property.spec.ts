import fc from 'fast-check';
import { Role, User } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { PasswordSetupTokenService } from '../auth/password-setup-token.service';
import { SessionTokenService } from '../auth/session-token.service';
import { SessionRegistry } from '../infra';
import { SessionDisconnector } from '../auth/session-disconnector';
import { MaxOAuthPort } from '../max/oauth';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 16: Права изменения учётных данных и валидация**
 *
 * Property 16 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.7, 6.8**:
 *
 * Для любого актора, целевого пользователя и поля профиля:
 *  - пароль ({@link AuthService.changePassword}) может изменить только сам
 *    пользователь при верном текущем пароле; новый пароль принимается тогда и
 *    только тогда, когда его длина 8–128 и он не совпадает с текущим
 *    (Req 6.1, 6.7);
 *  - адрес электронной почты и отображаемое имя ({@link UsersService.updateProfile})
 *    может изменить только Администратор (Req 6.2, 6.3);
 *  - любая попытка изменить неразрешённое поле либо передать недопустимое
 *    значение отклоняется и оставляет сохранённые данные без изменений
 *    (Req 6.7, 6.8).
 *
 * Реализует ровно ОДНО свойство. Граница БД ({@link UserRepository}) подменяется
 * детерминированным stateful in-memory фейком с тем же контрактом (Map-хранилище,
 * `runInTransaction` со snapshot/restore при исключении — как атомарный откат
 * реальной БД). {@link PasswordService} замокан моделью открытого текста
 * (`verify`/`hash`), остальные зависимости — мок-объекты. Обращений к реальным
 * БД/Redis/SendPulse нет. Минимум 100 итераций fast-check (здесь — 300).
 *
 * Модель пароля: храним `passwordHash = hashed:<plaintext>`; `verify(plain, hash)`
 * истинно ⇔ `hash === hashed:<plain>`. Пароли пользователей уникальны, поэтому
 * «верный текущий пароль» доступен только самому владельцу — это и моделирует
 * требование «менять пароль может только сам пользователь» (Req 6.1).
 */
describe('Property 16: Права изменения учётных данных и валидация (Req 6.1, 6.2, 6.3, 6.7, 6.8)', () => {
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 128;
  const NOW = new Date('2024-06-01T12:00:00.000Z');

  const hashOf = (plain: string): string => `hashed:${plain}`;
  const passwordOf = (id: string): string => `pw-${id}-secret`;

  function makeUser(id: string, role: Role, index: number): User {
    return {
      id,
      email: `u${index}@example.com`,
      displayName: `Имя ${index}`,
      role,
      isActive: true,
      passwordHash: hashOf(passwordOf(id)),
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
    } as unknown as User;
  }

  /**
   * Создаёт stateful in-memory фейк {@link UserRepository}, общий для
   * {@link AuthService} и {@link UsersService}, плюс обе службы вокруг него.
   */
  function makeEnv(roles: Role[]) {
    const store = new Map<string, User>();
    const emailHistory = new Map<string, string[]>();

    // Состав: ровно один администратор + переданные неадминистраторы.
    store.set('u0', makeUser('u0', Role.ADMIN, 0));
    roles.forEach((role, i) => {
      const id = `u${i + 1}`;
      store.set(id, makeUser(id, role, i + 1));
    });

    const snapshot = () => {
      const copy = new Map<string, User>();
      for (const [id, u] of store) {
        copy.set(id, { ...u });
      }
      return copy;
    };
    const restore = (copy: Map<string, User>) => {
      store.clear();
      for (const [id, u] of copy) {
        store.set(id, u);
      }
    };

    const repository = {
      findActiveById: jest.fn(async (id: string) => {
        const u = store.get(id);
        return u && u.deletedAt === null ? u : null;
      }),
      findByEmail: jest.fn(async (email: string) => {
        for (const u of store.values()) {
          if (u.email === email) {
            return u;
          }
        }
        return null;
      }),
      countActiveAdmins: jest.fn(async () => {
        let n = 0;
        for (const u of store.values()) {
          if (u.role === Role.ADMIN && u.deletedAt === null) {
            n += 1;
          }
        }
        return n;
      }),
      update: jest.fn(async (id: string, data: Partial<User>) => {
        const current = store.get(id);
        if (current === undefined) {
          throw new Error(`update: пользователь ${id} не найден`);
        }
        const next = { ...current, ...data } as User;
        store.set(id, next);
        return next;
      }),
      addEmailToHistory: jest.fn(async (userId: string, email: string) => {
        const list = emailHistory.get(userId) ?? [];
        if (!list.includes(email)) {
          list.push(email);
        }
        emailHistory.set(userId, list);
      }),
      runInTransaction: jest.fn(async (fn: (tx: unknown) => unknown) => {
        const backup = snapshot();
        try {
          return await fn({});
        } catch (error) {
          restore(backup);
          throw error;
        }
      }),
    } as unknown as UserRepository;

    const passwords = {
      verify: jest.fn(async (plain: string, hash: string) => hash === hashOf(plain)),
      hash: jest.fn(async (plain: string) => hashOf(plain)),
    } as unknown as PasswordService;

    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      limits: {
        passwordMinLength: PASSWORD_MIN,
        passwordMaxLength: PASSWORD_MAX,
        avatarMaxBytes: 5 * 1024 * 1024,
      },
    } as unknown as AppConfigService;

    const auth = new AuthService(
      repository,
      passwords,
      { issue: jest.fn(), consume: jest.fn() } as unknown as PasswordSetupTokenService,
      { enqueue: jest.fn() } as unknown as MailerService,
      config,
      { issue: jest.fn() } as unknown as SessionTokenService,
      { now: jest.fn(() => NOW) } as unknown as ClockService,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );

    const users = new UsersService(
      repository,
      {
        findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
        setStatus: jest.fn(),
      } as unknown as TaskRepository,
      { revokeAllSessions: jest.fn(async () => 0) } as unknown as AuthService,
      { enqueue: jest.fn() } as unknown as MailerService,
      { now: jest.fn(() => NOW) } as unknown as ClockService,
      config,
      { store: jest.fn() } as unknown as AvatarStorage,
    );

    return { store, auth, users };
  }

  const validLen = (len: number): boolean => len >= PASSWORD_MIN && len <= PASSWORD_MAX;

  // ---- Генераторы операций ----------------------------------------------

  /** Изменение пароля: верный/неверный текущий + варианты нового пароля. */
  type PasswordOp = {
    kind: 'password';
    actor: number;
    target: number;
    currentCorrect: boolean;
    nextKind: 'valid' | 'tooShort' | 'tooLong' | 'sameAsCurrent';
  };

  /** Изменение email/имени: доступно только Администратору. */
  type ProfileOp = {
    kind: 'email' | 'displayName';
    actor: number;
    target: number;
    value: string;
  };

  type Op = PasswordOp | ProfileOp;

  const idxArb = fc.integer({ min: 0, max: 5 });

  const passwordOpArb: fc.Arbitrary<Op> = fc.record({
    kind: fc.constant<'password'>('password'),
    actor: idxArb,
    target: idxArb,
    currentCorrect: fc.boolean(),
    nextKind: fc.constantFrom('valid', 'tooShort', 'tooLong', 'sameAsCurrent'),
  });

  const validEmailArb = fc.stringMatching(/^[a-z]{1,8}$/).map((s) => `new-${s}@example.org`);
  const validNameArb = fc.stringMatching(/^[A-Za-zА-Яа-я0-9]{1,40}$/);

  const profileOpArb: fc.Arbitrary<Op> = fc.oneof(
    fc
      .record({ actor: idxArb, target: idxArb, value: validEmailArb })
      .map((r) => ({ kind: 'email', ...r }) as Op),
    fc
      .record({ actor: idxArb, target: idxArb, value: validNameArb })
      .map((r) => ({ kind: 'displayName', ...r }) as Op),
  );

  const opArb: fc.Arbitrary<Op> = fc.oneof(passwordOpArb, profileOpArb);

  it('пароль меняет только владелец при верном текущем (8–128, ≠ текущему); email/имя — только администратор; иначе отказ без изменений данных', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(Role.MANAGER, Role.EXECUTOR), { minLength: 1, maxLength: 4 }),
        opArb,
        async (roles, op) => {
          const { store, auth, users } = makeEnv(roles);
          const ids = [...store.keys()];
          const n = ids.length;
          const actorId = ids[op.actor % n]!;
          const targetId = ids[op.target % n]!;

          const before = { ...store.get(targetId)! };

          if (op.kind === 'password') {
            // Текущий пароль, который «предъявляет» актор. Верный пароль цели
            // знает только сам владелец, поэтому при actor !== target проверка
            // не пройдёт даже при currentCorrect (пароли уникальны) — это и есть
            // правило «менять может только сам пользователь» (Req 6.1).
            const current = op.currentCorrect
              ? passwordOf(actorId)
              : `${passwordOf(actorId)}#wrong`;

            const next =
              op.nextKind === 'valid'
                ? 'n'.repeat(12)
                : op.nextKind === 'tooShort'
                  ? 'n'.repeat(PASSWORD_MIN - 1)
                  : op.nextKind === 'tooLong'
                    ? 'n'.repeat(PASSWORD_MAX + 1)
                    : current; // sameAsCurrent

            // Оракул: успех ⇔ предъявленный текущий совпадает с сохранённым
            // паролем цели (значит, актор — владелец), длина нового в [8,128]
            // и новый ≠ предъявленному текущему (Req 6.1, 6.7).
            const currentMatchesTarget = current === passwordOf(targetId);
            const expectSuccess = currentMatchesTarget && validLen(next.length) && next !== current;

            if (expectSuccess) {
              await auth.changePassword(targetId, current, next);
              // Пароль обновлён только у цели; прочие поля без изменений.
              expect(store.get(targetId)!.passwordHash).toBe(hashOf(next));
              expect(store.get(targetId)!.email).toBe(before.email);
              expect(store.get(targetId)!.displayName).toBe(before.displayName);
            } else {
              await expect(auth.changePassword(targetId, current, next)).rejects.toBeInstanceOf(
                ValidationException,
              );
              // Отклонение оставляет сохранённый пароль без изменений (Req 6.7, 6.8).
              expect(store.get(targetId)!.passwordHash).toBe(before.passwordHash);
            }
          } else {
            // Изменение email/имени разрешено только Администратору (Req 6.2, 6.3, 6.8).
            const actorIsAdmin = store.get(actorId)!.role === Role.ADMIN;
            const patch = op.kind === 'email' ? { email: op.value } : { displayName: op.value };

            if (actorIsAdmin) {
              const updated = await users.updateProfile(actorId, targetId, patch);
              if (op.kind === 'email') {
                expect(updated.email).toBe(op.value);
                expect(updated.displayName).toBe(before.displayName);
              } else {
                expect(updated.displayName).toBe(op.value.trim());
                expect(updated.email).toBe(before.email);
              }
              // Пароль никогда не затрагивается изменением профиля.
              expect(store.get(targetId)!.passwordHash).toBe(before.passwordHash);
            } else {
              await expect(users.updateProfile(actorId, targetId, patch)).rejects.toBeInstanceOf(
                AccessDeniedException,
              );
              // Неавторизованная попытка не меняет ни одно поле (Req 6.8).
              expect(store.get(targetId)!.email).toBe(before.email);
              expect(store.get(targetId)!.displayName).toBe(before.displayName);
              expect(store.get(targetId)!.passwordHash).toBe(before.passwordHash);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
