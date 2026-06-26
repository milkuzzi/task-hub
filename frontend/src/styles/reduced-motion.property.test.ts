import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

/**
 * Источник истины — единственный файл стилей `global.css`, лежащий рядом с
 * этим тестом. Читаем его как текст и разбираем блок
 * `@media (prefers-reduced-motion: reduce)`.
 */
const stylesDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(stylesDir, 'global.css'), 'utf8');

/**
 * Извлекает содержимое блока `@media (prefers-reduced-motion: reduce) { … }`.
 * Падает с понятным сообщением, если блок не найден или не сбалансирован —
 * инвариант Req 17.3/15.4 не должен молча обходиться.
 */
function extractReducedMotionBlock(source: string): string {
  // Требуем `{` сразу после `(... prefers-reduced-motion: reduce)`, чтобы не
  // зацепить упоминание в комментарии (там после `)` идёт обратная кавычка).
  const match = source.match(
    /@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)\s*\{/,
  );
  if (!match || match.index === undefined) {
    throw new Error('Не найден блок @media (prefers-reduced-motion: reduce) в global.css');
  }
  const braceStart = source.indexOf('{', match.index);
  if (braceStart === -1) {
    throw new Error(
      'Не найдена открывающая скобка блока prefers-reduced-motion в global.css',
    );
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
  throw new Error(
    'Не найдена закрывающая скобка блока prefers-reduced-motion в global.css',
  );
}

/**
 * Парсит значение длительности в миллисекундах из строки вида `0.001ms`, `0s`
 * или `0`. Возвращает число в мс. Падает с понятным сообщением на
 * неразбираемом значении (а не молча пропускает его).
 */
function parseDurationMs(raw: string): number {
  const value = raw.replace(/!important/g, '').trim();
  if (/^0+(\.0+)?$/.test(value)) {
    return 0;
  }
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

const reducedMotionBlock = extractReducedMotionBlock(css);

/**
 * Извлекает все объявления `transition-duration` и `animation-duration` из
 * блока reduced-motion. Падает, если ни одного такого объявления нет — это
 * означало бы, что движение не отключается.
 */
function extractDurationDeclarations(
  block: string,
): { property: string; ms: number }[] {
  const declarations: { property: string; ms: number }[] = [];
  const regex = /(transition-duration|animation-duration)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(block)) !== null) {
    declarations.push({ property: match[1]!, ms: parseDurationMs(match[2]!) });
  }
  if (declarations.length === 0) {
    throw new Error(
      'В блоке prefers-reduced-motion не найдено ни одного объявления ' +
        'transition-duration/animation-duration — движение не отключается',
    );
  }
  return declarations;
}

const durationDeclarations = extractDurationDeclarations(reducedMotionBlock);

/** Порог «фактического нуля»: 0.001ms задаётся в CSS, считаем ≤ 1ms нулём. */
const EFFECTIVELY_ZERO_MS = 1;

// Feature: ui-ux-redesign, Property 9: Reduced-motion отключает нефункциональное движение
describe('Property 9: Reduced-motion отключает нефункциональное движение', () => {
  it('каждая длительность перехода/анимации в reduced-motion блоке фактически нулевая (≈0)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...durationDeclarations), (declaration) => {
        expect(declaration.ms).toBeGreaterThanOrEqual(0);
        expect(declaration.ms).toBeLessThanOrEqual(EFFECTIVELY_ZERO_MS);
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 17.3, 15.4
});
