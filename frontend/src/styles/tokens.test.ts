import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Юнит-тесты слоя токенов оформления (задача 2.2).
 *
 * Источник истины — `frontend/src/styles/global.css`. Тест читает файл как
 * текст, извлекает первый блок `:root { … }` и проверяет обязательные
 * операционные роли токенов, шрифтовой стек, наличие двух уровней теней,
 * токена фокуса, токенов длительности/функции сглаживания и ≥5 уровней
 * `--fs-*`.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.3, 2.4, 2.5, 3.1, 17.4
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'global.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Извлекает содержимое первого блока `:root { … }` (без вложенных media-query).
 * Падает с понятным сообщением, если блок не найден.
 */
function extractRootBlock(source: string): string {
  const start = source.indexOf(':root');
  if (start === -1) {
    throw new Error('В global.css не найден блок :root');
  }
  const open = source.indexOf('{', start);
  if (open === -1) {
    throw new Error('Не удалось найти открывающую скобку блока :root');
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error('Не удалось найти закрывающую скобку блока :root');
}

const root = extractRootBlock(css);

/**
 * Возвращает значение токена `--name` из переданного блока CSS или `null`.
 */
function tokenValue(block: string, name: string): string | null {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1]!.trim() : null;
}

describe('Слой токенов :root в global.css', () => {
  it('defines required operational color roles', () => {
    const required = [
      '--color-bg',
      '--color-surface',
      '--color-surface-2',
      '--color-border',
      '--color-border-strong',
      '--color-text',
      '--color-muted',
      '--color-muted-strong',
      '--color-primary',
      '--color-primary-contrast',
      '--color-danger',
      '--color-success',
      '--color-warning',
      '--focus-ring',
    ];

    for (const token of required) {
      expect(tokenValue(root, token), token).not.toBeNull();
    }
  });

  it('системный шрифтовой стек (Req 3.1)', () => {
    const fontFamily = root.match(/font-family\s*:\s*([^;]+);/);
    expect(fontFamily).not.toBeNull();
    const stack = fontFamily![1];
    expect(stack).toContain('system-ui');
    expect(stack).toMatch(/-apple-system/);
    expect(stack).toMatch(/sans-serif\s*$/);
  });

  it('два уровня теней (Req 2.3)', () => {
    expect(tokenValue(root, '--shadow-surface')).not.toBeNull();
    expect(tokenValue(root, '--shadow-popover')).not.toBeNull();
  });

  it('токен фокус-кольца (Req 2.4)', () => {
    expect(tokenValue(root, '--focus-ring')).not.toBeNull();
  });

  it('токены длительности и функции сглаживания движения (Req 17.4)', () => {
    const fast = tokenValue(root, '--motion-fast');
    const base = tokenValue(root, '--motion-base');
    const ease = tokenValue(root, '--ease-standard');
    expect(fast).toMatch(/^\d+ms$/);
    expect(base).toMatch(/^\d+ms$/);
    expect(ease).toMatch(/cubic-bezier\(/);
  });

  it('операционные тинты заданы именованными токенами (Req 2.5)', () => {
    expect(tokenValue(root, '--tint-primary')).not.toBeNull();
    expect(tokenValue(root, '--tint-danger')).not.toBeNull();
    expect(tokenValue(root, '--tint-success')).not.toBeNull();
  });

  it('не менее пяти уровней --fs-* (Req 3.1)', () => {
    const levels = root.match(/--fs-[a-z0-9]+\s*:/g) ?? [];
    const unique = new Set(levels.map((entry) => entry.replace(/\s*:$/, '')));
    expect(unique.size).toBeGreaterThanOrEqual(5);
  });
});
