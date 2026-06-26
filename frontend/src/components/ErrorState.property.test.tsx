import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ErrorState } from './ErrorState';

/**
 * Свойство 16: `ErrorState` отображает переданное сообщение об ошибке и
 * показывает действие «Повторить» тогда и только тогда, когда передан
 * обработчик `onRetry`.
 *
 * i18next инициализируется глобально в `src/test/setup.ts` (локаль `ru`),
 * поэтому `useTranslation` внутри компонента возвращает реальную подпись
 * `common.retry` = «Повторить» без дополнительного провайдера.
 */
describe('ErrorState — Property 16', () => {
  // Feature: ui-ux-redesign, Property 16: ErrorState отображает сообщение и условный повтор
  // Validates: Requirements 16.1, 16.2
  it('отображает сообщение и показывает «Повторить» тогда и только тогда, когда передан onRetry', () => {
    fc.assert(
      fc.property(
        // случайное сообщение об ошибке с видимым содержимым
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        // наличие/отсутствие обработчика повтора
        fc.boolean(),
        (message, hasRetry) => {
          // С `exactOptionalPropertyTypes` нельзя передавать `onRetry={undefined}`
          // явно — собираем пропсы условно, не меняя смысла проверки.
          const { container, unmount } = render(
            hasRetry ? (
              <ErrorState message={message} onRetry={() => undefined} />
            ) : (
              <ErrorState message={message} />
            ),
          );

          try {
            // Сообщение всегда отображается без искажений (Req 16.1).
            const alert = screen.getByRole('alert');
            expect(alert).not.toBeNull();
            const messageEl = container.querySelector('.error-state__message');
            expect(messageEl).not.toBeNull();
            expect(messageEl?.textContent).toBe(message);

            // Кнопка «Повторить» присутствует ⇔ передан onRetry (Req 16.2).
            const retryButton = screen.queryByRole('button', {
              name: 'Повторить',
            });
            if (hasRetry) {
              expect(retryButton).not.toBeNull();
            } else {
              expect(retryButton).toBeNull();
            }
          } finally {
            unmount();
            cleanup();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
