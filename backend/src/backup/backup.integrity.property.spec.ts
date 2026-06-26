import fc from 'fast-check';
import { BackupRecord, BackupResult } from '@prisma/client';
import { ClockService } from '../clock';
import { BackupRecordRepository } from './backup-record.repository';
import { BackupService } from './backup.service';
import { OffsiteUploadPort, ResticBackupPort, UploadedBackupReference } from './backup.types';

/**
 * **Feature: task-assignment-system, Property 60: Целостность резервной копии по контрольной сумме**
 *
 * Property 60 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 21.6, 21.7**:
 *
 * Для любой резервной копии контрольная сумма, вычисленная после выгрузки в S3,
 * сверяется с суммой до выгрузки; при совпадении копия считается действительной,
 * при несоответствии — помечается недействительной с регистрацией события.
 *
 * Тест прогоняет {@link BackupService.verifyIntegrity} на произвольных парах
 * (сумма до выгрузки, сумма после выгрузки) и проверяет инвариант:
 *   - копия признаётся действительной (`true`) тогда и только тогда, когда
 *     пересчитанная после выгрузки сумма совпадает с суммой до выгрузки
 *     (Req 21.6);
 *   - при несоответствии копия помечается недействительной ровно один раз
 *     (`INTEGRITY_ERROR`) с причиной, указывающей на нарушение целостности и
 *     обе суммы, и метод возвращает `false` (Req 21.7); при совпадении пометка
 *     не выполняется;
 *   - проверка всегда сверяет фактическую сумму выгруженной копии именно с
 *     суммой, зафиксированной до выгрузки (полем `checksum` записи).
 *
 * Внешние границы абстрагированы согласно стратегии тестирования дизайна:
 * репозиторий журнала и S3-порт (`OffsiteUploadPort`) заменены управляемыми
 * заглушками в памяти; ни диск, ни сеть, ни БД не используются.
 *
 * Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
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

interface BuiltService {
  service: BackupService;
  markedCalls: Array<{ id: string; reason: string }>;
  computeRefs: UploadedBackupReference[];
}

/**
 * Собирает {@link BackupService} с заглушками репозитория и S3-порта,
 * управляемыми параметрами теста (без диска/сети/БД).
 */
function buildService(params: { record: BackupRecord; uploadedChecksum: string }): BuiltService {
  const markedCalls: Array<{ id: string; reason: string }> = [];
  const computeRefs: UploadedBackupReference[] = [];

  const records = {
    findById: async () => params.record,
    markIntegrityError: async (id: string, reason: string) => {
      markedCalls.push({ id, reason });
      return makeRecord({ id, result: BackupResult.INTEGRITY_ERROR, reason });
    },
  } as unknown as BackupRecordRepository;

  const offsite = {
    upload: async () => undefined,
    computeUploadedChecksum: async (ref: UploadedBackupReference) => {
      computeRefs.push(ref);
      return params.uploadedChecksum;
    },
  } as unknown as OffsiteUploadPort;

  const restic = { createDump: async () => makeRecord() } as unknown as ResticBackupPort;
  const clock = new ClockService({ now: () => FIXED_NOW });

  return {
    service: new BackupService(clock, records, restic, offsite),
    markedCalls,
    computeRefs,
  };
}

/** Непустая контрольная сумма (имитация sha256-дайджеста или иной суммы). */
const checksumArb = fc.string({ minLength: 1, maxLength: 64 }).map((s) => `sha256:${s}`);

const backupIdArb = fc.string({ minLength: 1, maxLength: 24 });

describe('Property 60: Целостность резервной копии по контрольной сумме (Req 21.6, 21.7)', () => {
  it('копия действительна тогда и только тогда, когда суммы совпадают; иначе помечается недействительной', async () => {
    await fc.assert(
      fc.asyncProperty(
        backupIdArb,
        checksumArb,
        // Управляем долей совпадений/расхождений, чтобы покрыть обе ветви:
        // при mutate=true сумма после выгрузки отличается от суммы до выгрузки.
        fc.boolean(),
        checksumArb,
        async (backupId, expectedChecksum, mutate, otherChecksum) => {
          const uploadedChecksum =
            mutate && otherChecksum !== expectedChecksum
              ? otherChecksum
              : mutate
                ? `${expectedChecksum}!` // гарантируем отличие
                : expectedChecksum;

          const record = makeRecord({ id: backupId, checksum: expectedChecksum });
          const { service, markedCalls, computeRefs } = buildService({
            record,
            uploadedChecksum,
          });

          const valid = await service.verifyIntegrity(backupId);
          const sumsMatch = uploadedChecksum === expectedChecksum;

          // Действительность копии эквивалентна совпадению контрольных сумм (Req 21.6).
          expect(valid).toBe(sumsMatch);

          // Сверка всегда выполняется против суммы, зафиксированной до выгрузки.
          expect(computeRefs).toEqual([{ backupId, checksum: expectedChecksum }]);

          if (sumsMatch) {
            // Совпадение — копия действительна, пометка недействительности не ставится.
            expect(markedCalls).toHaveLength(0);
          } else {
            // Несоответствие — копия помечается недействительной ровно один раз
            // с причиной, указывающей на нарушение целостности и обе суммы (Req 21.7).
            expect(markedCalls).toHaveLength(1);
            expect(markedCalls[0]?.id).toBe(backupId);
            expect(markedCalls[0]?.reason).toContain('целостност');
            expect(markedCalls[0]?.reason).toContain(expectedChecksum);
            expect(markedCalls[0]?.reason).toContain(uploadedChecksum);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
