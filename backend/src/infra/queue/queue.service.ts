import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JobsOptions, Queue, QueueOptions } from 'bullmq';
import { AppConfigService } from '../../config';
import { buildRedisOptions } from '../redis/redis.constants';
import { ALL_QUEUE_NAMES, QueueName } from './queue.constants';

/**
 * Фабрика и реестр очередей BullMQ.
 *
 * Создаёт по запросу (и кэширует) очереди предметной области: email-ретраи,
 * доставку MAX-уведомлений, напоминания о дедлайнах и резервное копирование.
 * Все очереди используют общие параметры подключения Redis из
 * {@link AppConfigService}; каждая очередь держит собственное подключение,
 * как того требует BullMQ (Req 1.7, 13.12).
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();
  private readonly connection: QueueOptions['connection'];

  constructor(config: AppConfigService) {
    this.connection = buildRedisOptions(config);
  }

  /** Предварительно создаёт все известные очереди при старте модуля. */
  onModuleInit(): void {
    for (const name of ALL_QUEUE_NAMES) {
      this.getQueue(name);
    }
  }

  /**
   * Возвращает очередь по имени, создавая её при первом обращении.
   * Очереди кэшируются: повторные вызовы возвращают тот же экземпляр.
   */
  getQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const queue = new Queue(name, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    this.queues.set(name, queue);
    this.logger.log(`Очередь «${name}» инициализирована`);
    return queue;
  }

  /**
   * Ставит задание в указанную очередь.
   * Параметры задания (число попыток, задержка, backoff) задаются вызывающим
   * модулем согласно его требованиям к ретраям.
   */
  add<TData>(
    name: QueueName,
    jobName: string,
    data: TData,
    options?: JobsOptions,
  ): Promise<unknown> {
    return this.getQueue(name).add(jobName, data, options);
  }

  /** Закрывает все открытые очереди при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
