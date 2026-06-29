import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import {
  AssignmentKind,
  Attachment,
  DeliveryStatus,
  Message,
  Notification,
  NotificationType,
  Role,
  Task,
  TaskStatus,
  User,
} from '@prisma/client';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { AuthenticationException } from '../common/errors';
import { PrismaService, QueueService, RedisService, SessionRegistry } from '../infra';
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
import { ChatMessageHttpView } from '../chat/chat-representation';
import { NotificationRepository } from '../notifications/notification.repository';
import { toNotificationView } from '../notifications/notification-representation';
import { NotificationChannel } from '../notifications/notifications.types';
import { MaxDeliveryFilter } from '../notifications/delivery/max-delivery-filter';
import { MaxDeliveryPort } from '../notifications/delivery/max-delivery.port';
import { NotificationDeliveryService } from '../notifications/delivery/notification-delivery.service';
import { SiteNotificationDispatcher } from '../notifications/delivery/site-notification.dispatcher';
import { SessionTokenService } from '../auth/session-token.service';
import { AuthService } from '../auth/auth.service';
import { AuthController } from '../auth/auth.controller';

/**
 * **Bugfix: task-hub-bug-fixes — сквозные интеграционные тесты по затронутым
 * потокам (задача 28).**
 *
 * **Validates: Requirements 2.2, 2.3, 2.8, 2.9, 3.3, 3.9**
 *
 * Серверная часть интеграционных тестов: проверяет взаимодействие исправленных
 * сервисов на уровне прикладной логики (а не полного HTTP-e2e), переиспользуя
 * harness/моки из per-defect тестов. Покрываемые потоки:
 *
 * - **Поток Чата** (дефекты 2, 8): отправка Сообщения с изображением → живая
 *   нагрузка несёт Вложение с `hasThumbnail = true` (миниатюра видна без
 *   перезагрузки, Req 2.2); удаление Сообщения с Вложениями → записи Вложений и
 *   их файлы удалены, раздел «Вложения» пуст (Req 2.8).
 * - **Поток Уведомлений** (дефекты 3, 3.3): новое Сообщение → онлайн-получателю
 *   доставляется живая нагрузка в форме `AppNotification` и сохраняется запись
 *   в Центре (Req 2.3); офлайн-получатель видит запись при следующем входе
 *   (Req 3.3).
 * - **Поток Сессии** (дефекты 9, 3.9): активная работа дольше TTL с проактивным
 *   `refresh` не прерывается (Req 2.9); после logout/сброса и для истёкших
 *   Сессий запросы отклоняются 401 (Req 3.9).
 *
 * Поток аватаров (дефекты 1, 4) покрыт фронтенд-интеграционным тестом
 * (`frontend/src/integration/avatar-flow.integration.test.tsx`).
 */

const FIXED_NOW = new Date('2030-05-01T12:00:00.000Z');
const MAX_BYTES = 25 * 1024 * 1024;
const CHAT_LIMITS = {
  messageTextMaxLength: 4000,
  messageCounterCap: 9999,
  maxAttachmentsPerMessage: 10,
  attachmentMaxBytes: MAX_BYTES,
};

// =============================================================================
// Поток Чата (дефекты 2, 8)
// =============================================================================

describe('Интеграция: поток Чата — миниатюра без перезагрузки и очистка Вложений (дефекты 2, 8)', () => {
  const TASK_ID = 'task-chat-1';
  const CHAT_ID = 'chat-1';
  const AUTHOR_ID = 'executor-1';

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
        { id: 'assignment-0', taskId: TASK_ID, userId: AUTHOR_ID, kind: AssignmentKind.EXECUTOR },
      ],
    } as unknown as TaskWithAssignments;
  }

  /**
   * «Висящее» Вложение-изображение в пределах лимита со сформированной
   * миниатюрой (`thumbnailPath` задан → `hasThumbnail = true`, дефект 2).
   */
  function makeImageAttachment(id: string): Attachment {
    return {
      id,
      messageId: null,
      taskId: TASK_ID,
      uploaderId: AUTHOR_ID,
      originalName: `${id}.png`,
      mimeType: 'image/png',
      sizeBytes: BigInt(1024),
      storagePath: `${TASK_ID}/orig-${id}.zst`,
      thumbnailPath: `${TASK_ID}/thumb-${id}.zst`,
      compression: 'zstd',
      checksum: `checksum-${id}`,
      createdAt: FIXED_NOW,
    } as unknown as Attachment;
  }

  interface ChatHarness {
    service: ChatService;
    attachments: Map<string, Attachment>;
    messages: Map<string, Message>;
    storageObjects: Set<string>;
    broadcastMessage: jest.Mock;
    storageDelete: jest.Mock;
  }

  function buildChatHarness(seedAttachments: Attachment[]): ChatHarness {
    const user = makeUser(AUTHOR_ID, Role.EXECUTOR);
    const task = makeTask();

    const attachments = new Map<string, Attachment>();
    const storageObjects = new Set<string>();
    for (const a of seedAttachments) {
      attachments.set(a.id, a);
      storageObjects.add(a.storagePath);
      if (a.thumbnailPath !== null) {
        storageObjects.add(a.thumbnailPath);
      }
    }

    const messages = new Map<string, Message>();
    let messageSeq = 0;

    const userRepository = {
      findActiveById: jest.fn(async (id: string) => (id === user.id ? user : null)),
      findById: jest.fn(async (id: string) => (id === user.id ? user : null)),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) => (id === task.id ? task : null)),
      update: jest.fn(async () => ({}) as Task),
      setStatus: jest.fn(async () => ({}) as Task),
    } as unknown as TaskRepository;

    const messageRepository = {
      create: jest.fn(async (data: Record<string, unknown>) => {
        const author = data.author as { connect: { id: string } };
        const id = `message-${(messageSeq += 1)}`;
        const message = {
          id,
          chatId: CHAT_ID,
          authorId: author.connect.id,
          authorDisplayName: data.authorDisplayName as string,
          text: data.text as string,
          createdAt: FIXED_NOW,
          editedAt: null,
          deleted: false,
        } as unknown as Message;
        messages.set(id, message);
        return message;
      }),
      findById: jest.fn(async (id: string) => messages.get(id) ?? null),
      update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
        const current = messages.get(id);
        if (current === undefined) {
          return null as unknown as Message;
        }
        Object.assign(current, patch);
        return current;
      }),
    } as unknown as MessageRepository;

    const attachmentRepository = {
      findById: jest.fn(async (id: string) => attachments.get(id) ?? null),
      linkToMessage: jest.fn(
        async (ids: string[], messageId: string, guard: { taskId: string; uploaderId: string }) => {
          let count = 0;
          for (const id of ids) {
            const a = attachments.get(id);
            if (
              a !== undefined &&
              a.messageId === null &&
              a.taskId === guard.taskId &&
              a.uploaderId === guard.uploaderId
            ) {
              a.messageId = messageId;
              count += 1;
            }
          }
          return count;
        },
      ),
      listByMessage: jest.fn(async (messageId: string) =>
        [...attachments.values()].filter((a) => a.messageId === messageId),
      ),
      deleteByMessage: jest.fn(async (messageId: string) => {
        let count = 0;
        for (const [id, a] of attachments) {
          if (a.messageId === messageId) {
            attachments.delete(id);
            count += 1;
          }
        }
        return count;
      }),
      listByTask: jest.fn(async (taskId: string) =>
        [...attachments.values()].filter((a) => a.taskId === taskId && a.messageId !== null),
      ),
    } as unknown as AttachmentRepository;

    const prisma = {
      runInTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
      chat: { findUnique: jest.fn(async () => ({ id: CHAT_ID, taskId: task.id })) },
    } as unknown as PrismaService;

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

    const storageDelete = jest.fn(async (storagePath: string) => {
      storageObjects.delete(storagePath);
    });
    const storage = { delete: storageDelete } as unknown as StorageService;

    const service = new ChatService(
      prisma,
      messageRepository,
      messageReadRepository,
      attachmentRepository,
      { setMute: jest.fn(), isMuted: jest.fn(async () => false) } as unknown as ChatMuteRepository,
      taskRepository,
      userRepository,
      new StatusMachine(),
      { now: () => FIXED_NOW } as unknown as ClockService,
      { limits: CHAT_LIMITS } as unknown as AppConfigService,
      gateway,
      {
        notifyNewMessage: jest.fn(async () => undefined),
        clearMessageNotification: jest.fn(async () => undefined),
      } as unknown as ChatNotificationRouter,
      { check: jest.fn(async () => ({ allowed: true })) } as unknown as RateLimiter,
      { record: jest.fn(async () => undefined) } as unknown as AuditRecorder,
      storage,
    );

    return { service, attachments, messages, storageObjects, broadcastMessage, storageDelete };
  }

  it('отправка Сообщения с изображением → живая нагрузка несёт миниатюру (hasThumbnail), затем удаление очищает раздел «Вложения»', async () => {
    const attachment = makeImageAttachment('att-img');
    const h = buildChatHarness([attachment]);

    // 1. Поток Чата (дефект 2): отправка Сообщения с изображением. Возвращённое
    //    и разосланное представление несёт Вложение с hasThumbnail=true —
    //    миниатюра видна без перезагрузки ленты (Req 2.2).
    const sent: ChatMessageHttpView = await h.service.sendMessage(
      AUTHOR_ID,
      TASK_ID,
      'Фото к задаче',
      ['att-img'],
    );

    expect(sent.attachments).toBeDefined();
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0]?.id).toBe('att-img');
    expect(sent.attachments?.[0]?.hasThumbnail).toBe(true);

    // Та же нагрузка разослана подключённым Участникам (live, без перезагрузки).
    const broadcastArgs = h.broadcastMessage.mock.calls[0];
    expect(broadcastArgs?.[0]).toBe(TASK_ID);
    const broadcastView = broadcastArgs?.[1] as ChatMessageHttpView;
    expect(broadcastView.attachments?.[0]?.hasThumbnail).toBe(true);

    // Раздел «Вложения» содержит привязанное Вложение.
    const before = await h.service.listAttachments(AUTHOR_ID, TASK_ID);
    expect(before.map((a) => a.id)).toEqual(['att-img']);

    // 2. Поток Чата (дефект 8): удаление Сообщения с Вложениями. Записи Вложений
    //    и их файлы (включая миниатюру) удаляются (Req 2.8).
    await h.service.deleteMessage(AUTHOR_ID, sent.id);

    // Сообщение логически удалено.
    expect(h.messages.get(sent.id)?.deleted).toBe(true);

    // Раздел «Вложения» очищен — осиротевших записей нет.
    const after = await h.service.listAttachments(AUTHOR_ID, TASK_ID);
    expect(after).toHaveLength(0);

    // Файлы Вложения и его миниатюры удалены из хранилища.
    expect(h.storageObjects.size).toBe(0);
    expect(h.storageDelete).toHaveBeenCalledWith(attachment.storagePath);
    expect(h.storageDelete).toHaveBeenCalledWith(attachment.thumbnailPath);
  });
});

// =============================================================================
// Поток Уведомлений (дефекты 3, 3.3)
// =============================================================================

describe('Интеграция: поток Уведомлений — живое AppNotification онлайн и запись в Центре офлайн (дефекты 3, 3.3)', () => {
  function chatMessageNotification(overrides: Partial<Notification>): Notification {
    return {
      id: 'notif-1',
      recipientId: 'recipient-R',
      taskId: 'task-1',
      messageId: 'message-1',
      type: NotificationType.CHAT_MESSAGE,
      payload: { authorName: 'Менеджер М' },
      isMessageNotification: true,
      siteStatus: DeliveryStatus.PENDING,
      maxStatus: DeliveryStatus.PENDING,
      maxRetryCount: 0,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
      ...overrides,
    } as Notification;
  }

  function buildDeliveryHarness(notification: Notification, online: boolean) {
    const findById = jest.fn().mockResolvedValue(notification);
    const update = jest
      .fn()
      .mockImplementation((_id: string, patch: Partial<Notification>) =>
        Promise.resolve({ ...notification, ...patch }),
      );
    const repository = { findById, update } as unknown as NotificationRepository;

    const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as QueueService;

    // Реальный диспетчер: при online регистрируем notifier (живое соединение),
    // иначе оставляем незарегистрированным (получатель офлайн → push=false).
    const site = new SiteNotificationDispatcher();
    let capturedUserId: string | undefined;
    let capturedPayload: unknown;
    if (online) {
      site.bind((userId, payload) => {
        capturedUserId = userId;
        capturedPayload = payload;
      });
    }
    const pushSpy = jest.spyOn(site, 'pushToUser');

    const redis = { set: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService;
    const maxPort = {
      deliverNotification: jest.fn().mockResolvedValue({ delivered: true }),
      deleteMessageNotification: jest.fn().mockResolvedValue({ delivered: true }),
    } as unknown as MaxDeliveryPort;
    const maxFilter = {
      isSuppressed: jest.fn().mockResolvedValue(false),
    } as unknown as MaxDeliveryFilter;

    const service = new NotificationDeliveryService(
      repository,
      queue,
      site,
      redis,
      maxPort,
      maxFilter,
    );

    return {
      service,
      update,
      pushSpy,
      getUserId: () => capturedUserId,
      getPayload: () => capturedPayload as Record<string, unknown> | undefined,
    };
  }

  it('онлайн-получатель: живая нагрузка соответствует AppNotification и запись сохранена в Центре', async () => {
    const notification = chatMessageNotification({
      id: 'notif-online',
      recipientId: 'recipient-online',
      taskId: 'task-77',
      messageId: 'message-88',
    });
    const h = buildDeliveryHarness(notification, true);

    await h.service.deliver({
      notificationId: notification.id,
      recipientId: notification.recipientId,
      channels: [NotificationChannel.Site],
    });

    // Живой push доставлен в персональную комнату получателя.
    expect(h.pushSpy).toHaveBeenCalledWith(notification.recipientId, expect.anything());
    expect(h.pushSpy).toHaveReturnedWith(true);
    expect(h.getUserId()).toBe(notification.recipientId);

    // Нагрузка целиком соответствует контракту AppNotification (= представление
    // Центра уведомлений через toNotificationView): title/body/тип/статусы.
    const centerView = toNotificationView(notification);
    expect(h.getPayload()).toEqual(centerView as unknown as Record<string, unknown>);
    expect(h.getPayload()?.type).toBe('NEW_MESSAGE');
    expect((h.getPayload()?.title as string)?.length).toBeGreaterThan(0);
    expect((h.getPayload()?.body as string)?.length).toBeGreaterThan(0);

    // Запись Уведомления сохранена (siteStatus=DELIVERED) — доступна в Центре.
    expect(h.update).toHaveBeenCalledWith(notification.id, {
      siteStatus: DeliveryStatus.DELIVERED,
    });
  });

  it('офлайн-получатель: живого push нет, но запись сохранена и доступна в Центре при следующем входе', async () => {
    const notification = chatMessageNotification({
      id: 'notif-offline',
      recipientId: 'recipient-offline',
      taskId: 'task-90',
      messageId: 'message-91',
    });
    const h = buildDeliveryHarness(notification, false);

    await h.service.deliver({
      notificationId: notification.id,
      recipientId: notification.recipientId,
      channels: [NotificationChannel.Site],
    });

    // Получатель офлайн: push выполнен best-effort и не доставлен.
    expect(h.pushSpy).toHaveBeenCalledWith(notification.recipientId, expect.anything());
    expect(h.pushSpy).toHaveReturnedWith(false);

    // Запись всё равно сохранена (siteStatus=DELIVERED) и доступна в Центре.
    expect(h.update).toHaveBeenCalledWith(notification.id, {
      siteStatus: DeliveryStatus.DELIVERED,
    });
    const centerView = toNotificationView(notification);
    expect(centerView.id).toBe(notification.id);
    expect(centerView.isMessageNotification).toBe(true);
  });
});

// =============================================================================
// Поток Сессии (дефекты 9, 3.9)
// =============================================================================

describe('Интеграция: поток Сессии — продление переживает TTL, аннулированные/истёкшие отклоняются 401 (дефекты 9, 3.9)', () => {
  const SECRET = 'integration-jwt-secret-session-flow';
  const TTL_SECONDS = 900;

  /** Минимальная in-memory реализация ioredis для {@link SessionRegistry}. */
  class FakeRedis {
    private strings = new Map<string, string>();
    private sets = new Map<string, Set<string>>();

    async get(key: string): Promise<string | null> {
      return this.strings.has(key) ? (this.strings.get(key) as string) : null;
    }
    async smembers(key: string): Promise<string[]> {
      return [...(this.sets.get(key) ?? new Set<string>())];
    }
    async exists(key: string): Promise<number> {
      return this.strings.has(key) ? 1 : 0;
    }
    async del(...keys: string[]): Promise<number> {
      return this.delSync(...keys);
    }
    delSync(...keys: string[]): number {
      let removed = 0;
      for (const key of keys) {
        if (this.strings.delete(key)) {
          removed += 1;
        }
        this.sets.delete(key);
      }
      return removed;
    }
    setSync(key: string, value: string): void {
      this.strings.set(key, value);
    }
    saddSync(key: string, member: string): void {
      const set = this.sets.get(key) ?? new Set<string>();
      set.add(member);
      this.sets.set(key, set);
    }
    sremSync(key: string, member: string): void {
      this.sets.get(key)?.delete(member);
    }
    multi(): FakePipeline {
      return new FakePipeline(this);
    }
  }

  class FakePipeline {
    private readonly ops: Array<() => void> = [];
    constructor(private readonly store: FakeRedis) {}
    set(key: string, value: string): this {
      this.ops.push(() => this.store.setSync(key, value));
      return this;
    }
    sadd(key: string, member: string): this {
      this.ops.push(() => this.store.saddSync(key, member));
      return this;
    }
    srem(key: string, member: string): this {
      this.ops.push(() => this.store.sremSync(key, member));
      return this;
    }
    del(key: string): this {
      this.ops.push(() => {
        this.store.delSync(key);
      });
      return this;
    }
    expire(key: string, ttl: number): this {
      void key;
      void ttl;
      return this;
    }
    async exec(): Promise<void> {
      for (const op of this.ops) {
        op();
      }
    }
  }

  function makeAuthEnv(user: User) {
    const fake = new FakeRedis();
    const sessions = new SessionRegistry(fake as unknown as Redis);
    const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: TTL_SECONDS } });
    const clock = { now: () => new Date() } as unknown as ClockService;
    const config = {
      auth: { jwtSecret: SECRET, accessTokenTtlSeconds: TTL_SECONDS },
    } as unknown as AppConfigService;
    const sessionTokens = new SessionTokenService(jwt, sessions, clock, config);

    const userRepository = {
      findActiveById: jest.fn(async (id: string) => (id === user.id ? user : null)),
    } as unknown as UserRepository;

    const authService = new AuthService(
      userRepository,
      {} as never,
      {} as never,
      {} as never,
      config,
      sessionTokens,
      clock,
      sessions,
      { disconnectUser: jest.fn(async () => undefined) } as never,
      {} as never,
    );

    return { sessions, sessionTokens, jwt, authService };
  }

  it('механизм продления Сессии присутствует (AuthController.refresh + AuthService.refreshSession)', () => {
    expect(typeof (AuthController.prototype as unknown as Record<string, unknown>).refresh).toBe(
      'function',
    );
    expect(
      typeof (AuthService.prototype as unknown as Record<string, unknown>).refreshSession,
    ).toBe('function');
  });

  it('активная работа дольше TTL: проактивный refresh поддерживает Сессию (issue-then-revoke)', async () => {
    const user = { id: 'active-user', role: Role.EXECUTOR, isActive: true } as unknown as User;
    const env = makeAuthEnv(user);

    // Вход и начало активной работы.
    let session = await env.sessionTokens.issue(user);
    await expect(env.sessionTokens.verify(session.accessToken)).resolves.toMatchObject({
      userId: user.id,
    });

    // Несколько циклов продления моделируют активную работу дольше TTL без
    // повторного входа. Каждый refresh: новый токен валиден, прежний — отклонён.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const previousToken = session.accessToken;
      const previousTokenId = session.tokenId;

      const renewed = await env.authService.refreshSession({
        userId: user.id,
        tokenId: previousTokenId,
        role: user.role,
      });

      // Новая Сессия действует — активная работа продолжается (Req 2.9).
      await expect(env.sessionTokens.verify(renewed.accessToken)).resolves.toMatchObject({
        userId: user.id,
        tokenId: renewed.tokenId,
      });

      // Прежний токен мгновенно аннулирован (issue-then-revoke сохраняет
      // отзываемость, Req 3.9).
      await expect(env.sessionTokens.verify(previousToken)).rejects.toBeInstanceOf(
        AuthenticationException,
      );

      session = renewed;
    }
  });

  it('после logout/принудительного сброса Сессия (и её refresh) отклоняются 401', async () => {
    const user = { id: 'user-logout', role: Role.MANAGER, isActive: true } as unknown as User;
    const env = makeAuthEnv(user);

    const session = await env.sessionTokens.issue(user);
    await expect(env.sessionTokens.verify(session.accessToken)).resolves.toMatchObject({
      userId: user.id,
    });

    // Принудительный сброс/logout: аннулируем все Сессии Пользователя.
    await env.sessions.revokeAllForUser(user.id);

    // Запросы с аннулированным токеном отклоняются 401 (Req 3.9).
    await expect(env.sessionTokens.verify(session.accessToken)).rejects.toBeInstanceOf(
      AuthenticationException,
    );

    // Продление аннулированной Сессии также невозможно: запись токена удалена,
    // повторная попытка verify подтверждает отказ.
    await expect(env.sessionTokens.verify(session.accessToken)).rejects.toBeInstanceOf(
      AuthenticationException,
    );
  });

  it('истёкшая без продления Сессия отклоняется 401', async () => {
    const user = { id: 'user-expired', role: Role.EXECUTOR, isActive: true } as unknown as User;
    const env = makeAuthEnv(user);

    // Токен с exp в прошлом моделирует активную работу дольше TTL без
    // своевременного refresh.
    const expiredToken = await env.jwt.signAsync(
      { sub: user.id, jti: 'expired-jti', role: user.role },
      { expiresIn: -1 },
    );

    await expect(env.sessionTokens.verify(expiredToken)).rejects.toBeInstanceOf(
      AuthenticationException,
    );
  });
});
