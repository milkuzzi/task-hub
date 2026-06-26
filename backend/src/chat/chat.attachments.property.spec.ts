import fc from 'fast-check';
import { AssignmentKind, Attachment, Role, TaskStatus, User } from '@prisma/client';
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
 * **Feature: task-assignment-system, Property 33: Полнота раздела «Вложения»**
 *
 * Property 33 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 11.10**:
 *
 * Для любого Чата множество Вложений, показываемых в разделе «Вложения», равно
 * множеству всех Вложений всех Сообщений этого Чата — ни одно Вложение не
 * пропущено и ни одно лишнее не добавлено.
 *
 * Тест прогоняет {@link ChatService.listAttachments} (доступ Участника чата
 * предоставлен) поверх stateful in-memory модели хранилища: Сообщения → их
 * Вложения. Подменённый {@link AttachmentRepository.listByTask} воспроизводит
 * поведение реального запроса (`attachment where message.chat.taskId = taskId`),
 * возвращая объединение Вложений всех Сообщений Чата Задачи. Никакой реальной
 * БД. Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь 200).
 */

const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
const LIMITS = { messageTextMaxLength: 4000, messageCounterCap: 9999 };
const TASK_ID = 'task-1';

/** Один Участник чата (Исполнитель) — доступ к разделу «Вложения» предоставлен. */
const PARTICIPANT_ID = 'executor-1';

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
      {
        id: 'assignment-0',
        taskId: TASK_ID,
        userId: PARTICIPANT_ID,
        kind: AssignmentKind.EXECUTOR,
      },
    ],
  } as unknown as TaskWithAssignments;
}

/**
 * Модель одного Сообщения с его Вложениями: упорядоченный список
 * идентификаторов Вложений, прикреплённых к Сообщению.
 */
interface MessageModel {
  messageId: string;
  attachmentIds: string[];
}

/**
 * Строит экземпляр {@link ChatService} поверх stateful in-memory модели
 * «Сообщения → Вложения». Подменённый репозиторий Вложений возвращает
 * объединение Вложений всех Сообщений Чата Задачи (как реальный запрос по
 * `message.chat.taskId`), сохраняя детерминированный порядок: по индексу
 * Сообщения, затем по идентификатору Вложения.
 */
function buildService(messages: MessageModel[]): {
  service: ChatService;
  expectedAttachmentIds: string[];
} {
  // Хранилище «Сообщение → Вложения» (stateful in-memory).
  const store = new Map<string, Attachment[]>();
  for (const [index, m] of messages.entries()) {
    const rows = m.attachmentIds.map((attId) => makeAttachment(attId, m.messageId, index));
    store.set(m.messageId, rows);
  }

  const expectedAttachmentIds = messages.flatMap((m) => m.attachmentIds);

  const user = makeUser(PARTICIPANT_ID, Role.EXECUTOR);
  const task = makeTask();

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => (id === user.id ? user : null)),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
  } as unknown as TaskRepository;

  const attachmentRepository = {
    // Воспроизводит запрос реального репозитория: все Вложения всех Сообщений
    // Чата Задачи в детерминированном порядке (Сообщение → id Вложения).
    listByTask: jest.fn(async (taskId: string): Promise<Attachment[]> => {
      if (taskId !== task.id) {
        return [];
      }
      const all: Array<{ row: Attachment; order: number }> = [];
      for (const m of messages) {
        const order = messages.indexOf(m);
        for (const row of store.get(m.messageId) ?? []) {
          all.push({ row, order });
        }
      }
      all.sort((a, b) => a.order - b.order || a.row.id.localeCompare(b.row.id));
      return all.map((e) => e.row);
    }),
  } as unknown as AttachmentRepository;

  const service = new ChatService(
    {} as unknown as PrismaService,
    {} as unknown as MessageRepository,
    {} as unknown as MessageReadRepository,
    attachmentRepository,
    {} as unknown as ChatMuteRepository,
    taskRepository,
    userRepository,
    new StatusMachine(),
    { now: () => FIXED_NOW } as unknown as ClockService,
    { limits: LIMITS } as unknown as AppConfigService,
    {} as unknown as ChatGateway,
    {
      notifyNewMessage: jest.fn(),
      clearMessageNotification: jest.fn(),
    } as unknown as ChatNotificationRouter,
    { check: jest.fn(async () => ({ allowed: true })) } as unknown as RateLimiter,
    {} as unknown as AuditRecorder,
    { delete: jest.fn(async () => undefined) } as unknown as StorageService,
  );

  return { service, expectedAttachmentIds };
}

function makeAttachment(id: string, messageId: string, seq: number): Attachment {
  return {
    id,
    messageId,
    originalName: `${id}.bin`,
    mimeType: 'application/octet-stream',
    sizeBytes: BigInt(1024 + seq),
    storagePath: `/storage/${id}`,
    thumbnailPath: null,
    compression: 'zstd',
    checksum: `sum-${id}`,
  } as unknown as Attachment;
}

describe('Property 33: Полнота раздела «Вложения» (Req 11.10)', () => {
  /**
   * Генератор набора Сообщений с Вложениями для одного Чата: уникальные
   * идентификаторы Сообщений и глобально уникальные идентификаторы Вложений
   * (на разных Сообщениях), от пустого набора до нескольких Сообщений с
   * нулём или несколькими Вложениями.
   */
  const messagesArb = fc
    .array(fc.array(fc.integer({ min: 0, max: 1000 }), { maxLength: 6 }), { maxLength: 8 })
    .map((perMessageCounts): MessageModel[] => {
      let attCounter = 0;
      return perMessageCounts.map((count, mi) => ({
        messageId: `message-${mi}`,
        // Глобально уникальные id Вложений вне зависимости от Сообщения.
        attachmentIds: Array.from({ length: count.length }, () => `att-${attCounter++}`),
      }));
    });

  it('раздел «Вложения» = множество всех Вложений всех Сообщений Чата (Req 11.10)', async () => {
    await fc.assert(
      fc.asyncProperty(messagesArb, async (messages) => {
        const { service, expectedAttachmentIds } = buildService(messages);

        const result = await service.listAttachments(PARTICIPANT_ID, TASK_ID);
        const resultIds = result.map((a) => a.id);

        const resultSet = new Set(resultIds);
        const expectedSet = new Set(expectedAttachmentIds);

        // Ни одно Вложение не пропущено и ни одно лишнее не добавлено:
        // множества совпадают (Req 11.10).
        expect(resultSet).toEqual(expectedSet);

        // Без дубликатов: размер совпадает с числом уникальных Вложений Чата.
        expect(resultIds).toHaveLength(expectedSet.size);
        expect(resultIds.length).toBe(expectedAttachmentIds.length);

        // Каждое возвращённое Вложение принадлежит Чату (нет посторонних).
        for (const id of resultIds) {
          expect(expectedSet.has(id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
