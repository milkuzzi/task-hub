jest.mock('@aws-sdk/client-s3');
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AppConfigService } from '../config';
import { DatabaseDumpResult } from './backup.types';
import { S3OffsiteUploadAdapter } from './s3-offsite-upload.adapter';

const send = jest.fn();

describe('S3OffsiteUploadAdapter', () => {
  const configFor = (overrides?: Partial<AppConfigService['s3']>): AppConfigService =>
    ({
      s3: {
        endpoint: 'https://s3.example.com',
        region: 'eu-central-003',
        bucket: 'backups',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
        ...overrides,
      },
    }) as unknown as AppConfigService;

  const dump: DatabaseDumpResult = {
    checksum: 'abc123checksum',
    snapshotId: 'snap-1',
    sizeBytes: 42,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send }));
  });

  it('выгружает копию через PutObject с нужными бакетом, ключом и метаданными (Req 21.4)', async () => {
    send.mockResolvedValue({});

    const adapter = new S3OffsiteUploadAdapter(configFor());
    await adapter.upload(dump);

    expect(send).toHaveBeenCalledTimes(1);
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'backups',
        Key: 'task-hub-backups/abc123checksum.json',
        Metadata: { 'dump-checksum': 'abc123checksum' },
      }),
    );
  });

  it('возвращает контрольную сумму выгруженной копии через HeadObject (Req 21.6)', async () => {
    send.mockResolvedValue({ Metadata: { 'dump-checksum': 'abc123checksum' } });

    const adapter = new S3OffsiteUploadAdapter(configFor());
    const checksum = await adapter.computeUploadedChecksum({
      backupId: 'rec-1',
      checksum: 'abc123checksum',
    });

    expect(checksum).toBe('abc123checksum');
    expect(HeadObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'backups', Key: 'task-hub-backups/abc123checksum.json' }),
    );
  });

  it('бросает ошибку, если объект не содержит сохранённой контрольной суммы (Req 21.7)', async () => {
    send.mockResolvedValue({ Metadata: {} });

    const adapter = new S3OffsiteUploadAdapter(configFor());
    await expect(
      adapter.computeUploadedChecksum({ backupId: 'rec-1', checksum: 'abc123checksum' }),
    ).rejects.toThrow(/контрольной суммы/i);
  });

  it('бросает «не сконфигурировано» при неполной конфигурации (мягкая деградация, Req 21.5)', async () => {
    const adapter = new S3OffsiteUploadAdapter(configFor({ accessKeyId: '' }));

    await expect(adapter.upload(dump)).rejects.toThrow(/не сконфигурировано/i);
    expect(send).not.toHaveBeenCalled();
  });
});
