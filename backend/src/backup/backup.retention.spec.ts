import { BackupRecord, BackupResult } from '@prisma/client';
import { BackupRecordRepository } from './backup-record.repository';
import {
  BackupRetentionService,
  GFS_RETENTION_POLICY,
  GfsRetentionPolicy,
  RetentionCandidate,
  selectGfsRetention,
} from './backup.retention';

/**
 * Модульные тесты GFS-политики хранения резервных копий (Req 21.3).
 *
 * Проверяется чистая функция отбора {@link selectGfsRetention} (изоляция по
 * категориям, выбор самой свежей копии в категории, соблюдение квот,
 * независимость от порядка входа, разбиение по MSK) и применение политики
 * сервисом {@link BackupRetentionService} к журналу успешных копий.
 */

/** Идентификатор по индексу — стабилен и читаем в проверках. */
function id(n: number): string {
  return `backup-${n}`;
}

/** Кандидат с заданным моментом (UTC). */
function at(idValue: string, iso: string): RetentionCandidate {
  return { id: idValue, timestamp: new Date(iso) };
}

describe('selectGfsRetention (Req 21.3)', () => {
  it('возвращает пустое разбиение для пустого набора', () => {
    const decision = selectGfsRetention([]);
    expect(decision.retainedIds).toEqual([]);
    expect(decision.deletedIds).toEqual([]);
  });

  it('удерживает все копии, если их меньше суточной квоты', () => {
    // Три копии в три последовательных дня MSK — все попадают в ежедневную квоту.
    const candidates = [
      at(id(1), '2030-03-04T09:00:00Z'),
      at(id(2), '2030-03-05T09:00:00Z'),
      at(id(3), '2030-03-06T09:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates);
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(1), id(2), id(3)]));
    expect(decision.deletedIds).toEqual([]);
  });

  it('по ежедневной квоте удерживает самые свежие дни (изоляция категории)', () => {
    const policy: GfsRetentionPolicy = { daily: 3, weekly: 0, monthly: 0 };
    // Пять последовательных дней, одна копия в день.
    const candidates = [
      at(id(1), '2030-03-01T09:00:00Z'),
      at(id(2), '2030-03-02T09:00:00Z'),
      at(id(3), '2030-03-03T09:00:00Z'),
      at(id(4), '2030-03-04T09:00:00Z'),
      at(id(5), '2030-03-05T09:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates, policy);
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(3), id(4), id(5)]));
    expect(new Set(decision.deletedIds)).toEqual(new Set([id(1), id(2)]));
  });

  it('в пределах одного дня удерживает самую свежую копию', () => {
    const policy: GfsRetentionPolicy = { daily: 1, weekly: 0, monthly: 0 };
    const candidates = [
      at(id(1), '2030-03-04T06:00:00Z'),
      at(id(2), '2030-03-04T12:00:00Z'),
      at(id(3), '2030-03-04T18:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates, policy);
    expect(decision.retainedIds).toEqual([id(3)]);
    expect(new Set(decision.deletedIds)).toEqual(new Set([id(1), id(2)]));
  });

  it('по еженедельной квоте удерживает самые свежие недели', () => {
    const policy: GfsRetentionPolicy = { daily: 0, weekly: 2, monthly: 0 };
    // Одна копия в неделю на протяжении четырёх недель (шаг 7 дней).
    const candidates = [
      at(id(1), '2030-03-04T09:00:00Z'),
      at(id(2), '2030-03-11T09:00:00Z'),
      at(id(3), '2030-03-18T09:00:00Z'),
      at(id(4), '2030-03-25T09:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates, policy);
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(3), id(4)]));
    expect(new Set(decision.deletedIds)).toEqual(new Set([id(1), id(2)]));
  });

  it('по ежемесячной квоте удерживает самые свежие месяцы', () => {
    const policy: GfsRetentionPolicy = { daily: 0, weekly: 0, monthly: 2 };
    // По одной копии в четыре разных месяца.
    const candidates = [
      at(id(1), '2030-01-15T09:00:00Z'),
      at(id(2), '2030-02-15T09:00:00Z'),
      at(id(3), '2030-03-15T09:00:00Z'),
      at(id(4), '2030-04-15T09:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates, policy);
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(3), id(4)]));
    expect(new Set(decision.deletedIds)).toEqual(new Set([id(1), id(2)]));
  });

  it('разбивает копии по календарю MSK, а не UTC', () => {
    const policy: GfsRetentionPolicy = { daily: 2, weekly: 0, monthly: 0 };
    // Обе копии приходятся на один день UTC (4 марта), но на разные дни MSK:
    // 20:30Z = 23:30 MSK 4 марта; 21:30Z = 00:30 MSK 5 марта.
    const candidates = [at(id(1), '2030-03-04T20:30:00Z'), at(id(2), '2030-03-04T21:30:00Z')];
    const decision = selectGfsRetention(candidates, policy);
    // Две различные суточные категории MSK → удерживаются обе.
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(1), id(2)]));
    expect(decision.deletedIds).toEqual([]);
  });

  it('удерживает копию, если её удерживает хотя бы одна квота (объединение)', () => {
    const policy: GfsRetentionPolicy = { daily: 1, weekly: 2, monthly: 3 };
    // Три копии, каждую удерживает своя квота:
    //  - id3 (18.03) — ежедневная (самая свежая) и представитель свежей недели/месяца;
    //  - id2 (11.03) — представитель предыдущей недели (еженедельная квота);
    //  - id1 (18.02) — представитель предыдущего месяца (ежемесячная квота).
    const candidates = [
      at(id(1), '2030-02-18T09:00:00Z'),
      at(id(2), '2030-03-11T09:00:00Z'),
      at(id(3), '2030-03-18T09:00:00Z'),
    ];
    const decision = selectGfsRetention(candidates, policy);
    expect(new Set(decision.retainedIds)).toEqual(new Set([id(1), id(2), id(3)]));
    expect(decision.deletedIds).toEqual([]);
  });

  it('соблюдает все квоты по умолчанию (7/4/6) и не превышает их', () => {
    // 60 ежедневных копий подряд.
    const candidates: RetentionCandidate[] = [];
    const start = Date.UTC(2030, 0, 1, 9, 0, 0);
    for (let i = 0; i < 60; i += 1) {
      candidates.push({
        id: id(i),
        timestamp: new Date(start + i * 24 * 60 * 60 * 1000),
      });
    }
    const decision = selectGfsRetention(candidates);
    // Каждая категория не превышает свою квоту; объединение не больше суммы квот.
    const maxUnion =
      GFS_RETENTION_POLICY.daily + GFS_RETENTION_POLICY.weekly + GFS_RETENTION_POLICY.monthly;
    expect(decision.retainedIds.length).toBeLessThanOrEqual(maxUnion);
    expect(decision.retainedIds.length).toBeGreaterThanOrEqual(GFS_RETENTION_POLICY.daily);
    // Все копии распределены ровно между удержанными и удалёнными.
    expect(decision.retainedIds.length + decision.deletedIds.length).toBe(candidates.length);
    // Самая свежая копия всегда сохраняется (ежедневная квота).
    expect(decision.retainedIds).toContain(id(59));
    // Самая старая копия выходит за все квоты и удаляется.
    expect(decision.deletedIds).toContain(id(0));
  });

  it('не зависит от порядка входных данных', () => {
    const policy: GfsRetentionPolicy = { daily: 2, weekly: 0, monthly: 0 };
    const ordered = [
      at(id(1), '2030-03-01T09:00:00Z'),
      at(id(2), '2030-03-02T09:00:00Z'),
      at(id(3), '2030-03-03T09:00:00Z'),
      at(id(4), '2030-03-04T09:00:00Z'),
      at(id(5), '2030-03-05T09:00:00Z'),
    ];
    const shuffled = [
      at(id(4), '2030-03-04T09:00:00Z'),
      at(id(1), '2030-03-01T09:00:00Z'),
      at(id(5), '2030-03-05T09:00:00Z'),
      at(id(3), '2030-03-03T09:00:00Z'),
      at(id(2), '2030-03-02T09:00:00Z'),
    ];

    const a = selectGfsRetention(ordered, policy);
    const b = selectGfsRetention(shuffled, policy);
    expect(new Set(a.retainedIds)).toEqual(new Set(b.retainedIds));
    expect(new Set(a.deletedIds)).toEqual(new Set(b.deletedIds));
  });
});

describe('BackupRetentionService.applyRetention (Req 21.3)', () => {
  function makeRecord(idValue: string, iso: string): BackupRecord {
    return {
      id: idValue,
      startedAt: new Date(iso),
      finishedAt: new Date(iso),
      result: BackupResult.SUCCESS,
      checksum: 'sum',
      reason: null,
    } as unknown as BackupRecord;
  }

  function makeService(records: BackupRecord[]): {
    service: BackupRetentionService;
    deleteByIds: jest.Mock;
  } {
    const deleteByIds = jest.fn(async (ids: string[]) => ids.length);
    const repo = {
      findAllSuccessful: jest.fn(async () => records),
      deleteByIds,
    } as unknown as BackupRecordRepository;
    return { service: new BackupRetentionService(repo), deleteByIds };
  }

  it('удаляет только копии за пределами квот', async () => {
    // Пять последовательных дней при квоте по умолчанию 7 — удалять нечего.
    const records = [
      makeRecord(id(1), '2030-03-01T09:00:00Z'),
      makeRecord(id(2), '2030-03-02T09:00:00Z'),
      makeRecord(id(3), '2030-03-03T09:00:00Z'),
    ];
    const { service, deleteByIds } = makeService(records);
    await service.applyRetention();
    expect(deleteByIds).not.toHaveBeenCalled();
  });

  it('удаляет копии, вышедшие за суточную квоту', async () => {
    // 10 последовательных дней одного месяца: ежедневная квота 7 удержит 7
    // самых свежих дней; еженедельная/ежемесячная квоты удержат представителей,
    // совпадающих с уже удержанными свежими копиями, поэтому удаляются старейшие.
    const records: BackupRecord[] = [];
    const start = Date.UTC(2030, 5, 1, 9, 0, 0);
    for (let i = 0; i < 10; i += 1) {
      records.push(makeRecord(id(i), new Date(start + i * 24 * 60 * 60 * 1000).toISOString()));
    }
    const { service, deleteByIds } = makeService(records);
    await service.applyRetention();
    expect(deleteByIds).toHaveBeenCalledTimes(1);
    const deleted: string[] = deleteByIds.mock.calls[0][0];
    // Самая свежая копия не удаляется, а самая старая — удаляется.
    expect(deleted).not.toContain(id(9));
    expect(deleted).toContain(id(0));
  });
});
