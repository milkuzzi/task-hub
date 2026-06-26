import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

/**
 * Источник истины — единственный файл стилей `global.css`. Читаем его как текст
 * рядом с этим тестом и разбираем объявления токенов радиусов.
 */
const stylesDir = dirname(fileURLToPath(import.meta.url));
const cssText = readFileSync(join(stylesDir, 'global.css'), 'utf8');

/**
 * Разбирает токены радиусов из `:root`.
 *
 * Возвращает только токены вида `--radius-<name>: <number>px`, у которых
 * значение задано числовым пиксельным литералом. Исключаются:
 *  - `--radius-pill` — пилюля для бейджей (запрет >16px к ней не относится);
 *  - алиас `--radius` — он ссылается на `var(--radius-sm)`, а не на литерал,
 *    поэтому не попадает под регулярное выражение пиксельного значения.
 *
 * Радиусы, применяемые к карточкам/кнопкам/полям/модалкам, — это именно
 * числовые токены `--radius-sm/md/lg`.
 */
function parseRadiusTokens(css: string): Array<{ name: string; value: number }> {
  const tokens: Array<{ name: string; value: number }> = [];
  const re = /(--radius-[a-z0-9]+)\s*:\s*(\d+)px\s*;/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const name = match[1]!;
    if (name === '--radius-pill') {
      continue;
    }
    tokens.push({ name, value: Number.parseInt(match[2]!, 10) });
  }
  return tokens;
}

const radiusTokens = parseRadiusTokens(cssText);

// Feature: ui-ux-redesign, Property 4: Радиусы скругления в пределах 8–16px
describe('Property 4: Радиусы скругления в пределах 8–16px', () => {
  it('разбирает хотя бы один радиус-токен (кроме --radius-pill)', () => {
    // Защита от «молчаливого» прохождения, если парсинг ничего не нашёл.
    expect(radiusTokens.length).toBeGreaterThan(0);
  });

  it('все радиус-токены карточек/кнопок/полей/модалок удовлетворяют 8 ≤ value ≤ 16', () => {
    fc.assert(
      fc.property(fc.constantFrom(...radiusTokens), (token) => {
        expect(token.value).toBeGreaterThanOrEqual(8);
        expect(token.value).toBeLessThanOrEqual(16);
      }),
      { numRuns: 100 },
    );
  });
});
