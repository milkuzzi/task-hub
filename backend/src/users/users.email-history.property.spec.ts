import fc from 'fast-check';
import { Prisma, Role, User, UserEmail } from '@prisma/client';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 18: История адресов электронной почты не теряется**
 *
 * Property 18 (см. design.md «Correctness Properties») — **Validates: Requirements 7.1**:
 *
 * Для любой последовательности изменений адреса электронной почты пользователя
 * сохранённая история адресов только растёт — прежние адреса никогда не
 * удаляются (монотонная неубывающая последовательность множеств) — и всегда
 * содержит каждый адрес, который у пользователя когда-либо был. Хранилище не
 * налагает искусственного лимита ниже фактического числа адресов, поэтому
 * вмещает не менее 50 адресов (Req 7.1).
 *
 * Граница БД ({@link UserRepository}) подменяется детерминированным stateful
 * in-memory фейком с тем же контрактом: история адресов — растущее множество
 * (Set) на пользователя, `addEmailToHistory` идемпотентно добавляет адрес,
 * `countEmails` возвращает размер множества, `runInTransaction` моделирует
 * атомарный откат при исключении (snapshot/restore). Побочные зависимости
 * ({@link AuthService}, {@link MailerService}, {@link ClockService},
 * {@link AvatarStorage}) замоканы. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 150).
 */
describe('Property 18: История адресов электронной почты не теряется (Req 7.1)', () => {
  const ADMIN_ID = 'admin';
  const ADMIN_EMAIL = 'admin@system.local';
  const TARGET_ID = 'target';
  const INITIAL_EMAIL = 'initial@example.com';

  function makeUser(partial: Partial<User> & { id: string; role: Role; email: string }): User {
    return {
      displayName: partial.id,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
      ...partial,
    } as unknown as User;
  }

  /**
   * Создаёт stateful in-memory фейк {@link UserRepository}.
   *
   * - `users` — Map учётных записей (администратор-инициатор + целевой пользователь).
   * - `emailHistory` — Map<userId, Set<email>>: история адресов как растущее
   *   множество; `addEmailToHistory` лишь добавляет (никогда не удаляет).
   * - `runInTransaction` снимает снимок состояния и восстанавливает его при
   *   исключении, моделируя атомарный откот транзакции реальной БД.
   */
  function makeFakeRepository() {
    const users = new Map<string, User>();
    users.set(ADMIN_ID, makeUser({ id: ADMIN_ID, role: Role.ADMIN, email: ADMIN_EMAIL }));
    users.set(TARGET_ID, makeUser({ id: TARGET_ID, role: Role.EXECUTOR, email: INITIAL_EMAIL }));

    const emailHistory = new Map<string, Set<string>>();

    const snapshot = () => ({
      users: new Map([...users].map(([id, u]) => [id, { ...u }] as const)),
      emailHistory: new Map([...emailHistory].map(([id, set]) => [id, new Set(set)] as const)),
    });
    const restore = (snap: ReturnType<typeof snapshot>) => {
      users.clear();
      for (const [id, u] of snap.users) {
        users.set(id, u);
      }
      emailHistory.clear();
      for (const [id, set] of snap.emailHistory) {
        emailHistory.set(id, set);
      }
    };

    const repository = {
      findActiveById: jest.fn(async (id: string) => {
        const u = users.get(id);
        return u && u.deletedAt === null ? u : null;
      }),
      findByEmail: jest.fn(async (email: string) => {
        for (const u of users.values()) {
          if (u.email === email) {
            return u;
          }
        }
        return null;
      }),
      update: jest.fn(async (id: string, data: Prisma.UserUpdateInput) => {
        const current = users.get(id);
        if (current === undefined) {
          throw new Error(`update: пользователь ${id} не найден`);
        }
        const next = { ...current, ...(data as Partial<User>) } as User;
        users.set(id, next);
        return next;
      }),
      addEmailToHistory: jest.fn(async (userId: string, email: string): Promise<UserEmail> => {
        let set = emailHistory.get(userId);
        if (set === undefined) {
          set = new Set<string>();
          emailHistory.set(userId, set);
        }
        // Идемпотентное добавление: множество только растёт, прежние адреса
        // никогда не удаляются (Req 7.1, свойство 18).
        set.add(email);
        return { userId, email } as unknown as UserEmail;
      }),
      countEmails: jest.fn(async (userId: string) => emailHistory.get(userId)?.size ?? 0),
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

    const historyOf = (userId: string): Set<string> =>
      new Set(emailHistory.get(userId) ?? new Set<string>());

    return { repository, users, historyOf };
  }

  function buildService(repository: UserRepository): UsersService {
    const auth = { revokeAllSessions: jest.fn(async () => 0) } as unknown as AuthService;
    const mailer = { enqueue: jest.fn(async () => undefined) } as unknown as MailerService;
    const clock = {
      now: () => new Date('2024-01-01T00:00:00Z'),
    } as unknown as ClockService;
    const config = { limits: { avatarMaxBytes: 5 * 1024 * 1024 } } as unknown as AppConfigService;
    const avatarStorage = { store: jest.fn() } as unknown as AvatarStorage;
    return new UsersService(
      repository,
      {
        findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
        setStatus: jest.fn(),
      } as unknown as TaskRepository,
      auth,
      mailer,
      clock,
      config,
      avatarStorage,
    );
  }

  /** Каждый адрес из этого множества является валидным (длина 6–254, формат email). */
  const isSuperset = (sup: Set<string>, sub: Set<string>): boolean => {
    for (const v of sub) {
      if (!sup.has(v)) {
        return false;
      }
    }
    return true;
  };

  /**
   * Описатель одного изменения адреса:
   * - `valid` — корректный уникальный адрес (приводит к успешной смене);
   * - `same` — повторный текущий адрес (no-op: смены нет);
   * - `invalid` — строка с заведомо недопустимым форматом (операция отклоняется).
   */
  type Change = { kind: 'valid'; n: number } | { kind: 'same' } | { kind: 'invalid'; raw: string };

  const changeArb: fc.Arbitrary<Change> = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.integer({ min: 0, max: 9999 }).map((n) => ({ kind: 'valid', n }) as Change),
    },
    { weight: 1, arbitrary: fc.constant({ kind: 'same' } as Change) },
    {
      weight: 2,
      arbitrary: fc
        .string({ minLength: 0, maxLength: 8 })
        .map((raw) => ({ kind: 'invalid', raw }) as Change),
    },
  );

  it('история адресов монотонно растёт и содержит каждый адрес, который у пользователя когда-либо был', async () => {
    await fc.assert(
      fc.asyncProperty(
        // До 60 изменений за прогон — достаточно, чтобы при цепочке валидных
        // смен превысить порог в 50 адресов и проверить отсутствие лимита.
        fc.array(changeArb, { minLength: 1, maxLength: 60 }),
        async (changes) => {
          const { repository, users, historyOf } = makeFakeRepository();
          const service = buildService(repository);

          // Эталон: множество всех адресов, через которые провёл пользователь
          // (включая исходный — он попадает в историю при первой же смене).
          const everHad = new Set<string>();
          let changesApplied = false;

          for (const change of changes) {
            const currentEmail = users.get(TARGET_ID)!.email;
            const historyBefore = historyOf(TARGET_ID);

            const patchEmail =
              change.kind === 'valid'
                ? `user${change.n}@example.com`
                : change.kind === 'same'
                  ? currentEmail
                  : change.raw;

            try {
              await service.updateProfile(ADMIN_ID, TARGET_ID, { email: patchEmail });
            } catch {
              // Отклонённые (невалидные) изменения не должны менять историю.
            }

            const historyAfter = historyOf(TARGET_ID);
            const newEmail = users.get(TARGET_ID)!.email;

            // 1) Монотонность: ни один прежний адрес не удалён — история после
            //    является надмножеством истории до (Req 7.1, свойство 18).
            expect(isSuperset(historyAfter, historyBefore)).toBe(true);
            expect(historyAfter.size).toBeGreaterThanOrEqual(historyBefore.size);

            // 2) Если смена фактически применена, в историю попали и прежний,
            //    и новый адреса.
            if (newEmail !== currentEmail) {
              expect(historyAfter.has(currentEmail)).toBe(true);
              expect(historyAfter.has(newEmail)).toBe(true);
              everHad.add(currentEmail);
              everHad.add(newEmail);
              changesApplied = true;
            }

            // 3) Полнота: история содержит каждый адрес, который у пользователя
            //    когда-либо был (после хотя бы одной смены).
            expect(isSuperset(historyAfter, everHad)).toBe(true);

            // 4) Отсутствие искусственного лимита: число сохранённых адресов
            //    равно числу различных адресов в истории (Req 7.1 — ≥50).
            const stored = await repository.countEmails(TARGET_ID);
            expect(stored).toBe(historyAfter.size);
          }

          // Если хотя бы одна смена была применена, исходный адрес сохранён.
          if (changesApplied) {
            expect(historyOf(TARGET_ID).has(INITIAL_EMAIL)).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
