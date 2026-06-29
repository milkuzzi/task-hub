import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BackupResult } from '@prisma/client';
import { ClockService } from '../clock';
import { EntityNotFoundException } from '../common/errors';
import { AppConfigService } from '../config';
import { BackupRecordRepository } from './backup-record.repository';
import { BACKUP_MAX_DURATION_MS } from './backup.constants';
import {
  BackupRunResult,
  DatabaseDumpResult,
  OFFSITE_UPLOAD_PORT,
  OffsiteUploadPort,
  RESTIC_BACKUP_PORT,
  ResticBackupPort,
} from './backup.types';

/**
 * Ошибка превышения предельной длительности выполнения резервного копирования
 * (Req 21.8). Сигнализирует, что выполнение следует пропустить.
 */
class BackupTimeoutError extends Error {
  constructor(maxDurationMs: number) {
    super(
      `Выполнение резервного копирования превысило бы ${Math.round(maxDurationMs / 60000)} минут`,
    );
    this.name = 'BackupTimeoutError';
  }
}

/**
 * Сервис резервного копирования (Req 21).
 *
 * Реализует запуск ежедневного бэкапа {@link BackupService.runDailyBackup}:
 * создание дампа БД инструментом дедупликации restic (Req 21.1, 21.2), выгрузку
 * копии вне VPS в S3-совместимое хранилище (Req 21.4), пропуск выполнения при
 * превышении 60 минут с регистрацией причины (Req 21.8) и сохранение последней
 * успешной копии без изменений при любом сбое или пропуске (Req 21.5).
 *
 * Внешние границы (restic, S3) абстрагированы портами {@link ResticBackupPort}
 * и {@link OffsiteUploadPort}; источник времени инъецируется через
 * {@link ClockService}. Каждый запуск фиксируется отдельной записью журнала
 * {@link BackupRecordRepository} — прежние записи не изменяются.
 *
 * GFS-политика хранения (`applyRetention`, Req 21.3) реализуется отдельной
 * задачей (18.3) в самостоятельном файле, чтобы не пересекаться с этой задачей.
 * Проверка целостности по контрольной сумме (`verifyIntegrity`, Req 21.6, 21.7)
 * реализована методом {@link BackupService.verifyIntegrity}.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly clock: ClockService,
    private readonly records: BackupRecordRepository,
    @Inject(RESTIC_BACKUP_PORT) private readonly restic: ResticBackupPort,
    @Inject(OFFSITE_UPLOAD_PORT) private readonly offsite: OffsiteUploadPort,
    @Optional() private readonly config?: AppConfigService,
  ) {}

  /**
   * Выполняет ежедневное резервное копирование (Req 21.2, 21.4, 21.5, 21.8).
   *
   * Шаги: создаёт дамп БД через restic и помещает его в дедуплицируемый
   * репозиторий (Req 21.1, 21.2), затем выгружает копию в S3-совместимое
   * хранилище (Req 21.4). Всё выполнение ограничено окном в 60 минут
   * ({@link BACKUP_MAX_DURATION_MS}); при его превышении выполнение прерывается
   * и регистрируется как пропуск с причиной (Req 21.8). При сбое создания дампа
   * или выгрузки регистрируется событие сбоя с причиной (Req 21.5). В обоих
   * случаях неуспеха прежние успешные копии не изменяются: журнал лишь
   * пополняется новой записью.
   *
   * @returns Структурированный итог запуска {@link BackupRunResult}.
   */
  async runDailyBackup(): Promise<BackupRunResult> {
    const startedAt = this.clock.now();
    if (this.config?.backup.mode === 'disabled') {
      const reason = 'Резервное копирование отключено конфигурацией BACKUP_MODE=disabled.';
      this.logger.log(reason);
      return this.recordOutcome(startedAt, { result: BackupResult.SKIPPED, reason });
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const dump = await Promise.race<DatabaseDumpResult>([
        this.performBackup(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BackupTimeoutError(BACKUP_MAX_DURATION_MS));
          }, BACKUP_MAX_DURATION_MS);
        }),
      ]);

      return await this.recordOutcome(startedAt, {
        result: BackupResult.SUCCESS,
        checksum: dump.checksum,
      });
    } catch (error) {
      const reason = this.describeError(error);
      if (error instanceof BackupTimeoutError) {
        // Req 21.8: пропуск с сохранением последней успешной копии и причиной.
        this.logger.warn(`Резервное копирование пропущено: ${reason}`);
        return await this.recordOutcome(startedAt, { result: BackupResult.SKIPPED, reason });
      }
      // Req 21.5: сбой создания дампа или выгрузки — регистрируем с причиной.
      this.logger.error(`Резервное копирование завершилось сбоем: ${reason}`);
      return await this.recordOutcome(startedAt, { result: BackupResult.FAILED, reason });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Выполняет создание дампа и выгрузку в S3 (без учёта тайм-аута).
   * Тайм-аут накладывается вызывающим методом через {@link Promise.race}.
   */
  private async performBackup(signal: AbortSignal): Promise<DatabaseDumpResult> {
    const dump = await this.restic.createDump(signal); // Req 21.1, 21.2
    if (this.offsite.isConfigured?.() === false) {
      this.logger.warn(
        'S3-манифест резервной копии не сконфигурирован; restic-снимок создан без внешнего манифеста.',
      );
      return dump;
    }
    await this.offsite.upload(dump, signal); // Req 21.4
    return dump;
  }

  /**
   * Проверяет целостность резервной копии по контрольной сумме (Req 21.6, 21.7).
   *
   * Сверяет контрольную сумму копии, выгруженной в S3-совместимое хранилище
   * (пересчитанную после выгрузки), с суммой, зафиксированной до выгрузки
   * (поле `checksum` записи журнала). При совпадении копия признаётся
   * действительной (`true`). При несоответствии копия помечается недействительной
   * — запись переводится в результат `INTEGRITY_ERROR` с причиной, указывающей на
   * нарушение целостности, регистрируется событие, метод возвращает `false`
   * (Req 21.7).
   *
   * @param backupId Идентификатор записи журнала резервной копии.
   * @returns `true`, если контрольные суммы совпали; иначе `false`.
   * @throws EntityNotFoundException если запись не найдена.
   * @throws Error если копию невозможно прочитать из хранилища для проверки.
   */
  async verifyIntegrity(backupId: string): Promise<boolean> {
    const record = await this.records.findById(backupId);
    if (record === null) {
      throw new EntityNotFoundException(`Запись резервной копии «${backupId}» не найдена`);
    }

    if (record.checksum === null) {
      // Контрольная сумма фиксируется только для успешно созданной копии
      // (Req 21.6). Без неё сверять нечего — целостность подтвердить нельзя.
      throw new EntityNotFoundException(
        `Резервная копия «${backupId}» не содержит контрольной суммы для проверки целостности`,
      );
    }

    const expected = record.checksum;
    const actual = await this.offsite.computeUploadedChecksum({
      backupId: record.id,
      checksum: expected,
    });

    if (actual === expected) {
      return true; // Req 21.6: суммы совпали — копия действительна.
    }

    // Req 21.7: несоответствие — помечаем копию недействительной и регистрируем
    // событие с индикацией нарушения целостности.
    const reason = `Нарушение целостности резервной копии: контрольная сумма после выгрузки (${actual}) не совпадает с суммой до выгрузки (${expected})`;
    await this.records.markIntegrityError(record.id, reason);
    this.logger.error(reason);
    return false;
  }

  /**
   * Фиксирует итог выполнения отдельной записью журнала и возвращает
   * структурированный результат. Прежние записи журнала не изменяются
   * (Req 21.5, 21.8).
   */
  private async recordOutcome(
    startedAt: Date,
    outcome: { result: BackupResult; checksum?: string; reason?: string },
  ): Promise<BackupRunResult> {
    const finishedAt = this.clock.now();
    const record = await this.records.create({
      startedAt,
      finishedAt,
      result: outcome.result,
      ...(outcome.checksum !== undefined ? { checksum: outcome.checksum } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    });

    return {
      recordId: record.id,
      result: outcome.result,
      startedAt,
      finishedAt,
      ...(outcome.checksum !== undefined ? { checksum: outcome.checksum } : {}),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  }

  /** Извлекает человекочитаемую причину из перехваченной ошибки. */
  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
