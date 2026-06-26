import { AppConfiguration } from './config.types';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Безопасно читает переменную окружения как строку с дефолтом. */
function str(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/** Читает переменную окружения как целое число с дефолтом. */
function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Читает переменную окружения как булево с дефолтом. */
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value === 'true' || value === '1';
}

/**
 * Фабрика конфигурации для @nestjs/config.
 * Преобразует (уже провалидированные Joi) переменные окружения
 * в строго типизированный объект {@link AppConfiguration}.
 */
export function configuration(): AppConfiguration {
  const env = process.env;

  return {
    app: {
      nodeEnv: str(env.NODE_ENV, 'development') as AppConfiguration['app']['nodeEnv'],
      port: int(env.PORT, 3000),
      publicUrl: str(env.PUBLIC_URL, 'https://localhost'),
    },
    auth: {
      jwtSecret: str(env.JWT_SECRET, 'dev-insecure-jwt-secret-change-me'),
      accessTokenTtlSeconds: int(env.ACCESS_TOKEN_TTL_SECONDS, 86400),
    },
    database: {
      url: str(env.DATABASE_URL, 'postgresql://postgres:postgres@localhost:5432/task_hub'),
    },
    redis: {
      host: str(env.REDIS_HOST, 'localhost'),
      port: int(env.REDIS_PORT, 6379),
      ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
      db: int(env.REDIS_DB, 0),
    },
    sendpulse: {
      apiUserId: str(env.SENDPULSE_API_USER_ID, ''),
      apiSecret: str(env.SENDPULSE_API_SECRET, ''),
      senderEmail: str(env.SENDPULSE_SENDER_EMAIL, 'noreply@example.com'),
      senderName: str(env.SENDPULSE_SENDER_NAME, 'Система поручений'),
    },
    max: {
      oauthClientId: str(env.MAX_OAUTH_CLIENT_ID, ''),
      oauthClientSecret: str(env.MAX_OAUTH_CLIENT_SECRET, ''),
      oauthRedirectUri: str(env.MAX_OAUTH_REDIRECT_URI, 'https://localhost/auth/max/callback'),
      botToken: str(env.MAX_BOT_TOKEN, ''),
      botApiBaseUrl: str(env.MAX_BOT_API_BASE_URL, 'https://botapi.max.ru'),
    },
    restic: {
      repository: str(env.RESTIC_REPOSITORY, ''),
      password: str(env.RESTIC_PASSWORD, ''),
      // По умолчанию — системный каталог временных файлов ОС.
      tmpDir: resolve(str(env.BACKUP_TMP_DIR, tmpdir())),
    },
    backup: {
      mode: str(env.BACKUP_MODE, 'disabled') as AppConfiguration['backup']['mode'],
    },
    s3: {
      endpoint: str(env.S3_ENDPOINT, 'https://s3.amazonaws.com'),
      region: str(env.S3_REGION, 'us-east-1'),
      bucket: str(env.S3_BUCKET, 'task-hub-backups'),
      accessKeyId: str(env.S3_ACCESS_KEY_ID, ''),
      secretAccessKey: str(env.S3_SECRET_ACCESS_KEY, ''),
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
    },
    reminders: {
      farSeconds: int(env.REMINDER_FAR_SECONDS, 86400),
      nearSeconds: int(env.REMINDER_NEAR_SECONDS, 7200),
      checkWindowSeconds: int(env.REMINDER_CHECK_WINDOW_SECONDS, 300),
    },
    limits: {
      attachmentMaxBytes: int(env.LIMIT_ATTACHMENT_MAX_BYTES, 26214400),
      avatarMaxBytes: int(env.LIMIT_AVATAR_MAX_BYTES, 5242880),
      maxAttachmentsPerMessage: int(env.LIMIT_MAX_ATTACHMENTS_PER_MESSAGE, 10),
      messageTextMaxLength: int(env.LIMIT_MESSAGE_TEXT_MAX_LENGTH, 4000),
      taskTitleMaxLength: int(env.LIMIT_TASK_TITLE_MAX_LENGTH, 200),
      taskDescriptionMaxLength: int(env.LIMIT_TASK_DESCRIPTION_MAX_LENGTH, 5000),
      maxAssigneesPerTask: int(env.LIMIT_MAX_ASSIGNEES_PER_TASK, 100),
      passwordMinLength: int(env.LIMIT_PASSWORD_MIN_LENGTH, 8),
      passwordMaxLength: int(env.LIMIT_PASSWORD_MAX_LENGTH, 128),
      messageCounterCap: int(env.LIMIT_MESSAGE_COUNTER_CAP, 9999),
      loginMaxFailedAttempts: int(env.LIMIT_LOGIN_MAX_FAILED_ATTEMPTS, 5),
      loginLockoutSeconds: int(env.LIMIT_LOGIN_LOCKOUT_SECONDS, 900),
      passwordSetupTtlSeconds: int(env.LIMIT_PASSWORD_SETUP_TTL_SECONDS, 86400),
      rateLimitMaxRequests: int(env.LIMIT_RATE_LIMIT_MAX_REQUESTS, 10),
      rateLimitWindowSeconds: int(env.LIMIT_RATE_LIMIT_WINDOW_SECONDS, 60),
    },
    storage: {
      // По умолчанию — каталог вне веб-корня (корень статики React), Req 19.8.
      baseDir: resolve(str(env.STORAGE_DIR, resolve(process.cwd(), 'var', 'attachments'))),
    },
  };
}
