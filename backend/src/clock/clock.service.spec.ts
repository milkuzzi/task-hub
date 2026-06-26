import { ClockService } from './clock.service';
import { NowProvider } from './clock.constants';

describe('ClockService', () => {
  const fixedNow = new Date('2024-03-15T09:30:00.000Z');
  const stubProvider: NowProvider = { now: () => fixedNow };
  const clock = new ClockService(stubProvider);

  describe('now()', () => {
    it('возвращает момент, выданный инъецированным провайдером', () => {
      expect(clock.now()).toBe(fixedNow);
    });
  });

  describe('formatMsk()', () => {
    it('форматирует момент UTC в строку MSK (UTC+3) формата ДД.ММ.ГГГГ ЧЧ:ММ', () => {
      // 2024-03-15T09:30Z + 3ч = 12:30 MSK 15.03.2024
      expect(clock.formatMsk(new Date('2024-03-15T09:30:00.000Z'))).toBe('15.03.2024 12:30');
    });

    it('корректно переносит дату через полночь при сдвиге на MSK', () => {
      // 2024-03-15T23:00Z + 3ч = 02:00 MSK 16.03.2024
      expect(clock.formatMsk(new Date('2024-03-15T23:00:00.000Z'))).toBe('16.03.2024 02:00');
    });

    it('дополняет день, месяц, часы и минуты ведущими нулями', () => {
      // 2024-01-05T02:05Z + 3ч = 05:05 MSK 05.01.2024
      expect(clock.formatMsk(new Date('2024-01-05T02:05:00.000Z'))).toBe('05.01.2024 05:05');
    });

    it('выбрасывает ошибку для некорректного Date', () => {
      expect(() => clock.formatMsk(new Date('invalid'))).toThrow(TypeError);
    });
  });

  describe('parseMsk()', () => {
    it('разбирает строку MSK в соответствующий момент UTC', () => {
      // 12:30 MSK 15.03.2024 - 3ч = 09:30Z
      expect(clock.parseMsk('15.03.2024 12:30').toISOString()).toBe('2024-03-15T09:30:00.000Z');
    });

    it('отвергает строку неверного формата', () => {
      expect(() => clock.parseMsk('2024-03-15 12:30')).toThrow(TypeError);
    });

    it('отвергает строку с недопустимой датой (переполнение полей)', () => {
      expect(() => clock.parseMsk('32.13.2024 25:61')).toThrow(TypeError);
    });
  });

  describe('round-trip', () => {
    it('parseMsk(formatMsk(date)) восстанавливает момент с точностью до минуты', () => {
      const original = new Date('2024-07-21T14:47:33.123Z');
      const truncatedToMinute = new Date('2024-07-21T14:47:00.000Z');
      const restored = clock.parseMsk(clock.formatMsk(original));
      expect(restored.getTime()).toBe(truncatedToMinute.getTime());
    });
  });
});
