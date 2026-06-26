/**
 * Строго типизированная структура конфигурации приложения «Система поручений».
 * Источник истины для значений, читаемых из переменных окружения.
 */

export interface AppEnv {
  /** Окружение исполнения. */
  nodeEnv: 'development' | 'test' | 'production';
  /** Порт HTTP-сервера NestJS. */
  port: number;
  /** Публичный базовый URL приложения (для ссылок в письмах и редиректов). */
  publicUrl: string;
}

/**
 * Конфигурация аутентификации по JWT-токенам доступа (Req 5.7, 19.10).
 *
 * Access-токены короткоживущие; их валидность дополнительно проверяется по
 * реестру сессий в Redis, что позволяет аннулировать токены ≤5с.
 */
export interface AuthConfig {
  /** Секрет подписи JWT (HS256). Обязателен в production. */
  jwtSecret: string;
  /** Срок жизни access-токена в секундах (по умолчанию 15 минут). */
  accessTokenTtlSeconds: number;
}

/** Конфигурация подключения к PostgreSQL (Req: модель данных, Prisma). */
export interface DatabaseConfig {
  /** Строка подключения формата postgresql://user:pass@host:port/db. */
  url: string;
}

/** Конфигурация Redis (очереди BullMQ, реестр сессий, rate-limit). */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  /** Номер логической БД Redis. */
  db: number;
}

/** Конфигурация исходящей почты через SendPulse (Req 1.6, 1.7). */
export interface SendPulseConfig {
  apiUserId: string;
  apiSecret: string;
  senderEmail: string;
  senderName: string;
}

/** Конфигурация интеграции с платформой MAX (OAuth-вход и Бот). */
export interface MaxConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRedirectUri: string;
  botToken: string;
  botApiBaseUrl: string;
}

/**
 * Конфигурация инструмента резервного копирования restic (Req 21.1, 21.2).
 *
 * Адаптер {@link import('../backup/restic-backup.adapter').ResticBackupAdapter}
 * создаёт дамп БД (`pg_dump` по {@link DatabaseConfig.url}) и помещает его в
 * дедуплицируемый репозиторий restic. Бесплатно: restic — open-source (BSD-2),
 * репозиторием может быть локальный каталог на VPS либо тот же S3-бакет
 * (Backblaze B2 free / MinIO). При отсутствии репозитория/пароля адаптер
 * сообщает о неконфигурированности — выполняется мягкая деградация (Req 21.5).
 */
export interface ResticConfig {
  /** Путь/URL репозитория restic (`RESTIC_REPOSITORY`). Пусто — не сконфигурирован. */
  repository: string;
  /** Пароль репозитория restic (`RESTIC_PASSWORD`). Пусто — не сконфигурирован. */
  password: string;
  /** Каталог для временного файла дампа БД перед помещением в restic. */
  tmpDir: string;
}

/** Режим встроенного ежедневного резервного копирования. */
export interface BackupConfig {
  /** `disabled` не планирует задания; `required` выполняет и регистрирует сбои. */
  mode: 'disabled' | 'required';
}

/** Конфигурация S3-совместимого хранилища для резервных копий (Req 21). */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Принудительный path-style доступ (для MinIO и совместимых). */
  forcePathStyle: boolean;
}

/**
 * Пороги напоминаний о дедлайне в секундах (Req 13.7–13.10).
 * По умолчанию дальний — 24ч (86400с), ближний — 2ч (7200с),
 * окно проверки ±5 минут (300с).
 */
export interface ReminderThresholdsConfig {
  farSeconds: number;
  nearSeconds: number;
  checkWindowSeconds: number;
}

/**
 * Лимиты и границы значений предметной области.
 * Значения по умолчанию соответствуют требованиям.
 */
export interface LimitsConfig {
  /** Максимальный размер вложения в байтах — 25 МБ (Req 12.2, 12.3). */
  attachmentMaxBytes: number;
  /** Максимальный размер аватара в байтах — 5 МБ (Req 6.4, 6.5). */
  avatarMaxBytes: number;
  /** Максимум вложений на одно сообщение — 10 (Req 11.9). */
  maxAttachmentsPerMessage: number;
  /** Максимальная длина текста сообщения — 4000 (Req 11.3, 11.4). */
  messageTextMaxLength: number;
  /** Границы длины названия задачи — 1..200 (Req 9.1). */
  taskTitleMaxLength: number;
  /** Границы длины описания задачи — 0..5000 (Req 9.1). */
  taskDescriptionMaxLength: number;
  /** Максимум исполнителей/менеджеров на задаче — 100 (Req 9.1). */
  maxAssigneesPerTask: number;
  /** Границы длины пароля — 8..128 (Req 6.7). */
  passwordMinLength: number;
  passwordMaxLength: number;
  /** Потолок счётчика сообщений на карточке — 9999 (Req 9.7, 9.9). */
  messageCounterCap: number;
  /** Число неудачных входов до блокировки — 5 (Req 5.9, 19.3). */
  loginMaxFailedAttempts: number;
  /** Длительность блокировки входа в секундах — 15 мин (Req 5.9). */
  loginLockoutSeconds: number;
  /** Срок жизни ссылки установки пароля в секундах — 24ч (Req 15.2). */
  passwordSetupTtlSeconds: number;
  /** Лимит запросов чувствительных операций за окно (Req 19.1). */
  rateLimitMaxRequests: number;
  /** Окно rate-limit в секундах — 60с (Req 19.1). */
  rateLimitWindowSeconds: number;
}

/**
 * Конфигурация файлового хранилища вложений (Req 12.8, 19.8).
 *
 * Файлы вложений хранятся в сжатом виде в каталоге вне веб-корня и отдаются
 * только через контролируемый сервис (а не статикой Nginx), что удовлетворяет
 * требованию контролируемой отдачи (Req 19.8).
 */
export interface StorageConfig {
  /** Абсолютный путь к базовому каталогу хранения вложений вне веб-корня. */
  baseDir: string;
}

/** Корневая конфигурация приложения. */
export interface AppConfiguration {
  app: AppEnv;
  auth: AuthConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  sendpulse: SendPulseConfig;
  max: MaxConfig;
  restic: ResticConfig;
  backup: BackupConfig;
  s3: S3Config;
  reminders: ReminderThresholdsConfig;
  limits: LimitsConfig;
  storage: StorageConfig;
}
