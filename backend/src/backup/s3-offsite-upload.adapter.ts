import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config';
import { DatabaseDumpResult, OffsiteUploadPort, UploadedBackupReference } from './backup.types';

/** Префикс ключей объектов резервных копий в бакете. */
const BACKUP_KEY_PREFIX = 'task-hub-backups';

/** Имя пользовательских метаданных объекта с контрольной суммой до выгрузки. */
const CHECKSUM_METADATA_KEY = 'dump-checksum';

/**
 * Рабочий адаптер порта {@link OffsiteUploadPort} поверх S3-совместимого
 * хранилища (Req 21.4, 21.6).
 *
 * Выгружает манифест резервной копии командой `PutObject`, помещая в
 * пользовательские метаданные объекта контрольную сумму дампа, вычисленную до
 * выгрузки (Req 21.6). Для проверки целостности
 * ({@link import('./backup.service').BackupService.verifyIntegrity}) метод
 * {@link computeUploadedChecksum} читает объект через `HeadObject` и возвращает
 * сохранённую в метаданных сумму: совпадение с суммой до выгрузки
 * подтверждает, что копия присутствует и не повреждена; рассогласование или
 * отсутствие объекта означает нарушение целостности (Req 21.7).
 *
 * Бесплатно и S3-совместимо: Backblaze B2 (free tier) или self-hosted MinIO —
 * подключаются через {@link import('../config').S3Config.endpoint} и
 * {@link import('../config').S3Config.forcePathStyle}.
 *
 * Мягкая деградация (Req 21.5): конструктор не бросает исключений и не
 * создаёт сетевых соединений; клиент S3 создаётся лениво при первом вызове.
 * Если к моменту вызова конфигурация хранилища неполна (нет ключей доступа или
 * бакета), метод бросает понятную ошибку «не сконфигурировано» —
 * {@link import('./backup.service').BackupService} регистрирует сбой и
 * сохраняет последнюю успешную копию.
 *
 * Отмена (Req 21.8): {@link AbortSignal} передаётся в вызовы клиента S3 и
 * прерывает сетевые операции при превышении предельной длительности.
 */
@Injectable()
export class S3OffsiteUploadAdapter implements OffsiteUploadPort {
  private readonly logger = new Logger(S3OffsiteUploadAdapter.name);
  private client: S3Client | undefined;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Выгружает манифест резервной копии в S3-совместимое хранилище (Req 21.4).
   *
   * @param dump Сведения о созданном дампе (контрольная сумма до выгрузки).
   * @param signal Сигнал отмены при превышении предельной длительности (Req 21.8).
   * @throws Error если хранилище не сконфигурировано (мягкая деградация, Req 21.5)
   *   либо при сетевой ошибке.
   */
  async upload(dump: DatabaseDumpResult, signal?: AbortSignal): Promise<void> {
    const { bucket } = this.requireConfig();
    const client = this.getClient();
    const key = this.objectKey(dump.checksum);

    const body = JSON.stringify({
      checksum: dump.checksum,
      ...(dump.snapshotId !== undefined ? { snapshotId: dump.snapshotId } : {}),
      ...(dump.sizeBytes !== undefined ? { sizeBytes: dump.sizeBytes } : {}),
      uploadedAt: new Date().toISOString(),
    });

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        Metadata: { [CHECKSUM_METADATA_KEY]: dump.checksum },
      }),
      ...(signal !== undefined ? [{ abortSignal: signal }] : []),
    );

    this.logger.log(`Резервная копия выгружена в S3: ${bucket}/${key}`);
  }

  /**
   * Возвращает контрольную сумму выгруженной копии, прочитанную из метаданных
   * объекта в S3-совместимом хранилище (Req 21.6).
   *
   * @param reference Ссылка на копию (контрольная сумма до выгрузки — ключ объекта).
   * @param signal Сигнал отмены.
   * @returns Контрольная сумма, сохранённая в метаданных объекта.
   * @throws Error если хранилище не сконфигурировано, объект не найден или не
   *   содержит сохранённой контрольной суммы.
   */
  async computeUploadedChecksum(
    reference: UploadedBackupReference,
    signal?: AbortSignal,
  ): Promise<string> {
    const { bucket } = this.requireConfig();
    const client = this.getClient();
    const key = this.objectKey(reference.checksum);

    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      ...(signal !== undefined ? [{ abortSignal: signal }] : []),
    );

    const checksum = head.Metadata?.[CHECKSUM_METADATA_KEY];
    if (checksum === undefined || checksum === '') {
      throw new Error(
        `Объект резервной копии «${key}» не содержит сохранённой контрольной суммы для проверки целостности.`,
      );
    }
    return checksum;
  }

  /**
   * Проверяет полноту конфигурации S3 и возвращает её обязательные поля
   * (мягкая деградация при отсутствии — Req 21.5).
   */
  private requireConfig(): { bucket: string } {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = this.config.s3;
    if (
      endpoint === '' ||
      region === '' ||
      bucket === '' ||
      accessKeyId === '' ||
      secretAccessKey === ''
    ) {
      throw new Error(
        'S3-совместимое хранилище для резервных копий не сконфигурировано: задайте S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY.',
      );
    }
    return { bucket };
  }

  /**
   * Лениво создаёт и кэширует клиент S3 из конфигурации (endpoint, region,
   * учётные данные, path-style). Создание отложено, чтобы граф зависимостей
   * собирался при старте без обращения к сети.
   */
  private getClient(): S3Client {
    if (this.client === undefined) {
      const { endpoint, region, accessKeyId, secretAccessKey, forcePathStyle } = this.config.s3;
      this.client = new S3Client({
        endpoint,
        region,
        forcePathStyle,
        credentials: { accessKeyId, secretAccessKey },
      });
    }
    return this.client;
  }

  /** Строит ключ объекта резервной копии по контрольной сумме дампа. */
  private objectKey(checksum: string): string {
    return `${BACKUP_KEY_PREFIX}/${checksum}.json`;
  }
}
