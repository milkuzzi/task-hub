import fc from 'fast-check';
import { AssignmentKind, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { PrismaService } from '../infra';
import {
  MessageReadRepository,
  AttachmentRepository,
  ChatMuteRepository,
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StatusMachine } from '../status';
import { AuditRecorder } from '../tasks/ports';
import { ChatNotificationRouter } from '../notifications';
import { RateLimiter } from '../security';
import { StorageService } from '../storage';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

/**
 * **Feature: task-assignment-system, Property 29: Валидация длины текста сообщения**
 *
 * Property 29 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 11.3, 11.4, 11.5**:
 *
 * Для любого текста Сообщение сохраняется тогда и только тогда, когда длина
 * текста в диапазоне 1–4000; пустой текст или длина более 4000 отклоняются без
 * сохранения изменений. Правило действует и при создании ({@link
 * ChatService.sendMessage}, Req 11.3, 11.4), и при редактировании ({@link
 * ChatService.editMessage}, Req 11.5).
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Все внешние границы (репозитории,
 * шлюз, конфигурация, часы) подменяются stateful-моками в памяти — обращений к
 * реальной БД/Redis нет. Доступ Участника всегда предоставлен (отправитель —
 * Исполнитель Задачи, инициатор правки — автор Сообщения), поэтому единственным
 * фактором исхода остаётся длина текста (Req 11.3–11.5). Лимит длины задаётся
 * конфигурацией (4000). Утверждается: вставка/обновление в хранилище происходит
 * тогда и только тогда, когда длина текста валидна.
 */
describe('Property 29: Валидация длины текста сообщения (Req 11.3, 11.4, 11.5)', () => {
  const MAX_LEN = 4000;
  const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
  const LIMITS = { messageTextMaxLength: MAX_LEN, messageCounterCap: 9999 };

  const SENDER_ID = 'executor-1';
  const TASK_ID = 'task-1';
  const CHAT_ID = 'chat-1';
  const SEED_MESSAGE_ID = 'message-seed';
  const SEED_TEXT = 'исходный текст';

  /** Stateful in-memory хранилище Сообщений + счётчики обращений к репозиторию. */
  interface Store {
    messages: Map<string, Message>;
    createCount: number;
    updateCount: number;
    nextId: number;
  }

  function makeTask(): TaskWithAssignments {
    return {
      id: TASK_ID,
      title: 'Задача',
      description: null,
      deadline: new Date('2030-12-31T00:00:00Z'),
      status: TaskStatus.IN_PROGRESS,
      adminReviewed: false,
      messageCount: 0,
      createdAt: FIXED_NOW,
      doneAt: null,
      updatedAt: FIXED_NOW,
      assignments: [
        {
          id: 'assignment-0',
          taskId: TASK_ID,
          userId: SENDER_ID,
          kind: AssignmentKind.EXECUTOR,
        },
      ],
    } as unknown as TaskWithAssignments;
  }

  /**
   * Строит {@link ChatService} поверх stateful-моков. Хранилище инициируется
   * одним валидным Сообщением (автор — {@link SENDER_ID}) для проверки
   * редактирования. Задача неизменна между прогонами; доступ Участника гарантирован.
   */
  function buildHarness(): { service: ChatService; store: Store } {
    const store: Store = {
      messages: new Map<string, Message>(),
      createCount: 0,
      updateCount: 0,
      nextId: 1,
    };
    store.messages.set(SEED_MESSAGE_ID, {
      id: SEED_MESSAGE_ID,
      chatId: CHAT_ID,
      authorId: SENDER_ID,
      authorDisplayName: `Имя ${SENDER_ID}`,
      text: SEED_TEXT,
      createdAt: FIXED_NOW,
      editedAt: null,
      deleted: false,
    } as unknown as Message);

    const task = makeTask();

    const userRepository = {
      findActiveById: jest.fn(async (id: string) =>
        id === SENDER_ID
          ? ({
              id,
              displayName: `Имя ${id}`,
              role: Role.EXECUTOR,
              isActive: true,
              deletedAt: null,
            } as unknown as User)
          : null,
      ),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) => (id === TASK_ID ? task : null)),
      update: jest.fn(async () => ({}) as Task),
      setStatus: jest.fn(async () => ({}) as Task),
    } as unknown as TaskRepository;

    const messageRepository = {
      create: jest.fn(async (data: Record<string, unknown>) => {
        store.createCount += 1;
        const id = `message-${store.nextId++}`;
        const created = {
          id,
          chatId: CHAT_ID,
          authorId: SENDER_ID,
          authorDisplayName: data.authorDisplayName as string,
          text: data.text as string,
          createdAt: FIXED_NOW,
          editedAt: null,
          deleted: false,
        } as unknown as Message;
        store.messages.set(id, created);
        return created;
      }),
      findById: jest.fn(async (id: string) => store.messages.get(id) ?? null),
      update: jest.fn(async (id: string, data: Record<string, unknown>) => {
        store.updateCount += 1;
        const current = store.messages.get(id) as Message;
        const updated = { ...current, ...data } as Message;
        store.messages.set(id, updated);
        return updated;
      }),
    } as unknown as MessageRepository;

    const prisma = {
      runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      chat: {
        findUnique: jest.fn(async () => ({ id: CHAT_ID, taskId: TASK_ID })),
      },
    } as unknown as PrismaService;

    const messageReadRepository = {
      markRead: jest.fn(async () => undefined),
      listReaders: jest.fn(async () => []),
    } as unknown as MessageReadRepository;

    const clock = { now: () => FIXED_NOW } as unknown as ClockService;
    const config = { limits: LIMITS } as unknown as AppConfigService;
    const statusMachine = new StatusMachine();
    const gateway = {
      broadcastMessage: jest.fn(),
      broadcastMessageCounter: jest.fn(),
      broadcastStatus: jest.fn(),
    } as unknown as ChatGateway;
    const audit = { record: jest.fn(async () => undefined) } as unknown as AuditRecorder;
    const attachmentRepository = {
      listByTask: jest.fn(async () => []),
    } as unknown as AttachmentRepository;
    const chatMuteRepository = {
      setMute: jest.fn(async () => true),
      isMuted: jest.fn(async () => false),
    } as unknown as ChatMuteRepository;

    const service = new ChatService(
      prisma,
      messageRepository,
      messageReadRepository,
      attachmentRepository,
      chatMuteRepository,
      taskRepository,
      userRepository,
      statusMachine,
      clock,
      config,
      gateway,
      {
        notifyNewMessage: jest.fn(),
        clearMessageNotification: jest.fn(),
      } as unknown as ChatNotificationRouter,
      { check: jest.fn(async () => ({ allowed: true })) } as unknown as RateLimiter,
      audit,
      { delete: jest.fn(async () => undefined) } as unknown as StorageService,
    );

    return { service, store };
  }

  /**
   * Арбитрари длины текста: концентрируется на границах (0, 1, 4000, 4001) и
   * покрывает как валидный диапазон 1..4000, так и невалидный 0 и >4000.
   */
  const lengthArb = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.constantFrom(0, 1, 2, MAX_LEN - 1, MAX_LEN, MAX_LEN + 1, MAX_LEN + 2),
    },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: MAX_LEN }) },
    { weight: 2, arbitrary: fc.integer({ min: MAX_LEN + 1, max: MAX_LEN + 500 }) },
  );

  /** Текст заданной длины (длина в код-юнитах UTF-16, как и `String.length`). */
  const textArb = lengthArb.map((len) => 'a'.repeat(len));

  /** Режим операции: создание или редактирование Сообщения. */
  const modeArb = fc.constantFrom<'send' | 'edit'>('send', 'edit');

  it('Сообщение сохраняется ⇔ длина текста в диапазоне 1–4000 (send и edit); иначе отказ без сохранения', async () => {
    await fc.assert(
      fc.asyncProperty(modeArb, textArb, async (mode, text) => {
        const { service, store } = buildHarness();
        const valid = text.length >= 1 && text.length <= MAX_LEN;

        if (mode === 'send') {
          if (valid) {
            await expect(service.sendMessage(SENDER_ID, TASK_ID, text)).resolves.toBeDefined();
            // Сохранено ровно одно новое Сообщение с этим текстом (Req 11.3).
            expect(store.createCount).toBe(1);
            const persisted = [...store.messages.values()].find((m) => m.id !== SEED_MESSAGE_ID);
            expect(persisted?.text).toBe(text);
          } else {
            await expect(service.sendMessage(SENDER_ID, TASK_ID, text)).rejects.toBeInstanceOf(
              ValidationException,
            );
            // Ничего не сохранено: только исходное seed-Сообщение (Req 11.4).
            expect(store.createCount).toBe(0);
            expect(store.messages.size).toBe(1);
          }
        } else {
          if (valid) {
            await expect(
              service.editMessage(SENDER_ID, SEED_MESSAGE_ID, text),
            ).resolves.toBeDefined();
            // Текст обновлён, проставлена метка «изменено» (Req 11.5).
            expect(store.updateCount).toBe(1);
            const edited = store.messages.get(SEED_MESSAGE_ID) as Message;
            expect(edited.text).toBe(text);
            expect(edited.editedAt).toEqual(FIXED_NOW);
          } else {
            await expect(
              service.editMessage(SENDER_ID, SEED_MESSAGE_ID, text),
            ).rejects.toBeInstanceOf(ValidationException);
            // Исходное Сообщение не изменено (Req 11.4, 11.5).
            expect(store.updateCount).toBe(0);
            const untouched = store.messages.get(SEED_MESSAGE_ID) as Message;
            expect(untouched.text).toBe(SEED_TEXT);
            expect(untouched.editedAt).toBeNull();
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
