import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { AppConfigService } from '../../config';
import { UserRepository } from '../../repositories';
import { MaxBotHttpApiAdapter } from './max-bot-http.adapter';

describe('MaxBotHttpApiAdapter', () => {
  const config = {
    app: { publicUrl: 'https://tasks.example.com' },
    max: {
      botToken: 'bot-token',
      botWebhookSecret: 'webhook-secret',
      botApiBaseUrl: 'https://platform-api2.max.ru/',
      botUsername: 'task_bot',
    },
  } as unknown as AppConfigService;

  const findMaxLinkByUserId = jest.fn();
  const userRepository = { findMaxLinkByUserId } as unknown as UserRepository;

  let fetchMock: jest.Mock;
  let adapter: MaxBotHttpApiAdapter;

  const okJson = (body: unknown = {}): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(okJson({ success: true }));
    global.fetch = fetchMock as unknown as typeof fetch;
    findMaxLinkByUserId.mockReset();
    adapter = new MaxBotHttpApiAdapter(config, userRepository);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('отправляет сообщение пользователю через platform-api2 и Authorization header', async () => {
    await adapter.reply('max-1', 'Привет');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform-api2.max.ru/messages?user_id=max-1');
    expect(new Headers(init.headers).get('Authorization')).toBe('bot-token');
    expect(JSON.parse(init.body as string)).toMatchObject({ text: 'Привет', notify: true });
  });

  it('регистрирует webhook-подписку с X-Max-Bot-Api-Secret-compatible secret', async () => {
    await adapter.ensureWebhookSubscription();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform-api2.max.ru/subscriptions');
    expect(new Headers(init.headers).get('Authorization')).toBe('bot-token');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://tasks.example.com/max/bot/webhook',
      update_types: ['message_created', 'bot_started'],
      secret: 'webhook-secret',
    });
  });

  it('отправляет единственную кнопку запуска mini-app', async () => {
    await adapter.reply('max-1', 'Откройте приложение', [[{ type: 'open_app', text: 'Открыть' }]]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstBody.attachments[0]).toEqual({
      type: 'inline_keyboard',
      payload: {
        buttons: [[{ type: 'open_app', text: 'Открыть' }]],
      },
    });
  });

  it('доставляет уведомление в привязанный MAX-профиль', async () => {
    findMaxLinkByUserId.mockResolvedValue({ maxUserId: 'max-linked' });

    const result = await adapter.deliverNotification(notificationStub());

    expect(result).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://platform-api2.max.ru/messages?user_id=max-linked');
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain('Статус задачи изменён');
    expect(body.attachments[0].payload.buttons[0][0]).toEqual({
      type: 'link',
      text: 'Открыть задачу',
      url: 'https://max.ru/task_bot?startapp=task_task-1',
    });
  });

  it('доставляет MAX-уведомление о новом сообщении в чате', async () => {
    findMaxLinkByUserId.mockResolvedValue({ maxUserId: 'max-linked' });

    const result = await adapter.deliverNotification(
      notificationStub({
        messageId: 'message-1',
        type: NotificationType.CHAT_MESSAGE,
        payload: {
          taskTitle: 'Документы',
          authorId: 'executor-1',
          authorDisplayName: 'Иван Петров',
        },
        isMessageNotification: true,
      }),
    );

    expect(result).toEqual({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const text = JSON.parse(init.body as string).text as string;
    expect(text).toContain('В чате новое сообщение');
    expect(text).toContain('В чате задачи опубликовано новое сообщение от Иван Петров');
    expect(text).not.toContain('Статус задачи изменён');
  });

  it('не вызывает MAX API, если у получателя нет привязки MAX', async () => {
    findMaxLinkByUserId.mockResolvedValue(null);

    const result = await adapter.deliverNotification(notificationStub());

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('не привязан');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function notificationStub(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notification-1',
    recipientId: 'user-1',
    taskId: 'task-1',
    messageId: null,
    type: NotificationType.TASK_STATUS_CHANGED,
    payload: { status: 'DONE', taskTitle: 'Документы' },
    isMessageNotification: false,
    siteStatus: DeliveryStatus.PENDING,
    maxStatus: DeliveryStatus.PENDING,
    maxRetryCount: 0,
    createdAt: new Date('2026-06-27T00:00:00.000Z'),
    ...overrides,
  };
}
