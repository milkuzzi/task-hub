import { ReminderThreshold } from '@prisma/client';

/**
 * Настраиваемые пороги напоминаний о приближении Дедлайна, в секундах
 * (Req 13.7–13.10).
 *
 * - {@link far} — дальний порог (по умолчанию 86400 с = 24 ч);
 * - {@link near} — ближний порог (по умолчанию 7200 с = 2 ч);
 * - {@link window} — половина окна проверки (по умолчанию 300 с = ±5 мин):
 *   порог считается «наступившим», если остаток до Дедлайна отстоит от значения
 *   порога не более чем на {@link window} секунд.
 *
 * Инвариант предметной области: `near < far`, `window >= 0`.
 */
export interface ReminderThresholds {
  /** Дальний порог напоминания, секунды (по умолчанию 86400). */
  far: number;
  /** Ближний порог напоминания, секунды (по умолчанию 7200). */
  near: number;
  /** Половина окна проверки, секунды (по умолчанию 300 = ±5 мин). */
  window: number;
}

/**
 * Триггер, по которому принимается решение об отправке порогов напоминания.
 *
 * - {@link Periodic} — периодическая проверка окна (Req 13.7, 13.8): порог
 *   отправляется, когда остаток до Дедлайна попадает в окно `[порог − window,
 *   порог + window]`.
 * - {@link Immediate} — создание Задачи или изменение её Дедлайна (Req 13.9,
 *   13.10): если остаток между порогами — немедленно только дальний; если
 *   остаток меньше ближнего — немедленно только ближний.
 */
export enum ReminderTrigger {
  /** Периодическая проверка окна порога (Req 13.7, 13.8). */
  Periodic = 'periodic',
  /** Создание/изменение Дедлайна (Req 13.9, 13.10). */
  Immediate = 'immediate',
}

/**
 * Вход чистой функции принятия решения о порогах напоминания
 * {@link decideDueReminders}.
 */
export interface ReminderDecisionInput {
  /** Текущий момент времени (абсолютный, UTC). */
  now: Date;
  /** Момент Дедлайна Задачи (абсолютный, UTC). */
  deadline: Date;
  /** Настраиваемые пороги и окно проверки. */
  thresholds: ReminderThresholds;
  /** Триггер принятия решения (периодическая проверка / создание-изменение). */
  trigger: ReminderTrigger;
  /** Дальний порог уже отправлялся (защита от повтора, Req 13.7, 13.9). */
  farSent: boolean;
  /** Ближний порог уже отправлялся (защита от повтора, Req 13.8, 13.10). */
  nearSent: boolean;
}

/** Число миллисекунд в секунде. */
const MS_PER_SECOND = 1000;

/**
 * Чистая функция принятия решения о порогах напоминания о Дедлайне
 * (Req 13.7–13.10).
 *
 * Возвращает множество порогов, которые СЛЕДУЕТ отправить в данный момент, и
 * НИКОГДА не возвращает порог, который уже был отправлен ({@link farSent} /
 * {@link nearSent}) — этим обеспечивается отправка каждого порога не более
 * одного раза (Req 13.7–13.10). Функция детерминирована и не имеет побочных
 * эффектов: фактическая отправка и фиксация состояния «отправлено» выполняются
 * вызывающим сервисом.
 *
 * Правила в зависимости от {@link ReminderTrigger}:
 *
 * - {@link ReminderTrigger.Periodic} (Req 13.7, 13.8): порог `T ∈ {FAR, NEAR}`
 *   отправляется тогда и только тогда, когда остаток до Дедлайна
 *   `remaining` попадает в окно `|remaining − T| ≤ window` и порог ещё не
 *   отправлялся. Оба порога могут попасть в окно лишь при перекрытии окон;
 *   тогда возвращаются оба неотправленных порога.
 *
 * - {@link ReminderTrigger.Immediate} (Req 13.9, 13.10) — при создании Задачи
 *   или изменении Дедлайна:
 *   - если `near ≤ remaining ≤ far` (остаток между порогами) — отправляется
 *     ТОЛЬКО дальний порог (Req 13.9);
 *   - если `remaining < near` (остаток меньше ближнего) — отправляется ТОЛЬКО
 *     ближний порог (Req 13.10);
 *   - если `remaining > far` (до дальнего порога ещё далеко) — немедленно ничего
 *     не отправляется; дальний порог будет отправлен периодической проверкой
 *     при входе остатка в его окно.
 *   Уже отправленные пороги исключаются из результата (Req 13.7–13.10).
 *
 * @param input Текущий момент, Дедлайн, пороги, триггер и признаки отправки.
 * @returns Пороги к отправке (подмножество `{FAR, NEAR}`), без уже отправленных.
 */
export function decideDueReminders(input: ReminderDecisionInput): ReminderThreshold[] {
  const { now, deadline, thresholds, trigger, farSent, nearSent } = input;
  const remaining = (deadline.getTime() - now.getTime()) / MS_PER_SECOND;

  const due: ReminderThreshold[] = [];

  if (trigger === ReminderTrigger.Periodic) {
    if (!farSent && withinWindow(remaining, thresholds.far, thresholds.window)) {
      due.push(ReminderThreshold.FAR);
    }
    if (!nearSent && withinWindow(remaining, thresholds.near, thresholds.window)) {
      due.push(ReminderThreshold.NEAR);
    }
    return due;
  }

  // ReminderTrigger.Immediate — создание/изменение Дедлайна (Req 13.9, 13.10).
  if (remaining < thresholds.near) {
    // Остаток меньше ближнего порога — только ближний (Req 13.10).
    if (!nearSent) {
      due.push(ReminderThreshold.NEAR);
    }
  } else if (remaining <= thresholds.far) {
    // Остаток между ближним и дальним порогами — только дальний (Req 13.9).
    if (!farSent) {
      due.push(ReminderThreshold.FAR);
    }
  }
  // remaining > far — немедленно ничего не отправляется (отработает периодика).

  return due;
}

/**
 * Возвращает `true`, если остаток до Дедлайна `remaining` (секунды) попадает в
 * окно порога: `|remaining − threshold| ≤ window`.
 */
function withinWindow(remaining: number, threshold: number, window: number): boolean {
  return Math.abs(remaining - threshold) <= window;
}
