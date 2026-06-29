import fc from 'fast-check';
import { AssignmentKind, Attachment, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { PrismaService } from '../infra';
import {
  AttachmentRepository,
  ChatMuteRepository,
  MessageReadRepository,
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
 * **Bugfix: task-hub-bug-fixes — Property 16 (Preservation): удаление Сообщения
 * без Вложений**
 *
 * **Validates: Requirements 3.8**
 *
 * Preservation-тест для входов ¬C дефекта 8 (`isBugCondition_8` ложно): число
 * связанных Вложений Сообщения равно нулю.
 *
 * Неизменное поведение (раздел 3 `bugfix.md`, Req 3.8): при удалении Сообщения
 * БЕЗ Вложений путь не меняется — выполняется только логическое удаление
 * (`deleted = true`) и трансляция события удаления; обращений к хранилищу
 * (`StorageService.delete`) нет, поскольку удалять нечего.
 *
 * **Scoped PBT**: property-based генерация Сообщений с числом Вложений = 0
 * (отрицание детерминированной части условия дефекта 8) через fast-check;
 * удаление инициирует уполномоченный актор (автор, Менеджер, Администратор).
 *
 * **Методология «сначала наблюдение»**: тест запускается на НЕИСПРАВЛЕННОМ коде
 * и ДОЛЖЕН ПРОХОДИТЬ — он фиксирует базовое поведение, которое исправление
 * дефекта 8 обязано сохранить.
 *
 * Все границы (репозитории, шлюз, часы, конфигурация, аудит, хранилище)
 * подменены stateful-моками поверх простых in-memory-структур — обращений к
 * реальной БД и файловой системе нет. `StorageService` передаётся как
 * дополнительный (последний) аргумент конструктора: на неисправленном коде он
 * игнорируется, а исправленный код использует его для удаления файлов.
 */

const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
const MAX_BYTES = 25 * 1024 * 1024; // 25 МБ (Req 12.2)
const LIMITS = {
  messageTextMaxLength: 4000,
  messageCounterCap: 9999,
  maxAttachmentsPerMessage: 10,
  attachmentMaxBytes: MAX_BYTES,
};

const TASK_ID = 'task-1';
const CHAT_ID = 'chat-1';
const MESSAGE_ID = 'message-1';
const AUTHOR_ID = 'executor-1';
const MANAGER_ID = 'manager-1';
const ADMIN_ID = 'admin-1';

function makeUser(id: string, role: Role): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: `Имя ${id}`,
    role,
    isActive: true,
    deletedAt: null,
  } as unknown as User;
}

function makeTask(): TaskWithAssignments {
  return {
    id: TASK_ID,
    title: 'Задача',
    description: null,
    deadline: new Date('2030-12-31T00:00:00Z'),
    status: TaskStatus.IN_PROGRESS,
    adminReviewed: false,
    messageCount: 1,
    createdAt: new Date('2030-01-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2030-01-01T00:00:00Z'),
    assignments: [
      { id: 'assignment-0', taskId: TASK_ID, userId: AUTHOR_ID, kind: AssignmentKind.EXECUTOR },
      { id: 'assignment-1', taskId: TASK_ID, userId: MANAGER_ID, kind: AssignmentKind.MANAGER },
    ],
  } as unknown as TaskWithAssignments;
}

interface Harness {
  service: ChatService;
  storedMessage: Message;
  messageUpdate: jest.Mock;
  broadcastMessage: jest.Mock;
  storageDelete: jest.Mock;
}

/** Строит окружение для Сообщения БЕЗ Вложений (¬C дефекта 8). */
function buildHarness(actorId: string): Harness {
  const users: Record<string, User> = {
    [AUTHOR_ID]: makeUser(AUTHOR_ID, Role.EXECUTOR),
    [MANAGER_ID]: makeUser(MANAGER_ID, Role.MANAGER),
    [ADMIN_ID]: makeUser(ADMIN_ID, Role.ADMIN),
  };
  const task = makeTask();

  // Сообщение без связанных Вложений.
  const attachmentRows: Attachment[] = [];

  const storedMessage = {
    id: MESSAGE_ID,
    chatId: CHAT_ID,
    authorId: AUTHOR_ID,
    authorDisplayName: `Имя ${AUTHOR_ID}`,
    text: 'Сообщение без вложений',
    createdAt: FIXED_NOW,
    editedAt: null,
    deleted: false,
  } as unknown as Message;

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
    findById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
    update: jest.fn(async () => ({}) as Task),
    setStatus: jest.fn(async () => ({}) as Task),
  } as unknown as TaskRepository;

  const messageUpdate = jest.fn(async (_id: string, data: Record<string, unknown>) => {
    Object.assign(storedMessage, data);
    return storedMessage;
  });
  const messageRepository = {
    findById: jest.fn(async (id: string) => (id === storedMessage.id ? storedMessage : null)),
    update: messageUpdate,
  } as unknown as MessageRepository;

  const prisma = {
    runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    chat: { findUnique: jest.fn(async () => ({ id: CHAT_ID, taskId: task.id })) },
  } as unknown as PrismaService;

  const clock = { now: () => FIXED_NOW } as unknown as ClockService;
  const config = { limits: LIMITS } as unknown as AppConfigService;
  const statusMachine = new StatusMachine();

  const messageReadRepository = {
    markRead: jest.fn(async () => true),
    listReaders: jest.fn(async () => []),
  } as unknown as MessageReadRepository;

  const broadcastMessage = jest.fn();
  const gateway = {
    broadcastMessage,
    broadcastMessageCounter: jest.fn(),
    broadcastStatus: jest.fn(),
    broadcastMessageReaders: jest.fn(),
  } as unknown as ChatGateway;

  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditRecorder;

  const chatNotifications = {
    notifyNewMessage: jest.fn(async () => undefined),
    clearMessageNotification: jest.fn(async () => undefined),
  } as unknown as ChatNotificationRouter;

  // Репозиторий Вложений: для Сообщения без Вложений выборка пуста, удаление
  // ничего не убирает. Методы предоставлены для совместимости с исправленным
  // кодом (он может их вызвать, но для ¬C они не дают объектов хранилища).
  const attachmentRepository = {
    listByTask: jest.fn(async (id: string) =>
      attachmentRows.filter((a) => a.taskId === id && a.messageId !== null),
    ),
    findById: jest.fn(async (id: string) => attachmentRows.find((a) => a.id === id) ?? null),
    listByMessage: jest.fn(async (messageId: string) =>
      attachmentRows.filter((a) => a.messageId === messageId),
    ),
    deleteByMessage: jest.fn(async (messageId: string) => {
      const removed = attachmentRows.filter((a) => a.messageId === messageId);
      for (const a of removed) {
        const idx = attachmentRows.indexOf(a);
        if (idx >= 0) {
          attachmentRows.splice(idx, 1);
        }
      }
      return removed.length;
    }),
  } as unknown as AttachmentRepository;

  const chatMuteRepository = {
    setMute: jest.fn(async () => true),
    isMuted: jest.fn(async () => false),
  } as unknown as ChatMuteRepository;

  const rateLimiter = {
    check: jest.fn(async () => ({ allowed: true })),
  } as unknown as RateLimiter;

  // Хранилище: для Сообщения без Вложений `delete` не должен вызываться.
  const storageDelete = jest.fn(async () => undefined);
  const storage = { delete: storageDelete } as unknown as StorageService;

  // StorageService передаётся последним аргументом: неисправленный конструктор
  // (14 параметров) его игнорирует, исправленный — использует. Вариативное
  // приведение позволяет тесту компилироваться для обеих версий сигнатуры.
  const ChatServiceCtor = ChatService as unknown as new (...args: unknown[]) => ChatService;
  const service = new ChatServiceCtor(
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
    chatNotifications,
    rateLimiter,
    audit,
    storage,
  );

  void actorId;
  return { service, storedMessage, messageUpdate, broadcastMessage, storageDelete };
}

describe('Property 16 (Preservation): удаление Сообщения без Вложений (Req 3.8)', () => {
  // Удаление инициирует уполномоченный актор: автор, Менеджер Задачи или
  // Администратор (Req 11.6).
  const actorArb = fc.constantFrom(AUTHOR_ID, MANAGER_ID, ADMIN_ID);

  it('логически удаляет Сообщение и транслирует событие, не трогая хранилище', async () => {
    await fc.assert(
      fc.asyncProperty(actorArb, async (actorId) => {
        const h = buildHarness(actorId);

        await h.service.deleteMessage(actorId, MESSAGE_ID);

        // Логическое удаление: messageRepository.update вызван с { deleted: true }.
        expect(h.messageUpdate).toHaveBeenCalledWith(MESSAGE_ID, { deleted: true });
        expect(h.storedMessage.deleted).toBe(true);

        // Трансляция события удаления выполнена.
        expect(h.broadcastMessage).toHaveBeenCalled();

        // Нет Вложений — обращений к хранилищу нет.
        expect(h.storageDelete).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });
});
