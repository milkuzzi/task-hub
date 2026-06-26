import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../config';
import { QueueName, QueueService, buildRedisOptions } from '../infra';
import { DeadlineReminderService } from './deadline-reminder.service';

/** Имя задания периодической проверки напоминаний о Дедлайне. */
export const DEADLINE_REMINDER_SCAN_JOB_NAME = 'scan-deadline-reminders';

/** Идентификатор повторяющегося задания проверки (защита от дублей расписания). */
export const DEADLINE_REMINDER_SCAN_JOB_ID = 'deadline-reminder-scan';

/**
 * Фоновый воркер периодической проверки напоминаний о Дедлайне
 * (Req 13.7, 13.8).
 *
 * При старте модуля регистрирует повторяющееся задание в очереди
 * {@link QueueName.DeadlineReminders} с интервалом, равным окну проверки
 * (`reminders.checkWindowSeconds`), и обрабатывает его через
 * {@link DeadlineReminderService.scanDueReminders}: отбирает Задачи, остаток до
 * Дедлайна которых попадает в окно дальнего/ближнего порога, и отправляет
 * наступившие, ещё не отправленные пороги. Логика принятия решения — в чистой
 * функции {@link decideDueReminders}; воркер лишь обеспечивает периодичность.
 *
 * Немедленная отправка порога при создании Задачи или изменении Дедлайна
 * выполняется синхронно через {@link DeadlineReminderService.scheduleDeadlineReminders}
 * (Req 13.9, 13.10) и здесь не дублируется.
 */
@Injectable()
export class DeadlineReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadlineReminderWorker.name);
  private worker: Worker | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly queue: QueueService,
    private readonly service: DeadlineReminderService,
  ) {}

  /** Регистрирует повторяющееся задание и запускает воркер проверки. */
  async onModuleInit(): Promise<void> {
    const connection = buildRedisOptions(this.config);
    const everyMs = Math.max(1, this.config.reminders.checkWindowSeconds) * 1000;

    await this.queue.add(
      QueueName.DeadlineReminders,
      DEADLINE_REMINDER_SCAN_JOB_NAME,
      {},
      {
        repeat: { every: everyMs },
        jobId: DEADLINE_REMINDER_SCAN_JOB_ID,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.worker = new Worker(QueueName.DeadlineReminders, () => this.service.scanDueReminders(), {
      connection,
    });
    this.worker.on('failed', (job, error) => {
      this.handleFailure(job, error);
    });

    this.logger.log('Воркер напоминаний о дедлайне запущен');
  }

  /** Логирует неуспешную обработку задания проверки напоминаний. */
  private handleFailure(job: Job | undefined, error: Error): void {
    this.logger.error(
      `Сбой обработки задания напоминаний о дедлайне «${job?.id ?? 'без данных'}»: ${error.message}`,
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
