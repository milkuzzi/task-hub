import { DeliveryStatus, NotificationType } from '@prisma/client';
import {
  ACCOUNT_RETRY_INTERVAL_MS,
  MAX_DELIVERY_MAX_ATTEMPTS,
  MESSAGE_RETRY_INTERVAL_MS,
  TASK_RETRY_INTERVAL_MS,
  classifyNotification,
  decideMaxDeliveryOnFailure,
  hasExhaustedMaxAttempts,
  maxRetryIntervalMs,
} from './delivery-policy';

describe('delivery-policy', () => {
  describe('classifyNotification', () => {
    it('относит уведомление о Сообщении Чата к классу message (Req 14.6)', () => {
      expect(classifyNotification(NotificationType.CHAT_MESSAGE)).toBe('message');
    });

    it('относит уведомления по аккаунту/роли к классу account (Req 15.7)', () => {
      expect(classifyNotification(NotificationType.MANAGER_ROLE_CHANGED)).toBe('account');
      expect(classifyNotification(NotificationType.ADMIN_TRANSFER)).toBe('account');
      expect(classifyNotification(NotificationType.ACCOUNT_REGISTRATION)).toBe('account');
    });

    it('относит события Задачи и напоминания к классу task (Req 13.13)', () => {
      const taskTypes = [
        NotificationType.TASK_ASSIGNED,
        NotificationType.TASK_UNASSIGNED,
        NotificationType.TASK_FIELD_CHANGED,
        NotificationType.TASK_STATUS_CHANGED,
        NotificationType.TASK_REOPENED,
        NotificationType.TASK_CANCELLED,
        NotificationType.TASK_RETURNED,
        NotificationType.DEADLINE_REMINDER_FAR,
        NotificationType.DEADLINE_REMINDER_NEAR,
      ];
      for (const type of taskTypes) {
        expect(classifyNotification(type)).toBe('task');
      }
    });
  });

  describe('maxRetryIntervalMs', () => {
    it('5 минут для уведомлений о Задаче (Req 13.13)', () => {
      expect(maxRetryIntervalMs(NotificationType.TASK_STATUS_CHANGED)).toBe(TASK_RETRY_INTERVAL_MS);
      expect(TASK_RETRY_INTERVAL_MS).toBe(300_000);
    });

    it('5 секунд для уведомлений о Сообщении Чата (Req 14.6)', () => {
      expect(maxRetryIntervalMs(NotificationType.CHAT_MESSAGE)).toBe(MESSAGE_RETRY_INTERVAL_MS);
      expect(MESSAGE_RETRY_INTERVAL_MS).toBe(5_000);
    });

    it('30 секунд для уведомлений по аккаунту/роли (Req 15.7)', () => {
      expect(maxRetryIntervalMs(NotificationType.MANAGER_ROLE_CHANGED)).toBe(
        ACCOUNT_RETRY_INTERVAL_MS,
      );
      expect(ACCOUNT_RETRY_INTERVAL_MS).toBe(30_000);
    });
  });

  describe('hasExhaustedMaxAttempts', () => {
    it('истинно при достижении максимума попыток (≤3, Req 13.13/14.6/15.7)', () => {
      expect(hasExhaustedMaxAttempts(MAX_DELIVERY_MAX_ATTEMPTS)).toBe(true);
      expect(hasExhaustedMaxAttempts(MAX_DELIVERY_MAX_ATTEMPTS + 1)).toBe(true);
    });

    it('ложно, пока попытки не исчерпаны', () => {
      expect(hasExhaustedMaxAttempts(0)).toBe(false);
      expect(hasExhaustedMaxAttempts(MAX_DELIVERY_MAX_ATTEMPTS - 1)).toBe(false);
    });
  });

  describe('decideMaxDeliveryOnFailure', () => {
    it('планирует ретрай со статусом RETRY и интервалом по типу, пока попытки не исчерпаны', () => {
      const decision = decideMaxDeliveryOnFailure(NotificationType.TASK_STATUS_CHANGED, 0);
      expect(decision.attemptsMade).toBe(1);
      expect(decision.shouldRetry).toBe(true);
      expect(decision.status).toBe(DeliveryStatus.RETRY);
      expect(decision.retryDelayMs).toBe(TASK_RETRY_INTERVAL_MS);
    });

    it('при исчерпании попыток назначает FAILED без планирования ретрая', () => {
      const decision = decideMaxDeliveryOnFailure(
        NotificationType.CHAT_MESSAGE,
        MAX_DELIVERY_MAX_ATTEMPTS - 1,
      );
      expect(decision.attemptsMade).toBe(MAX_DELIVERY_MAX_ATTEMPTS);
      expect(decision.shouldRetry).toBe(false);
      expect(decision.status).toBe(DeliveryStatus.FAILED);
      expect(decision.retryDelayMs).toBeNull();
    });

    it('число попыток доставки ограничено максимумом (свойство 3)', () => {
      // Симулируем последовательность сбоев и считаем фактические попытки.
      let previousAttempts = 0;
      let attempts = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempts += 1;
        const decision = decideMaxDeliveryOnFailure(
          NotificationType.MANAGER_ROLE_CHANGED,
          previousAttempts,
        );
        previousAttempts = decision.attemptsMade;
        if (!decision.shouldRetry) {
          break;
        }
        // защита от бесконечного цикла в случае регрессии политики
        expect(attempts).toBeLessThanOrEqual(MAX_DELIVERY_MAX_ATTEMPTS);
      }
      expect(attempts).toBe(MAX_DELIVERY_MAX_ATTEMPTS);
      expect(previousAttempts).toBe(MAX_DELIVERY_MAX_ATTEMPTS);
    });
  });
});
