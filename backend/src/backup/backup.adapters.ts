import { Injectable, Logger } from '@nestjs/common';
import { DatabaseDumpResult, OffsiteUploadPort, ResticBackupPort } from './backup.types';

/**
 * Реализации-заглушки портов резервного копирования до подключения реальной
 * инфраструктуры (restic и S3-клиента).
 *
 * По аналогии с {@link import('../notifications/delivery/max-delivery.port').UnavailableMaxDeliveryAdapter}
 * заглушки сообщают о недоступности соответствующей внешней границы, сигнализируя
 * сбой. Это корректно запускает обработку неуспеха в {@link
 * import('./backup.service').BackupService.runDailyBackup}: последняя успешная
 * копия сохраняется без изменений, а событие сбоя регистрируется с причиной
 * (Req 21.5). Реальные адаптеры (вызов restic, выгрузка в S3) переопределяют
 * привязку токенов на уровне инфраструктуры/развёртывания, не затрагивая
 * прикладную логику запуска бэкапа.
 */

/**
 * Заглушка порта restic: сообщает, что инструмент резервного копирования ещё не
 * сконфигурирован.
 */
@Injectable()
export class UnavailableResticAdapter implements ResticBackupPort {
  private readonly logger = new Logger(UnavailableResticAdapter.name);

  private static readonly REASON =
    'Инструмент резервного копирования restic ещё не сконфигурирован.';

  async createDump(): Promise<DatabaseDumpResult> {
    this.logger.warn(`Создание дампа БД пропущено: ${UnavailableResticAdapter.REASON}`);
    throw new Error(UnavailableResticAdapter.REASON);
  }
}

/**
 * Заглушка порта выгрузки в S3: сообщает, что хранилище ещё не сконфигурировано.
 */
@Injectable()
export class UnavailableOffsiteUploadAdapter implements OffsiteUploadPort {
  private readonly logger = new Logger(UnavailableOffsiteUploadAdapter.name);

  private static readonly REASON =
    'S3-совместимое хранилище для резервных копий ещё не сконфигурировано.';

  async upload(): Promise<void> {
    this.logger.warn(
      `Выгрузка резервной копии пропущена: ${UnavailableOffsiteUploadAdapter.REASON}`,
    );
    throw new Error(UnavailableOffsiteUploadAdapter.REASON);
  }

  async computeUploadedChecksum(): Promise<string> {
    this.logger.warn(
      `Чтение резервной копии для проверки целостности пропущено: ${UnavailableOffsiteUploadAdapter.REASON}`,
    );
    throw new Error(UnavailableOffsiteUploadAdapter.REASON);
  }
}
