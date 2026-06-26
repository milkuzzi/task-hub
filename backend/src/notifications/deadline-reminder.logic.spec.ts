import { ReminderThreshold } from '@prisma/client';
import { ReminderThresholds, ReminderTrigger, decideDueReminders } from './deadline-reminder.logic';

/** Пороги по умолчанию: дальний 24 ч, ближний 2 ч, окно ±5 мин. */
const DEFAULT_THRESHOLDS: ReminderThresholds = { far: 86_400, near: 7_200, window: 300 };

/** Базовый момент «сейчас» для детерминированных расчётов. */
const NOW = new Date('2024-01-01T00:00:00.000Z');

/** Возвращает Дедлайн, отстоящий от {@link NOW} на `seconds` секунд. */
function deadlineInSeconds(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1000);
}

describe('decideDueReminders', () => {
  describe('периодическая проверка окна (Req 13.7, 13.8)', () => {
    it('отправляет дальний порог, когда остаток в окне дальнего порога', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(86_400),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Periodic,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.FAR]);
    });

    it('отправляет дальний порог на границе окна (far - window)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(86_400 - 300),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Periodic,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.FAR]);
    });

    it('отправляет ближний порог, когда остаток в окне ближнего порога', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(7_200 + 200),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Periodic,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.NEAR]);
    });

    it('не отправляет порог вне окна', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(50_000),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Periodic,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([]);
    });

    it('не отправляет уже отправленный порог (защита от повтора)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(86_400),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Periodic,
        farSent: true,
        nearSent: false,
      });
      expect(due).toEqual([]);
    });

    it('возвращает оба неотправленных порога при перекрытии окон', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(1_000),
        thresholds: { far: 1_000, near: 1_100, window: 300 },
        trigger: ReminderTrigger.Periodic,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual(expect.arrayContaining([ReminderThreshold.FAR, ReminderThreshold.NEAR]));
      expect(due).toHaveLength(2);
    });
  });

  describe('создание/изменение дедлайна (Req 13.9, 13.10)', () => {
    it('остаток между порогами → только дальний (Req 13.9)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(10 * 3_600),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Immediate,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.FAR]);
    });

    it('остаток меньше ближнего → только ближний (Req 13.10)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(3_600),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Immediate,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.NEAR]);
    });

    it('остаток больше дальнего → немедленно ничего (отработает периодика)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(40 * 3_600),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Immediate,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([]);
    });

    it('остаток ровно на ближнем пороге → дальний (граница near включительно)', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(7_200),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Immediate,
        farSent: false,
        nearSent: false,
      });
      expect(due).toEqual([ReminderThreshold.FAR]);
    });

    it('не отправляет уже отправленный дальний порог при изменении дедлайна', () => {
      const due = decideDueReminders({
        now: NOW,
        deadline: deadlineInSeconds(10 * 3_600),
        thresholds: DEFAULT_THRESHOLDS,
        trigger: ReminderTrigger.Immediate,
        farSent: true,
        nearSent: false,
      });
      expect(due).toEqual([]);
    });
  });
});
