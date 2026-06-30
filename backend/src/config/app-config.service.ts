import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppConfiguration,
  AppEnv,
  AuthConfig,
  BackupConfig,
  DatabaseConfig,
  LimitsConfig,
  MetricsConfig,
  MaxConfig,
  RedisConfig,
  ReminderThresholdsConfig,
  ResticConfig,
  S3Config,
  SendPulseConfig,
  StorageConfig,
} from './config.types';

/**
 * Типобезопасная обёртка над {@link ConfigService}.
 * Предоставляет доступ к секциям конфигурации без строковых ключей и без `any`.
 * Инъецируется в любой модуль приложения.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  get app(): AppEnv {
    return this.config.get('app', { infer: true });
  }

  get metrics(): MetricsConfig {
    return this.config.get('metrics', { infer: true });
  }

  get auth(): AuthConfig {
    return this.config.get('auth', { infer: true });
  }

  get database(): DatabaseConfig {
    return this.config.get('database', { infer: true });
  }

  get redis(): RedisConfig {
    return this.config.get('redis', { infer: true });
  }

  get sendpulse(): SendPulseConfig {
    return this.config.get('sendpulse', { infer: true });
  }

  get max(): MaxConfig {
    return this.config.get('max', { infer: true });
  }

  get restic(): ResticConfig {
    return this.config.get('restic', { infer: true });
  }

  get backup(): BackupConfig {
    return this.config.get('backup', { infer: true });
  }

  get s3(): S3Config {
    return this.config.get('s3', { infer: true });
  }

  get reminders(): ReminderThresholdsConfig {
    return this.config.get('reminders', { infer: true });
  }

  get limits(): LimitsConfig {
    return this.config.get('limits', { infer: true });
  }

  get storage(): StorageConfig {
    return this.config.get('storage', { infer: true });
  }

  get isProduction(): boolean {
    return this.app.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.app.nodeEnv === 'test';
  }
}
