import { describe, expect, it } from 'vitest';
import {
  MSK_OFFSET_MS,
  formatMsk,
  fromMskInputValue,
  parseMsk,
  toMskInputValue,
} from './time';

/**
 * Юнит-тесты клиентского форматирования времени в MSK (Req 1.2).
 *
 * Покрывают формат `ДД.ММ.ГГГГ ЧЧ:ММ`, независимость от часового пояса
 * браузера (поля читаются как UTC после сдвига на +3ч), round-trip
 * `formatMsk ∘ parseMsk` и `toMskInputValue ∘ fromMskInputValue`, а также
 * отклонение недопустимых строк.
 */
describe('formatMsk', () => {
  it('форматирует UTC-момент в настенное время Москвы (UTC+3) как ДД.ММ.ГГГГ ЧЧ:ММ', () => {
    // 2024-01-02 09:30:00Z → 12:30 по Москве.
    const utc = new Date('2024-01-02T09:30:00.000Z');
    expect(formatMsk(utc)).toBe('02.01.2024 12:30');
  });

  it('переносит дату через полночь при сдвиге на +3 часа', () => {
    // 2024-03-10 22:15:00Z → 11 марта 01:15 по Москве.
    expect(formatMsk('2024-03-10T22:15:00.000Z')).toBe('11.03.2024 01:15');
  });

  it('дополняет одно­значные день/месяц/час/минуту ведущими нулями', () => {
    // 2024-09-05 02:03:00Z → 05:03 по Москве.
    expect(formatMsk('2024-09-05T02:03:00.000Z')).toBe('05.09.2024 05:03');
  });

  it('принимает epoch-ms и ISO-строку, давая одинаковый результат', () => {
    const iso = '2024-06-15T12:00:00.000Z';
    const ms = Date.parse(iso);
    expect(formatMsk(ms)).toBe(formatMsk(iso));
  });

  it('усекает точность до минуты (секунды отбрасываются)', () => {
    expect(formatMsk('2024-06-15T12:00:59.999Z')).toBe('15.06.2024 15:00');
  });

  it('бросает TypeError на некорректной дате', () => {
    expect(() => formatMsk('не дата')).toThrow(TypeError);
  });
});

describe('parseMsk', () => {
  it('разбирает строку MSK в абсолютный момент (UTC)', () => {
    const date = parseMsk('02.01.2024 12:30');
    expect(date.toISOString()).toBe('2024-01-02T09:30:00.000Z');
  });

  it('отклоняет строку неверного формата', () => {
    expect(() => parseMsk('2024-01-02 12:30')).toThrow(TypeError);
    expect(() => parseMsk('2.1.2024 12:30')).toThrow(TypeError);
    expect(() => parseMsk('')).toThrow(TypeError);
  });

  it('отклоняет недопустимые дату/время (переполнение полей)', () => {
    expect(() => parseMsk('32.01.2024 12:30')).toThrow(TypeError);
    expect(() => parseMsk('01.13.2024 12:30')).toThrow(TypeError);
    expect(() => parseMsk('01.01.2024 25:00')).toThrow(TypeError);
    expect(() => parseMsk('01.01.2024 12:61')).toThrow(TypeError);
  });
});

describe('round-trip formatMsk ∘ parseMsk', () => {
  it('parseMsk(formatMsk(d)) восстанавливает момент с точностью до минуты', () => {
    const samples = [
      '2024-01-01T00:00:00.000Z',
      '2024-02-29T21:00:00.000Z', // високосный год + перенос даты
      '2023-12-31T20:59:00.000Z', // переход через год по Москве
      '2024-07-04T11:11:00.000Z',
    ];
    for (const iso of samples) {
      const original = new Date(iso);
      const restored = parseMsk(formatMsk(original));
      expect(restored.getTime()).toBe(original.getTime());
    }
  });

  it('formatMsk(parseMsk(s)) возвращает исходную строку для всех валидных строк', () => {
    const strings = [
      '01.01.2024 00:00',
      '29.02.2024 23:59',
      '11.03.2024 01:15',
      '31.12.2023 23:59',
    ];
    for (const s of strings) {
      expect(formatMsk(parseMsk(s))).toBe(s);
    }
  });
});

describe('toMskInputValue / fromMskInputValue', () => {
  it('формирует значение datetime-local в московском времени', () => {
    expect(toMskInputValue('2024-01-02T09:30:00.000Z')).toBe('2024-01-02T12:30');
  });

  it('разбирает значение datetime-local как московское время в UTC-момент', () => {
    const date = fromMskInputValue('2024-01-02T12:30');
    expect(date.toISOString()).toBe('2024-01-02T09:30:00.000Z');
  });

  it('round-trip toMskInputValue ∘ fromMskInputValue сохраняет момент', () => {
    const original = new Date('2024-06-15T08:45:00.000Z');
    expect(fromMskInputValue(toMskInputValue(original)).getTime()).toBe(
      original.getTime(),
    );
  });

  it('отклоняет неверный формат и недопустимые значения', () => {
    expect(() => fromMskInputValue('02.01.2024 12:30')).toThrow(TypeError);
    expect(() => fromMskInputValue('2024-13-01T00:00')).toThrow(TypeError);
    expect(() => fromMskInputValue('2024-01-01T24:00')).toThrow(TypeError);
  });
});

describe('MSK_OFFSET_MS', () => {
  it('равно трём часам в миллисекундах (UTC+3)', () => {
    expect(MSK_OFFSET_MS).toBe(3 * 60 * 60 * 1000);
  });
});
