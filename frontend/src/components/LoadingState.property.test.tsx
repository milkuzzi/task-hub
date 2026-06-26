import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { LoadingState } from './LoadingState';

afterEach(() => {
  cleanup();
});

describe('LoadingState — Property 14', () => {
  // Feature: ui-ux-redesign, Property 14: LoadingState предоставляет статус для скринридеров
  // Validates: Requirements 15.2
  it('предоставляет область статуса с непустым текстом одновременно с визуальным индикатором', () => {
    fc.assert(
      fc.property(
        // Подпись передаётся уже локализованной и непустой (из ru.ts).
        // Генерируем непустые строки с хотя бы одним непробельным символом.
        fc
          .string({ minLength: 1 })
          .filter((value) => value.trim().length > 0),
        (label) => {
          const { container } = render(<LoadingState label={label} />);

          try {
            // Область со статусной семантикой присутствует:
            // role="status" и aria-live одновременно.
            const status = container.querySelector('[role="status"]');
            expect(status).not.toBeNull();
            expect(status!.getAttribute('aria-live')).toBeTruthy();

            // Непустой текст состояния доступен скринридерам одновременно
            // с областью статуса: переданная подпись отрендерена дословно.
            const labelNode = status!.querySelector('.loading-state__label');
            expect(labelNode).not.toBeNull();
            expect(labelNode!.textContent).toBe(label);
            expect(status!.textContent?.trim()).toBeTruthy();

            // Визуальный индикатор (спиннер) присутствует одновременно с текстом.
            const spinner = status!.querySelector('.spinner');
            expect(spinner).not.toBeNull();
            expect(spinner!.getAttribute('aria-hidden')).toBe('true');
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
