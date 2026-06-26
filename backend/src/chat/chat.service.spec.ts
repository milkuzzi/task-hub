import { AssignmentKind, Attachment, Message, Role, Task, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  RateLimitException,
  ValidationException,
} from '../common/errors';
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
 * Модульные тесты {@link ChatService} (Req 11.3–11.7, 10.1–10.3) с подменой
 * репозиториев, шлюза, конфигурации и часов — без обращения к реальной базе.
 *
 * Проверяются: валидация длины текста (Req 11.4), принадлежность к Участникам
 * чата (Req 11.2), атомарное сохранение с насыщающим инкрементом счётчика
 * (Req 9.7) и авто-переходом Статуса (Req 10.1–10.3), немедленная рассылка
 * подключённым Участникам (Req 11.3), метка «изменено» (Req 11.5), метка
 * удаления (Req 11.7) и права на правку (Req 11.6).
 */

const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');

const LIMITS = {
  messageTextMaxLength: 4000,
  messageCounterCap: 9999,
  maxAttachmentsPerMessage: 10,
};

function makeUser(id: string, role: Role, avatarPath: string | null = null): User {
  return {
    id,
    email: `${id}@example.com`,
    displayName: `Имя ${id}`,
    role,
    avatarPath,
    isActive: true,
    deletedAt: null,
  } as unknown as User;
}

function makeTask(
  overrides: Partial<Task> & {
    assignments?: Array<{ userId: string; kind: AssignmentKind }>;
  } = {},
): TaskWithAssignments {
  const assignments = (overrides.assignments ?? []).map((a, index) => ({
    id: `assignment-${index}`,
    taskId: 'task-1',
    userId: a.userId,
    kind: a.kind,
  }));
  return {
    id: 'task-1',
    title: 'Задача',
    description: null,
    deadline: new Date('2030-12-31T00:00:00Z'),
    status: overrides.status ?? TaskStatus.IN_PROGRESS,
    adminReviewed: false,
    messageCount: overrides.messageCount ?? 0,
    createdAt: new Date('2030-01-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2030-01-01T00:00:00Z'),
    assignments,
  } as unknown as TaskWithAssignments;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    chatId: 'chat-1',
    authorId: 'executor-1',
    authorDisplayName: 'Имя executor-1',
    text: 'Привет',
    createdAt: FIXED_NOW,
    editedAt: null,
    deleted: false,
    ...overrides,
  } as unknown as Message;
}

interface Harness {
  service: ChatService;
  users: Record<string, User>;
  task: TaskWithAssignments;
  createdMessages: Array<Record<string, unknown>>;
  updatedTask: { messageCount?: number; status?: TaskStatus };
  messageUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  gateway: {
    broadcastMessage: jest.Mock;
    broadcastMessageCounter: jest.Mock;
    broadcastStatus: jest.Mock;
    broadcastMessageReaders: jest.Mock;
  };
  audit: { record: jest.Mock };
  chatNotifications: { notifyNewMessage: jest.Mock; clearMessageNotification: jest.Mock };
  storedMessage: Message | null;
  reads: Array<{ messageId: string; userId: string }>;
  readerRows: Array<{ messageId: string; userId: string; readAt: Date; user: User }>;
  messageReadRepository: {
    markRead: jest.Mock;
    listReaders: jest.Mock;
  };
  attachmentRepository: { listByTask: jest.Mock; findById: jest.Mock; linkToMessage: jest.Mock };
  linkCalls: Array<{ ids: string[]; messageId: string; guard: unknown }>;
  chatMuteRepository: { setMute: jest.Mock; isMuted: jest.Mock };
  mutes: Set<string>;
}

function buildHarness(
  options: {
    task?: TaskWithAssignments;
    users?: Record<string, User>;
    storedMessage?: Message;
    attachments?: Attachment[];
    rateLimitAllowed?: boolean;
  } = {},
): Harness {
  const users = options.users ?? {
    'executor-1': makeUser('executor-1', Role.EXECUTOR),
    'manager-1': makeUser('manager-1', Role.MANAGER),
    'admin-1': makeUser('admin-1', Role.ADMIN),
    'outsider-1': makeUser('outsider-1', Role.EXECUTOR),
  };
  const task =
    options.task ??
    makeTask({
      assignments: [
        { userId: 'executor-1', kind: AssignmentKind.EXECUTOR },
        { userId: 'manager-1', kind: AssignmentKind.MANAGER },
      ],
    });

  const createdMessages: Array<Record<string, unknown>> = [];
  const updatedTask: { messageCount?: number; status?: TaskStatus } = {};
  const messageUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const storedMessage = options.storedMessage ?? null;

  const userRepository = {
    findActiveById: jest.fn(async (id: string) => users[id] ?? null),
  } as unknown as UserRepository;

  const taskRepository = {
    findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
    update: jest.fn(async (_id: string, data: { messageCount?: number }) => {
      if (data.messageCount !== undefined) {
        updatedTask.messageCount = data.messageCount;
      }
      return {} as Task;
    }),
    setStatus: jest.fn(async (_id: string, status: TaskStatus) => {
      updatedTask.status = status;
      return {} as Task;
    }),
  } as unknown as TaskRepository;

  const messageRepository = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      createdMessages.push(data);
      return makeMessage({
        id: 'message-new',
        text: data.text as string,
        authorDisplayName: data.authorDisplayName as string,
      });
    }),
    findById: jest.fn(async (id: string) =>
      storedMessage !== null && storedMessage.id === id ? storedMessage : null,
    ),
    update: jest.fn(async (id: string, data: Record<string, unknown>) => {
      messageUpdates.push({ id, data });
      return makeMessage({ ...(storedMessage ?? {}), id, ...data } as Partial<Message>);
    }),
  } as unknown as MessageRepository;

  const prisma = {
    runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    chat: {
      findUnique: jest.fn(async () => ({ id: 'chat-1', taskId: task.id })),
    },
  } as unknown as PrismaService;

  const clock = { now: () => FIXED_NOW } as unknown as ClockService;
  const config = { limits: LIMITS } as unknown as AppConfigService;
  const statusMachine = new StatusMachine();

  // Учёт отметок о прочтении (Req 11.8): in-memory с идемпотентностью.
  const reads: Array<{ messageId: string; userId: string }> = [];
  const readerRows: Array<{ messageId: string; userId: string; readAt: Date; user: User }> = [];
  const messageReadRepository = {
    markRead: jest.fn(async (messageId: string, userId: string) => {
      const exists = reads.some((r) => r.messageId === messageId && r.userId === userId);
      if (exists) {
        return false;
      }
      reads.push({ messageId, userId });
      readerRows.push({ messageId, userId, readAt: FIXED_NOW, user: users[userId] as User });
      return true;
    }),
    listReaders: jest.fn(async (messageId: string) =>
      readerRows.filter((r) => r.messageId === messageId),
    ),
  };

  const gateway = {
    broadcastMessage: jest.fn(),
    broadcastMessageCounter: jest.fn(),
    broadcastStatus: jest.fn(),
    broadcastMessageReaders: jest.fn(),
  };
  const audit = { record: jest.fn(async () => undefined) };

  // Маршрутизатор уведомлений Чата (Req 14.1, 14.2, 14.4): подменяется моком —
  // здесь проверяется лишь факт делегирования формирования/очистки.
  const chatNotifications = {
    notifyNewMessage: jest.fn(async () => undefined),
    clearMessageNotification: jest.fn(async () => undefined),
  };

  // Вложения Чата (Req 11.10): in-memory выборка по Задаче и привязка к Сообщению.
  const attachmentRows: Attachment[] = options.attachments ?? [];
  const linkCalls: Array<{ ids: string[]; messageId: string; guard: unknown }> = [];
  const attachmentRepository = {
    listByTask: jest.fn(async (id: string) => (id === task.id ? attachmentRows : [])),
    findById: jest.fn(async (id: string) => attachmentRows.find((a) => a.id === id) ?? null),
    linkToMessage: jest.fn(
      async (ids: string[], messageId: string, guard: { taskId: string; uploaderId: string }) => {
        linkCalls.push({ ids, messageId, guard });
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
  };

  // Заглушение Чата (Req 16.9): in-memory набор пар «Пользователь + Задача».
  const mutes = new Set<string>();
  const chatMuteRepository = {
    setMute: jest.fn(async (userId: string, taskId: string, muted: boolean) => {
      const key = `${userId}:${taskId}`;
      if (muted) {
        mutes.add(key);
        return true;
      }
      mutes.delete(key);
      return false;
    }),
    isMuted: jest.fn(async (userId: string, taskId: string) => mutes.has(`${userId}:${taskId}`)),
  };

  const service = new ChatService(
    prisma,
    messageRepository,
    messageReadRepository as unknown as MessageReadRepository,
    attachmentRepository as unknown as AttachmentRepository,
    chatMuteRepository as unknown as ChatMuteRepository,
    taskRepository,
    userRepository,
    statusMachine,
    clock,
    config,
    gateway as unknown as ChatGateway,
    chatNotifications as unknown as ChatNotificationRouter,
    {
      check: jest.fn(async () => ({ allowed: options.rateLimitAllowed ?? true })),
    } as unknown as RateLimiter,
    audit as unknown as AuditRecorder,
    { delete: jest.fn(async () => undefined) } as unknown as StorageService,
  );

  return {
    service,
    users,
    task,
    createdMessages,
    updatedTask,
    messageUpdates,
    gateway,
    audit,
    chatNotifications,
    storedMessage,
    reads,
    readerRows,
    messageReadRepository,
    attachmentRepository,
    linkCalls,
    chatMuteRepository,
    mutes,
  };
}

describe('ChatService.sendMessage', () => {
  it('отклоняет пустой текст без сохранения (Req 11.4)', async () => {
    const h = buildHarness();
    await expect(h.service.sendMessage('executor-1', 'task-1', '')).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(h.createdMessages).toHaveLength(0);
    expect(h.gateway.broadcastMessage).not.toHaveBeenCalled();
  });

  it('отклоняет отправку 429 при превышении частоты, ничего не сохраняя (Req 19.1, 19.2)', async () => {
    const h = buildHarness({ rateLimitAllowed: false });
    await expect(h.service.sendMessage('executor-1', 'task-1', 'Привет')).rejects.toBeInstanceOf(
      RateLimitException,
    );
    expect(h.createdMessages).toHaveLength(0);
    expect(h.gateway.broadcastMessage).not.toHaveBeenCalled();
  });

  it('отклоняет текст длиннее 4000 символов без сохранения (Req 11.4)', async () => {
    const h = buildHarness();
    await expect(
      h.service.sendMessage('executor-1', 'task-1', 'a'.repeat(4001)),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(h.createdMessages).toHaveLength(0);
  });

  it('принимает граничную длину 4000 символов (Req 11.3)', async () => {
    const h = buildHarness();
    await expect(
      h.service.sendMessage('executor-1', 'task-1', 'a'.repeat(4000)),
    ).resolves.toBeDefined();
    expect(h.createdMessages).toHaveLength(1);
  });

  it('не раскрывает чужую задачу не-Участнику чата (Req 11.2, 2.12)', async () => {
    const h = buildHarness();
    await expect(h.service.sendMessage('outsider-1', 'task-1', 'Привет')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(h.createdMessages).toHaveLength(0);
  });

  it('сохраняет сообщение с денормализованным именем автора и рассылает его (Req 11.3, 8.4)', async () => {
    const h = buildHarness();
    await h.service.sendMessage('executor-1', 'task-1', 'Привет');
    expect(h.createdMessages[0]).toMatchObject({
      text: 'Привет',
      authorDisplayName: 'Имя executor-1',
      chat: { connect: { taskId: 'task-1' } },
      author: { connect: { id: 'executor-1' } },
    });
    expect(h.gateway.broadcastMessage).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ taskId: 'task-1', authorDisplayName: 'Имя executor-1' }),
    );
    expect(h.gateway.broadcastMessageCounter).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ messageCount: 1 }),
    );
    expect(h.chatNotifications.notifyNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', taskTitle: 'Задача' }),
    );
  });

  it('сообщение Исполнителя в «В работе» переводит задачу в «Ожидает» (Req 10.1)', async () => {
    const h = buildHarness();
    await h.service.sendMessage('executor-1', 'task-1', 'Готовлю');
    expect(h.updatedTask.status).toBe(TaskStatus.WAITING);
    expect(h.gateway.broadcastStatus).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: TaskStatus.WAITING }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'status', oldValue: 'IN_PROGRESS', newValue: 'WAITING' }),
    );
  });

  it('сообщение Менеджера в «Ожидает» переводит задачу в «В работе» (Req 10.2)', async () => {
    const h = buildHarness({
      task: makeTask({
        status: TaskStatus.WAITING,
        assignments: [{ userId: 'manager-1', kind: AssignmentKind.MANAGER }],
      }),
    });
    await h.service.sendMessage('manager-1', 'task-1', 'Жду результат');
    expect(h.updatedTask.status).toBe(TaskStatus.IN_PROGRESS);
  });

  it('Менеджер, назначенный Исполнителем, считается Исполнителем для авто-перехода (Req 2.4, 10.1)', async () => {
    const h = buildHarness({
      task: makeTask({
        status: TaskStatus.IN_PROGRESS,
        assignments: [{ userId: 'manager-1', kind: AssignmentKind.EXECUTOR }],
      }),
    });
    await h.service.sendMessage('manager-1', 'task-1', 'Делаю');
    expect(h.updatedTask.status).toBe(TaskStatus.WAITING);
  });

  it('в статусе «Выполнено» сообщение статус не меняет (Req 10.3)', async () => {
    const h = buildHarness({
      task: makeTask({
        status: TaskStatus.DONE,
        assignments: [{ userId: 'executor-1', kind: AssignmentKind.EXECUTOR }],
      }),
    });
    await h.service.sendMessage('executor-1', 'task-1', 'Готово?');
    expect(h.updatedTask.status).toBeUndefined();
    expect(h.gateway.broadcastStatus).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('счётчик насыщается на 9999 и не пишется повторно (Req 9.9)', async () => {
    const h = buildHarness({
      task: makeTask({
        status: TaskStatus.DONE,
        messageCount: 9999,
        assignments: [{ userId: 'executor-1', kind: AssignmentKind.EXECUTOR }],
      }),
    });
    await h.service.sendMessage('executor-1', 'task-1', 'Ещё одно');
    // Счётчик уже на потолке — обновление хранилища не выполняется.
    expect(h.updatedTask.messageCount).toBeUndefined();
    expect(h.gateway.broadcastMessageCounter).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ messageCount: 9999 }),
    );
  });

  it('привязывает ранее загруженные «висящие» вложения к сообщению при отправке (Req 12.1–12.5)', async () => {
    const attachments = [
      makeAttachment('att-1', { messageId: null, taskId: 'task-1', uploaderId: 'executor-1' }),
      makeAttachment('att-2', { messageId: null, taskId: 'task-1', uploaderId: 'executor-1' }),
    ];
    const h = buildHarness({ attachments });

    await h.service.sendMessage('executor-1', 'task-1', 'Привет', ['att-1', 'att-2']);

    expect(h.createdMessages).toHaveLength(1);
    expect(h.attachmentRepository.linkToMessage).toHaveBeenCalledWith(
      ['att-1', 'att-2'],
      'message-new',
      { taskId: 'task-1', uploaderId: 'executor-1' },
      expect.anything(),
    );
    // Вложения фактически привязаны к сохранённому Сообщению.
    expect(attachments.every((a) => a.messageId === 'message-new')).toBe(true);
  });

  it('разрешает отправить сообщение с вложением без текста', async () => {
    const attachment = makeAttachment('att-1', {
      messageId: null,
      taskId: 'task-1',
      uploaderId: 'executor-1',
    });
    const h = buildHarness({ attachments: [attachment] });

    const result = await h.service.sendMessage('executor-1', 'task-1', '', ['att-1']);

    expect(h.createdMessages).toHaveLength(1);
    expect(h.createdMessages[0]).toMatchObject({ text: '' });
    expect(attachment.messageId).toBe('message-new');
    expect(result.attachments?.[0]).toMatchObject({ id: 'att-1', messageId: 'message-new' });
  });

  it('отклоняет пустое сообщение без вложений и не сохраняет его', async () => {
    const h = buildHarness();

    await expect(h.service.sendMessage('executor-1', 'task-1', '')).rejects.toBeInstanceOf(
      ValidationException,
    );

    expect(h.createdMessages).toHaveLength(0);
    expect(h.gateway.broadcastMessage).not.toHaveBeenCalled();
  });

  it('возвращает и рассылает аватар автора для свежеотправленного сообщения', async () => {
    const h = buildHarness({
      users: {
        'executor-1': makeUser('executor-1', Role.EXECUTOR, 'avatars/executor-1.png'),
        'manager-1': makeUser('manager-1', Role.MANAGER),
        'admin-1': makeUser('admin-1', Role.ADMIN),
        'outsider-1': makeUser('outsider-1', Role.EXECUTOR),
      },
    });

    const result = await h.service.sendMessage('executor-1', 'task-1', 'Привет');

    expect(result.authorAvatarPath).toBe('avatars/executor-1.png');
    expect(h.gateway.broadcastMessage).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ authorAvatarPath: 'avatars/executor-1.png' }),
    );
  });

  it('отклоняет недопустимое вложение без сохранения сообщения (Req 12.1–12.5, 2.12)', async () => {
    const attachments = [
      // Чужое вложение другого пользователя — недопустимо к привязке.
      makeAttachment('att-1', { messageId: null, taskId: 'task-1', uploaderId: 'outsider-9' }),
    ];
    const h = buildHarness({ attachments });

    await expect(
      h.service.sendMessage('executor-1', 'task-1', 'Привет', ['att-1']),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(h.createdMessages).toHaveLength(0);
    expect(h.attachmentRepository.linkToMessage).not.toHaveBeenCalled();
  });

  it('отклоняет несуществующий идентификатор вложения без сохранения сообщения (Req 12.1–12.5, 2.12)', async () => {
    const h = buildHarness();

    await expect(
      h.service.sendMessage('executor-1', 'task-1', 'Привет', ['ghost']),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(h.createdMessages).toHaveLength(0);
  });

  it('отклоняет превышение лимита 10 вложений на сообщение без сохранения (Req 11.9)', async () => {
    const h = buildHarness();
    const ids = Array.from({ length: 11 }, (_, i) => `att-${i}`);

    await expect(
      h.service.sendMessage('executor-1', 'task-1', 'Привет', ids),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(h.createdMessages).toHaveLength(0);
    expect(h.attachmentRepository.linkToMessage).not.toHaveBeenCalled();
  });
});

describe('ChatService.editMessage', () => {
  it('проставляет метку «изменено» и рассылает обновление (Req 11.5)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    await h.service.editMessage('executor-1', 'message-1', 'Исправленный текст');
    expect(h.messageUpdates[0]).toMatchObject({
      data: { text: 'Исправленный текст', editedAt: FIXED_NOW },
    });
    expect(h.gateway.broadcastMessage).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ id: 'message-1' }),
    );
  });

  it('Менеджер задачи вправе редактировать чужое сообщение (Req 11.5)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    await expect(
      h.service.editMessage('manager-1', 'message-1', 'Правка менеджера'),
    ).resolves.toBeDefined();
  });

  it('Администратор вправе редактировать чужое сообщение (Req 11.6, 2.3)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    await expect(
      h.service.editMessage('admin-1', 'message-1', 'Правка администратора'),
    ).resolves.toBeDefined();
  });

  it('отклоняет правку Участником, не являющимся автором/Менеджером/Администратором (Req 11.6)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    h.users['executor-2'] = makeUser('executor-2', Role.EXECUTOR);
    h.task.assignments.push({
      id: 'assignment-x',
      taskId: 'task-1',
      userId: 'executor-2',
      kind: AssignmentKind.EXECUTOR,
    } as never);
    await expect(
      h.service.editMessage('executor-2', 'message-1', 'Чужая правка'),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(h.messageUpdates).toHaveLength(0);
  });

  it('отклоняет пустой текст без изменения сообщения (Req 11.4)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    await expect(h.service.editMessage('executor-1', 'message-1', '')).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(h.messageUpdates).toHaveLength(0);
  });
});

describe('ChatService.deleteMessage', () => {
  it('помечает сообщение удалённым и рассылает обновление (Req 11.7)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    await h.service.deleteMessage('executor-1', 'message-1');
    expect(h.messageUpdates[0]).toMatchObject({ data: { deleted: true } });
    expect(h.gateway.broadcastMessage).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ deleted: true }),
    );
  });

  it('отклоняет удаление Участником без прав (Req 11.6)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'executor-1' }) });
    h.users['executor-2'] = makeUser('executor-2', Role.EXECUTOR);
    h.task.assignments.push({
      id: 'assignment-x',
      taskId: 'task-1',
      userId: 'executor-2',
      kind: AssignmentKind.EXECUTOR,
    } as never);
    await expect(h.service.deleteMessage('executor-2', 'message-1')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect(h.messageUpdates).toHaveLength(0);
  });
});

describe('ChatService.markRead', () => {
  it('фиксирует отметку и рассылает обновлённый список прочитавших (Req 11.8)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await h.service.markRead('executor-1', 'message-1');

    expect(h.messageReadRepository.markRead).toHaveBeenCalledWith('message-1', 'executor-1');
    expect(h.gateway.broadcastMessageReaders).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        messageId: 'message-1',
        taskId: 'task-1',
        readers: [expect.objectContaining({ userId: 'executor-1', displayName: 'Имя executor-1' })],
      }),
    );
  });

  it('идемпотентна: повторная отметка не рассылает список повторно (Req 11.8)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await h.service.markRead('executor-1', 'message-1');
    h.gateway.broadcastMessageReaders.mockClear();

    await h.service.markRead('executor-1', 'message-1');
    expect(h.gateway.broadcastMessageReaders).not.toHaveBeenCalled();
    expect(h.reads).toHaveLength(1);
  });

  it('накапливает несколько прочитавших Участников (Req 11.8)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await h.service.markRead('executor-1', 'message-1');
    await h.service.markRead('manager-1', 'message-1');

    const lastCall = h.gateway.broadcastMessageReaders.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({
      readers: [
        expect.objectContaining({ userId: 'executor-1' }),
        expect.objectContaining({ userId: 'manager-1' }),
      ],
    });
  });

  it('не раскрывает Сообщение не-Участнику чата (Req 11.2, 2.12)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await expect(h.service.markRead('outsider-1', 'message-1')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(h.messageReadRepository.markRead).not.toHaveBeenCalled();
    expect(h.gateway.broadcastMessageReaders).not.toHaveBeenCalled();
  });

  it('Администратор вправе отметить Сообщение прочитанным (Req 2.3, 11.8)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await expect(h.service.markRead('admin-1', 'message-1')).resolves.toBeUndefined();
    expect(h.reads).toEqual([{ messageId: 'message-1', userId: 'admin-1' }]);
  });
});

describe('ChatService.listReaders', () => {
  it('возвращает список прочитавших, видимый Участнику чата (Req 11.8)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await h.service.markRead('executor-1', 'message-1');

    const readers = await h.service.listReaders('manager-1', 'message-1');
    expect(readers).toEqual([
      { userId: 'executor-1', displayName: 'Имя executor-1', readAt: FIXED_NOW },
    ]);
  });

  it('не раскрывает список прочитавших не-Участнику чата (Req 11.2, 2.12)', async () => {
    const h = buildHarness({ storedMessage: makeMessage({ authorId: 'manager-1' }) });
    await expect(h.service.listReaders('outsider-1', 'message-1')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

function makeAttachment(id: string, overrides: Partial<Attachment> = {}): Attachment {
  return {
    id,
    messageId: 'message-1',
    originalName: `${id}.bin`,
    mimeType: 'application/octet-stream',
    sizeBytes: BigInt(1024),
    storagePath: `/storage/${id}`,
    thumbnailPath: null,
    compression: 'zstd',
    checksum: `sum-${id}`,
    ...overrides,
  } as unknown as Attachment;
}

describe('ChatService.listAttachments', () => {
  it('возвращает все вложения чата Участнику чата (Req 11.10)', async () => {
    const attachments = [makeAttachment('att-1'), makeAttachment('att-2')];
    const h = buildHarness({ attachments });

    const result = await h.service.listAttachments('executor-1', 'task-1');
    expect(result).toEqual(attachments);
    expect(h.attachmentRepository.listByTask).toHaveBeenCalledWith('task-1');
  });

  it('возвращает пустой список, когда вложений нет (Req 11.10)', async () => {
    const h = buildHarness({ attachments: [] });
    await expect(h.service.listAttachments('manager-1', 'task-1')).resolves.toEqual([]);
  });

  it('доступно Администратору (Req 2.3, 11.10)', async () => {
    const h = buildHarness({ attachments: [makeAttachment('att-1')] });
    await expect(h.service.listAttachments('admin-1', 'task-1')).resolves.toHaveLength(1);
  });

  it('не раскрывает вложения не-Участнику чата (Req 11.2, 2.12)', async () => {
    const h = buildHarness({ attachments: [makeAttachment('att-1')] });
    await expect(h.service.listAttachments('outsider-1', 'task-1')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(h.attachmentRepository.listByTask).not.toHaveBeenCalled();
  });

  it('отклоняет запрос от неизвестной/удалённой учётной записи (Req 11.2)', async () => {
    const h = buildHarness({ attachments: [makeAttachment('att-1')] });
    await expect(h.service.listAttachments('ghost', 'task-1')).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });

  it('не раскрывает отсутствующую задачу (Req 2.12)', async () => {
    const h = buildHarness();
    await expect(h.service.listAttachments('executor-1', 'missing-task')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('ChatService.setMute', () => {
  it('заглушает чат для Участника (Req 16.9)', async () => {
    const h = buildHarness();
    await h.service.setMute('executor-1', 'task-1', true);
    expect(h.chatMuteRepository.setMute).toHaveBeenCalledWith('executor-1', 'task-1', true);
    expect(h.mutes.has('executor-1:task-1')).toBe(true);
  });

  it('снимает заглушение (round-trip) (Req 16.9)', async () => {
    const h = buildHarness();
    await h.service.setMute('executor-1', 'task-1', true);
    await h.service.setMute('executor-1', 'task-1', false);
    expect(h.mutes.has('executor-1:task-1')).toBe(false);
  });

  it('идемпотентно при повторном заглушении (Req 16.9)', async () => {
    const h = buildHarness();
    await h.service.setMute('manager-1', 'task-1', true);
    await expect(h.service.setMute('manager-1', 'task-1', true)).resolves.toBeUndefined();
    expect(h.mutes.has('manager-1:task-1')).toBe(true);
  });

  it('доступно Администратору (Req 2.3, 16.9)', async () => {
    const h = buildHarness();
    await expect(h.service.setMute('admin-1', 'task-1', true)).resolves.toBeUndefined();
    expect(h.mutes.has('admin-1:task-1')).toBe(true);
  });

  it('не раскрывает задачу не-Участнику чата и не меняет заглушение (Req 11.2, 2.12)', async () => {
    const h = buildHarness();
    await expect(h.service.setMute('outsider-1', 'task-1', true)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(h.chatMuteRepository.setMute).not.toHaveBeenCalled();
  });

  it('отклоняет запрос от неизвестной/удалённой учётной записи (Req 11.2)', async () => {
    const h = buildHarness();
    await expect(h.service.setMute('ghost', 'task-1', true)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });
});
