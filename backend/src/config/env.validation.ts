import * as Joi from 'joi';

export const DEVELOPMENT_JWT_SECRET = 'dev-insecure-jwt-secret-change-me';

/**
 * Схема валидации переменных окружения.
 * Применяется при старте приложения: при недопустимых значениях запуск прерывается.
 * Значения по умолчанию соответствуют требованиям предметной области.
 */
export const envValidationSchema = Joi.object({
  // --- Приложение ---
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  PUBLIC_URL: Joi.string().uri().default('https://localhost'),
  METRICS_TOKEN: Joi.string().min(16).allow('').default(''),

  // --- Аутентификация (JWT) ---
  JWT_SECRET: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).invalid(DEVELOPMENT_JWT_SECRET).required().messages({
      'any.invalid': 'JWT_SECRET must not use the development fallback in production',
      'any.required': 'JWT_SECRET is required in production',
      'string.min': 'JWT_SECRET must contain at least 32 characters in production',
    }),
    otherwise: Joi.string().min(16).default(DEVELOPMENT_JWT_SECRET),
  }),
  ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(1).default(900),

  // --- PostgreSQL ---
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .default('postgresql://postgres:postgres@localhost:5432/task_hub'),

  // --- Redis ---
  REDIS_HOST: Joi.string().hostname().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().integer().min(0).default(0),

  // --- SendPulse ---
  SENDPULSE_API_USER_ID: Joi.string().allow('').default(''),
  SENDPULSE_API_SECRET: Joi.string().allow('').default(''),
  SENDPULSE_SENDER_EMAIL: Joi.string().email().default('noreply@example.com'),
  SENDPULSE_SENDER_NAME: Joi.string().default('Система поручений'),

  // --- MAX ---
  MAX_OAUTH_CLIENT_ID: Joi.string().allow('').default(''),
  MAX_OAUTH_CLIENT_SECRET: Joi.string().allow('').default(''),
  MAX_OAUTH_AUTHORIZE_URL: Joi.string().uri().allow('').default(''),
  MAX_OAUTH_REDIRECT_URI: Joi.string().uri().default('https://localhost/auth/max/callback'),
  MAX_BOT_USERNAME: Joi.string().allow('').default(''),
  MAX_BOT_TOKEN: Joi.string().allow('').default(''),
  MAX_BOT_WEBHOOK_SECRET: Joi.string()
    .pattern(/^[A-Za-z0-9-]*$/)
    .min(5)
    .max(256)
    .allow('')
    .default(''),
  MAX_BOT_API_BASE_URL: Joi.string().uri().default('https://platform-api2.max.ru'),
  MAX_MINI_APP_INIT_DATA_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(300),

  // --- restic (резервные копии) ---
  RESTIC_REPOSITORY: Joi.string().allow('').default(''),
  RESTIC_PASSWORD: Joi.string().allow('').default(''),
  BACKUP_TMP_DIR: Joi.string().allow('').default(''),
  BACKUP_MODE: Joi.string().valid('disabled', 'required').default('disabled'),

  // --- S3 ---
  S3_ENDPOINT: Joi.string().uri().default('https://s3.amazonaws.com'),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_BUCKET: Joi.string().default('task-hub-backups'),
  S3_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  S3_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),

  // --- Пороги напоминаний (секунды) ---
  REMINDER_FAR_SECONDS: Joi.number().integer().min(0).default(86400),
  REMINDER_NEAR_SECONDS: Joi.number().integer().min(0).default(7200),
  REMINDER_CHECK_WINDOW_SECONDS: Joi.number().integer().min(0).default(300),

  // --- Лимиты ---
  LIMIT_ATTACHMENT_MAX_BYTES: Joi.number().integer().min(1).default(26214400),
  LIMIT_AVATAR_MAX_BYTES: Joi.number().integer().min(1).default(5242880),
  LIMIT_MAX_ATTACHMENTS_PER_MESSAGE: Joi.number().integer().min(1).default(10),
  LIMIT_MESSAGE_TEXT_MAX_LENGTH: Joi.number().integer().min(1).default(4000),
  LIMIT_TASK_TITLE_MAX_LENGTH: Joi.number().integer().min(1).default(200),
  LIMIT_TASK_DESCRIPTION_MAX_LENGTH: Joi.number().integer().min(0).default(5000),
  LIMIT_MAX_ASSIGNEES_PER_TASK: Joi.number().integer().min(1).default(100),
  LIMIT_PASSWORD_MIN_LENGTH: Joi.number().integer().min(1).default(8),
  LIMIT_PASSWORD_MAX_LENGTH: Joi.number().integer().min(1).default(128),
  LIMIT_MESSAGE_COUNTER_CAP: Joi.number().integer().min(1).default(9999),
  LIMIT_LOGIN_MAX_FAILED_ATTEMPTS: Joi.number().integer().min(1).default(5),
  LIMIT_LOGIN_LOCKOUT_SECONDS: Joi.number().integer().min(1).default(900),
  LIMIT_PASSWORD_SETUP_TTL_SECONDS: Joi.number().integer().min(1).default(86400),
  LIMIT_RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().min(1).default(10),
  LIMIT_RATE_LIMIT_WINDOW_SECONDS: Joi.number().integer().min(1).default(60),

  // --- Хранилище вложений ---
  STORAGE_DIR: Joi.string().allow('').default(''),
});
