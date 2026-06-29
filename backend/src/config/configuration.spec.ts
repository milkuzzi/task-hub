import * as fc from 'fast-check';
import { configuration } from './configuration';

describe('configuration()', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Изолируем процессное окружение между тестами.
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('возвращает значения по умолчанию для всех секций при пустом окружении', () => {
    delete process.env.PORT;
    delete process.env.ACCESS_TOKEN_TTL_SECONDS;
    delete process.env.REMINDER_FAR_SECONDS;
    delete process.env.LIMIT_ATTACHMENT_MAX_BYTES;

    const cfg = configuration();

    expect(cfg.app.port).toBe(3000);
    expect(cfg.auth.accessTokenTtlSeconds).toBe(86400);
    expect(cfg.database.url).toContain('postgresql://');
    expect(cfg.redis.host).toBe('localhost');
    expect(cfg.redis.port).toBe(6379);
    expect(cfg.sendpulse.senderName).toBe('Система поручений');
    expect(cfg.max.oauthAuthorizeUrl).toBe('');
    expect(cfg.max.botUsername).toBe('');
    expect(cfg.max.botApiBaseUrl).toBe('https://platform-api2.max.ru');
    expect(cfg.max.botWebhookSecret).toBe('');
    expect(cfg.max.miniAppInitDataTtlSeconds).toBe(300);
    expect(cfg.s3.bucket).toBe('task-hub-backups');
    expect(cfg.reminders.farSeconds).toBe(86400);
    expect(cfg.reminders.nearSeconds).toBe(7200);
    expect(cfg.reminders.checkWindowSeconds).toBe(300);
    expect(cfg.limits.attachmentMaxBytes).toBe(26214400);
    expect(cfg.limits.avatarMaxBytes).toBe(5242880);
    expect(cfg.limits.messageTextMaxLength).toBe(4000);
    expect(cfg.limits.messageCounterCap).toBe(9999);
  });

  it('сохраняет явное переопределение времени жизни сессии', () => {
    process.env.ACCESS_TOKEN_TTL_SECONDS = '3600';

    const cfg = configuration();

    expect(cfg.auth.accessTokenTtlSeconds).toBe(3600);
  });

  it('использует токен Бота MAX как webhook secret, если отдельный secret не задан', () => {
    process.env.MAX_BOT_TOKEN = 'bot-token';
    delete process.env.MAX_BOT_WEBHOOK_SECRET;

    const cfg = configuration();

    expect(cfg.max.botWebhookSecret).toBe('bot-token');
  });

  it('не задаёт пароль Redis, если REDIS_PASSWORD не указан', () => {
    delete process.env.REDIS_PASSWORD;
    const cfg = configuration();
    expect(cfg.redis.password).toBeUndefined();
  });

  // Sanity-проверка интеграции fast-check: для любого валидного порта
  // конфигурация читает именно это значение.
  it('читает PORT из окружения для любого допустимого значения порта', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
        process.env.PORT = String(port);
        const cfg = configuration();
        expect(cfg.app.port).toBe(port);
      }),
      { numRuns: 100 },
    );
  });
});
