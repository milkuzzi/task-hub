import { Injectable } from '@nestjs/common';
import { AuditEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from '../repositories';

/**
 * Данные для добавления одной записи в Журнал изменений (Req 20.1).
 *
 * Соответствуют модели {@link AuditEntry}: задача, автор (может быть `null`
 * после hard-delete автора), машинное имя параметра, прежнее/новое значение и
 * момент изменения (UTC). Время хранится в UTC; представление в MSK выполняется
 * при отображении (Req 20.1).
 */
export interface AuditEntryCreateData {
  taskId: string;
  authorId: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
}

/**
 * Репозиторий-обёртка над сущностью {@link AuditEntry} — Журналом изменений
 * (Req 20).
 *
 * Журнал неизменяем (append-only): репозиторий намеренно предоставляет ТОЛЬКО
 * операции добавления записи и чтения списка. Методы правки или удаления записей
 * отсутствуют — это обеспечивает запрет изменения и удаления Журнала на уровне
 * слоя доступа к данным (Req 20.4). Все методы поддерживают выполнение в рамках
 * транзакции.
 */
@Injectable()
export class AuditEntryRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Добавляет одну запись в Журнал изменений (append-only, Req 20.1, 20.4).
   *
   * @param data Данные записи (задача, автор, параметр, прежнее/новое значение,
   *   момент изменения в UTC).
   * @returns Созданная запись Журнала.
   */
  create(data: AuditEntryCreateData, tx?: Prisma.TransactionClient): Promise<AuditEntry> {
    return this.client(tx).auditEntry.create({ data });
  }

  /**
   * Возвращает все записи Журнала указанной Задачи, упорядоченные по времени
   * изменения от новых к старым (Req 20.2).
   *
   * @param taskId Идентификатор Задачи.
   * @returns Записи Журнала (новые → старые); пустой массив, если изменений не было.
   */
  listByTaskNewestFirst(taskId: string, tx?: Prisma.TransactionClient): Promise<AuditEntry[]> {
    return this.client(tx).auditEntry.findMany({
      where: { taskId },
      orderBy: { changedAt: 'desc' },
    });
  }
}
