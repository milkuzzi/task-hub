import fc from 'fast-check';
import {
  GFS_RETENTION_POLICY,
  GfsRetentionPolicy,
  RetentionCandidate,
  selectGfsRetention,
} from './backup.retention';

/**
 * **Feature: task-assignment-system, Property 59: Для любого набора резервных копий после применения политики хранения остаётся не более 7 ежедневных, 4 еженедельных и 6 ежемесячных копий, и сохраняются именно те копии, которые соответствуют каждой квоте (самые свежие в своей категории); копии за пределами квот удаляются.**
 *
 * Property 59 (см. design.md «Correctness Properties») — **Validates: Requirements 21.3**.
 *
 * Тест прогоняет чистую функцию отбора {@link selectGfsRetention} на произвольных
 * наборах копий и проверяет её против НЕЗАВИСИМОГО оракула, выраженного в духе
 * спецификации: для каждой категории (день/неделя/месяц MSK) копии группируются
 * по календарному ведру, представителем ведра выбирается самая свежая копия, и
 * удерживаются представители `limit` самых свежих вёдер. Удерживаемое множество —
 * объединение по трём категориям; остальные копии удаляются.
 *
 * Формулировка оракула (группировка-затем-выбор) намеренно отличается от
 * реализации (однопроходный обход по убыванию времени), поэтому совпадение
 * результатов содержательно подтверждает свойство, а не дублирует алгоритм.
 *
 * Свойство проверяется при политике GFS по умолчанию (7/4/6, Req 21.3) и при
 * случайных малых квотах (для интенсивного прохождения границ вытеснения). Без
 * БД и внешних зависимостей; реализует ровно ОДНО свойство; ≥100 итераций
 * fast-check (здесь — 300).
 */

// Смещение MSK (UTC+3) — то же настенное время Москвы, что и в реализации.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

interface MskParts {
  year: number;
  month: number; // 0..11
  day: number; // 1..31
}

/** Календарные поля момента в MSK (сдвиг + чтение полей как UTC). */
function mskParts(date: Date): MskParts {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  return { year: msk.getUTCFullYear(), month: msk.getUTCMonth(), day: msk.getUTCDate() };
}

/** Ключ суточной категории: календарная дата MSK. */
function dayKey(date: Date): string {
  const { year, month, day } = mskParts(date);
  return `${year}-${month}-${day}`;
}

/** Ключ месячной категории: календарный месяц MSK. */
function monthKey(date: Date): string {
  const { year, month } = mskParts(date);
  return `${year}-${month}`;
}

/** Ключ недельной категории: ISO-неделя (год+номер) в MSK. */
function weekKey(date: Date): string {
  const { year, month, day } = mskParts(date);
  const utc = new Date(Date.UTC(year, month, day));
  const isoDow = (utc.getUTCDay() + 6) % 7; // понедельник = 0
  utc.setUTCDate(utc.getUTCDate() - isoDow + 3); // четверг текущей ISO-недели
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${week}`;
}

/**
 * Независимый оракул: множество идентификаторов, удерживаемых GFS-политикой.
 *
 * Для каждой категории копии группируются по ключу ведра; представителем ведра
 * становится копия с максимальным временем; удерживаются представители `limit`
 * самых свежих вёдер. Итог — объединение представителей трёх категорий.
 */
function expectedRetained(
  candidates: readonly RetentionCandidate[],
  policy: GfsRetentionPolicy,
): Set<string> {
  const retained = new Set<string>();
  const categories: Array<readonly [(d: Date) => string, number]> = [
    [dayKey, policy.daily],
    [weekKey, policy.weekly],
    [monthKey, policy.monthly],
  ];

  for (const [keyOf, limit] of categories) {
    if (limit <= 0) {
      continue;
    }
    // Представитель каждого ведра — самая свежая (max timestamp) копия в нём.
    const reps = new Map<string, RetentionCandidate>();
    for (const candidate of candidates) {
      const key = keyOf(candidate.timestamp);
      const current = reps.get(key);
      if (!current || candidate.timestamp.getTime() > current.timestamp.getTime()) {
        reps.set(key, candidate);
      }
    }
    // Удерживаем представителей `limit` самых свежих вёдер.
    const sorted = [...reps.values()].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    for (const rep of sorted.slice(0, limit)) {
      retained.add(rep.id);
    }
  }

  return retained;
}

describe('Property 59: GFS-политика хранения резервных копий (Req 21.3)', () => {
  // Опорный момент: 00:00 UTC 1 января 2024. Диапазоны смещений охватывают
  // переход через границу года для проверки ISO-недель.
  const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

  // Ширина окна (в минутах) задаёт плотность копий: узкие окна дают кластеры
  // в одном дне/неделе/месяце (проверка выбора самой свежей в ведре), широкие —
  // множество вёдер (проверка вытеснения по квотам).
  const spanMinutesArb = fc.constantFrom(
    2 * 24 * 60, // ~2 дня — плотный кластер
    14 * 24 * 60, // ~2 недели
    90 * 24 * 60, // ~3 месяца
    420 * 24 * 60, // ~14 месяцев — через границу года
  );

  // Набор кандидатов с уникальными моментами (различные минуты ⇒ нет ничьих) и
  // уникальными идентификаторами; допускается пустой набор.
  const candidatesArb = spanMinutesArb.chain((span) =>
    fc
      .uniqueArray(fc.integer({ min: 0, max: span }), { minLength: 0, maxLength: 40 })
      .map((offsets) =>
        offsets.map((minutes, index) => ({
          id: `backup-${index}`,
          timestamp: new Date(BASE_MS + minutes * 60_000),
        })),
      ),
  );

  // Политика: либо квоты GFS по умолчанию (7/4/6, Req 21.3), либо случайные
  // малые квоты для интенсивной проверки границ вытеснения.
  const policyArb = fc.oneof(
    fc.constant(GFS_RETENTION_POLICY),
    fc.record({
      daily: fc.integer({ min: 0, max: 8 }),
      weekly: fc.integer({ min: 0, max: 5 }),
      monthly: fc.integer({ min: 0, max: 7 }),
    }),
  );

  it('удерживает ровно представителей квот (≤7/4/6 самых свежих в категории), остальные удаляет', () => {
    fc.assert(
      fc.property(candidatesArb, policyArb, (candidates, policy) => {
        const decision = selectGfsRetention(candidates, policy);
        const allIds = candidates.map((c) => c.id);

        // 1. Разбиение: удержанные и удалённые не пересекаются, без повторов и
        //    в сумме дают исходный набор (каждая копия учтена ровно один раз).
        const retainedSet = new Set(decision.retainedIds);
        const deletedSet = new Set(decision.deletedIds);
        expect(decision.retainedIds.length).toBe(retainedSet.size);
        expect(decision.deletedIds.length).toBe(deletedSet.size);
        expect(decision.retainedIds.length + decision.deletedIds.length).toBe(allIds.length);
        for (const id of allIds) {
          expect(retainedSet.has(id) !== deletedSet.has(id)).toBe(true);
        }

        // 2. Удерживаются ИМЕННО те копии, что соответствуют квотам (самые
        //    свежие в своей категории) — сверка с независимым оракулом.
        expect(retainedSet).toEqual(expectedRetained(candidates, policy));

        // 3. Квоты соблюдены: удерживается не более суммы квот трёх категорий
        //    (объединение представителей ≤7 ежедневных + 4 еженедельных +
        //    6 ежемесячных вёдер), поэтому копии за пределами всех квот удалены.
        expect(decision.retainedIds.length).toBeLessThanOrEqual(
          policy.daily + policy.weekly + policy.monthly,
        );
      }),
      { numRuns: 300 },
    );
  });
});
