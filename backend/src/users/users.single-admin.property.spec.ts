import fc from 'fast-check';
import { Role, User } from '@prisma/client';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 4: Инвариант единственного администратора**
 *
 * Property 4 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 2.2, 2.11, 3.1, 3.3, 4.4, 8.8**:
 *
 * Для любой последовательности допустимых операций над пользователями
 * (создание первичного администратора, смена роли, передача роли
 * администратора) число активных администраторов в системе остаётся ровно
 * равным 1; любая операция, которая привела бы к нулю или более чем одному
 * администратору, отклоняется и оставляет роли без изменений.
 *
 * Граница БД ({@link UserRepository}) подменяется детерминированным in-memory
 * фейком с тем же контрактом: stateful-хранилище в Map, `countActiveAdmins`,
 * а также `runInTransaction`, передающий tx-клиент и моделирующий откат
 * транзакции при исключении (snapshot/restore) — как реальная БД. Побочные
 * зависимости ({@link AuthService}, {@link MailerService}, {@link ClockService})
 * замоканы. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 *
 * Примечание: операция удаления (`deleteUser`) на текущем этапе в
 * {@link UsersService} ещё не реализована (задача плана 3.19), поэтому
 * последовательности составляются из реализованных операций, изменяющих состав
 * администраторов: создание, смена роли и передача роли. Все они проверяются на
 * сохранение инварианта.
 */
describe('Property 4: Инвариант единственного администратора (Req 2.2, 2.11, 3.1, 3.3, 4.4, 8.8)', () => {
  const ROLES = [Role.ADMIN, Role.MANAGER, Role.EXECUTOR] as const;

  function makeUser(partial: Partial<User> & { id: string; role: Role }): User {
    return {
      email: `${partial.id}@example.com`,
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
   * Хранилище — общая для всех методов Map. `runInTransaction` снимает снимок
   * хранилища, выполняет переданную функцию и при исключении восстанавливает
   * снимок (моделирование атомарного отката транзакции реальной БД), затем
   * пробрасывает ошибку.
   */
  function makeFakeRepository() {
    const store = new Map<string, User>();
    let createdCounter = 0;

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
      findById: jest.fn(async (id: string) => store.get(id) ?? null),
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
      create: jest.fn(
        async (data: { email: string; displayName: string; role: Role; isActive: boolean }) => {
          const id = `created-${(createdCounter += 1)}`;
          const user = makeUser({
            id,
            role: data.role,
            email: data.email,
            isActive: data.isActive,
          });
          store.set(id, user);
          return user;
        },
      ),
      addEmailToHistory: jest.fn(async (userId: string, email: string) => ({ userId, email })),
      update: jest.fn(async (id: string, data: Partial<User>) => {
        const current = store.get(id);
        if (current === undefined) {
          throw new Error(`update: пользователь ${id} не найден`);
        }
        const next = { ...current, ...data } as User;
        store.set(id, next);
        return next;
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

    return { repository, store };
  }

  function buildService(repository: UserRepository) {
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

  const countAdmins = (store: Map<string, User>): number => {
    let n = 0;
    for (const u of store.values()) {
      if (u.role === Role.ADMIN && u.deletedAt === null) {
        n += 1;
      }
    }
    return n;
  };

  const roleSnapshot = (store: Map<string, User>): Record<string, Role> => {
    const snap: Record<string, Role> = {};
    for (const [id, u] of store) {
      snap[id] = u.role;
    }
    return snap;
  };

  /** Описатель одной операции последовательности. */
  type Op =
    | { kind: 'createAdmin'; email: string }
    | { kind: 'updateRole'; actor: 'admin' | number; target: number; role: Role }
    | { kind: 'transferAdmin'; actor: 'admin' | number; target: number };

  const validEmail = fc
    .tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.constantFrom('com', 'ru', 'org', 'net'))
    .map(([local, tld]) => `${local}@example.${tld}`);

  // Индексы пользователей генерируются в диапазоне [0, 5] и приводятся к
  // фактическому размеру состава по модулю во время исполнения. Это позволяет
  // fast-check свободно сжимать (shrink) последовательности операций.
  const MAX_INDEX = 5;
  const actorArb = fc.oneof(fc.constant<'admin'>('admin'), fc.integer({ min: 0, max: MAX_INDEX }));

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    validEmail.map((email) => ({ kind: 'createAdmin', email }) as Op),
    fc
      .record({
        actor: actorArb,
        target: fc.integer({ min: 0, max: MAX_INDEX }),
        role: fc.constantFrom(...ROLES),
      })
      .map((r) => ({ kind: 'updateRole', ...r }) as Op),
    fc
      .record({ actor: actorArb, target: fc.integer({ min: 0, max: MAX_INDEX }) })
      .map((r) => ({ kind: 'transferAdmin', ...r }) as Op),
  );

  it('поддерживает ровно одного администратора при любой последовательности операций; отклонённые операции не меняют роли', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Роли неадминистраторов в начальном составе (1..5 пользователей).
        fc.array(fc.constantFrom(Role.MANAGER, Role.EXECUTOR), { minLength: 1, maxLength: 5 }),
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        async (otherRoles, ops) => {
          const { repository, store } = makeFakeRepository();
          const service = buildService(repository);

          // 1) Операция «создание»: первичный администратор создаётся при пустой
          //    системе — ровно один администратор (Req 4.4).
          const admin = await service.createPrimaryAdmin('founder@example.com');
          // Активируем (имитация установки пароля), чтобы запись могла быть
          // источником передачи роли; на инвариант это не влияет.
          store.set(admin.id, { ...store.get(admin.id)!, isActive: true });
          expect(countAdmins(store)).toBe(1);

          // Прочие активные пользователи начального состава.
          const allIds: string[] = [admin.id];
          otherRoles.forEach((role, i) => {
            const id = `user-${i}`;
            store.set(id, makeUser({ id, role }));
            allIds.push(id);
          });

          const userCount = allIds.length;

          const resolveAdminId = (): string => {
            for (const [id, u] of store) {
              if (u.role === Role.ADMIN && u.deletedAt === null) {
                return id;
              }
            }
            throw new Error('инвариант нарушен: администратор отсутствует');
          };

          for (const op of ops) {
            const before = roleSnapshot(store);
            let threw = false;
            try {
              if (op.kind === 'createAdmin') {
                await service.createPrimaryAdmin(op.email);
              } else if (op.kind === 'updateRole') {
                const actorId =
                  op.actor === 'admin' ? resolveAdminId() : allIds[op.actor % userCount]!;
                const targetId = allIds[op.target % userCount]!;
                await service.updateRole(actorId, targetId, op.role);
              } else {
                const actorId =
                  op.actor === 'admin' ? resolveAdminId() : allIds[op.actor % userCount]!;
                const targetId = allIds[op.target % userCount]!;
                await service.transferAdmin(actorId, targetId);
              }
            } catch {
              threw = true;
            }

            // Главный инвариант: после любой операции — ровно один администратор
            // (Req 2.2, 2.11, 3.3, 4.4, 8.8).
            expect(countAdmins(store)).toBe(1);

            // Отклонённая операция оставляет роли без изменений (Req 2.11, 3.3).
            if (threw) {
              expect(roleSnapshot(store)).toEqual(before);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
