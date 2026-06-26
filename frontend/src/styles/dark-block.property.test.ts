import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

// Feature: ui-ux-redesign, Property 8: Тёмный блок переопределяет только токены

/**
 * Источник истины — единственный файл стилей `frontend/src/styles/global.css`,
 * лежащий рядом с этим тестом.
 */
const GLOBAL_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'global.css');

const DARK_MEDIA_MARKER = '@media (prefers-color-scheme: dark)';

/**
 * Удаляет блочные комментарии `/* ... *\/`, чтобы они не мешали разбору правил
 * (внутри комментариев встречаются фигурные скобки и слова, похожие на
 * селекторы).
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Извлекает внутреннее содержимое блока `@media (prefers-color-scheme: dark)`
 * посредством подсчёта баланса фигурных скобок. Согласно дизайну, при
 * невозможности разобрать блок функция БРОСАЕТ исключение с понятным
 * сообщением (а не молча возвращает пустоту), чтобы инвариант Req 18.5 не
 * обходился.
 */
function extractDarkMediaBlock(css: string): string {
  const markerIndex = css.indexOf(DARK_MEDIA_MARKER);
  if (markerIndex === -1) {
    throw new Error(
      `Не найден блок "${DARK_MEDIA_MARKER}" в global.css — тёмная схема отсутствует или объявлена иначе.`,
    );
  }

  const braceStart = css.indexOf('{', markerIndex + DARK_MEDIA_MARKER.length);
  if (braceStart === -1) {
    throw new Error(
      `Не удалось разобрать тёмный блок: после "${DARK_MEDIA_MARKER}" не найдена открывающая скобка "{".`,
    );
  }

  let depth = 0;
  let i = braceStart;
  for (; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }

  if (depth !== 0) {
    throw new Error(
      'Не удалось разобрать тёмный блок: фигурные скобки @media не сбалансированы (блок не закрыт).',
    );
  }

  return css.slice(braceStart + 1, i);
}

/**
 * Разбирает правила вида `selector { ... }` внутри переданного содержимого
 * media-блока и возвращает список селекторов. При обнаружении неразбираемого
 * фрагмента (висящий селектор без блока, незакрытое правило, пустой селектор)
 * БРОСАЕТ исключение с понятным сообщением — правило не пропускается молча.
 */
function parseSelectors(blockContent: string): string[] {
  const selectors: string[] = [];
  const length = blockContent.length;
  let i = 0;

  while (i < length) {
    // Пропускаем ведущие пробелы и точки с запятой между правилами.
    while (i < length && /[\s;]/.test(blockContent[i]!)) {
      i += 1;
    }
    if (i >= length) {
      break;
    }

    const braceOpen = blockContent.indexOf('{', i);
    if (braceOpen === -1) {
      const leftover = blockContent.slice(i).trim();
      throw new Error(
        `Не удалось разобрать правило в тёмном блоке: висящий фрагмент без блока объявлений: "${leftover}".`,
      );
    }

    const selector = blockContent.slice(i, braceOpen).trim();
    if (selector.length === 0) {
      throw new Error(
        'Не удалось разобрать правило в тёмном блоке: обнаружен пустой селектор перед "{".',
      );
    }

    let depth = 0;
    let j = braceOpen;
    for (; j < length; j += 1) {
      const ch = blockContent[j];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }

    if (depth !== 0) {
      throw new Error(
        `Не удалось разобрать правило в тёмном блоке: правило для селектора "${selector}" не закрыто "}".`,
      );
    }

    selectors.push(selector);
    i = j + 1;
  }

  return selectors;
}

describe('Property 8: Тёмный блок переопределяет только токены', () => {
  const css = stripComments(readFileSync(GLOBAL_CSS_PATH, 'utf8'));
  const darkBlock = extractDarkMediaBlock(css);
  const selectors = parseSelectors(darkBlock);

  it('тёмный блок содержит хотя бы одно правило для разбора', () => {
    // Защита от ложного «зелёного» прогона при пустом или нераспознанном блоке.
    expect(selectors.length).toBeGreaterThan(0);
  });

  it('каждый селектор внутри @media (prefers-color-scheme: dark) равен :root', () => {
    fc.assert(
      fc.property(fc.constantFrom(...selectors), (selector) => {
        expect(selector).toBe(':root');
      }),
      { numRuns: 100 },
    );
  });
});
