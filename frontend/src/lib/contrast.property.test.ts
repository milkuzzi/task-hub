import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { contrastRatio, relativeLuminance } from './contrast';

/**
 * Генератор одного канала sRGB (0..255).
 */
const channel = fc.integer({ min: 0, max: 255 });

/**
 * Преобразует тройку каналов в нормализованный hex-цвет `#rrggbb`.
 */
function toHex(r: number, g: number, b: number): string {
  const part = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Генератор случайного hex-цвета формата `#rrggbb`.
 */
const hexColor = fc
  .tuple(channel, channel, channel)
  .map(([r, g, b]) => toHex(r, g, b));

// Feature: ui-ux-redesign, Property 1: Корректность функции контраста
describe('Property 1: Корректность функции контраста', () => {
  it('симметрична: contrastRatio(a, b) === contrastRatio(b, a)', () => {
    fc.assert(
      fc.property(hexColor, hexColor, (a, b) => {
        expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 12);
      }),
      { numRuns: 100 },
    );
  });

  it('даёт ровно 1 при равных цветах', () => {
    fc.assert(
      fc.property(hexColor, (a) => {
        expect(contrastRatio(a, a)).toBeCloseTo(1, 12);
      }),
      { numRuns: 100 },
    );
  });

  it('всегда находится в диапазоне [1, 21]', () => {
    fc.assert(
      fc.property(hexColor, hexColor, (a, b) => {
        const ratio = contrastRatio(a, b);
        expect(ratio).toBeGreaterThanOrEqual(1);
        expect(ratio).toBeLessThanOrEqual(21);
      }),
      { numRuns: 100 },
    );
  });

  it('монотонна: затемнение более тёмного цвета относительно общего светлого фона не уменьшает контраст', () => {
    fc.assert(
      fc.property(hexColor, hexColor, fc.integer({ min: 1, max: 255 }), (bg, fg, delta) => {
        // Светлый фон — более яркий из двух цветов; тёмный — менее яркий.
        const lightBg = relativeLuminance(bg) >= relativeLuminance(fg) ? bg : fg;
        const dark = lightBg === bg ? fg : bg;

        const { r, g, b } = {
          r: Number.parseInt(dark.slice(1, 3), 16),
          g: Number.parseInt(dark.slice(3, 5), 16),
          b: Number.parseInt(dark.slice(5, 7), 16),
        };
        // Затемняем тёмный цвет (уменьшаем каждый канал, не ниже 0).
        const darker = toHex(
          Math.max(0, r - delta),
          Math.max(0, g - delta),
          Math.max(0, b - delta),
        );

        const before = contrastRatio(lightBg, dark);
        const after = contrastRatio(lightBg, darker);
        // Допуск на численную погрешность с плавающей точкой.
        expect(after).toBeGreaterThanOrEqual(before - 1e-9);
      }),
      { numRuns: 100 },
    );
  });
});
