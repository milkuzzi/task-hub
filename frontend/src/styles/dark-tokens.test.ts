import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Юнит-тесты тёмной схемы и дефолта (задача 3.7).
 *
 * Источник истины — `frontend/src/styles/global.css`. Тест читает файл как
 * текст, извлекает блок тёмной схемы `@media (prefers-color-scheme: dark)`
 * и базовый `:root`, после чего проверяет инварианты:
 *   1. тёмная схема переопределяет тот же набор операционных ролей;
 *   2. базовая и тёмная темы материально различаются;
 *   3. токены бейджей в тёмной схеме присутствуют и остаются hex-цветами.
 *
 * Requirements: 18.1, 18.7
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'global.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Извлекает содержимое блока `{ … }`, начиная поиск открывающей скобки от
 * позиции `from`. Возвращает содержимое блока и индекс закрывающей скобки.
 * Падает с понятным сообщением, если скобки не сбалансированы.
 */
function extractBlock(source: string, from: number): { body: string; end: number } {
  const open = source.indexOf('{', from);
  if (open === -1) {
    throw new Error('Не удалось найти открывающую скобку блока');
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(open + 1, i), end: i };
      }
    }
  }
  throw new Error('Не удалось найти закрывающую скобку блока');
}

/**
 * Извлекает базовый блок `:root { … }` (первый, вне media-query).
 */
function extractBaseRoot(source: string): string {
  const start = source.indexOf(':root');
  if (start === -1) {
    throw new Error('В global.css не найден базовый блок :root');
  }
  return extractBlock(source, start).body;
}

/**
 * Извлекает тело media-query `@media (prefers-color-scheme: dark) { … }`.
 */
function extractDarkMedia(source: string): string {
  const match = source.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/);
  if (!match || match.index === undefined) {
    throw new Error('В global.css не найден блок @media (prefers-color-scheme: dark)');
  }
  return extractBlock(source, match.index).body;
}

/**
 * Возвращает значение токена `--name` из переданного блока CSS или `null`.
 */
function tokenValue(block: string, name: string): string | null {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? match[1]!.trim() : null;
}

const baseRoot = extractBaseRoot(css);
const darkMedia = extractDarkMedia(css);
// Внутри media-query тёмные значения объявлены в `:root { … }`.
const darkRoot = extractBlock(darkMedia, darkMedia.indexOf(':root')).body;

describe('Тёмная схема и дефолт light в global.css', () => {
  it('dark theme overrides the same operational roles as light theme', () => {
    const roles = [
      '--color-bg',
      '--color-surface',
      '--color-surface-2',
      '--color-border',
      '--color-text',
      '--color-muted',
      '--color-primary',
      '--sidebar-brand-fg',
      '--sidebar-user-fg',
    ];

    for (const token of roles) {
      expect(tokenValue(darkRoot, token), token).not.toBeNull();
    }
  });

  it('base light theme and dark theme are materially different', () => {
    expect(tokenValue(baseRoot, '--color-bg')).not.toBe(tokenValue(darkRoot, '--color-bg'));
    expect(tokenValue(baseRoot, '--color-surface')).not.toBe(tokenValue(darkRoot, '--color-surface'));
    expect(tokenValue(baseRoot, '--color-text')).not.toBe(tokenValue(darkRoot, '--color-text'));
  });

  it('dark badge tokens are present and remain hex colors', () => {
    const badgeTokens = [
      '--badge-in_progress-bg',
      '--badge-in_progress-fg',
      '--badge-waiting-bg',
      '--badge-waiting-fg',
      '--badge-done-bg',
      '--badge-done-fg',
      '--badge-needs_admin-bg',
      '--badge-needs_admin-fg',
      '--badge-cancelled-bg',
      '--badge-cancelled-fg',
    ];

    for (const token of badgeTokens) {
      const value = tokenValue(darkRoot, token);
      expect(value, token).not.toBeNull();
      expect(value).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });
});
