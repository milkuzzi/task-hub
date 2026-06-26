import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

/**
 * Источник истины — единственный файл стилей global.css. Структурный
 * property-тест разбирает его как текст и падает с понятным сообщением, если
 * шкала отступов не разобрана (а не молча пропускает токены). Путь резолвится
 * относительно корня пакета frontend (рабочая директория Vitest).
 */
function readGlobalCss(): string {
  const candidates = [
    resolve(process.cwd(), 'src/styles/global.css'),
    resolve(process.cwd(), 'frontend/src/styles/global.css'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // пробуем следующий путь
    }
  }
  throw new Error(
    `Не удалось прочитать global.css ни по одному из путей: ${candidates.join(', ')}`,
  );
}

const css = readGlobalCss();

/**
 * Допустимое множество значений шкалы отступов (Req 4.1): положительные
 * кратные 4px из дизайна.
 */
const ALLOWED = new Set([4, 8, 12, 16, 24, 32, 48]);

/**
 * Разбирает токены `--space-*` со значением в пикселях из global.css.
 * Алиас `--gap` исключается: он ссылается на `var(--space-4)`, а не на px-литерал.
 */
function parseSpaceTokens(source: string): Array<{ name: string; value: number }> {
  const tokens: Array<{ name: string; value: number }> = [];
  // Имя токена начинается с --space-, значение — целое число пикселей.
  const re = /(--space-[\w-]+)\s*:\s*(\d+)px\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    tokens.push({ name: match[1]!, value: Number.parseInt(match[2]!, 10) });
  }
  return tokens;
}

const spaceTokens = parseSpaceTokens(css);

// Feature: ui-ux-redesign, Property 5: Шкала отступов кратна 4px
describe('Property 5: Шкала отступов кратна 4px', () => {
  it('находит токены шкалы отступов в global.css', () => {
    // Если шкала не разобрана, инвариант Req 4.1 нельзя проверить — падаем явно.
    expect(spaceTokens.length).toBeGreaterThan(0);
  });

  it('каждый токен --space-* — положительное кратное 4px из множества {4,8,12,16,24,32,48}', () => {
    fc.assert(
      fc.property(fc.constantFrom(...spaceTokens), (token) => {
        expect(token.value).toBeGreaterThan(0);
        expect(token.value % 4).toBe(0);
        expect(ALLOWED.has(token.value)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
