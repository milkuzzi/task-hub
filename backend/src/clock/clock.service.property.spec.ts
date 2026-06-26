import fc from 'fast-check';
import { ClockService } from './clock.service';
import { MSK_OFFSET_MS, NowProvider } from './clock.constants';

/**
 * **Feature: task-assignment-system, Property 1: Форматирование времени в MSK и round-trip**
 *
 * Для любого момента времени (UTC) форматирование в MSK даёт строку вида
 * `ДД.ММ.ГГГГ ЧЧ:ММ`, соответствующую UTC+3, и обратный разбор этой строки
 * восстанавливает исходный момент с точностью до минуты.
 *
 * **Validates: Requirements 1.2**
 */
describe('ClockService — Property 1: форматирование MSK и round-trip', () => {
  const stubProvider: NowProvider = { now: () => new Date(0) };
  const clock = new ClockService(stubProvider);

  /** Шаблон строки формата `ДД.ММ.ГГГГ ЧЧ:ММ`. */
  const MSK_STRING_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

  // Диапазон четырёхзначных годов (формат использует ровно 4 цифры года).
  // Верхняя граница берётся с запасом на смещение MSK (+3ч), чтобы настенное
  // время в Москве не выходило за пределы 9999 года.
  const minInstant = new Date('1000-01-01T00:00:00.000Z');
  const maxInstant = new Date('9999-12-31T20:59:00.000Z');

  it('formatMsk даёт строку ДД.ММ.ГГГГ ЧЧ:ММ (UTC+3), а parseMsk round-trip до минуты', () => {
    fc.assert(
      fc.property(
        fc.date({ min: minInstant, max: maxInstant, noInvalidDate: true }),
        (instant: Date) => {
          const formatted = clock.formatMsk(instant);

          // 1. Структура строки соответствует формату ДД.ММ.ГГГГ ЧЧ:ММ.
          const match = MSK_STRING_PATTERN.exec(formatted);
          expect(match).not.toBeNull();

          // 2. Поля строки согласованы с настенным временем MSK (UTC+3):
          //    сдвигаем момент на +3ч и читаем поля как UTC.
          const mskWall = new Date(instant.getTime() + MSK_OFFSET_MS);
          const expected =
            `${String(mskWall.getUTCDate()).padStart(2, '0')}.` +
            `${String(mskWall.getUTCMonth() + 1).padStart(2, '0')}.` +
            `${String(mskWall.getUTCFullYear()).padStart(4, '0')} ` +
            `${String(mskWall.getUTCHours()).padStart(2, '0')}:` +
            `${String(mskWall.getUTCMinutes()).padStart(2, '0')}`;
          expect(formatted).toBe(expected);

          // 3. Round-trip: parseMsk восстанавливает момент с точностью до минуты.
          const restored = clock.parseMsk(formatted);
          const truncatedToMinute = Math.floor(instant.getTime() / 60000) * 60000;
          expect(restored.getTime()).toBe(truncatedToMinute);
        },
      ),
      { numRuns: 200 },
    );
  });
});
