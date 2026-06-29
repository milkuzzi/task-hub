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
 * **Bugfix: task-hub-bug-fixes — Property 15 (Bug Condition): удаление Вложений
 * вместе с Сообщением**
 *
 * **Validates: Requirements 1.8, 2.8**
 *
 * Exploratory-тест условия дефекта 8 (`isBugCondition_8`).
 *
 * Условие дефекта: удаляется Сообщение Чата, у которого есть связанные Вложения
 * (`attachments.length > 0`). Ожидаемое (корректное) поведение Property 15:
 * исправленный код удаляет связанные записи Вложений И их объекты в хранилище
 * (`storagePath` и `thumbnailPath`, включая миниатюры), чтобы они не оставались
 * осиротевшими и не отображались в разделе «Вложения».
 *
 * Наблюдение на неисправленном коде: `ChatService.deleteMessage` выполняет лишь
 * `messageRepository.update(messageId, { deleted: true })` и рассылку события —
 * связанные Вложения и их файлы не удаляются. Поэтому после удаления Сообщения
 * записи Вложений и объекты хранилища (включая миниатюры) остаются осиротевшими.
 *
 * **Scoped PBT**: property-based генерация Сообщений с числом Вложений > 0
 * (детерминированная часть `isBugCondition_8`) через fast-check; каждое Вложение
 * имеет `storagePath` и, возможно, `thumbnailPath`.
 *
 * **CRITICAL (методология bugfix)**: тест ДОЛЖЕН ПАДАТЬ на неисправленном коде —
 * Вложения и файлы остаются осиротевшими. НЕ чинить тест/код при падении.
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

/** Описание одного генерируемого Вложения Сообщения. */
interface AttachmentSpec {
  hasThumbnail: boolean;
}

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

function makeAttachment(index: number, spec: AttachmentSpec): Attachment {
  return {
    id: `att-${index}`,
    messageId: MESSAGE_ID,
    taskId: TASK_ID,
    uploaderId: AUTHOR_ID,
    originalName: `photo-${index}.png`,
    mimeType: 'image/png',
    sizeBytes: BigInt(1024 + index),
    storagePath: `${TASK_ID}/orig-${index}.zst`,
    thumbnailPath: spec.hasThumbnail ? `${TASK_ID}/thumb-${index}.zst` : null,
    compression: 'zstd',
    checksum: `checksum-att-${index}`,
    createdAt: FIXED_NOW,
  } as unknown as Attachment;
}

interface Harness {
  service: ChatService;
  storedMessage: Message;
  /** Живые (ещё не удалённые) записи Вложений, привязанные к Сообщению. */
  attachmentRows: Attachment[];
  /** Объекты в хранилище (`storagePath`/`thumbnailPath`), удаляемые StorageService.delete. */
  storageObjects: Set<string>;
  broadcastMessage: jest.Mock;
  storageDelete: jest.Mock;
}

function buildHarness(attachments: Attachment[], actorId: string): Harness {
  const users: Record<string, User> = {
    [AUTHOR_ID]: makeUser(AUTHOR_ID, Role.EXECUTOR),
    [MANAGER_ID]: makeUser(MANAGER_ID, Role.MANAGER),
    [ADMIN_ID]: makeUser(ADMIN_ID, Role.ADMIN),
  };
  const task = makeTask();

  // Живое состояние записей Вложений и объектов хранилища.
  const attachmentRows: Attachment[] = [...attachments];
  const storageObjects = new Set<string>();
  for (const a of attachmentRows) {
    storageObjects.add(a.storagePath);
    if (a.thumbnailPath !== null) {
      storageObjects.add(a.thumbnailPath);
    }
  }

  const storedMessage = {
    id: MESSAGE_ID,
    chatId: CHAT_ID,
    authorId: AUTHOR_ID,
    authorDisplayName: `Имя ${AUTHOR_ID}`,
    text: 'Сообщение с вложениями',
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

  const messageRepository = {
    findById: jest.fn(async (id: string) => (id === storedMessage.id ? storedMessage : null)),
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => {
      Object.assign(storedMessage, data);
      return storedMessage;
    }),
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

  // Stateful-репозиторий Вложений: выборка и удаление Вложений Сообщения по
  // живому состоянию `attachmentRows`. Исправленный код использует эти методы
  // для удаления записей в транзакции (design.md, дефект 8).
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

  // Хранилище: `delete` идемпотентно убирает объект из живого набора (Req 12.8).
  const storageDelete = jest.fn(async (storagePath: string) => {
    storageObjects.delete(storagePath);
  });
  const storage = { delete: storageDelete } as unknown as StorageService;

  // StorageService передаётся последним аргументом: неисправленный конструктор
  // (14 параметров) его игнорирует, исправленный — использует для удаления
  // файлов. Вариативное приведение позволяет тесту компилироваться для обеих
  // версий сигнатуры конструктора.
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
  return {
    service,
    storedMessage,
    attachmentRows,
    storageObjects,
    broadcastMessage,
    storageDelete,
  };
}

describe('Property 15 (Bug Condition): удаление Вложений вместе с Сообщением (Req 1.8, 2.8)', () => {
  // Число Вложений > 0 (детерминированная часть isBugCondition_8), в пределах
  // лимита на Сообщение (Req 11.9), каждое — с миниатюрой или без неё.
  const attachmentSpecsArb = fc.array(fc.record<AttachmentSpec>({ hasThumbnail: fc.boolean() }), {
    minLength: 1,
    maxLength: LIMITS.maxAttachmentsPerMessage,
  });

  // Удаление инициирует уполномоченный актор: автор, Менеджер Задачи или
  // Администратор (Req 11.6).
  const actorArb = fc.constantFrom(AUTHOR_ID, MANAGER_ID, ADMIN_ID);

  it('после удаления Сообщения связанные записи Вложений и их файлы (включая миниатюры) удалены', async () => {
    await fc.assert(
      fc.asyncProperty(attachmentSpecsArb, actorArb, async (specs, actorId) => {
        const attachments = specs.map((spec, index) => makeAttachment(index, spec));
        // Предусловие isBugCondition_8: у Сообщения есть связанные Вложения.
        expect(attachments.length).toBeGreaterThan(0);

        const h = buildHarness(attachments, actorId);
        const expectedStoragePaths = new Set(h.storageObjects);

        await h.service.deleteMessage(actorId, MESSAGE_ID);

        // Сообщение логически удалено и событие разослано (базовое поведение).
        expect(h.storedMessage.deleted).toBe(true);
        expect(h.broadcastMessage).toHaveBeenCalled();

        // Property 15: связанные записи Вложений удалены — осиротевших нет.
        const remaining = h.attachmentRows.filter((a) => a.messageId === MESSAGE_ID);
        expect(remaining).toHaveLength(0);

        // Property 15: файлы Вложений и их миниатюры удалены из хранилища.
        expect(expectedStoragePaths.size).toBeGreaterThan(0);
        expect(h.storageObjects.size).toBe(0);
        for (const path of expectedStoragePaths) {
          expect(h.storageDelete).toHaveBeenCalledWith(path);
        }
      }),
      { numRuns: 50 },
    );
  });
});
