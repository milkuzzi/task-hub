import { useEffect, type RefObject } from 'react';

/**
 * Опции хука захвата фокуса для модальных окон (Req 11.2–11.5, 20.1).
 */
export interface FocusTrapOptions {
  /** Активен ли захват (окно открыто). */
  active: boolean;
  /** Контейнер модального окна. */
  containerRef: RefObject<HTMLElement>;
  /** Вызывается при нажатии Escape (Req 11.4). */
  onEscape: () => void;
}

/**
 * Стандартный селектор фокусируемых элементов. Видимость дополнительно
 * проверяется в `getFocusableElements`.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Виден ли элемент (не скрыт через display/visibility и имеет размеры).
 * `offsetParent === null` ловит `display:none`; дополнительно проверяем
 * `visibility`/`hidden`, чтобы не переводить фокус на невидимые элементы.
 */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden) {
    return false;
  }
  if (element.offsetWidth <= 0 && element.offsetHeight <= 0 && element.getClientRects().length === 0) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none') {
    return false;
  }
  return true;
}

/**
 * Возвращает видимые фокусируемые элементы внутри контейнера в порядке DOM.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter(isVisible);
}

/**
 * Хук захвата фокуса для модальных окон.
 *
 * Контракт (Req 11.2–11.5, 20.1):
 * 1. При активации сохраняет `document.activeElement` («открывающий» элемент) и
 *    переводит фокус на первый фокусируемый элемент внутри контейнера. Если
 *    фокусируемых элементов нет — фокусирует сам контейнер (`tabindex="-1"`).
 * 2. Перехватывает `Tab`/`Shift+Tab`, циклически удерживая фокус внутри
 *    контейнера (focus trap).
 * 3. По `Escape` вызывает `onEscape` независимо от того, удалось ли перевести
 *    фокус внутрь окна (обработчик на документе).
 * 4. При деактивации возвращает фокус «открывающему» элементу, если он ещё в DOM.
 */
export function useFocusTrap(options: FocusTrapOptions): void {
  const { active, containerRef, onEscape } = options;

  // Активация/деактивация: сохранение и возврат фокуса. Завязано только на
  // `active`, чтобы возврат фокуса происходил ровно один раз при закрытии и не
  // сбрасывался на каждый ре-рендер (например, при вводе текста в поле).
  useEffect(() => {
    if (!active) {
      return;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const container = containerRef.current;
    if (container) {
      const focusable = getFocusableElements(container);
      const firstFocusable = focusable[0];
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        // Нет фокусируемых элементов — переводим фокус на сам контейнер,
        // сохраняя инвариант «фокус внутри окна».
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus();
      }
    }

    return () => {
      // Возврат фокуса открывающему элементу, если он ещё присутствует в DOM.
      if (opener && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [active, containerRef]);

  // Перехват Tab/Shift+Tab (focus trap) и Escape. Escape обрабатывается на
  // документе и вызывает onEscape независимо от успешности захвата фокуса.
  useEffect(() => {
    if (!active) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onEscape();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const focusable = getFocusableElements(container);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Нет фокусируемых элементов — удерживаем фокус на контейнере.
        event.preventDefault();
        container.focus();
        return;
      }

      const activeElement = document.activeElement;

      if (event.shiftKey) {
        // Shift+Tab перед первым элементом → переходим на последний.
        if (activeElement === first || !container.contains(activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab за последним элементом → переходим на первый.
        if (activeElement === last || !container.contains(activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, containerRef, onEscape]);
}
