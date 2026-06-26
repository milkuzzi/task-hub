import { ReminderThreshold } from '@prisma/client';
import fc from 'fast-check';
import {
  ReminderDecisionInput,
  ReminderThresholds,
  ReminderTrigger,
  decideDueReminders,
} from './deadline-reminder.logic';

/**
 * **Feature: task-assignment-system, Property 39: Логика порогов напоминаний о дедлайне**
 *
 * **Validates: Requirements 13.7, 13.8, 13.9, 13.10**
 *
 * Для любой Задачи и настраиваемых порогов (near < far, window ≥ 0):
 * - Periodic (Req 13.7, 13.8): дальний порог возвращается тогда и только тогда,
 *   когда `|remaining − far| ≤ window` и он ещё не отправлялся; ближний — когда
 *   `|remaining − near| ≤ window` и он ещё не отправлялся.
 * - Immediate (Req 13.9, 13.10): при `remaining < near` — только ближний (если
 *   не отправлен); при `near ≤ remaining ≤ far` — только дальний (если не
 *   отправлен); при `remaining > far` — ничего.
 * - Уже отправленный порог не возвращается никогда (отправка не более одного
 *   раза, Req 13.7–13.10).
 *
 * Тест чистый: функция {@link decideDueReminders} детерминирована и не имеет
 * внешних зависимостей (без БД). Результат сверяется с независимым оракулом,
 * выведенным напрямую из критериев приёмки.
 */

/** Базовый момент «сейчас» (UTC) — фиксирован для детерминированных расчётов. */
const NOW_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

/**
 * Независимый оракул, реализующий правила Req 13.7–13.10 отдельно от
 * проверяемой функции. Возвращает множество ожидаемых порогов как отсортированный
 * массив (для сравнения без учёта порядка).
 */
function oracle(
  remaining: number,
  thresholds: ReminderThresholds,
  trigger: ReminderTrigger,
  farSent: boolean,
  nearSent: boolean,
): ReminderThreshold[] {
  const { far, near, window } = thresholds;
  const result = new Set<ReminderThreshold>();

  if (trigger === ReminderTrigger.Periodic) {
    // Req 13.7 / 13.8: порог в своём окне и ещё не отправлялся.
    if (!farSent && Math.abs(remaining - far) <= window) {
      result.add(ReminderThreshold.FAR);
    }
    if (!nearSent && Math.abs(remaining - near) <= window) {
      result.add(ReminderThreshold.NEAR);
    }
  } else {
    // Immediate (Req 13.9 / 13.10): создание/изменение Дедлайна.
    if (remaining < near) {
      // Req 13.10: остаток меньше ближнего — только ближний.
      if (!nearSent) {
        result.add(ReminderThreshold.NEAR);
      }
    } else if (remaining <= far) {
      // Req 13.9: остаток между порогами — только дальний.
      if (!farSent) {
        result.add(ReminderThreshold.FAR);
      }
    }
    // remaining > far — ничего.
  }

  return [...result].sort();
}

/** Сортирует результат функции для сравнения без учёта порядка. */
function asSet(thresholds: ReminderThreshold[]): ReminderThreshold[] {
  return [...thresholds].sort();
}

describe('decideDueReminders — Property 39: логика порогов напоминаний о дедлайне', () => {
  // Сценарий: пороги (near < far, window ≥ 0), триггер, признаки отправки и
  // целочисленный остаток до Дедлайна (секунды), сгенерированный «умно» —
  // с упором на границы окон порогов.
  const scenario = fc
    .record({
      near: fc.integer({ min: 0, max: 100_000 }),
      delta: fc.integer({ min: 1, max: 100_000 }), // far = near + delta ⇒ near < far
      window: fc.integer({ min: 0, max: 10_000 }),
      trigger: fc.constantFrom(ReminderTrigger.Periodic, ReminderTrigger.Immediate),
      farSent: fc.boolean(),
      nearSent: fc.boolean(),
    })
    .chain((base) => {
      const far = base.near + base.delta;
      // Якорные точки, вокруг которых интересно проверять поведение границ.
      const anchors = [
        0,
        base.near,
        far,
        base.near - base.window,
        base.near + base.window,
        far - base.window,
        far + base.window,
        Math.floor((base.near + far) / 2),
      ];
      const remainingArb = fc.oneof(
        // Около границ окон: якорь ± небольшое смещение, перекрывающее окно.
        fc
          .tuple(
            fc.constantFrom(...anchors),
            fc.integer({ min: -(base.window + 2), max: base.window + 2 }),
          )
          .map(([anchor, jitter]) => anchor + jitter),
        // Широкий диапазон, включая отрицательный остаток (Дедлайн прошёл).
        fc.integer({ min: -10_000, max: far + base.window + 10_000 }),
      );
      return remainingArb.map((remaining) => ({ ...base, far, remaining }));
    });

  it('возвращаемое множество порогов совпадает с независимым оракулом (Req 13.7–13.10)', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const thresholds: ReminderThresholds = {
          far: s.far,
          near: s.near,
          window: s.window,
        };
        // Целочисленный остаток ⇒ deadline−now = remaining*1000 точно, без
        // погрешности при делении на 1000 внутри функции.
        const input: ReminderDecisionInput = {
          now: new Date(NOW_MS),
          deadline: new Date(NOW_MS + s.remaining * 1000),
          thresholds,
          trigger: s.trigger,
          farSent: s.farSent,
          nearSent: s.nearSent,
        };

        const actual = asSet(decideDueReminders(input));
        const expected = oracle(s.remaining, thresholds, s.trigger, s.farSent, s.nearSent);

        // Совпадение с оракулом (включает правила окон, выбор порога при
        // создании/изменении и исключение уже отправленных порогов).
        expect(actual).toEqual(expected);

        // Дополнительно: никогда не возвращается уже отправленный порог
        // (отправка не более одного раза, Req 13.7–13.10).
        if (s.farSent) {
          expect(actual).not.toContain(ReminderThreshold.FAR);
        }
        if (s.nearSent) {
          expect(actual).not.toContain(ReminderThreshold.NEAR);
        }
      }),
      { numRuns: 300 },
    );
  });
});
