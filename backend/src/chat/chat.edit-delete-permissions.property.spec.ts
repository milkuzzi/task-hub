import fc from 'fast-check';

import { AssignmentKind, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import { AccessDeniedException } from '../common/errors';
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
 * **Feature: task-assignment-system, Property 30: Права на редактирование и удаление сообщения**
 *
 * Property-тест свойства из раздела Correctness Properties дизайна:
 *
 * *Для любого* Сообщения и любого актора редактирование/удаление разрешено
 * ТОГДА И ТОЛЬКО ТОГДА, когда актор — автор Сообщения, Менеджер этой Задачи или
 * Администратор; иначе операция отклоняется (`AccessDeniedException`), а
 * Сообщение остаётся без изменений (Req 11.5, 11.6, 11.7).
 *
 * Свойство проверяется через прикладной сервис {@link ChatService.editMessage}
 * и {@link ChatService.deleteMessage}. Все границы (репозитории сообщений,
 * задач и пользователей, шлюз, часы, конфигурация, аудит) подменены
 * stateful-моками поверх простых in-memory-структур — обращений к реальной базе
 * нет. Хранилище Сообщения мутируется при `update`, что позволяет убедиться в
 * неизменности Сообщения при отказе.
 *
 * Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */

const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
const LIMITS = { messageTextMaxLength: 4000, messageCounterCap: 9999 };
const ORIGINAL_TEXT = 'Исходный текст сообщения';

/** Описание участника популяции теста: глобальная роль и (опц.) назначение в Задаче. */
interface Person {
  id: string;
  role: Role;
  assignment: AssignmentKind | null;
}

/**
 * Stateful in-memory харнесс ChatService для проверки прав на правку/удаление.
 * Хранит единственное Сообщение, мутируемое при `update`, и журнал изменений
 * хранилища (`messageMutations`) для проверки неизменности при отказе.
 */
interface Harness {
  service: ChatService;
  storedMessage: Message;
  messageMutations: number;
}

function buildHarness(people: Person[], authorId: string | null): Harness {
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
      taskId: 'task-1',
      userId: p.id,
      kind: p.assignment as AssignmentKind,
    }));

  const task = {
    id: 'task-1',
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
    id: 'message-1',
    chatId: 'chat-1',
    authorId,
    authorDisplayName: authorId !== null ? `Имя ${authorId}` : 'Удалённый пользователь',
    text: ORIGINAL_TEXT,
    createdAt: FIXED_NOW,
    editedAt: null,
    deleted: false,
  } as unknown as Message;

  const state = { messageMutations: 0 };

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
    update: jest.fn(async (_id: string, data: Record<string, unknown>) => {
      // Мутируем хранимое Сообщение, фиксируя факт изменения (Req 11.5, 11.6, 11.7).
      Object.assign(storedMessage, data);
      state.messageMutations += 1;
      return storedMessage;
    }),
  } as unknown as MessageRepository;

  const messageReadRepository = {
    markRead: jest.fn(async () => true),
    listReaders: jest.fn(async () => []),
  } as unknown as MessageReadRepository;

  const prisma = {
    runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    chat: {
      findUnique: jest.fn(async () => ({ id: 'chat-1', taskId: task.id })),
    },
  } as unknown as PrismaService;

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
    listByMessage: jest.fn(async () => []),
    deleteByMessage: jest.fn(async () => 0),
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

  return {
    service,
    storedMessage,
    get messageMutations() {
      return state.messageMutations;
    },
  } as Harness;
}

/** Ожидаемое право актора на правку/удаление по модели Req 11.6. */
function isAllowed(people: Person[], actorId: string, authorId: string | null): boolean {
  const actor = people.find((p) => p.id === actorId);
  if (actor === undefined) {
    return false;
  }
  const isAuthor = authorId !== null && actorId === authorId;
  const isAdmin = actor.role === Role.ADMIN;
  const isTaskManager = people.some(
    (p) => p.id === actorId && p.assignment === AssignmentKind.MANAGER,
  );
  return isAuthor || isAdmin || isTaskManager;
}

describe('Property 30: Права на редактирование и удаление сообщения (Req 11.5, 11.6, 11.7)', () => {
  // Генерируем популяцию из ровно одного Администратора и набора прочих
  // пользователей с различными глобальными ролями и назначениями в Задаче.
  // Это покрывает: автора, Менеджера задачи, Администратора, глобального
  // Менеджера БЕЗ назначения менеджером в этой задаче, постороннего Исполнителя.
  const roleArb = fc.constantFrom<Role>(Role.EXECUTOR, Role.MANAGER);
  const assignmentArb = fc.constantFrom<AssignmentKind | null>(
    AssignmentKind.EXECUTOR,
    AssignmentKind.MANAGER,
    null,
  );

  const peopleArb = fc
    .array(fc.record({ role: roleArb, assignment: assignmentArb }), { minLength: 1, maxLength: 6 })
    .map((others) => {
      const people: Person[] = others.map((o, index) => ({
        id: `user-${index}`,
        role: o.role,
        assignment: o.assignment,
      }));
      // Ровно один Администратор в популяции (инвариант системы), без назначения
      // в задаче — его право следует исключительно из роли ADMIN (Req 2.3, 11.6).
      people.push({ id: 'admin', role: Role.ADMIN, assignment: null });
      return people;
    });

  it('правка/удаление разрешены ⇔ актор — автор, Менеджер задачи или Администратор; иначе отказ без изменения сообщения', async () => {
    await fc.assert(
      fc.asyncProperty(
        peopleArb,
        fc.nat(),
        // authorIdx: индекс автора в популяции; -1 — автор не задан (authorId === null).
        fc.integer({ min: -1, max: 6 }),
        fc.constantFrom<'edit' | 'delete'>('edit', 'delete'),
        async (people, actorRaw, authorRaw, operation) => {
          const actorId = people[actorRaw % people.length]!.id;
          const authorId = authorRaw < 0 ? null : people[authorRaw % people.length]!.id;

          const h = buildHarness(people, authorId);
          const allowed = isAllowed(people, actorId, authorId);

          if (operation === 'edit') {
            const newText = 'Изменённый текст';
            if (allowed) {
              const updated = await h.service.editMessage(actorId, 'message-1', newText);
              // Разрешено: текст обновлён и установлена метка «изменено» (Req 11.5).
              expect(updated.text).toBe(newText);
              expect(updated.editedAt).toEqual(FIXED_NOW);
              expect(h.storedMessage.text).toBe(newText);
              expect(h.messageMutations).toBe(1);
            } else {
              await expect(
                h.service.editMessage(actorId, 'message-1', newText),
              ).rejects.toBeInstanceOf(AccessDeniedException);
              // Отклонено: Сообщение не изменено (Req 11.6).
              expect(h.storedMessage.text).toBe(ORIGINAL_TEXT);
              expect(h.storedMessage.editedAt).toBeNull();
              expect(h.messageMutations).toBe(0);
            }
          } else {
            if (allowed) {
              await h.service.deleteMessage(actorId, 'message-1');
              // Разрешено: Сообщение помечено удалённым (Req 11.7).
              expect(h.storedMessage.deleted).toBe(true);
              expect(h.messageMutations).toBe(1);
            } else {
              await expect(h.service.deleteMessage(actorId, 'message-1')).rejects.toBeInstanceOf(
                AccessDeniedException,
              );
              // Отклонено: Сообщение не изменено (Req 11.6).
              expect(h.storedMessage.deleted).toBe(false);
              expect(h.messageMutations).toBe(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
