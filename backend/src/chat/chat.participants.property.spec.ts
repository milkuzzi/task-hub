import fc from 'fast-check';
import { AssignmentKind, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import { EntityNotFoundException } from '../common/errors';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
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
 * **Feature: task-assignment-system, Property 28: Участники чата**
 *
 * Property 28 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 11.2**:
 *
 * Для любой Задачи множество Участников её Чата равно объединению её
 * Исполнителей, её Менеджеров и Администратора. Иными словами, для любой Задачи
 * и любого активного Пользователя: Пользователь является Участником чата тогда
 * и только тогда, когда он назначен Исполнителем Задачи, назначен Менеджером
 * Задачи или обладает глобальной ролью Администратора.
 *
 * Свойство проверяется через прикладную логику доступа к Чату:
 * {@link ChatService.sendMessage} принимает Сообщение тогда и только тогда,
 * когда отправитель — Участник чата (Req 11.2), и отклоняет его
 * {@link EntityNotFoundException}, не раскрывая Задачу, в противном случае
 * (Req 11.2, 2.12). Таким образом «принято к сохранению» ≡ «Участник чата».
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Внешние границы
 * ({@link UserRepository}, {@link TaskRepository}, {@link MessageRepository},
 * {@link PrismaService}, {@link ChatGateway}, {@link ClockService},
 * {@link AppConfigService}, {@link AuditRecorder}) подменяются СТАТЕФУЛ
 * in-memory моками поверх общего хранилища — обращений к реальной
 * БД/Redis/сокетам нет. Production-код не изменяется.
 */
describe('Property 28: Участники чата (Req 11.2)', () => {
  const TASK_ID = 'task-1';
  const CHAT_ID = 'chat-1';
  const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
  const LIMITS = { messageTextMaxLength: 4000, messageCounterCap: 9999 };

  /** Статэфул in-memory хранилище Пользователей и одной Задачи. */
  interface Store {
    users: Map<string, User>;
    task: TaskWithAssignments;
    createdMessages: Array<Record<string, unknown>>;
  }

  function buildService(store: Store): ChatService {
    const userRepository = {
      findActiveById: jest.fn(async (id: string) => store.users.get(id) ?? null),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) =>
        id === store.task.id ? store.task : null,
      ),
      update: jest.fn(async () => ({}) as Task),
      setStatus: jest.fn(async () => ({}) as Task),
    } as unknown as TaskRepository;

    const messageRepository = {
      create: jest.fn(async (data: Record<string, unknown>) => {
        store.createdMessages.push(data);
        return {
          id: 'message-new',
          chatId: CHAT_ID,
          authorId: (data.author as { connect: { id: string } }).connect.id,
          authorDisplayName: data.authorDisplayName as string,
          text: data.text as string,
          createdAt: FIXED_NOW,
          editedAt: null,
          deleted: false,
        } as unknown as Message;
      }),
    } as unknown as MessageRepository;

    const prisma = {
      runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      chat: { findUnique: jest.fn(async () => ({ id: CHAT_ID, taskId: TASK_ID })) },
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
    const messageReadRepository = {} as unknown as MessageReadRepository;
    const attachmentRepository = {
      listByTask: jest.fn(async () => []),
    } as unknown as AttachmentRepository;
    const chatMuteRepository = {
      setMute: jest.fn(async () => true),
      isMuted: jest.fn(async () => false),
    } as unknown as ChatMuteRepository;

    return new ChatService(
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
  }

  // --- Арбитрари ---

  /** Глобальная роль Пользователя. */
  const roleArb = fc.constantFrom<Role>(Role.EXECUTOR, Role.MANAGER, Role.ADMIN);

  /** Назначения Пользователя на Задачу: любое подмножество видов назначения. */
  const kindsArb = fc.subarray<AssignmentKind>([AssignmentKind.EXECUTOR, AssignmentKind.MANAGER]);

  /** Один кандидат: глобальная роль и его назначения на Задачу. */
  const candidateArb = fc.record({ role: roleArb, kinds: kindsArb });

  it('Пользователь — Участник чата ⇔ он Исполнитель/Менеджер Задачи или Администратор', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(candidateArb, { minLength: 1, maxLength: 8 }),
        fc.nat(),
        async (candidates, senderPick) => {
          const store: Store = {
            users: new Map(),
            task: undefined as unknown as TaskWithAssignments,
            createdMessages: [],
          };

          const assignments: Array<{
            id: string;
            taskId: string;
            userId: string;
            kind: AssignmentKind;
          }> = [];

          candidates.forEach((c, idx) => {
            const id = `user-${idx}`;
            store.users.set(id, {
              id,
              email: `${id}@example.com`,
              displayName: `Имя ${id}`,
              role: c.role,
              isActive: true,
              deletedAt: null,
            } as unknown as User);
            for (const kind of c.kinds) {
              assignments.push({
                id: `assignment-${idx}-${kind}`,
                taskId: TASK_ID,
                userId: id,
                kind,
              });
            }
          });

          store.task = {
            id: TASK_ID,
            title: 'Задача',
            description: null,
            deadline: new Date('2099-01-01T00:00:00.000Z'),
            status: TaskStatus.IN_PROGRESS,
            adminReviewed: false,
            messageCount: 0,
            createdAt: new Date('2020-01-01T00:00:00.000Z'),
            doneAt: null,
            updatedAt: new Date('2020-01-01T00:00:00.000Z'),
            assignments,
          } as unknown as TaskWithAssignments;

          const senderIndex = senderPick % candidates.length;
          const senderId = `user-${senderIndex}`;
          const sender = candidates[senderIndex]!;

          // Эталонное определение участия согласно Req 11.2: Исполнитель Задачи,
          // Менеджер Задачи или Администратор.
          const isExecutor = sender.kinds.includes(AssignmentKind.EXECUTOR);
          const isManager = sender.kinds.includes(AssignmentKind.MANAGER);
          const isAdmin = sender.role === Role.ADMIN;
          const expectedParticipant = isExecutor || isManager || isAdmin;

          const service = buildService(store);

          let accepted = false;
          let caught: unknown;
          try {
            await service.sendMessage(senderId, TASK_ID, 'Привет');
            accepted = true;
          } catch (err) {
            caught = err;
          }

          // «Сообщение принято к сохранению» ≡ «Пользователь — Участник чата».
          expect(accepted).toBe(expectedParticipant);
          expect(store.createdMessages.length > 0).toBe(expectedParticipant);

          if (!expectedParticipant) {
            // Не-Участник получает отказ «не найдена/недоступна» (Req 11.2, 2.12).
            expect(caught).toBeInstanceOf(EntityNotFoundException);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
