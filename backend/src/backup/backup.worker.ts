import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../config';
import { QueueName, QueueService, buildRedisOptions } from '../infra';
import {
  BACKUP_CRON_PATTERN,
  BACKUP_DAILY_JOB_ID,
  BACKUP_DAILY_JOB_NAME,
  BACKUP_TIMEZONE,
} from './backup.constants';
import { BackupService } from './backup.service';

/**
 * Фоновый воркер ежедневного резервного копирования (Req 21.2).
 *
 * При старте модуля регистрирует повторяющееся задание в очереди
 * {@link QueueName.Backup} по cron-расписанию {@link BACKUP_CRON_PATTERN}
 * (03:00) в часовом поясе {@link BACKUP_TIMEZONE} (MSK) и обрабатывает его через
 * {@link BackupService.runDailyBackup}. Сама логика бэкапа (дамп restic,
 * выгрузка в S3, пропуск при превышении 60 минут, сохранение последней успешной
 * копии) инкапсулирована в {@link BackupService}; воркер обеспечивает только
 * периодичность запуска и логирование итога.
 */
@Injectable()
export class BackupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupWorker.name);
  private worker: Worker | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly queue: QueueService,
    private readonly service: BackupService,
  ) {}

  /** Регистрирует повторяющееся задание 03:00 MSK и запускает воркер бэкапа. */
  async onModuleInit(): Promise<void> {
    if (this.config.backup.mode === 'disabled') {
      this.logger.log('Встроенное резервное копирование отключено (BACKUP_MODE=disabled)');
      return;
    }

    const connection = buildRedisOptions(this.config);

    await this.queue.add(
      QueueName.Backup,
      BACKUP_DAILY_JOB_NAME,
      {},
      {
        repeat: { pattern: BACKUP_CRON_PATTERN, tz: BACKUP_TIMEZONE },
        jobId: BACKUP_DAILY_JOB_ID,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.worker = new Worker(QueueName.Backup, () => this.service.runDailyBackup(), {
      connection,
    });
    this.worker.on('failed', (job, error) => {
      this.handleFailure(job, error);
    });

    this.logger.log('Воркер ежедневного резервного копирования запущен (03:00 MSK)');
  }

  /** Логирует неуспешную обработку задания бэкапа на уровне воркера. */
  private handleFailure(job: Job | undefined, error: Error): void {
    this.logger.error(
      `Сбой обработки задания резервного копирования «${job?.id ?? 'без данных'}»: ${error.message}`,
    );
  }

  /** Останавливает воркер при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    if (this.worker !== undefined) {
      await this.worker.close();
      this.worker = undefined;
    }
  }
}
