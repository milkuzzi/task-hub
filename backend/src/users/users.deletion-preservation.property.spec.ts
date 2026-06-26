import fc from 'fast-check';
import { Prisma, Role, User } from '@prisma/client';
import { TaskRepository, UserRepository } from '../repositories';
import { AuthService } from '../auth/auth.service';
import { MailerService } from '../mailer';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 20: Сохранность сообщений и отображаемого имени при удалении пользователя**
 *
 * Property 20 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 8.2, 8.3, 8.4**:
 *
 * Для ЛЮБОГО пользователя, у которого есть сообщения (с вложениями), после
 * удаления в ЛЮБОМ режиме:
 * - все его Сообщения и Вложения сохраняются неизменными (содержимое, вложения,
 *   метки правок) — Req 8.3 (hard) и неявно при soft;
 * - его отображаемое имя (`authorDisplayName`) остаётся ровно таким, каким было
 *   на момент удаления, БЕЗ обезличивания — Req 8.4;
 * - при soft-удалении запись пользователя остаётся в хранилище и помечена
 *   удалённой (`deletedAt !== null`) — Req 8.2;
 * - при hard-удалении запись пользователя отсутствует в хранилище, но связанные
 *   сообщения уцелели: ссылка `authorId` обнуляется (модель `SetNull` БД), а
 *   денормализованное `authorDisplayName` сохраняет имя автора — Req 8.3, 8.4.
 *
 * Граница БД ({@link UserRepository}) подменяется детерминированным stateful
 * in-memory фейком с тем же контрактом. Хранилище сообщений моделируется как
 * отдельная коллекция: `userRepository.delete` воспроизводит поведение реальной
 * БД (`Message.authorId` → `SetNull` при сохранении `authorDisplayName`), а
 * `update` (soft) лишь помечает запись удалённой. Сервис не обращается к
 * сообщениям напрямую, поэтому их содержимое не может измениться. Побочные
 * зависимости ({@link AuthService}, {@link MailerService}, {@link ClockService},
 * {@link AppConfigService}, {@link AvatarStorage}, {@link TaskRepository})
 * замоканы. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 150).
 */
describe('Property 20: Сохранность сообщений и отображаемого имени при удалении пользователя (Req 8.2, 8.3, 8.4)', () => {
  const ADMIN_ID = 'admin';
  const ADMIN_EMAIL = 'admin@system.local';

  /** Модель сообщения с денормализованным именем автора и вложениями. */
  interface StoredMessage {
    id: string;
    authorId: string | null;
    authorDisplayName: string;
    content: string;
    attachments: { id: string; name: string; size: number }[];
    edited: boolean;
  }

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
   * Создаёт stateful in-memory фейки {@link UserRepository} и хранилища
   * сообщений.
   *
   * - `users` — Map учётных записей (администратор-инициатор + целевой пользователь).
   * - `messages` — массив сообщений целевого пользователя (с вложениями).
   * - `userRepository.delete` моделирует FK `SetNull` БД: обнуляет `authorId`
   *   сообщений удаляемого пользователя, сохраняя `authorDisplayName` и всё
   *   остальное содержимое неизменным (Req 8.3, 8.4).
   * - `runInTransaction` снимает снимок состояния (users + messages) и
   *   восстанавливает его при исключении, моделируя атомарный откат.
   */
  function makeFakeRepository(
    targetId: string,
    targetDisplayName: string,
    messages: StoredMessage[],
  ) {
    const users = new Map<string, User>();
    users.set(ADMIN_ID, makeUser({ id: ADMIN_ID, role: Role.ADMIN, email: ADMIN_EMAIL }));
    users.set(
      targetId,
      makeUser({
        id: targetId,
        role: Role.EXECUTOR,
        email: `${targetId}@example.com`,
        displayName: targetDisplayName,
      }),
    );

    const cloneMessages = (src: StoredMessage[]): StoredMessage[] =>
      src.map((m) => ({ ...m, attachments: m.attachments.map((a) => ({ ...a })) }));

    const snapshot = () => ({
      users: new Map([...users].map(([id, u]) => [id, { ...u }] as const)),
      messages: cloneMessages(messages),
    });
    const restore = (snap: ReturnType<typeof snapshot>) => {
      users.clear();
      for (const [id, u] of snap.users) {
        users.set(id, u);
      }
      messages.length = 0;
      messages.push(...snap.messages);
    };

    const repository = {
      findActiveById: jest.fn(async (id: string) => {
        const u = users.get(id);
        return u && u.deletedAt === null ? u : null;
      }),
      findById: jest.fn(async (id: string) => users.get(id) ?? null),
      update: jest.fn(async (id: string, data: Prisma.UserUpdateInput) => {
        const current = users.get(id);
        if (current === undefined) {
          throw new Error(`update: пользователь ${id} не найден`);
        }
        const next = { ...current, ...(data as Partial<User>) } as User;
        users.set(id, next);
        // Сервис не трогает сообщения при soft-удалении: содержимое и имя
        // автора остаются неизменными по построению (Req 8.2, 8.4).
        return next;
      }),
      delete: jest.fn(async (id: string) => {
        const removed = users.get(id);
        if (removed === undefined) {
          throw new Error(`delete: пользователь ${id} не найден`);
        }
        users.delete(id);
        // Моделируем поведение реальной БД: внешний ключ Message.authorId
        // обнуляется (SetNull), но денормализованное authorDisplayName и всё
        // остальное содержимое сообщений сохраняется неизменным (Req 8.3, 8.4).
        for (const m of messages) {
          if (m.authorId === id) {
            m.authorId = null;
          }
        }
        return removed;
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

    return { repository, users };
  }

  function buildService(repository: UserRepository): UsersService {
    const auth = { revokeAllSessions: jest.fn(async () => 0) } as unknown as AuthService;
    const mailer = { enqueue: jest.fn(async () => undefined) } as unknown as MailerService;
    const clock = {
      now: () => new Date('2024-01-01T00:00:00Z'),
    } as unknown as ClockService;
    const config = { limits: { avatarMaxBytes: 5 * 1024 * 1024 } } as unknown as AppConfigService;
    const avatarStorage = { store: jest.fn() } as unknown as AvatarStorage;
    // Удаляемый пользователь не является единственным исполнителем/менеджером
    // ни в одной задаче — переназначение осиротевших задач (свойство 21)
    // проверяется отдельным тестом и здесь не влияет на сохранность сообщений.
    const taskRepository = {
      findTaskIdsWhereUserIsSoleAssignee: jest.fn(async () => []),
      setStatus: jest.fn(async () => undefined),
    } as unknown as TaskRepository;
    return new UsersService(repository, taskRepository, auth, mailer, clock, config, avatarStorage);
  }

  /** Генератор одного вложения сообщения. */
  const attachmentArb = fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 40 }),
    size: fc.integer({ min: 0, max: 25 * 1024 * 1024 }),
  });

  /** Генератор сообщения (с произвольным набором вложений и меткой правки). */
  const messageArb = fc.record({
    id: fc.uuid(),
    content: fc.string({ minLength: 0, maxLength: 200 }),
    attachments: fc.array(attachmentArb, { minLength: 0, maxLength: 10 }),
    edited: fc.boolean(),
  });

  it('после удаления (soft или hard) сообщения и вложения неизменны, имя автора сохранено без обезличивания', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'soft' | 'hard'>('soft', 'hard'),
        // Уникальный идентификатор и непустое отображаемое имя удаляемого
        // пользователя; имя на момент удаления денормализовано в сообщениях.
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.array(messageArb, { minLength: 1, maxLength: 12 }),
        async (mode, targetId, displayName, rawMessages) => {
          // Идентификатор не должен совпадать со служебным ADMIN_ID.
          fc.pre(targetId !== ADMIN_ID);

          // Денормализуем имя автора на момент удаления во все его сообщения
          // (как это делает система при создании сообщения).
          const messages: StoredMessage[] = rawMessages.map((m) => ({
            id: m.id,
            authorId: targetId,
            authorDisplayName: displayName,
            content: m.content,
            attachments: m.attachments,
            edited: m.edited,
          }));

          // Эталонный снимок содержимого сообщений ДО удаления (без authorId,
          // который при hard-удалении легитимно обнуляется моделью SetNull).
          const expectedContent = messages.map((m) => ({
            id: m.id,
            authorDisplayName: m.authorDisplayName,
            content: m.content,
            attachments: m.attachments.map((a) => ({ ...a })),
            edited: m.edited,
          }));

          const { repository, users } = makeFakeRepository(targetId, displayName, messages);
          const service = buildService(repository);

          await service.deleteUser(ADMIN_ID, targetId, mode);

          // 1) Все сообщения уцелели: их число не изменилось.
          expect(messages).toHaveLength(expectedContent.length);

          for (const expected of expectedContent) {
            const actual = messages.find((m) => m.id === expected.id);
            // 2) Каждое сообщение присутствует и его содержимое неизменно.
            expect(actual).toBeDefined();
            if (actual === undefined) {
              continue;
            }
            expect(actual.content).toBe(expected.content);
            expect(actual.edited).toBe(expected.edited);
            // 3) Вложения сохранены неизменными (число и каждое поле).
            expect(actual.attachments).toEqual(expected.attachments);
            // 4) Отображаемое имя автора сохранено ровно как на момент удаления,
            //    без обезличивания (Req 8.4).
            expect(actual.authorDisplayName).toBe(displayName);
            expect(actual.authorDisplayName).not.toBe('');
          }

          const record = users.get(targetId);
          if (mode === 'soft') {
            // 5a) Soft: запись пользователя сохранена и помечена удалённой
            //     (Req 8.2); ссылка authorId в сообщениях сохраняется.
            expect(record).toBeDefined();
            expect(record!.deletedAt).not.toBeNull();
            for (const m of messages) {
              expect(m.authorId).toBe(targetId);
            }
          } else {
            // 5b) Hard: запись пользователя отсутствует (Req 8.3); ссылка
            //     authorId обнулена (SetNull), но имя сохранено (Req 8.4).
            expect(record).toBeUndefined();
            for (const m of messages) {
              expect(m.authorId).toBeNull();
              expect(m.authorDisplayName).toBe(displayName);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
