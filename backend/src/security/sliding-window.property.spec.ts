import fc from 'fast-check';
import { evaluateSlidingWindow } from './sliding-window';
import { SensitiveOp } from './security.types';

/**
 * **Feature: task-assignment-system, Property 55: Ограничение частоты запросов (скользящее окно)**
 *
 * Property 55 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 19.1, 19.2**:
 *
 * Для любого источника и любой последовательности чувствительных операций
 * (вход, установка/смена пароля, отправка сообщения, загрузка файла) в
 * скользящем окне 60 секунд первые 10 запросов допускаются, а все избыточные
 * (11-й и далее) отклоняются с ошибкой превышения частоты, независимо от типа
 * операции.
 *
 * Тест прогоняет чистую логику решения {@link evaluateSlidingWindow} (ту же,
 * что использует {@link RateLimiter} поверх Redis) для последовательности
 * запросов от одного источника. Состояние окна (сохранённые метки) протягивается
 * между запросами, как это делает ограничитель. Решение сверяется с независимой
 * эталонной моделью скользящего окна, которая не учитывает тип операции — тем
 * самым проверяется независимость лимита от типа операции (Req 19.2). Реализует
 * ровно ОДНО свойство; ≥100 итераций fast-check (здесь — 300).
 */

const WINDOW_MS = 60_000; // Скользящее окно 60 секунд (Req 19.1).
const MAX_REQUESTS = 10; // Не более 10 запросов с источника за окно (Req 19.1).

const SENSITIVE_OPS: readonly SensitiveOp[] = [
  'login',
  'set_password',
  'change_password',
  'send_message',
  'upload',
];

const opArb = fc.constantFrom(...SENSITIVE_OPS);

/** Один запрос: тип чувствительной операции и его момент (мс эпохи). */
interface Request {
  op: SensitiveOp;
  now: number;
}

/**
 * Эталонная модель скользящего окна, НЕ зависящая от типа операции.
 * Возвращает решения для последовательности запросов: запрос допускается тогда
 * и только тогда, когда число ранее допущенных запросов, чьи метки строго
 * новее границы окна `(now - WINDOW_MS)`, меньше {@link MAX_REQUESTS}.
 * Отклонённые запросы не сохраняют метку и не продлевают окно.
 */
function referenceDecisions(requests: readonly Request[]): boolean[] {
  const accepted: number[] = [];
  return requests.map(({ now }) => {
    const windowStart = now - WINDOW_MS;
    const inWindow = accepted.filter((t) => t > windowStart).length;
    const allowed = inWindow < MAX_REQUESTS;
    if (allowed) {
      accepted.push(now);
    }
    return allowed;
  });
}

describe('Property 55: Ограничение частоты запросов (скользящее окно) (Req 19.1, 19.2)', () => {
  it('для любой последовательности операций допуск совпадает с эталонной моделью окна независимо от типа', () => {
    // Запросы внутри одного источника с неубывающими метками времени:
    // стартовая метка + случайные неотрицательные приращения (мс). Приращения
    // покрывают как плотные всплески (внутри окна), так и паузы (выход за окно).
    const requestsArb = fc
      .tuple(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({
            op: opArb,
            delta: fc.oneof(
              fc.integer({ min: 0, max: 5_000 }), // плотный всплеск внутри окна
              fc.integer({ min: 0, max: WINDOW_MS }), // средние паузы у границы
              fc.integer({ min: WINDOW_MS, max: WINDOW_MS * 2 }), // выход за окно
            ),
          }),
          { minLength: 0, maxLength: 60 },
        ),
      )
      .map(([start, steps]) => {
        let now = start;
        const requests: Request[] = [];
        for (const step of steps) {
          now += step.delta;
          requests.push({ op: step.op, now });
        }
        return requests;
      });

    fc.assert(
      fc.property(requestsArb, (requests) => {
        const expected = referenceDecisions(requests);

        // Протягиваем состояние окна между запросами, как RateLimiter.
        let retained: number[] = [];
        requests.forEach((request, index) => {
          const decision = evaluateSlidingWindow(retained, request.now, WINDOW_MS, MAX_REQUESTS);
          // Решение не зависит от типа операции и совпадает с эталоном.
          expect(decision.allowed).toBe(expected[index]);
          retained = decision.retained;
        });
      }),
      { numRuns: 300 },
    );
  });

  it('в пределах одного окна первые 10 запросов допускаются, а 11-й и далее отклоняются', () => {
    // Все запросы строго внутри окна 60с (метки в (start, start + WINDOW_MS)),
    // поэтому ни одна метка не истекает: проверяем границу «первые 10 / избыток».
    const burstArb = fc
      .tuple(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(
          fc.record({
            op: opArb,
            // Смещение строго меньше окна — метка не выходит за границу.
            offset: fc.integer({ min: 1, max: WINDOW_MS - 1 }),
          }),
          { minLength: 0, maxLength: 40 },
        ),
      )
      .map(([start, items]) => {
        // Сортируем по смещению: метки внутри источника неубывающие.
        const sorted = [...items].sort((a, b) => a.offset - b.offset);
        return sorted.map(({ op, offset }) => ({ op, now: start + offset }));
      });

    fc.assert(
      fc.property(burstArb, (requests) => {
        let retained: number[] = [];
        let acceptedSoFar = 0;
        requests.forEach((request) => {
          const decision = evaluateSlidingWindow(retained, request.now, WINDOW_MS, MAX_REQUESTS);
          // Внутри окна допускаются ровно первые MAX_REQUESTS запросов.
          const shouldAllow = acceptedSoFar < MAX_REQUESTS;
          expect(decision.allowed).toBe(shouldAllow);
          if (decision.allowed) {
            acceptedSoFar += 1;
          }
          retained = decision.retained;
        });
        // Допущено не больше лимита независимо от числа и типов операций.
        expect(acceptedSoFar).toBe(Math.min(requests.length, MAX_REQUESTS));
      }),
      { numRuns: 300 },
    );
  });
});
