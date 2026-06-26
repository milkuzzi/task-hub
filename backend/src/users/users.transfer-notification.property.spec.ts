import fc from 'fast-check';
import { Logger } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 10: Сохранность операции при сбое уведомления**
 *
 * Property 10 (см. design.md «Correctness Properties») — **Validates: Requirements 3.6**:
 *
 * Для любой передачи роли администратора, завершившейся сменой ролей,
 * последующий сбой отправки email НЕ откатывает смену ролей, а лишь фиксирует
 * признак неуспешной отправки.
 *
 * Тест реализует ровно это одно свойство. Все внешние границы подменяются:
 * - {@link UserRepository} — stateful in-memory мок с транзакционной семантикой
 *   (снимок состояния на входе в транзакцию, откат при исключении);
 * - {@link AuthService.revokeAllSessions} — мок;
 * - {@link ClockService} — детерминированный фиксированный момент времени;
 * - {@link MailerService} — мок, у которого `enqueue` может отклоняться
 *   (rejection) согласно сгенерированному сценарию сбоя.
 *
 * Живой БД нет. Минимум 100 итераций fast-check (здесь — 200).
 */
describe('Property 10: Сохранность операции при сбое уведомления (Req 3.6)', () => {
  const FIXED_NOW = new Date('2025-01-01T12:00:00.000Z');

  /** Конструирует запись пользователя с заданными полями. */
  const makeUser = (overrides: Partial<User>): User =>
    ({
      id: 'user-id',
      email: 'user@example.com',
      displayName: 'Пользователь',
      role: Role.EXECUTOR,
      isActive: true,
      lockedUntil: null,
      deletedAt: null,
      ...overrides,
    }) as User;

  /**
   * Stateful in-memory репозиторий с транзакционной семантикой. `runInTransaction`
   * делает снимок состояния перед выполнением функции и восстанавливает его при
   * исключении (имитация отката), оставляя изменения при успешной фиксации.
   */
  const makeRepository = (initial: User[]) => {
    const store = new Map<string, User>();
    for (const u of initial) {
      store.set(u.id, { ...u });
    }

    const clone = (u: User | undefined): User | null => (u ? ({ ...u } as User) : null);

    const repository = {
      runInTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const snapshot = new Map<string, User>();
        for (const [id, u] of store) {
          snapshot.set(id, { ...u });
        }
        try {
          return await fn({});
        } catch (error) {
          // Откат: восстанавливаем состояние, каким оно было до транзакции.
          store.clear();
          for (const [id, u] of snapshot) {
            store.set(id, u);
          }
          throw error;
        }
      },
      findActiveById: async (id: string): Promise<User | null> => {
        const u = store.get(id);
        return u && u.deletedAt === null ? clone(u) : null;
      },
      findById: async (id: string): Promise<User | null> => clone(store.get(id)),
      countActiveAdmins: async (): Promise<number> => {
        let count = 0;
        for (const u of store.values()) {
          if (u.role === Role.ADMIN && u.deletedAt === null) {
            count += 1;
          }
        }
        return count;
      },
      update: async (id: string, data: Partial<User>): Promise<User> => {
        const existing = store.get(id);
        if (!existing) {
          throw new Error(`Пользователь ${id} не найден`);
        }
        const updated = { ...existing, ...data } as User;
        store.set(id, updated);
        return clone(updated) as User;
      },
    } as unknown as UserRepository;

    return { repository, store };
  };

  /**
   * Сценарии поведения почтовой очереди: какие из вызовов `enqueue` отклоняются.
   * Покрывают отсутствие сбоя, сбой на первом/втором письме и сбой на обоих.
   */
  const emailScenario = fc.constantFrom<
    'resolveAll' | 'rejectFirst' | 'rejectSecond' | 'rejectAll'
  >('resolveAll', 'rejectFirst', 'rejectSecond', 'rejectAll');

  /** Создаёт мок MailerService, отклоняющий вызовы согласно сценарию. */
  const makeMailer = (scenario: string) => {
    let call = 0;
    const enqueue = jest.fn(async () => {
      call += 1;
      const failFirst = scenario === 'rejectFirst' || scenario === 'rejectAll';
      const failSecond = scenario === 'rejectSecond' || scenario === 'rejectAll';
      if ((call === 1 && failFirst) || (call === 2 && failSecond)) {
        throw new Error('Сбой постановки письма в очередь');
      }
      return undefined;
    });
    return { enqueue } as unknown as MailerService;
  };

  it('завершённая передача роли сохраняется при любом исходе отправки email; фиксируется лишь признак неуспеха', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.emailAddress(),
        fc.emailAddress(),
        emailScenario,
        // lockedUntil: null или момент в прошлом (target остаётся назначаемым).
        fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
        async (adminId, targetId, adminEmail, targetEmail, scenario, lockedPastMs) => {
          // Идентификаторы должны различаться (иначе это передача самому себе).
          fc.pre(adminId !== targetId);

          const lockedUntil =
            lockedPastMs === null ? null : new Date(FIXED_NOW.getTime() - lockedPastMs);

          const currentAdmin = makeUser({
            id: adminId,
            email: adminEmail,
            role: Role.ADMIN,
            isActive: true,
            lockedUntil: null,
          });
          const target = makeUser({
            id: targetId,
            email: targetEmail,
            role: Role.EXECUTOR,
            isActive: true,
            lockedUntil,
          });

          const { repository, store } = makeRepository([currentAdmin, target]);
          const revokeAllSessions = jest.fn(async () => undefined);
          const mailer = makeMailer(scenario);
          // Признак неуспешной отправки фиксируется через журнал ошибок сервиса
          // (this.logger.error). Перехватываем его на прототипе Nest Logger.
          const errorLog = jest
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => undefined);

          const service = new UsersService(
            repository,
            {
              findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
              setStatus: jest.fn(),
            } as unknown as TaskRepository,
            { revokeAllSessions } as unknown as AuthService,
            mailer,
            { now: () => FIXED_NOW } as unknown as ClockService,
            { limits: { avatarMaxBytes: 5 * 1024 * 1024 } } as unknown as AppConfigService,
            { store: jest.fn() } as unknown as AvatarStorage,
          );

          // Передача роли НЕ выбрасывает исключение независимо от исхода email:
          // сбой постановки писем перехватывается и лишь фиксируется (Req 3.6).
          await expect(service.transferAdmin(adminId, targetId)).resolves.toBeUndefined();

          // Главный инвариант: смена ролей зафиксирована и сохранена в БД
          // независимо от результата отправки email (Req 3.6).
          const persistedNewAdmin = store.get(targetId);
          const persistedFormerAdmin = store.get(adminId);
          expect(persistedNewAdmin?.role).toBe(Role.ADMIN);
          expect(persistedFormerAdmin?.role).toBe(Role.EXECUTOR);

          // Инвариант «ровно один администратор» сохранён.
          const adminCount = [...store.values()].filter(
            (u) => u.role === Role.ADMIN && u.deletedAt === null,
          ).length;
          expect(adminCount).toBe(1);

          // Сессии бывшего администратора аннулируются вне зависимости от email.
          expect(revokeAllSessions).toHaveBeenCalledWith(adminId);

          // Признак неуспеха фиксируется (логируется) тогда и только тогда, когда
          // отправка письма завершилась ошибкой; при успехе записи об ошибке нет.
          const expectFailureRecorded = scenario !== 'resolveAll';
          if (expectFailureRecorded) {
            expect(errorLog).toHaveBeenCalled();
          } else {
            expect(errorLog).not.toHaveBeenCalled();
          }

          errorLog.mockRestore();
        },
      ),
      { numRuns: 200 },
    );
  });
});
