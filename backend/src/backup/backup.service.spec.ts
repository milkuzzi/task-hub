import { BackupRecord, BackupResult } from '@prisma/client';
import { ClockService } from '../clock';
import { EntityNotFoundException } from '../common/errors';
import { BackupRecordRepository } from './backup-record.repository';
import { BackupService } from './backup.service';
import { OffsiteUploadPort, ResticBackupPort } from './backup.types';

/**
 * Модульные тесты {@link BackupService.verifyIntegrity} (Req 21.6, 21.7).
 *
 * Проверяется: при совпадении контрольной суммы, пересчитанной после выгрузки в
 * S3, с суммой до выгрузки копия признаётся действительной (Req 21.6); при
 * несоответствии копия помечается недействительной (`INTEGRITY_ERROR`) с
 * регистрацией события и причиной, указывающей на нарушение целостности
 * (Req 21.7); отсутствующая запись или запись без контрольной суммы
 * отклоняются.
 */

const FIXED_NOW = new Date('2030-05-01T00:00:00Z');

function makeRecord(overrides: Partial<BackupRecord> = {}): BackupRecord {
  return {
    id: 'b1',
    startedAt: new Date('2030-04-30T00:00:00Z'),
    finishedAt: new Date('2030-04-30T00:10:00Z'),
    result: BackupResult.SUCCESS,
    checksum: 'sha256:abc',
    reason: null,
    ...overrides,
  } as unknown as BackupRecord;
}

interface Fixture {
  record?: BackupRecord | null;
  uploadedChecksum?: string;
  uploadedChecksumError?: Error;
}

function buildService(fixture: Fixture = {}) {
  const marked: Array<{ id: string; reason: string }> = [];

  const findById = jest.fn(async () =>
    fixture.record === undefined ? makeRecord() : fixture.record,
  );
  const markIntegrityError = jest.fn(async (id: string, reason: string) => {
    marked.push({ id, reason });
    return makeRecord({ id, result: BackupResult.INTEGRITY_ERROR, reason });
  });
  const records = { findById, markIntegrityError } as unknown as BackupRecordRepository;

  const computeUploadedChecksum = jest.fn(async () => {
    if (fixture.uploadedChecksumError !== undefined) {
      throw fixture.uploadedChecksumError;
    }
    return fixture.uploadedChecksum ?? 'sha256:abc';
  });
  const offsite = {
    upload: jest.fn(),
    computeUploadedChecksum,
  } as unknown as OffsiteUploadPort;

  const restic = { createDump: jest.fn() } as unknown as ResticBackupPort;
  const clock = new ClockService({ now: () => FIXED_NOW });

  const service = new BackupService(clock, records, restic, offsite);
  return { service, findById, markIntegrityError, computeUploadedChecksum, marked };
}

describe('BackupService.verifyIntegrity (Req 21.6, 21.7)', () => {
  it('признаёт копию действительной при совпадении контрольных сумм (Req 21.6)', async () => {
    const { service, markIntegrityError } = buildService({
      record: makeRecord({ checksum: 'sha256:abc' }),
      uploadedChecksum: 'sha256:abc',
    });

    await expect(service.verifyIntegrity('b1')).resolves.toBe(true);
    expect(markIntegrityError).not.toHaveBeenCalled();
  });

  it('помечает копию недействительной с причиной при несоответствии суммы (Req 21.7)', async () => {
    const { service, markIntegrityError, marked } = buildService({
      record: makeRecord({ id: 'b1', checksum: 'sha256:abc' }),
      uploadedChecksum: 'sha256:DIFFERENT',
    });

    await expect(service.verifyIntegrity('b1')).resolves.toBe(false);
    expect(markIntegrityError).toHaveBeenCalledTimes(1);
    expect(marked[0]?.id).toBe('b1');
    expect(marked[0]?.reason).toContain('целостност');
    expect(marked[0]?.reason).toContain('sha256:DIFFERENT');
    expect(marked[0]?.reason).toContain('sha256:abc');
  });

  it('сверяет фактическую сумму выгруженной копии с суммой до выгрузки', async () => {
    const { service, computeUploadedChecksum } = buildService({
      record: makeRecord({ id: 'b1', checksum: 'sha256:abc' }),
      uploadedChecksum: 'sha256:abc',
    });

    await service.verifyIntegrity('b1');

    expect(computeUploadedChecksum).toHaveBeenCalledWith({
      backupId: 'b1',
      checksum: 'sha256:abc',
    });
  });

  it('сообщает о несуществующей записи резервной копии', async () => {
    const { service } = buildService({ record: null });

    await expect(service.verifyIntegrity('missing')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('отклоняет запись без контрольной суммы', async () => {
    const { service, computeUploadedChecksum } = buildService({
      record: makeRecord({ checksum: null }),
    });

    await expect(service.verifyIntegrity('b1')).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(computeUploadedChecksum).not.toHaveBeenCalled();
  });

  it('пробрасывает ошибку, если копию нельзя прочитать из хранилища', async () => {
    const { service } = buildService({
      record: makeRecord({ checksum: 'sha256:abc' }),
      uploadedChecksumError: new Error('S3 недоступно'),
    });

    await expect(service.verifyIntegrity('b1')).rejects.toThrow('S3 недоступно');
  });
});
