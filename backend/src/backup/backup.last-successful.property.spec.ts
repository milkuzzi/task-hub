import fc from 'fast-check';
import { BackupRecord, BackupResult } from '@prisma/client';
import { ClockService } from '../clock';
import { BackupService } from './backup.service';
import { CreateBackupRecordInput } from './backup-record.repository';
import { BACKUP_MAX_DURATION_MS } from './backup.constants';
import { DatabaseDumpResult, OffsiteUploadPort, ResticBackupPort } from './backup.types';

/**
 * Property-тест сохранности последней успешной копии при сбое/пропуске (задача 18.2).
 *
 * **Feature: task-assignment-system, Property 61: Сохранность последней успешной копии
 * при сбое или пропуске** — для любого запуска резервного копирования, завершившегося
 * сбоем дампа/выгрузки или пропущенного из-за превышения лимита 60 минут, последняя
 * успешная резервная копия остаётся без изменений, а событие сбоя/пропуска регистрируется
 * с указанием причины.
 *
 * **Validates: Requirements 21.5, 21.8**
 *
 * Внешние границы (restic, S3) подменяются управляемыми заглушками портов
 * {@link ResticBackupPort}/{@link OffsiteUploadPort}; журнал {@link BackupRecord}
 * заменён детерминированной in-memory-реализацией репозитория; источник времени
 * инъецируется через подменённый {@link ClockService} (см. Testing Strategy дизайна).
 */

/** Снимок успешной записи журнала для сравнения «до/после» (защита от мутаций). */
function snapshot(record: BackupRecord): Record<string, unknown> {
  return {
    id: record.id,
    startedAt: record.startedAt.getTime(),
    finishedAt: record.finishedAt === null ? null : record.finishedAt.getTime(),
    result: record.result,
    checksum: record.checksum,
    reason: record.reason,
  };
}

/**
 * Детерминированный in-memory-репозиторий журнала резервных копий: записи только
 * добавляются (append-only), как в реальном {@link BackupRecordRepository}. Сервису
 * {@link BackupService.runDailyBackup} достаточно метода `create`; остальное —
 * для проверок теста.
 */
class InMemoryBackupRecordRepository {
  private readonly store: BackupRecord[] = [];
  private counter = 0;

  /** Засевает заранее существующую успешную копию (имитация прошлых запусков). */
  seedSuccess(startedAt: Date, checksum: string): BackupRecord {
    const record: BackupRecord = {
      id: `seed-${this.counter++}`,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1000),
      result: BackupResult.SUCCESS,
      checksum,
      reason: null,
    };
    this.store.push(record);
    return record;
  }

  async create(input: CreateBackupRecordInput): Promise<BackupRecord> {
    const record: BackupRecord = {
      id: `rec-${this.counter++}`,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      result: input.result,
      checksum: input.checksum ?? null,
      reason: input.reason ?? null,
    };
    this.store.push(record);
    return record;
  }

  async findLastSuccessful(): Promise<BackupRecord | null> {
    const successes = this.successfulDesc();
    return successes[0] ?? null;
  }

  async findAllSuccessful(): Promise<BackupRecord[]> {
    return this.successfulDesc();
  }

  /** Все записи (для проверки append-only-роста журнала). */
  all(): BackupRecord[] {
    return [...this.store];
  }

  private successfulDesc(): BackupRecord[] {
    return this.store
      .filter((r) => r.result === BackupResult.SUCCESS)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
}

/** Подменённый источник времени с фиксированным моментом (детерминизм). */
function fixedClock(): ClockService {
  return { now: () => new Date('2030-06-01T03:00:00Z') } as unknown as ClockService;
}

type FailureMode = 'dumpFail' | 'uploadFail' | 'timeout';

/** Сценарий запуска: засеянные успешные копии и режим неуспеха текущего запуска. */
interface Scenario {
  seeds: Array<{ offsetMs: number; checksum: string }>;
  mode: FailureMode;
  /** Сообщение об ошибке для сбоя дампа/выгрузки (непустое — у реального сбоя есть причина). */
  errorMessage: string;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  seeds: fc.array(
    fc.record({
      offsetMs: fc.integer({ min: 0, max: 30 * 24 * 60 * 60 * 1000 }),
      checksum: fc.hexaString({ minLength: 8, maxLength: 32 }),
    }),
    { maxLength: 5 },
  ),
  mode: fc.constantFrom<FailureMode>('dumpFail', 'uploadFail', 'timeout'),
  errorMessage: fc.string({ minLength: 1, maxLength: 64 }),
});

/**
 * Собирает ResticBackupPort/OffsiteUploadPort под заданный режим неуспеха.
 * - dumpFail: создание дампа завершается ошибкой (Req 21.5).
 * - uploadFail: дамп создан, выгрузка в S3 завершается ошибкой (Req 21.5).
 * - timeout: создание дампа «зависает» дольше лимита — срабатывает прерывание по
 *   тайм-ауту 60 минут (Req 21.8).
 */
function makePorts(
  mode: FailureMode,
  errorMessage: string,
): {
  restic: ResticBackupPort;
  offsite: OffsiteUploadPort;
} {
  const dump: DatabaseDumpResult = { checksum: 'fresh-checksum' };

  const restic: ResticBackupPort = {
    createDump: (): Promise<DatabaseDumpResult> => {
      if (mode === 'dumpFail') {
        return Promise.reject(new Error(errorMessage));
      }
      if (mode === 'timeout') {
        // Никогда не разрешается: завершение наступает только по тайм-ауту.
        return new Promise<DatabaseDumpResult>(() => {});
      }
      return Promise.resolve(dump);
    },
  };

  const offsite: OffsiteUploadPort = {
    upload: (): Promise<void> => {
      if (mode === 'uploadFail') {
        return Promise.reject(new Error(errorMessage));
      }
      return Promise.resolve();
    },
    computeUploadedChecksum: (): Promise<string> => Promise.resolve(dump.checksum),
  };

  return { restic, offsite };
}

describe('BackupService.runDailyBackup — сохранность последней успешной копии (Property 61)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('сохраняет последнюю успешную копию без изменений и регистрирует сбой/пропуск с причиной', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const repo = new InMemoryBackupRecordRepository();

        // Засеваем ранее существующие успешные копии (прошлые запуски).
        const base = new Date('2030-05-01T03:00:00Z').getTime();
        for (const seed of scenario.seeds) {
          repo.seedSuccess(new Date(base + seed.offsetMs), seed.checksum);
        }

        // Снимок состояния успешных копий ДО запуска.
        const successBefore = (await repo.findAllSuccessful()).map(snapshot);
        const lastSuccessfulBefore = await repo.findLastSuccessful();
        const totalBefore = repo.all().length;

        const { restic, offsite } = makePorts(scenario.mode, scenario.errorMessage);
        const service = new BackupService(fixedClock(), repo as never, restic, offsite);

        // Запуск с гарантированным неуспехом: сбой дампа/выгрузки либо пропуск по тайм-ауту.
        const runPromise = service.runDailyBackup();
        if (scenario.mode === 'timeout') {
          await jest.advanceTimersByTimeAsync(BACKUP_MAX_DURATION_MS);
        }
        const result = await runPromise;

        // (1) Запуск зарегистрирован как сбой (Req 21.5) или пропуск (Req 21.8).
        const expectedResult =
          scenario.mode === 'timeout' ? BackupResult.SKIPPED : BackupResult.FAILED;
        expect(result.result).toBe(expectedResult);

        // (2) Событие зарегистрировано с указанием непустой причины.
        expect(typeof result.reason).toBe('string');
        expect((result.reason ?? '').length).toBeGreaterThan(0);

        // (3) Неуспешный запуск не порождает новой успешной копии — append-only,
        //     добавлена ровно одна запись с результатом сбоя/пропуска.
        expect(repo.all().length).toBe(totalBefore + 1);
        const appended = repo.all().find((r) => r.id === result.recordId);
        expect(appended).toBeDefined();
        expect(appended?.result).toBe(expectedResult);
        expect(appended?.reason).toBe(result.reason ?? null);
        // Новая запись неуспеха не содержит контрольной суммы успешной копии.
        expect(appended?.checksum).toBeNull();

        // (4) Множество успешных копий и последняя успешная копия — без изменений.
        const successAfter = (await repo.findAllSuccessful()).map(snapshot);
        expect(successAfter).toEqual(successBefore);

        const lastSuccessfulAfter = await repo.findLastSuccessful();
        if (lastSuccessfulBefore === null) {
          expect(lastSuccessfulAfter).toBeNull();
        } else {
          expect(lastSuccessfulAfter).not.toBeNull();
          expect(snapshot(lastSuccessfulAfter as BackupRecord)).toEqual(
            snapshot(lastSuccessfulBefore),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
