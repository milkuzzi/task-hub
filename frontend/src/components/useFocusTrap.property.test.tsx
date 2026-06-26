import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { useFocusTrap } from './useFocusTrap';

/**
 * jsdom не реализует движок раскладки, поэтому `offsetWidth`/`offsetHeight`/
 * `getClientRects()` всегда сообщают о нулевом размере, и хук счёл бы любой
 * элемент невидимым. Подменяем `getClientRects`, чтобы элементы считались
 * видимыми (как в настоящем браузере) — это позволяет проверить логику
 * захвата фокуса, не завися от отсутствующей в jsdom раскладки.
 */
let originalGetClientRects: typeof HTMLElement.prototype.getClientRects;

beforeAll(() => {
  originalGetClientRects = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
  };
});

afterAll(() => {
  HTMLElement.prototype.getClientRects = originalGetClientRects;
});

/**
 * Тестовый каркас: кнопка-«открыватель» вне модального окна и контейнер с
 * настраиваемым числом фокусируемых кнопок внутри. Хук `useFocusTrap`
 * управляет захватом фокуса по контракту дизайна.
 *
 * - Нажатие на «открыватель» открывает окно (фокус в этот момент на кнопке,
 *   поэтому она сохраняется как «открывающий» элемент).
 * - `onEscape` закрывает окно (как в реальных диалогах), что приводит к
 *   возврату фокуса открывающему элементу.
 */
function TrapHarness({ count }: { count: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useFocusTrap({
    active: open,
    containerRef,
    onEscape: () => setOpen(false),
  });

  return (
    <>
      <button
        type="button"
        data-testid="opener"
        onClick={() => setOpen(true)}
      >
        Открыть
      </button>
      {open && (
        <div ref={containerRef} role="dialog" aria-modal="true" data-testid="container">
          {Array.from({ length: count }, (_, index) => (
            <button type="button" key={index} data-testid={`btn-${index}`}>
              Кнопка {index}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

describe('useFocusTrap — Property 11', () => {
  // Feature: ui-ux-redesign, Property 11: Захват и возврат фокуса в модальном окне
  // Validates: Requirements 11.3, 11.4, 11.5
  it('удерживает фокус внутри окна, закрывает по Escape и возвращает фокус открывающему элементу', () => {
    fc.assert(
      fc.property(
        // случайное число фокусируемых элементов внутри окна
        fc.integer({ min: 0, max: 6 }),
        // исходное состояние фокуса перед Escape: внутри окна или снаружи
        fc.boolean(),
        (count, focusInsideBeforeEscape) => {
          const { unmount } = render(<TrapHarness count={count} />);

          try {
            const opener = document.querySelector<HTMLElement>(
              '[data-testid="opener"]',
            );
            expect(opener).not.toBeNull();

            // Открыватель в фокусе на момент открытия — он станет «открывающим».
            act(() => {
              opener!.focus();
            });
            expect(document.activeElement).toBe(opener);

            // Открываем окно: хук переносит фокус внутрь контейнера.
            fireEvent.click(opener!);

            const container = document.querySelector<HTMLElement>(
              '[data-testid="container"]',
            );
            expect(container).not.toBeNull();

            const buttons = Array.from(
              container!.querySelectorAll<HTMLElement>('[data-testid^="btn-"]'),
            );
            expect(buttons).toHaveLength(count);

            if (count > 0) {
              // count > 0 гарантирует наличие первого и последнего элементов.
              const first = buttons[0]!;
              const last = buttons[buttons.length - 1]!;

              // При активации фокус перемещён на первый фокусируемый элемент.
              expect(document.activeElement).toBe(first);

              // Tab за последним элементом → фокус возвращается на первый.
              act(() => {
                last.focus();
              });
              fireEvent.keyDown(document.activeElement ?? document.body, {
                key: 'Tab',
              });
              expect(document.activeElement).toBe(first);

              // Shift+Tab перед первым элементом → фокус переходит на последний.
              act(() => {
                first.focus();
              });
              fireEvent.keyDown(document.activeElement ?? document.body, {
                key: 'Tab',
                shiftKey: true,
              });
              expect(document.activeElement).toBe(last);
            } else {
              // Без фокусируемых элементов фокус удерживается на контейнере.
              expect(document.activeElement).toBe(container);
            }

            // Escape должен закрывать окно независимо от расположения фокуса.
            if (!focusInsideBeforeEscape) {
              act(() => {
                (document.activeElement as HTMLElement | null)?.blur();
                document.body.focus();
              });
            }

            fireEvent.keyDown(document.activeElement ?? document.body, {
              key: 'Escape',
            });

            // Окно закрыто (контейнер удалён из DOM).
            expect(
              document.querySelector('[data-testid="container"]'),
            ).toBeNull();

            // При закрытии фокус возвращается открывающему элементу.
            expect(document.activeElement).toBe(opener);
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
