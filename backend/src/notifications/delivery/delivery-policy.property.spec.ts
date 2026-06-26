import fc from 'fast-check';
import { DeliveryStatus, NotificationType } from '@prisma/client';
import {
  ACCOUNT_RETRY_INTERVAL_MS,
  MAX_DELIVERY_MAX_ATTEMPTS,
  MESSAGE_RETRY_INTERVAL_MS,
  TASK_RETRY_INTERVAL_MS,
  classifyNotification,
  decideMaxDeliveryOnFailure,
} from './delivery-policy';
import { MAX_EMAIL_ATTEMPTS, hasExhaustedAttempts } from '../../mailer/mailer.constants';

/**
 * **Feature: task-assignment-system, Property 3: Число попыток внешней доставки ограничено**
 *
 * Property 3 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 1.7, 13.13, 14.6, 14.7, 15.4, 15.7**:
 *
 * Для любой последовательности сбоев внешнего провайдера (email или MAX)
 * количество попыток доставки одного сообщения/уведомления не превышает 3, и
 * при окончательной неудаче элемент остаётся в очереди/сохранён, а факт неудачи
 * зафиксирован.
 *
 * Тест прогоняет ЧИСТЫЕ функции политики ретраев без живых сервисов:
 *   - канал MAX — {@link decideMaxDeliveryOnFailure}, применяемая последовательно
 *     для каждой неуспешной попытки (как это делает воркер доставки), начиная с
 *     `previousAttempts = 0`;
 *   - канал email — {@link hasExhaustedAttempts} с предельным числом попыток
 *     {@link MAX_EMAIL_ATTEMPTS} (семантика очереди SendPulse, Req 1.7).
 *
 * Для произвольного типа уведомления и произвольного числа подряд идущих сбоев
 * провайдера проверяется, что:
 *   - число выполненных попыток никогда не превышает 3
 *     ({@link MAX_DELIVERY_MAX_ATTEMPTS} / {@link MAX_EMAIL_ATTEMPTS});
 *   - пока попытки не исчерпаны: решение требует повтора (`shouldRetry = true`),
 *     статус канала — {@link DeliveryStatus.RETRY}, а интервал ретрая
 *     соответствует классу уведомления (5 мин для задач, 5 с для сообщений,
 *     30 с для аккаунта; Req 13.13, 14.6, 15.7);
 *   - при достижении предела ретраи прекращаются (`shouldRetry = false`),
 *     задержки нет (`retryDelayMs = null`), а итоговый статус — окончательная
 *     неудача {@link DeliveryStatus.FAILED} (элемент сохранён, факт неудачи
 *     зафиксирован; Req 14.7, 15.4, 15.7);
 *   - ровно одна попытка переводит канал из «можно повторить» в «исчерпано» —
 *     повторов не больше, чем разрешённый предел.
 *
 * Реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 300).
 */

/** Все типы уведомлений системы (источник интервалов ретраев по классу). */
const NOTIFICATION_TYPES: NotificationType[] = Object.values(NotificationType);

/** Ожидаемый интервал ретрая (мс) для типа уведомления по его классу доставки. */
function expectedRetryIntervalMs(type: NotificationType): number {
  switch (classifyNotification(type)) {
    case 'message':
      return MESSAGE_RETRY_INTERVAL_MS;
    case 'account':
      return ACCOUNT_RETRY_INTERVAL_MS;
    case 'task':
      return TASK_RETRY_INTERVAL_MS;
  }
}

describe('Property 3: Число попыток внешней доставки ограничено (Req 1.7, 13.13, 14.6, 14.7, 15.4, 15.7)', () => {
  it('для любой последовательности сбоев число попыток ≤ 3, ретраи прекращаются и фиксируется окончательная неудача', () => {
    // Предельное число попыток едино для каналов MAX и email — не более 3.
    expect(MAX_DELIVERY_MAX_ATTEMPTS).toBe(3);
    expect(MAX_EMAIL_ATTEMPTS).toBe(3);

    fc.assert(
      fc.property(
        fc.constantFrom(...NOTIFICATION_TYPES),
        fc.constantFrom<'max' | 'email'>('max', 'email'),
        // Число подряд идущих сбоев провайдера — заведомо больше предела,
        // чтобы проверить остановку ретраев и окончательный статус.
        fc.integer({ min: 1, max: 25 }),
        (type, channel, failureCount) => {
          const limit = channel === 'max' ? MAX_DELIVERY_MAX_ATTEMPTS : MAX_EMAIL_ATTEMPTS;
          const expectedInterval = expectedRetryIntervalMs(type);

          let previousAttempts = 0;
          let stoppedAtAttempt: number | null = null;

          for (let failure = 0; failure < failureCount; failure++) {
            // Если предыдущая попытка уже исчерпала лимит, новых попыток не делаем.
            if (hasExhaustedAttempts(previousAttempts, limit)) {
              break;
            }

            if (channel === 'max') {
              const decision = decideMaxDeliveryOnFailure(type, previousAttempts);

              // Число выполненных попыток растёт ровно на единицу и не выходит за предел.
              expect(decision.attemptsMade).toBe(previousAttempts + 1);
              expect(decision.attemptsMade).toBeLessThanOrEqual(limit);

              if (decision.shouldRetry) {
                // Лимит не достигнут: запланирован повтор с интервалом по классу.
                expect(decision.status).toBe(DeliveryStatus.RETRY);
                expect(decision.retryDelayMs).toBe(expectedInterval);
                expect(decision.attemptsMade).toBeLessThan(limit);
              } else {
                // Лимит достигнут: окончательная неудача, повтор не планируется.
                expect(decision.status).toBe(DeliveryStatus.FAILED);
                expect(decision.retryDelayMs).toBeNull();
                expect(decision.attemptsMade).toBe(limit);
                stoppedAtAttempt = decision.attemptsMade;
              }

              previousAttempts = decision.attemptsMade;
            } else {
              // Канал email: одна неуспешная попытка увеличивает счётчик.
              previousAttempts += 1;
              expect(previousAttempts).toBeLessThanOrEqual(limit);

              if (hasExhaustedAttempts(previousAttempts, limit)) {
                stoppedAtAttempt = previousAttempts;
              }
            }

            // Инвариант на каждом шаге: попыток не больше предела (≤ 3).
            expect(previousAttempts).toBeLessThanOrEqual(limit);

            if (stoppedAtAttempt !== null) {
              break;
            }
          }

          // При достаточном числе сбоев ретраи обязаны остановиться ровно на пределе.
          if (failureCount >= limit) {
            expect(stoppedAtAttempt).toBe(limit);
            expect(hasExhaustedAttempts(previousAttempts, limit)).toBe(true);
          }

          // Итог: суммарное число попыток никогда не превышает 3.
          expect(previousAttempts).toBeLessThanOrEqual(limit);
          expect(previousAttempts).toBeLessThanOrEqual(MAX_DELIVERY_MAX_ATTEMPTS);
        },
      ),
      { numRuns: 300 },
    );
  });
});
