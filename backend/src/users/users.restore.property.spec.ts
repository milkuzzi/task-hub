import fc from 'fast-check';
import { Prisma, Role, User, UserEmail } from '@prisma/client';
import { StateConflictException } from '../common/errors';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 19: Восстановление удалённого пользователя**
 *
 * Property 19 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 7.2, 7.5**:
 *
 * Для любого удалённого (soft-delete) пользователя с непустой историей
 * сохранённых адресов и любого выбранного из этой истории адреса:
 * восстановление через {@link UsersService.restoreUser} создаёт активную
 * учётную запись (снятие пометки удаления, `isActive = true`, выбранный адрес,
 * роль без изменений) тогда и только тогда, когда выбранный адрес НЕ используется
 * другой активной учётной записью (Req 7.2). В противном случае восстановление
 * отклоняется конфликтом адреса, а данные удалённого пользователя остаются
 * без изменений (Req 7.5).
 *
 * Граница БД ({@link UserRepository}) подменяется детерминированным stateful
 * in-memory фейком с тем же контрактом: учётные записи и история адресов
 * (`UserEmail`) как Map; `findByEmail` соблюдает уникальность адреса (не более
 * одного владельца на адрес); `runInTransaction` моделирует атомарный откат при
 * исключении (snapshot/restore). Побочные зависимости ({@link AuthService},
 * {@link MailerService}, {@link ClockService}, {@link AvatarStorage},
 * {@link TaskRepository}) замоканы. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 150).
 */
describe('Property 19: Восстановление удалённого пользователя (Req 7.2, 7.5)', () => {
  const ADMIN_ID = 'admin';
  const ADMIN_EMAIL = 'admin@system.local';
  const TARGET_ID = 'target';
  /** Текущий адрес удалённого пользователя на момент удаления (хранится в записи и истории). */
  const CURRENT_EMAIL = 'current@deleted.example';
  const CONFLICT_ID = 'conflict-user';
  const BYSTANDER_ID = 'bystander-user';
  const BYSTANDER_EMAIL = 'bystander@example.com';

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
   * - `users` — Map учётных записей (администратор-инициатор, удалённый целевой
   *   пользователь и опциональные конфликтующий/посторонний активные пользователи).
   * - `emailHistory` — Map<userId, Set<email>>: сохранённые адреса пользователя.
   * - `findByEmail` соблюдает уникальность адреса: возвращает единственного
   *   владельца адреса (как уникальный столбец в БД).
   * - `runInTransaction` снимает снимок состояния и восстанавливает его при
   *   исключении, моделируя атомарный откат транзакции реальной БД (Req 7.5).
   */
  function makeFakeRepository(savedEmails: string[], extras: User[]) {
    const users = new Map<string, User>();
    users.set(ADMIN_ID, makeUser({ id: ADMIN_ID, role: Role.ADMIN, email: ADMIN_EMAIL }));
    // Целевой пользователь в состоянии soft-delete (Req 8.2): запись сохранена,
    // помечена удалённой, неактивна.
    users.set(
      TARGET_ID,
      makeUser({
        id: TARGET_ID,
        role: Role.EXECUTOR,
        email: CURRENT_EMAIL,
        isActive: false,
        deletedAt: new Date('2023-12-31T00:00:00Z'),
      }),
    );
    for (const u of extras) {
      users.set(u.id, u);
    }

    const emailHistory = new Map<string, Set<string>>();
    emailHistory.set(TARGET_ID, new Set<string>([...savedEmails, CURRENT_EMAIL]));

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
      findById: jest.fn(async (id: string) => users.get(id) ?? null),
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
      listEmails: jest.fn(async (userId: string): Promise<UserEmail[]> => {
        const set = emailHistory.get(userId) ?? new Set<string>();
        return [...set].map((email) => ({ userId, email }) as unknown as UserEmail);
      }),
      addEmailToHistory: jest.fn(async (userId: string, email: string): Promise<UserEmail> => {
        let set = emailHistory.get(userId);
        if (set === undefined) {
          set = new Set<string>();
          emailHistory.set(userId, set);
        }
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

    const targetSnapshot = (): User => ({ ...users.get(TARGET_ID)! });
    const historyOf = (userId: string): Set<string> =>
      new Set(emailHistory.get(userId) ?? new Set<string>());

    return { repository, users, targetSnapshot, historyOf };
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

  it('создаёт активную учётную запись тогда и только тогда, когда выбранный адрес свободен; иначе отклоняет и не меняет данные', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // Число сохранённых адресов-кандидатов для восстановления (Req 7.1, 7.3).
          candidateCount: fc.integer({ min: 1, max: 5 }),
          // Индекс выбираемого Администратором адреса из истории (Req 7.3).
          chosenIdx: fc.nat({ max: 50 }),
          // Выбранный адрес уже занят другой активной учётной записью (Req 7.5).
          conflict: fc.boolean(),
          // Присутствует посторонний активный пользователь с собственным адресом
          // (не конфликтует с выбранным) — проверяет, что он не мешает.
          bystander: fc.boolean(),
        }),
        async ({ candidateCount, chosenIdx, conflict, bystander }) => {
          // Кандидатные адреса истории (отличны от текущего CURRENT_EMAIL).
          const candidateEmails = Array.from(
            { length: candidateCount },
            (_, i) => `cand${i}@example.com`,
          );
          const chosenEmail = candidateEmails[chosenIdx % candidateCount]!;

          // Готовим дополнительные активные учётные записи, соблюдая уникальность
          // адреса: конфликтующий владелец занимает именно выбранный адрес.
          const extras: User[] = [];
          if (conflict) {
            extras.push(makeUser({ id: CONFLICT_ID, role: Role.EXECUTOR, email: chosenEmail }));
          }
          if (bystander) {
            extras.push(makeUser({ id: BYSTANDER_ID, role: Role.MANAGER, email: BYSTANDER_EMAIL }));
          }

          const { repository, users, targetSnapshot, historyOf } = makeFakeRepository(
            candidateEmails,
            extras,
          );
          const service = buildService(repository);

          // Эталон ожидаемого исхода: восстановление успешно тогда и только тогда,
          // когда выбранный адрес не принадлежит ДРУГОЙ учётной записи.
          const usedByOther = [...users.values()].some(
            (u) => u.id !== TARGET_ID && u.email === chosenEmail,
          );
          const expectedSuccess = !usedByOther;

          const before = targetSnapshot();
          const historyBefore = historyOf(TARGET_ID);

          let succeeded = false;
          let result: User | null = null;
          let error: unknown = null;
          try {
            result = await service.restoreUser(ADMIN_ID, TARGET_ID, chosenEmail);
            succeeded = true;
          } catch (e) {
            error = e;
          }

          // Двунаправленная эквивалентность (iff) исхода и условия занятости адреса.
          expect(succeeded).toBe(expectedSuccess);

          if (expectedSuccess) {
            // Создана активная учётная запись по выбранному адресу (Req 7.2).
            expect(result).not.toBeNull();
            expect(result!.deletedAt).toBeNull();
            expect(result!.isActive).toBe(true);
            expect(result!.email).toBe(chosenEmail);
            // Роль не изменяется при восстановлении.
            expect(result!.role).toBe(before.role);

            const after = targetSnapshot();
            expect(after.deletedAt).toBeNull();
            expect(after.isActive).toBe(true);
            expect(after.email).toBe(chosenEmail);
          } else {
            // Восстановление отклонено именно конфликтом адреса (Req 7.5).
            expect(error).toBeInstanceOf(StateConflictException);

            // Данные удалённого пользователя сохранены без изменений (Req 7.5):
            // запись всё ещё помечена удалённой, неактивна, адрес не изменён.
            const after = targetSnapshot();
            expect(after.deletedAt).toEqual(before.deletedAt);
            expect(after.isActive).toBe(false);
            expect(after.email).toBe(before.email);
            expect(after.role).toBe(before.role);

            // История адресов не изменилась (откат транзакции).
            const historyAfter = historyOf(TARGET_ID);
            expect([...historyAfter].sort()).toEqual([...historyBefore].sort());
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
