import fc from 'fast-check';
import { saturateMessageCount } from './message-counter';

/**
 * **Feature: task-assignment-system, Property 24: Насыщение счётчика сообщений**
 *
 * Property 24 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 9.7, 9.9**:
 *
 * Для любого фактического числа Сообщений в Чате Задачи отображаемый счётчик
 * равен `min(max(0, ⌊actual⌋), cap)` и всегда находится в диапазоне 0–`cap`
 * (потолок системы — 9999). Пока фактическое число ниже потолка, счётчик равен
 * этому числу (с отбрасыванием дробной части и без отрицательных значений);
 * при значении, равном потолку или большем (≥10000 при стандартном потолке
 * 9999), счётчик фиксируется на `cap` и не превышает его, а также никогда не
 * становится отрицательным.
 *
 * Тест проверяет чистую функцию {@link saturateMessageCount} в полной изоляции
 * от хранилища (без БД, без моков). Реализует ровно ОДНО свойство. Минимум 100
 * итераций fast-check (здесь — 300).
 */
describe('Property 24: Насыщение счётчика сообщений (Req 9.7, 9.9)', () => {
  /** Потолок отображаемого счётчика согласно Req 9.7, 9.9. */
  const CAP = 9999;

  /**
   * Фактическое число Сообщений: широкий диапазон, включающий значения ниже
   * потолка, ровно на границе, заметно выше потолка, а также отрицательные и
   * дробные значения (которые должны нормализоваться).
   */
  const actualCountArb = fc.oneof(
    // Целые в окрестности всего рабочего диапазона, включая границы.
    fc.integer({ min: -100, max: 20000 }),
    // Заведомо большие значения для проверки насыщения.
    fc.integer({ min: 10000, max: Number.MAX_SAFE_INTEGER }),
    // Дробные значения, в т.ч. вблизи потолка и отрицательные.
    fc.double({ min: -50, max: 20000, noNaN: true }),
  );

  it('отображаемый счётчик = min(max(0, ⌊actual⌋), cap), в диапазоне 0..cap', () => {
    fc.assert(
      fc.property(actualCountArb, (actual) => {
        const displayed = saturateMessageCount(actual, CAP);

        const expected = Math.min(Math.max(0, Math.trunc(actual)), CAP);

        // Точное определяющее равенство (Req 9.7, 9.9).
        expect(displayed).toBe(expected);

        // Инварианты диапазона: никогда не отрицательный и никогда не выше cap.
        expect(displayed).toBeGreaterThanOrEqual(0);
        expect(displayed).toBeLessThanOrEqual(CAP);

        // Целое число (Req 9.7 — счётчик отображает целое значение).
        expect(Number.isInteger(displayed)).toBe(true);

        if (Math.trunc(actual) >= CAP) {
          // Req 9.9: при достижении/превышении потолка — фиксация на cap.
          expect(displayed).toBe(CAP);
        } else if (actual >= 0) {
          // Ниже потолка счётчик равен фактическому числу (с отбрасыванием
          // дробной части). Прибавление 0 нормализует -0 → +0, чтобы сравнение
          // через Object.is (Jest toBe) не падало на отрицательном нуле.
          expect(displayed).toBe(Math.trunc(actual) + 0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
