import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

/**
 * Источник истины — единственный файл стилей `global.css`, лежащий рядом с
 * этим тестом. Читаем его как текст и разбираем токены длительности движения.
 */
const stylesDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(stylesDir, 'global.css'), 'utf8');

/**
 * Извлекает блок `:root { … }` из CSS. Падает с понятным сообщением, если блок
 * не найден (инвариант не должен молча обходиться).
 */
function extractRootBlock(source: string): string {
  const start = source.indexOf(':root');
  if (start === -1) {
    throw new Error('Не найден блок :root в global.css');
  }
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error('Не найдена открывающая скобка блока :root в global.css');
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  throw new Error('Не найдена закрывающая скобка блока :root в global.css');
}

/**
 * Парсит значение длительности в миллисекундах из строки вида `140ms` или
 * `0.2s`. Возвращает число в мс. Падает на неразбираемом значении.
 */
function parseDurationMs(raw: string): number {
  const value = raw.trim();
  const msMatch = value.match(/^([\d.]+)ms$/);
  if (msMatch) {
    return Number.parseFloat(msMatch[1]!);
  }
  const sMatch = value.match(/^([\d.]+)s$/);
  if (sMatch) {
    return Number.parseFloat(sMatch[1]!) * 1000;
  }
  throw new Error(`Не удалось разобрать длительность движения: "${raw}"`);
}

/**
 * Токены длительности, применяемые к переходам наведения/фокуса (см. правила
 * `.btn`, `.field__input`, `.tab`, `.app-nav a` и др., использующие
 * `--motion-fast`/`--motion-base`), а также длительность появления модального
 * окна `--motion-modal`. Разбираются из блока `:root` global.css.
 */
const rootBlock = extractRootBlock(css);

const HOVER_FOCUS_DURATION_TOKENS = ['--motion-fast', '--motion-base', '--motion-modal'] as const;

const durationTokens: { name: string; ms: number }[] = HOVER_FOCUS_DURATION_TOKENS.map((name) => {
  const match = rootBlock.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match) {
    throw new Error(`Не найден токен длительности ${name} в :root global.css`);
  }
  return { name, ms: parseDurationMs(match[1]!) };
});

// Feature: ui-ux-redesign, Property 10: Длительности переходов наведения/фокуса в диапазоне 120–240ms
describe('Property 10: Длительности переходов наведения/фокуса в диапазоне 120–240ms', () => {
  it('каждый токен длительности hover/focus лежит в диапазоне 120ms ≤ value ≤ 240ms', () => {
    fc.assert(
      fc.property(fc.constantFrom(...durationTokens), (token) => {
        expect(token.ms).toBeGreaterThanOrEqual(120);
        expect(token.ms).toBeLessThanOrEqual(240);
      }),
      { numRuns: 100 },
    );
  });
});
