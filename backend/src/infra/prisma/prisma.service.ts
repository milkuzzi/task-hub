import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfigService } from '../../config';

/** Параметры интерактивной транзакции Prisma (без `any`). */
export type TransactionOptions = {
  /** Максимальное время ожидания старта транзакции, мс. */
  maxWait?: number;
  /** Максимальное время выполнения транзакции, мс. */
  timeout?: number;
  /** Уровень изоляции транзакции. */
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/**
 * Обёртка Prisma Client как инъецируемый сервис NestJS.
 *
 * Управляет жизненным циклом подключения к PostgreSQL (подключение при старте
 * модуля, корректное закрытие при остановке) и предоставляет типобезопасный
 * хелпер транзакций {@link PrismaService.runInTransaction}. Строка подключения
 * берётся из {@link AppConfigService} (Req 1.7, 13.12).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      datasources: { db: { url: config.database.url } },
    });
  }

  /** Устанавливает соединение с БД при инициализации модуля. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Подключение к PostgreSQL установлено');
  }

  /** Закрывает соединение с БД при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Подключение к PostgreSQL закрыто');
  }

  /**
   * Выполняет переданную функцию в рамках интерактивной транзакции.
   * Все операции внутри `fn` атомарны: при выбросе исключения транзакция
   * откатывается целиком. Используется для инвариантов предметной области
   * (например, «ровно один администратор»), требующих согласованности.
   */
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.$transaction(fn, options);
  }
}
