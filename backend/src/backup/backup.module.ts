import { Module } from '@nestjs/common';
import { BackupRecordRepository } from './backup-record.repository';
import { BackupService } from './backup.service';
import { BackupRetentionService } from './backup.retention';
import { BackupWorker } from './backup.worker';
import { ResticBackupAdapter } from './restic-backup.adapter';
import { S3OffsiteUploadAdapter } from './s3-offsite-upload.adapter';
import { OFFSITE_UPLOAD_PORT, RESTIC_BACKUP_PORT } from './backup.types';

/**
 * Модуль резервного копирования (Req 21).
 *
 * Предоставляет {@link BackupService} — запуск ежедневного бэкапа
 * ({@link BackupService.runDailyBackup}): дамп БД инструментом дедупликации
 * restic (Req 21.1, 21.2), выгрузка вне VPS в S3-совместимое хранилище
 * (Req 21.4), пропуск при превышении 60 минут с регистрацией причины (Req 21.8)
 * и сохранение последней успешной копии без изменений при сбое (Req 21.5).
 *
 * Периодичность запуска (03:00 MSK) обеспечивает {@link BackupWorker} поверх
 * очереди {@link import('../infra').QueueName.Backup}. Результаты фиксируются в
 * журнале через {@link BackupRecordRepository}.
 *
 * Внешние границы restic и S3 абстрагированы портами {@link RESTIC_BACKUP_PORT}
 * и {@link OFFSITE_UPLOAD_PORT}. К ним привязаны рабочие адаптеры
 * {@link ResticBackupAdapter} (вызов `pg_dump` + `restic backup`) и
 * {@link S3OffsiteUploadAdapter} (выгрузка в S3-совместимое хранилище).
 * Адаптеры конструируются без обращения к инфраструктуре; при отсутствии
 * конфигурации они сообщают о неготовности границы в момент вызова, что
 * приводит к предсказуемой мягкой деградации (Req 21.5): последняя успешная
 * копия сохраняется без изменений, причина фиксируется в журнале. Безопасные
 * заглушки {@link import('./backup.adapters').UnavailableResticAdapter} и
 * {@link import('./backup.adapters').UnavailableOffsiteUploadAdapter} остаются
 * доступными как резервный вариант привязки.
 *
 * GFS-политика хранения (Req 21.3, задача 18.3) реализована в отдельном файле
 * сервисом {@link BackupRetentionService} (`applyRetention`), чтобы не
 * пересекаться с задачами 18.1/18.5, редактирующими {@link BackupService}.
 * Проверка целостности по контрольной сумме (`verifyIntegrity`, Req 21.6, 21.7)
 * реализована в {@link BackupService}.
 *
 * Опирается на глобальные инфраструктурные модули: {@link PrismaModule}
 * ({@link import('../infra').PrismaService}), {@link QueueModule}
 * ({@link import('../infra').QueueService}) и {@link ClockModule}
 * ({@link import('../clock').ClockService}).
 */
@Module({
  providers: [
    BackupRecordRepository,
    BackupService,
    BackupRetentionService,
    BackupWorker,
    ResticBackupAdapter,
    S3OffsiteUploadAdapter,
    { provide: RESTIC_BACKUP_PORT, useExisting: ResticBackupAdapter },
    { provide: OFFSITE_UPLOAD_PORT, useExisting: S3OffsiteUploadAdapter },
  ],
  exports: [BackupService, BackupRetentionService, BackupRecordRepository],
})
export class BackupModule {}
