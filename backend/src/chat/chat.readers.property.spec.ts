import fc from 'fast-check';

import { AssignmentKind, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { PrismaService } from '../infra';
import {
  AttachmentRepository,
  ChatMuteRepository,
  MessageReadRepository,
  MessageReadWithUser,
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
 * **Feature: task-assignment-system, Property 31: Список прочитавших сообщение**
 *
 * Property-тест свойства из раздела Correctness Properties дизайна:
 *
 * *Для любого* Сообщения отображаемый список прочитавших равен в точности
 * множеству Участников чата, отметивших это Сообщение прочитанным (Req 11.8).
 *
 * Конкретизация для проверки: для ЛЮБОЙ последовательности операций
 * {@link ChatService.markRead} итоговый список прочитавших
 * ({@link ChatService.listReaders}) равен в точности МНОЖЕСТВУ различных
 * Пользователей, отметивших Сообщение прочитанным — без дубликатов и
 * идемпотентно (повторная отметка тем же Пользователем не меняет список), —
 * и этот список одинаково виден ВСЕМ Участникам чата.
 *
 * Граница {@link MessageReadRepository} подменена stateful in-memory-моком с
 * семантикой множества по уникальному ключу `[messageId, userId]`: повторная
 * вставка пропускается (`markRead` возвращает `false`), а `listReaders`
 * отдаёт отметки с включённым Пользователем в порядке прочтения. Прочие
 * границы (репозитории задач/пользователей, шлюз, часы, конфигурация, аудит)
 * подменены простыми моками — обращений к реальной базе нет.
 *
 * Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */

const LIMITS = { messageTextMaxLength: 4000, messageCounterCap: 9999 };
const MESSAGE_ID = 'message-1';
const TASK_ID = 'task-1';
const CHAT_ID = 'chat-1';
const READ_AT_BASE = Date.parse('2030-05-01T12:00:00.000Z');

/** Участник чата: глобальная роль и (опц.) вид назначения в Задаче. */
interface Person {
  id: string;
  role: Role;
  assignment: AssignmentKind | null;
}

/**
 * Stateful in-memory-реализация {@link MessageReadRepository} с семантикой
 * множества: отметка идемпотентна по ключу `[messageId, userId]`, а список
 * прочитавших формируется в порядке прочтения (ранние → поздние).
 */
class InMemoryMessageReadRepository {
  private readonly reads = new Map<string, { userId: string; readAt: Date }[]>();
  private seq = 0;

  constructor(private readonly users: Record<string, User>) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async markRead(messageId: string, userId: string): Promise<boolean> {
    const list = this.reads.get(messageId) ?? [];
    if (list.some((r) => r.userId === userId)) {
      return false; // Дубликат пропущен — множество не изменилось (Req 11.8).
    }
    list.push({ userId, readAt: new Date(READ_AT_BASE + this.seq++ * 1000) });
    this.reads.set(messageId, list);
    return true;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listReaders(messageId: string): Promise<MessageReadWithUser[]> {
    const list = this.reads.get(messageId) ?? [];
    return list.map(
      (r) =>
        ({
          messageId,
          userId: r.userId,
          readAt: r.readAt,
          user: this.users[r.userId],
        }) as unknown as MessageReadWithUser,
    );
  }
}

interface Harness {
  service: ChatService;
}

function buildHarness(people: Person[]): Harness {
  const users: Record<string, User> = {};
  for (const p of people) {
    users[p.id] = {
      id: p.id,
      email: `${p.id}@example.com`,
      displayName: `Имя ${p.id}`,
      role: p.role,
      isActive: true,
      deletedAt: null,
    } as unknown as User;
  }

  const assignments = people
    .filter((p) => p.assignment !== null)
    .map((p, index) => ({
      id: `assignment-${index}`,
      taskId: TASK_ID,
      userId: p.id,
      kind: p.assignment as AssignmentKind,
    }));

  const task = {
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
    assignments,
  } as unknown as TaskWithAssignments;

  const storedMessage = {
    id: MESSAGE_ID,
    chatId: CHAT_ID,
    authorId: people[0]?.id ?? null,
    authorDisplayName: 'Имя автора',
    text: 'Текст сообщения',
    createdAt: new Date(READ_AT_BASE),
    editedAt: null,
    deleted: false,
  } as unknown as Message;

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
    update: jest.fn(async () => ({}) as Task),
    setStatus: jest.fn(async () => ({}) as Task),
  } as unknown as TaskRepository;

  const messageRepository = {
    findById: jest.fn(async (id: string) => (id === storedMessage.id ? storedMessage : null)),
    update: jest.fn(async () => storedMessage),
  } as unknown as MessageRepository;

  const messageReadRepository = new InMemoryMessageReadRepository(
    users,
  ) as unknown as MessageReadRepository;

  const prisma = {
    runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    chat: {
      findUnique: jest.fn(async () => ({ id: CHAT_ID, taskId: task.id })),
    },
  } as unknown as PrismaService;

  const clock = { now: () => new Date(READ_AT_BASE) } as unknown as ClockService;
  const config = { limits: LIMITS } as unknown as AppConfigService;
  const statusMachine = new StatusMachine();
  const gateway = {
    broadcastMessage: jest.fn(),
    broadcastMessageCounter: jest.fn(),
    broadcastStatus: jest.fn(),
    broadcastMessageReaders: jest.fn(),
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

  return { service };
}

/** Является ли Пользователь Участником чата Задачи (Исполнитель/Менеджер/Администратор). */
function isParticipant(p: Person): boolean {
  return p.role === Role.ADMIN || p.assignment !== null;
}

describe('Property 31: Список прочитавших сообщение (Req 11.8)', () => {
  // Популяция: набор Участников чата с различными ролями/назначениями плюс
  // ровно один Администратор (системный инвариант). Все они — Участники чата,
  // поэтому их отметки прочтения принимаются (Req 11.2, 11.8).
  const peopleArb = fc
    .array(
      fc.record({
        role: fc.constantFrom<Role>(Role.EXECUTOR, Role.MANAGER),
        assignment: fc.constantFrom<AssignmentKind>(
          AssignmentKind.EXECUTOR,
          AssignmentKind.MANAGER,
        ),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map((others) => {
      const people: Person[] = others.map((o, index) => ({
        id: `user-${index}`,
        role: o.role,
        assignment: o.assignment,
      }));
      people.push({ id: 'admin', role: Role.ADMIN, assignment: null });
      return people;
    });

  it('список прочитавших равен в точности множеству различных отметивших; идемпотентно и одинаково видим всем участникам', async () => {
    await fc.assert(
      fc.asyncProperty(
        peopleArb,
        // Последовательность отметок: индексы Участников с возможными повторами,
        // чтобы проверить идемпотентность повторного markRead.
        fc.array(fc.nat({ max: 6 }), { minLength: 0, maxLength: 30 }),
        async (people, rawOps) => {
          const participants = people.filter(isParticipant);
          const h = buildHarness(people);

          // Прогоняем последовательность отметок прочтения.
          const markedOrder: string[] = [];
          for (const raw of rawOps) {
            const reader = participants[raw % participants.length]!;
            await h.service.markRead(reader.id, MESSAGE_ID);
            if (!markedOrder.includes(reader.id)) {
              markedOrder.push(reader.id);
            }
          }

          // Ожидаемое множество — различные отметившие, в порядке первой отметки.
          const expectedSet = new Set(markedOrder);

          // Список одинаково виден ВСЕМ Участникам чата (Req 11.8).
          for (const viewer of participants) {
            const readers = await h.service.listReaders(viewer.id, MESSAGE_ID);
            const readerIds = readers.map((r) => r.userId);

            // Без дубликатов.
            expect(new Set(readerIds).size).toBe(readerIds.length);
            // Равенство множеств: в точности множество отметивших.
            expect(new Set(readerIds)).toEqual(expectedSet);
            expect(readerIds.length).toBe(expectedSet.size);
            // Каждый прочитавший несёт корректное отображаемое имя.
            for (const r of readers) {
              expect(r.displayName).toBe(`Имя ${r.userId}`);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
