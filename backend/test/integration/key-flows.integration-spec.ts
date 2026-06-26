/**
 * Интеграционные тесты ключевых сквозных потоков системы (задача 21.2).
 *
 * Проверяются на РЕАЛЬНЫХ PostgreSQL и Redis (поднимаются в docker, см.
 * `docker-compose.integration.yml`) четыре представительных потока, для которых
 * дизайн (Testing Strategy → «Интеграционные») предписывает интеграционную, а не
 * property-проверку:
 *
 *  1. Отправка Сообщения в Чат со сменой Статуса Задачи, доставка ≤2с
 *     (Req 11.3, 10.1) — через {@link ChatService.sendMessage} с реальными
 *     транзакциями Prisma и Socket.IO-рассылкой.
 *  2. Доставка Уведомления через очередь BullMQ с ретраями и независимостью
 *     сайта от MAX (Req 13.12, 13.13) — реальная очередь Redis + воркер
 *     доставки + политика ≤3 попыток.
 *  3. Вход через OAuth MAX с выпуском Сессии в Redis (Req 16.4, 16.1, 16.3) —
 *     {@link AuthService.loginWithMax} с регистрацией сессии и её проверкой.
 *  4. Восстановление удалённого Пользователя по сохранённому адресу (Req 7.2,
 *     7.5; в задаче помечено как 3.5 — поток восстановления доступа) —
 *     {@link UsersService.restoreUser} с реальной БД и историей адресов.
 *
 * Внешние сетевые границы (OAuth MAX, Бот MAX) подменяются управляемыми
 * фейками через DI-токены `MAX_OAUTH_PORT` и `MAX_DELIVERY_PORT`; PostgreSQL и
 * Redis используются настоящие.
 *
 * Запуск требует поднятой инфраструктуры и флага окружения RUN_INTEGRATION:
 *   docker compose -f docker-compose.integration.yml up -d
 *   DATABASE_URL=... npx prisma migrate deploy
 *   RUN_INTEGRATION=1 DATABASE_URL=... REDIS_PORT=6380 \
 *     npm --workspace backend run test:integration
 *
 * Без RUN_INTEGRATION весь набор пропускается (describe.skip), чтобы обычный
 * unit-прогон не зависел от внешних сервисов.
 */

// --- Значения окружения по умолчанию ДО загрузки конфигурации приложения. ---
// Конфигурация (AppConfigModule) читает process.env при создании модуля.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5433/task_hub_test';
process.env.REDIS_HOST ??= 'localhost';
process.env.REDIS_PORT ??= '6380';
process.env.JWT_SECRET ??= 'integration-test-secret-please-change';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AssignmentKind,
  DeliveryStatus,
  Notification,
  NotificationType,
  Role,
  TaskStatus,
} from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth';
import { ChatService } from '../../src/chat';
import { PrismaService, QueueName, QueueService } from '../../src/infra';
import { SessionTokenService } from '../../src/auth/session-token.service';
import { UsersService } from '../../src/users';
import { MAX_OAUTH_PORT, MaxOAuthExchangeError, type MaxOAuthPort } from '../../src/max/oauth';
import {
  MAX_DELIVERY_PORT,
  type MaxDeliveryPort,
  type MaxDeliveryResult,
} from '../../src/notifications/delivery/max-delivery.port';
import { NotificationRepository } from '../../src/notifications/notification.repository';
import {
  NOTIFICATION_DELIVERY_JOB_NAME,
  NOTIFICATION_DELIVERY_JOB_OPTIONS,
} from '../../src/notifications/notifications.constants';
import { NotificationChannel } from '../../src/notifications/notifications.types';
import { AuthenticationException } from '../../src/common/errors';

/**
 * Управляемый фейк порта OAuth MAX: позволяет каждому тесту задать поведение
 * обмена кода авторизации на идентификатор профиля MAX.
 */
class FakeMaxOAuthPort implements MaxOAuthPort {
  handler: (authCode: string) => Promise<string> = async () => {
    throw new MaxOAuthExchangeError('OAuth MAX не сконфигурирован для теста.');
  };

  exchangeAuthCode(authCode: string): Promise<string> {
    return this.handler(authCode);
  }
}

/**
 * Фейк порта доставки MAX, всегда сообщающий о неуспехе, чтобы запустить
 * политику ретраев (≤3 попыток). Считает число обращений.
 */
class AlwaysFailingMaxDeliveryPort implements MaxDeliveryPort {
  deliveries = 0;

  async deliverNotification(): Promise<MaxDeliveryResult> {
    this.deliveries += 1;
    return { delivered: false, reason: 'Принудительный отказ доставки MAX (интеграционный тест).' };
  }

  async deleteMessageNotification(): Promise<MaxDeliveryResult> {
    return { delivered: false, reason: 'Удаление в MAX недоступно (интеграционный тест).' };
  }
}

const RUN_INTEGRATION =
  process.env.RUN_INTEGRATION === '1' || process.env.RUN_INTEGRATION === 'true';
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

describeIntegration('Ключевые сквозные потоки (PostgreSQL + Redis, задача 21.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let chat: ChatService;
  let auth: AuthService;
  let users: UsersService;
  let sessionTokens: SessionTokenService;
  let notificationRepo: NotificationRepository;
  let queue: QueueService;
  const oauthPort = new FakeMaxOAuthPort();
  const maxDeliveryPort = new AlwaysFailingMaxDeliveryPort();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAX_OAUTH_PORT)
      .useValue(oauthPort)
      .overrideProvider(MAX_DELIVERY_PORT)
      .useValue(maxDeliveryPort)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    // Реальный слушающий порт инициализирует Socket.IO-сервер, без которого
    // ChatGateway не сможет выполнять broadcast при отправке Сообщения.
    await app.listen(0);

    prisma = app.get(PrismaService, { strict: false });
    chat = app.get(ChatService, { strict: false });
    auth = app.get(AuthService, { strict: false });
    users = app.get(UsersService, { strict: false });
    sessionTokens = app.get(SessionTokenService, { strict: false });
    notificationRepo = app.get(NotificationRepository, { strict: false });
    queue = app.get(QueueService, { strict: false });
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // Поток 1. Отправка Сообщения со сменой Статуса (≤2с) — Req 11.3, 10.1.
  // ---------------------------------------------------------------------------
  it('отправка Сообщения Исполнителем переводит Задачу «В работе» → «Ожидает» и доставляется ≤2с (Req 11.3, 10.1)', async () => {
    const executor = await prisma.user.create({
      data: {
        email: 'executor@example.com',
        displayName: 'Исполнитель',
        role: Role.EXECUTOR,
        isActive: true,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Интеграционная задача',
        deadline: new Date(Date.now() + 86_400_000),
        status: TaskStatus.IN_PROGRESS,
        assignments: { create: [{ userId: executor.id, kind: AssignmentKind.EXECUTOR }] },
        chat: { create: {} },
      },
    });

    const startedAt = Date.now();
    const message = await chat.sendMessage(executor.id, task.id, 'Приступил к работе.');
    const elapsedMs = Date.now() - startedAt;

    // Доставка (запись + рассылка) укладывается в 2 секунды (Req 11.3).
    expect(elapsedMs).toBeLessThan(2000);

    const persisted = await prisma.message.findUnique({ where: { id: message.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.text).toBe('Приступил к работе.');
    expect(persisted?.authorDisplayName).toBe('Исполнитель');

    // Авто-переход Статуса по сообщению Исполнителя (Req 10.1).
    const reloaded = await prisma.task.findUnique({ where: { id: task.id } });
    expect(reloaded?.status).toBe(TaskStatus.WAITING);
    expect(reloaded?.messageCount).toBe(1);

    // Смена Статуса зафиксирована в Журнале изменений (Req 20.1).
    const audit = await prisma.auditEntry.findMany({ where: { taskId: task.id, field: 'status' } });
    expect(audit).toHaveLength(1);
    const statusEntry = audit[0];
    expect(statusEntry?.oldValue).toBe(TaskStatus.IN_PROGRESS);
    expect(statusEntry?.newValue).toBe(TaskStatus.WAITING);
  });

  // ---------------------------------------------------------------------------
  // Поток 2. Доставка Уведомления через очередь с ретраями — Req 13.12, 13.13.
  // ---------------------------------------------------------------------------
  it('доставка Уведомления выполняет ≤3 попыток в MAX (итог FAILED) при независимой доставке на сайт (Req 13.12, 13.13)', async () => {
    const recipient = await prisma.user.create({
      data: {
        email: 'recipient@example.com',
        displayName: 'Получатель',
        role: Role.EXECUTOR,
        isActive: true,
      },
    });
    // Тип CHAT_MESSAGE => класс доставки «message», интервал ретрая 5с
    // (укладывается в таймаут теста; для задач интервал был бы 5 минут).
    const notification = await notificationRepo.create({
      recipientId: recipient.id,
      type: NotificationType.CHAT_MESSAGE,
      payload: { text: 'Новое сообщение в чате' },
      isMessageNotification: true,
    });

    const before = maxDeliveryPort.deliveries;

    // Ставим задание в реальную очередь; фоновый воркер обработает его и
    // переотправит отложенные ретраи согласно политике (Req 13.13).
    await queue.add(
      QueueName.MaxNotifications,
      NOTIFICATION_DELIVERY_JOB_NAME,
      {
        notificationId: notification.id,
        recipientId: recipient.id,
        channels: [NotificationChannel.Site, NotificationChannel.Max],
      },
      NOTIFICATION_DELIVERY_JOB_OPTIONS,
    );

    const finalState = await waitFor(
      async () => {
        const current = await notificationRepo.findById(notification.id);
        return current !== null && current.maxStatus === DeliveryStatus.FAILED ? current : null;
      },
      40_000,
      250,
    );

    expect(finalState).not.toBeNull();
    const result = finalState as Notification;
    // Канал MAX исчерпал ровно 3 попытки и окончательно неуспешен (Req 13.13).
    expect(result.maxStatus).toBe(DeliveryStatus.FAILED);
    expect(result.maxRetryCount).toBe(3);
    expect(maxDeliveryPort.deliveries - before).toBe(3);
    // Доставка на сайт выполнена независимо от MAX (Req 13.13, 14.6).
    expect(result.siteStatus).toBe(DeliveryStatus.DELIVERED);
  });

  // ---------------------------------------------------------------------------
  // Поток 3. Вход через OAuth MAX — Req 16.4, 16.1, 16.3.
  // ---------------------------------------------------------------------------
  it('вход через OAuth MAX выпускает действительную Сессию для привязанного активного Пользователя (Req 16.1, 16.4)', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'max-user@example.com',
        displayName: 'Пользователь MAX',
        role: Role.MANAGER,
        isActive: true,
        maxLink: { create: { maxUserId: 'max-uid-777' } },
      },
    });
    oauthPort.handler = async (code) =>
      code === 'valid-code' ? 'max-uid-777' : Promise.reject(new MaxOAuthExchangeError('bad code'));

    const session = await auth.loginWithMax('valid-code');

    expect(session.userId).toBe(user.id);
    expect(session.accessToken).toBeTruthy();
    // Сессия зарегистрирована в Redis и проходит проверку (Req 19.10).
    const principal = await sessionTokens.verify(session.accessToken);
    expect(principal.userId).toBe(user.id);
  });

  it('вход через OAuth MAX отклоняется для непривязанного профиля без раскрытия причины (Req 16.3)', async () => {
    oauthPort.handler = async () => 'unlinked-max-uid';

    await expect(auth.loginWithMax('any-code')).rejects.toBeInstanceOf(AuthenticationException);
  });

  // ---------------------------------------------------------------------------
  // Поток 4. Восстановление удалённого Пользователя — Req 7.2, 7.5.
  // ---------------------------------------------------------------------------
  it('восстановление удалённого Пользователя без пароля оставляет учётную запись неактивной (Req 7.2)', async () => {
    const admin = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        displayName: 'Администратор',
        role: Role.ADMIN,
        isActive: true,
      },
    });
    const deleted = await prisma.user.create({
      data: {
        email: 'old-deleted@example.com',
        displayName: 'Удалённый',
        role: Role.EXECUTOR,
        isActive: false,
        deletedAt: new Date(),
        emails: { create: [{ email: 'old-deleted@example.com' }] },
      },
    });

    const restored = await users.restoreUser(admin.id, deleted.id, 'old-deleted@example.com');

    expect(restored.id).toBe(deleted.id);
    expect(restored.isActive).toBe(false);
    expect(restored.deletedAt).toBeNull();

    const reloaded = await prisma.user.findUnique({ where: { id: deleted.id } });
    expect(reloaded?.isActive).toBe(false);
    expect(reloaded?.deletedAt).toBeNull();
  });

  it('восстановление отклоняется, если выбранный адрес занят другой учётной записью (Req 7.5)', async () => {
    const admin = await prisma.user.create({
      data: {
        email: 'admin2@example.com',
        displayName: 'Администратор',
        role: Role.ADMIN,
        isActive: true,
      },
    });
    // Активный пользователь уже занимает адрес.
    await prisma.user.create({
      data: {
        email: 'shared@example.com',
        displayName: 'Активный',
        role: Role.EXECUTOR,
        isActive: true,
      },
    });
    const deleted = await prisma.user.create({
      data: {
        email: 'deleted-2@example.com',
        displayName: 'Удалённый-2',
        role: Role.EXECUTOR,
        isActive: false,
        deletedAt: new Date(),
        emails: { create: [{ email: 'shared@example.com' }] },
      },
    });

    await expect(users.restoreUser(admin.id, deleted.id, 'shared@example.com')).rejects.toThrow();

    // Данные удалённого Пользователя не изменились (Req 7.5).
    const reloaded = await prisma.user.findUnique({ where: { id: deleted.id } });
    expect(reloaded?.isActive).toBe(false);
    expect(reloaded?.deletedAt).not.toBeNull();
  });
});

/**
 * Очищает все таблицы предметной области между тестами (RESTART IDENTITY
 * CASCADE), обеспечивая изоляцию. Порядок не важен благодаря CASCADE.
 */
async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE ' +
      [
        '"Notification"',
        '"MessageRead"',
        '"Attachment"',
        '"Message"',
        '"Chat"',
        '"TaskAssignment"',
        '"AuditEntry"',
        '"DeadlineReminder"',
        '"Session"',
        '"MaxLink"',
        '"ChatMute"',
        '"UserEmail"',
        '"Task"',
        '"User"',
      ].join(', ') +
      ' RESTART IDENTITY CASCADE',
  );
}

/**
 * Опрашивает асинхронное условие до получения непустого результата или таймаута.
 *
 * @param probe Функция-проба, возвращающая результат либо `null`, пока условие
 *   не выполнено.
 * @param timeoutMs Максимальное время ожидания, мс.
 * @param intervalMs Интервал между опросами, мс.
 * @returns Первый непустой результат пробы либо `null` по истечении таймаута.
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== null) {
      return result;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
