import { Injectable } from '@nestjs/common';
import { BackupRecord, BackupResult, Prisma } from '@prisma/client';
import { PrismaService } from '../infra';
import { BaseRepository } from '../repositories';

/** Данные для создания записи журнала резервного копирования (Req 21.5, 21.8). */
export interface CreateBackupRecordInput {
  /** Момент начала выполнения (UTC). */
  startedAt: Date;
  /** Момент завершения выполнения (UTC). */
  finishedAt: Date;
  /** Итог выполнения. */
  result: BackupResult;
  /** Контрольная сумма копии при успехе (Req 21.6). */
  checksum?: string;
  /** Причина пропуска/сбоя при неуспехе (Req 21.5, 21.8). */
  reason?: string;
}

/**
 * Репозиторий-обёртка над сущностью {@link BackupRecord} (Req 21).
 *
 * Каждый запуск резервного копирования фиксируется отдельной записью журнала:
 * успех, сбой (с причиной, Req 21.5) или пропуск (с причиной, Req 21.8). Записи
 * только добавляются — прежние успешные копии и их записи не изменяются и не
 * удаляются, что обеспечивает сохранность последней успешной копии при сбое или
 * пропуске (Req 21.5, 21.8; свойство 61, задача 18.2).
 */
@Injectable()
export class BackupRecordRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** Создаёт запись журнала о результате выполнения резервного копирования. */
  async create(
    input: CreateBackupRecordInput,
    tx?: Prisma.TransactionClient,
  ): Promise<BackupRecord> {
    return this.client(tx).backupRecord.create({
      data: {
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        result: input.result,
        checksum: input.checksum ?? null,
        reason: input.reason ?? null,
      },
    });
  }

  /**
   * Возвращает запись журнала резервного копирования по идентификатору или
   * `null`, если запись не найдена.
   *
   * Используется при проверке целостности по контрольной сумме (Req 21.6, 21.7).
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<BackupRecord | null> {
    return this.client(tx).backupRecord.findUnique({ where: { id } });
  }

  /**
   * Помечает резервную копию недействительной из-за нарушения целостности
   * (Req 21.7): фиксирует результат `INTEGRITY_ERROR` и причину, указывающую на
   * несоответствие контрольной суммы.
   *
   * В отличие от сохранения последней успешной копии при сбое нового запуска
   * (Req 21.5, 21.8), здесь намеренно изменяется состояние конкретной копии,
   * не прошедшей проверку целостности.
   */
  async markIntegrityError(
    id: string,
    reason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<BackupRecord> {
    return this.client(tx).backupRecord.update({
      where: { id },
      data: { result: BackupResult.INTEGRITY_ERROR, reason },
    });
  }

  /**
   * Возвращает последнюю успешную резервную копию (самую свежую запись с
   * результатом `SUCCESS`) или `null`, если успешных копий ещё нет.
   *
   * Используется для проверки сохранности последней успешной копии при сбое или
   * пропуске (Req 21.5, 21.8).
   */
  async findLastSuccessful(tx?: Prisma.TransactionClient): Promise<BackupRecord | null> {
    return this.client(tx).backupRecord.findFirst({
      where: { result: BackupResult.SUCCESS },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Возвращает все успешные резервные копии (записи с результатом `SUCCESS`),
   * упорядоченные от самой свежей к самой старой.
   *
   * Используется при применении GFS-политики хранения (Req 21.3): квоты
   * 7/4/6 распространяются именно на действительные копии, поэтому пропуски,
   * сбои и копии, не прошедшие проверку целостности (`INTEGRITY_ERROR`), в
   * выборку не попадают.
   */
  async findAllSuccessful(tx?: Prisma.TransactionClient): Promise<BackupRecord[]> {
    return this.client(tx).backupRecord.findMany({
      where: { result: BackupResult.SUCCESS },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Удаляет записи журнала о резервных копиях по списку идентификаторов и
   * возвращает количество удалённых записей (Req 21.3).
   *
   * В отличие от append-only-поведения при сбое/пропуске нового запуска
   * (Req 21.5, 21.8), удаление здесь является целенаправленной частью
   * GFS-политики хранения: копии, выходящие за пределы квот 7/4/6, удаляются.
   */
  async deleteByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const { count } = await this.client(tx).backupRecord.deleteMany({
      where: { id: { in: ids } },
    });
    return count;
  }
}
