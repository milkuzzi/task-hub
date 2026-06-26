import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { EmptyState } from './EmptyState';

// Feature: ui-ux-redesign, Property 13: EmptyState отображает сообщение и условное действие

afterEach(() => {
  cleanup();
});

/**
 * Property 13: EmptyState отображает сообщение и условное действие.
 *
 * Для любой строки сообщения компонент рендерит её как поясняющий текст
 * (`.empty-state__message`); кнопка действия (`.btn--primary`) рендерится
 * тогда и только тогда, когда передан проп `action`.
 *
 * Validates: Requirements 14.1, 14.4
 */
describe('EmptyState — Property 13', () => {
  it('рендерит сообщение и условное действие для произвольных входов', () => {
    fc.assert(
      fc.property(
        // Непустые произвольные строки сообщений: пустое сообщение не имеет
        // смысла для пустого состояния и не покрывается требованием 14.1.
        fc.string({ minLength: 1 }),
        // Наличие/отсутствие действия + произвольная подпись действия.
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (message, actionLabel) => {
          const action =
            actionLabel === undefined
              ? undefined
              : { label: actionLabel, onClick: () => {} };

          // С `exactOptionalPropertyTypes` нельзя передавать `action={undefined}`
          // явно — собираем пропсы условно, сохраняя смысл проверки.
          const { container } = render(
            action === undefined ? (
              <EmptyState message={message} />
            ) : (
              <EmptyState message={message} action={action} />
            ),
          );

          // Сообщение всегда отрисовано как поясняющий текст.
          const messageEl = container.querySelector('.empty-state__message');
          expect(messageEl).not.toBeNull();
          expect(messageEl?.textContent).toBe(message);

          // Кнопка действия рендерится ⇔ передан action.
          const button = container.querySelector('button.btn--primary');
          if (action === undefined) {
            expect(button).toBeNull();
          } else {
            expect(button).not.toBeNull();
            expect(button?.textContent).toBe(action.label);
          }

          cleanup();
        },
      ),
      { numRuns: 100 },
    );
  });
});
