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
import { ChatGateway } from '../chat/chat.gateway';
import { ChatService } from '../chat/chat.service';
import {
  AttachmentMetaView,
  ChatMessageHttpView,
  toAttachmentMeta,
} from '../chat/chat-representation';
import { isPreviewableImage } from './attachment-representation';

/**
 * **Bugfix: task-hub-bug-fixes — Property 3 (Bug Condition): миниатюра
 * изображения формируется И ОТДАЁТСЯ в нагрузке Сообщения**
 *
 * **Validates: Requirements 1.2, 2.2**
 *
 * Exploratory-тест условия дефекта 2 (`isBugCondition_2`).
 *
 * Контекст (по наблюдению на неисправленном коде): на этапе загрузки
 * (`AttachmentsService.uploadToTask`) миниатюра формируется надёжно —
 * `thumbnailPath` устанавливается продуктовым `PassthroughThumbnailGenerator`,
 * который никогда не бросает. Поэтому гипотеза о «тихом» проглатывании сбоя
 * генерации ОПРОВЕРГНУТА. Перегипотезированная (вторая ветвь дизайна) причина —
 * **«не отдан»**: при отправке Сообщения ответ `sendMessage` и realtime-нагрузка
 * (`ChatGateway.broadcastMessage`) НЕ несут `attachments`, поэтому свежеотправ-
 * ленное Сообщение не получает миниатюр до перезагрузки ленты.
 *
 * Этот тест целит именно в путь отдачи: отправляет Сообщение с допустимым
 * изображением-Вложением (`mime ∈ previewable`, `sizeBytes ≤ attachmentMaxBytes`,
 * `thumbnailPath` уже сформирован при загрузке) и утверждает Property 3: в
 * realtime-нагрузке, разосланной Участникам, присутствует Вложение с
 * `hasThumbnail = true`.
 *
 * **Scoped PBT**: property-based генерация допустимых изображений (детермини-
 * рованная часть `isBugCondition_2`) через fast-check.
 *
 * **CRITICAL (методология bugfix)**: тест ДОЛЖЕН ПАДАТЬ на неисправленном коде —
 * realtime-нагрузка (`ChatMessageView`) не содержит `attachments`. НЕ чинить
 * тест/код при падении.
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
const SENDER_ID = 'executor-1';

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
    messageCount: 0,
    createdAt: new Date('2030-01-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2030-01-01T00:00:00Z'),
    assignments: [
      { id: 'assignment-0', taskId: TASK_ID, userId: SENDER_ID, kind: AssignmentKind.EXECUTOR },
    ],
  } as unknown as TaskWithAssignments;
}

function makeImageAttachment(mimeType: string, sizeBytes: number): Attachment {
  return {
    id: 'att-1',
    messageId: null, // «висящее» Вложение, готовое к привязке
    taskId: TASK_ID,
    uploaderId: SENDER_ID,
    originalName: `photo.${mimeType.split('/')[1]}`,
    mimeType,
    sizeBytes: BigInt(sizeBytes),
    storagePath: 'task-1/orig.zst',
    // Миниатюра уже сформирована при загрузке (uploadToTask) — hasThumbnail=true.
    thumbnailPath: 'task-1/thumb.zst',
    compression: 'zstd',
    checksum: 'checksum-att-1',
    createdAt: FIXED_NOW,
  } as unknown as Attachment;
}

interface Harness {
  service: ChatService;
  broadcastMessage: jest.Mock;
}

function buildHarness(attachment: Attachment): Harness {
  const users: Record<string, User> = {
    [SENDER_ID]: makeUser(SENDER_ID, Role.EXECUTOR),
  };
  const task = makeTask();
  const attachmentRows: Attachment[] = [attachment];

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
    update: jest.fn(async () => ({}) as Task),
    setStatus: jest.fn(async () => ({}) as Task),
  } as unknown as TaskRepository;

  const messageRepository = {
    create: jest.fn(async (data: Record<string, unknown>) => ({
      id: 'message-new',
      chatId: 'chat-1',
      authorId: SENDER_ID,
      authorDisplayName: data.authorDisplayName as string,
      text: data.text as string,
      createdAt: FIXED_NOW,
      editedAt: null,
      deleted: false,
    })) as unknown as Message,
    findById: jest.fn(async () => null),
    update: jest.fn(async () => ({}) as Message),
  } as unknown as MessageRepository;

  const prisma = {
    runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    chat: { findUnique: jest.fn(async () => ({ id: 'chat-1', taskId: task.id })) },
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

  const attachmentRepository = {
    listByTask: jest.fn(async (id: string) => (id === task.id ? attachmentRows : [])),
    findById: jest.fn(async (id: string) => attachmentRows.find((a) => a.id === id) ?? null),
    linkToMessage: jest.fn(
      async (ids: string[], messageId: string, guard: { taskId: string; uploaderId: string }) => {
        let count = 0;
        for (const a of attachmentRows) {
          if (
            ids.includes(a.id) &&
            a.messageId === null &&
            a.taskId === guard.taskId &&
            a.uploaderId === guard.uploaderId
          ) {
            (a as { messageId: string | null }).messageId = messageId;
            count += 1;
          }
        }
        return count;
      },
    ),
  } as unknown as AttachmentRepository;

  const chatMuteRepository = {
    setMute: jest.fn(async () => true),
    isMuted: jest.fn(async () => false),
  } as unknown as ChatMuteRepository;

  const rateLimiter = {
    check: jest.fn(async () => ({ allowed: true })),
  } as unknown as RateLimiter;

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
    chatNotifications,
    rateLimiter,
    audit,
    { delete: jest.fn(async () => undefined) } as unknown as StorageService,
  );

  return { service, broadcastMessage };
}

describe('Property 3 (Bug Condition): миниатюра изображения отдаётся в нагрузке Сообщения (Req 1.2, 2.2)', () => {
  // Допустимые изображения (previewable) — детерминированная часть isBugCondition_2.
  const previewableImageMimeArb = fc.constantFrom(
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  );

  // Размер в пределах лимита (Req 12.2).
  const inLimitSizeArb = fc.integer({ min: 1, max: MAX_BYTES });

  it('realtime-нагрузка содержит Вложение с hasThumbnail = true для допустимого изображения', async () => {
    await fc.assert(
      fc.asyncProperty(previewableImageMimeArb, inLimitSizeArb, async (mimeType, sizeBytes) => {
        // Предусловие isBugCondition_2: previewable И ≤ лимита.
        expect(isPreviewableImage(mimeType)).toBe(true);
        expect(sizeBytes).toBeLessThanOrEqual(MAX_BYTES);

        const attachment = makeImageAttachment(mimeType, sizeBytes);
        // Контроль: ожидаемое представление Вложения несёт миниатюру.
        const expectedMeta: AttachmentMetaView = toAttachmentMeta(attachment, FIXED_NOW);
        expect(expectedMeta.hasThumbnail).toBe(true);

        const h = buildHarness(attachment);

        await h.service.sendMessage(SENDER_ID, TASK_ID, 'Фото во вложении', [attachment.id]);

        // Перехватываем realtime-нагрузку, разосланную Участникам (Req 11.3).
        expect(h.broadcastMessage).toHaveBeenCalledTimes(1);
        const payload = h.broadcastMessage.mock.calls[0][1] as ChatMessageHttpView;

        // Property 3 («не отдан»): нагрузка несёт Вложение с миниатюрой.
        expect(payload.attachments).toBeDefined();
        const served = (payload.attachments ?? []).find((a) => a.id === attachment.id);
        expect(served).toBeDefined();
        expect(served?.hasThumbnail).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
