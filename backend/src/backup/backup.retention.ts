import { Injectable, Logger } from '@nestjs/common';
import { MSK_OFFSET_MS } from '../clock/clock.constants';
import { BackupRecordRepository } from './backup-record.repository';

/**
 * GFS-политика хранения резервных копий (Req 21.3).
 *
 * Логика отбора копий реализована в самостоятельном файле (а не в
 * {@link import('./backup.service').BackupService}), чтобы задача 18.3 не
 * пересекалась с проверкой целостности (`verifyIntegrity`, задача 18.5),
 * редактирующей сервис. Ядро политики — чистая функция
 * {@link selectGfsRetention}, удобная для модульного и property-тестирования
 * (Property 59); применение к журналу копий выполняет
 * {@link BackupRetentionService.applyRetention}.
 */

/** Квоты GFS-политики хранения: число удерживаемых копий в каждой категории. */
export interface GfsRetentionPolicy {
  /** Максимум ежедневных копий (самые свежие по дням MSK). */
  daily: number;
  /** Максимум еженедельных копий (самые свежие по неделям ISO в MSK). */
  weekly: number;
  /** Максимум ежемесячных копий (самые свежие по месяцам MSK). */
  monthly: number;
}

/** Квоты GFS по умолчанию (Req 21.3): 7 ежедневных, 4 еженедельных, 6 ежемесячных. */
export const GFS_RETENTION_POLICY: GfsRetentionPolicy = {
  daily: 7,
  weekly: 4,
  monthly: 6,
};

/** Кандидат на хранение: резервная копия с идентификатором и моментом создания. */
export interface RetentionCandidate {
  /** Идентификатор записи журнала резервной копии. */
  id: string;
  /** Момент создания копии (абсолютный, UTC). */
  timestamp: Date;
}

/** Результат отбора: идентификаторы удерживаемых и удаляемых копий. */
export interface RetentionDecision {
  /** Идентификаторы копий, удерживаемых хотя бы одной квотой (Req 21.3). */
  retainedIds: string[];
  /** Идентификаторы копий, выходящих за пределы всех квот, — подлежат удалению. */
  deletedIds: string[];
}

/** Календарные поля момента времени в часовом поясе MSK (UTC+3). */
interface MskDateParts {
  year: number;
  month: number; // 0..11
  day: number; // 1..31
}

/**
 * Раскладывает абсолютный момент времени на календарные поля MSK.
 *
 * Используется тот же приём, что и в {@link import('../clock').ClockService}:
 * момент сдвигается на смещение MSK, после чего поля читаются как UTC, что даёт
 * настенное время Москвы независимо от пояса процесса (Req 1.2).
 */
function mskParts(date: Date): MskDateParts {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  return {
    year: msk.getUTCFullYear(),
    month: msk.getUTCMonth(),
    day: msk.getUTCDate(),
  };
}

/** Ключ ежедневной категории: календарная дата MSK. */
function dailyKey(date: Date): string {
  const { year, month, day } = mskParts(date);
  return `${year}-${month}-${day}`;
}

/** Ключ ежемесячной категории: календарный месяц MSK. */
function monthlyKey(date: Date): string {
  const { year, month } = mskParts(date);
  return `${year}-${month}`;
}

/**
 * Ключ еженедельной категории: ISO-неделя (год+номер недели) в MSK.
 *
 * Неделя по ISO 8601 начинается с понедельника; номер недели определяется по
 * четвергу этой недели, благодаря чему недели на стыке годов относятся к
 * корректному ISO-году.
 */
function weeklyKey(date: Date): string {
  const { year, month, day } = mskParts(date);
  // Полдень UTC выбранной даты MSK — устойчивая опорная точка для арифметики дней.
  const utc = new Date(Date.UTC(year, month, day));
  const isoDow = (utc.getUTCDay() + 6) % 7; // понедельник = 0 ... воскресенье = 6
  // Сдвигаемся к четвергу текущей ISO-недели.
  utc.setUTCDate(utc.getUTCDate() - isoDow + 3);
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDow + 3);
  const weekNumber =
    1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${weekNumber}`;
}

/**
 * Отбирает копию-представителя для каждой из самых свежих `limit` категорий.
 *
 * Кандидаты передаются упорядоченными от самой свежей к самой старой, поэтому
 * первая встреченная копия в каждой категории — самая свежая в ней (она и
 * удерживается). Открываются не более `limit` различных категорий, что
 * ограничивает квоту; копии в уже занятых и в избыточных категориях не
 * добавляются.
 */
function keepByCategory(
  sortedDesc: RetentionCandidate[],
  keyOf: (date: Date) => string,
  limit: number,
  retained: Set<string>,
): void {
  if (limit <= 0) {
    return;
  }
  const buckets = new Set<string>();
  for (const candidate of sortedDesc) {
    const key = keyOf(candidate.timestamp);
    if (buckets.has(key)) {
      continue; // представитель этой категории уже удержан (более свежий).
    }
    if (buckets.size >= limit) {
      continue; // квота категорий исчерпана — более старые категории отбрасываем.
    }
    buckets.add(key);
    retained.add(candidate.id);
  }
}

/**
 * Применяет GFS-политику хранения к набору резервных копий (Req 21.3).
 *
 * Удерживается не более `daily` ежедневных, `weekly` еженедельных и `monthly`
 * ежемесячных копий — в каждой категории сохраняется самая свежая копия
 * соответствующего периода (дня/недели/месяца MSK). Копия удерживается, если
 * попадает хотя бы в одну квоту; все остальные подлежат удалению.
 *
 * Функция чистая и детерминированная: не обращается к БД и не зависит от
 * порядка входных данных (внутренне сортирует копии по времени).
 *
 * @param candidates Произвольный набор копий-кандидатов.
 * @param policy Квоты GFS (по умолчанию {@link GFS_RETENTION_POLICY}).
 * @returns Разбиение идентификаторов на удерживаемые и удаляемые.
 */
export function selectGfsRetention(
  candidates: readonly RetentionCandidate[],
  policy: GfsRetentionPolicy = GFS_RETENTION_POLICY,
): RetentionDecision {
  const sortedDesc = [...candidates].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const retained = new Set<string>();
  keepByCategory(sortedDesc, dailyKey, policy.daily, retained);
  keepByCategory(sortedDesc, weeklyKey, policy.weekly, retained);
  keepByCategory(sortedDesc, monthlyKey, policy.monthly, retained);

  const retainedIds: string[] = [];
  const deletedIds: string[] = [];
  for (const candidate of sortedDesc) {
    if (retained.has(candidate.id)) {
      retainedIds.push(candidate.id);
    } else {
      deletedIds.push(candidate.id);
    }
  }

  return { retainedIds, deletedIds };
}

/**
 * Применяет GFS-политику хранения к журналу резервных копий (Req 21.3).
 *
 * Вынесен в отдельный сервис, чтобы изолировать логику хранения от
 * {@link import('./backup.service').BackupService} (задачи 18.1/18.5). Отбор
 * копий выполняет чистая функция {@link selectGfsRetention}; здесь же
 * происходит обращение к репозиторию: чтение действительных (успешных) копий и
 * удаление вышедших за квоты.
 */
@Injectable()
export class BackupRetentionService {
  private readonly logger = new Logger(BackupRetentionService.name);

  constructor(private readonly records: BackupRecordRepository) {}

  /**
   * Удаляет резервные копии, выходящие за пределы квот GFS (Req 21.3).
   *
   * Политика распространяется только на действительные копии (результат
   * `SUCCESS`): пропуски, сбои и копии, не прошедшие проверку целостности, в
   * расчёте квот не участвуют. Самая свежая успешная копия всегда попадает в
   * ежедневную квоту и потому сохраняется, что согласуется с сохранностью
   * последней успешной копии (Req 21.5).
   */
  async applyRetention(): Promise<void> {
    const copies = await this.records.findAllSuccessful();
    const decision = selectGfsRetention(
      copies.map((record) => ({ id: record.id, timestamp: record.startedAt })),
    );

    if (decision.deletedIds.length === 0) {
      return;
    }

    const deleted = await this.records.deleteByIds(decision.deletedIds);
    this.logger.log(
      `GFS-политика хранения: удалено ${deleted} резервных копий за пределами квот, ` +
        `оставлено ${decision.retainedIds.length}`,
    );
  }
}
