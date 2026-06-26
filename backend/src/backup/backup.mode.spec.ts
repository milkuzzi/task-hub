import { BackupRecord, BackupResult } from '@prisma/client';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { QueueService } from '../infra';
import { BackupRecordRepository } from './backup-record.repository';
import { BackupService } from './backup.service';
import { BackupWorker } from './backup.worker';
import { BACKUP_MAX_DURATION_MS } from './backup.constants';
import { OffsiteUploadPort, ResticBackupPort } from './backup.types';

const NOW = new Date('2030-01-01T00:00:00.000Z');

function config(mode: 'disabled' | 'required'): AppConfigService {
  return {
    backup: { mode },
    redis: { host: 'localhost', port: 6379, db: 0 },
  } as unknown as AppConfigService;
}

function buildService(
  mode: 'disabled' | 'required',
  restic: ResticBackupPort = {
    createDump: async () => ({ checksum: 'checksum' }),
  },
) {
  const create = jest.fn(async (input) => ({ id: 'record-1', ...input }) as BackupRecord);
  const records = { create } as unknown as BackupRecordRepository;
  const offsite = {
    upload: jest.fn(async () => undefined),
    computeUploadedChecksum: jest.fn(async () => 'checksum'),
  } as unknown as OffsiteUploadPort;
  const service = new BackupService(
    new ClockService({ now: () => NOW }),
    records,
    restic,
    offsite,
    config(mode),
  );
  return { service, create, offsite };
}

describe('backup mode', () => {
  it('records an intentionally disabled run as skipped without invoking adapters', async () => {
    const restic = { createDump: jest.fn() } as unknown as ResticBackupPort;
    const { service, create, offsite } = buildService('disabled', restic);

    const result = await service.runDailyBackup();

    expect(result.result).toBe(BackupResult.SKIPPED);
    expect(result.reason).toContain('BACKUP_MODE=disabled');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ result: BackupResult.SKIPPED }));
    expect(restic.createDump).not.toHaveBeenCalled();
    expect(offsite.upload).not.toHaveBeenCalled();
  });

  it('records required but misconfigured backup as failed', async () => {
    const restic = {
      createDump: jest.fn(async () => {
        throw new Error('restic не сконфигурирован');
      }),
    } as unknown as ResticBackupPort;
    const { service, create } = buildService('required', restic);

    const result = await service.runDailyBackup();

    expect(result.result).toBe(BackupResult.FAILED);
    expect(result.reason).toContain('не сконфигурирован');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ result: BackupResult.FAILED }));
  });

  it('records a backup timeout as skipped', async () => {
    jest.useFakeTimers();
    const restic = {
      createDump: jest.fn(() => new Promise(() => undefined)),
    } as unknown as ResticBackupPort;
    const { service, create } = buildService('required', restic);

    try {
      const resultPromise = service.runDailyBackup();
      await jest.advanceTimersByTimeAsync(BACKUP_MAX_DURATION_MS);
      const result = await resultPromise;

      expect(result.result).toBe(BackupResult.SKIPPED);
      expect(result.reason).toContain('превысило бы');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ result: BackupResult.SKIPPED }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not register a queue or worker when backups are disabled', async () => {
    const queue = { add: jest.fn() } as unknown as QueueService;
    const service = { runDailyBackup: jest.fn() } as unknown as BackupService;
    const worker = new BackupWorker(config('disabled'), queue, service);

    await worker.onModuleInit();

    expect(queue.add).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });
});
