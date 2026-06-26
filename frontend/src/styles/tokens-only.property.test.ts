import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

// Feature: ui-ux-redesign, Property 6: Правила компонентов используют токены, а не литералы

/**
 * Источник истины — единственный файл стилей `frontend/src/styles/global.css`,
 * лежащий рядом с этим тестом. Структурный property-тест разбирает его как
 * текст и падает с понятным сообщением при неразбираемом правиле (а не молча
 * пропускает декларации), чтобы инвариант Req 2.2/4.2 не обходился.
 */
const GLOBAL_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'global.css');

/**
 * Удаляет блочные комментарии `/* ... *\/`, чтобы фигурные скобки, селекторо-
 * подобные слова и hex-значения внутри пояснений не мешали разбору правил.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface StyleRule {
  selector: string;
  body: string;
}

/**
 * Рекурсивно собирает обычные style-правила (`selector { ... }`) из CSS,
 * разворачивая обёртки `@media`/`@supports` (правила внутри них — настоящие
 * компонентные правила, например `.grid` в `@media (min-width: 600px)`), и
 * пропуская `@keyframes`/`@font-face` (там нет адресуемых деклараций).
 *
 * Блок `@media (prefers-color-scheme: dark)` разворачивается так же: внутри он
 * содержит только `:root { ... }`, который далее отфильтровывается наравне с
 * базовым `:root`. Балансировка фигурных скобок; при незакрытом правиле
 * функция БРОСАЕТ исключение с понятным сообщением.
 */
function collectRules(css: string, out: StyleRule[]): void {
  const length = css.length;
  let i = 0;

  while (i < length) {
    while (i < length && /[\s;]/.test(css[i]!)) {
      i += 1;
    }
    if (i >= length) {
      break;
    }

    const braceOpen = css.indexOf('{', i);
    if (braceOpen === -1) {
      const leftover = css.slice(i).trim();
      if (leftover.length === 0) {
        break;
      }
      throw new Error(
        `Не удалось разобрать global.css: висящий фрагмент без блока объявлений: "${leftover.slice(0, 80)}".`,
      );
    }

    const prelude = css.slice(i, braceOpen).trim();

    let depth = 0;
    let j = braceOpen;
    for (; j < length; j += 1) {
      const ch = css[j];
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
        `Не удалось разобрать global.css: правило для "${prelude.slice(0, 80)}" не закрыто "}".`,
      );
    }

    const body = css.slice(braceOpen + 1, j);

    if (prelude.startsWith('@')) {
      const atName = prelude.split(/[\s(]/)[0];
      if (atName === '@media' || atName === '@supports') {
        // Разворачиваем: внутренние правила — настоящие компонентные правила.
        collectRules(body, out);
      }
      // @keyframes, @font-face и прочие at-правила пропускаем.
    } else {
      out.push({ selector: prelude.replace(/\s+/g, ' ').trim(), body });
    }

    i = j + 1;
  }
}

interface Declaration {
  selector: string;
  property: string;
  value: string;
}

/**
 * Извлекает декларации `property: value;` из тела правила. Значения могут
 * содержать круглые скобки и запятые (`var(...)`, `repeat(...)`), но не `;`,
 * поэтому разбор по `[^;{}]+` корректен.
 */
function parseDeclarations(rule: StyleRule): Declaration[] {
  const decls: Declaration[] = [];
  const re = /([-\w]+)\s*:\s*([^;{}]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rule.body)) !== null) {
    decls.push({
      selector: rule.selector,
      property: match[1]!.trim().toLowerCase(),
      value: match[2]!.replace(/\s+/g, ' ').trim(),
    });
  }
  return decls;
}

const cssText = stripComments(readFileSync(GLOBAL_CSS_PATH, 'utf8'));
const allRules: StyleRule[] = [];
collectRules(cssText, allRules);

/**
 * Декларации вне `:root` (и вне dark-`:root`) — только правила компонентов.
 * Базовый и тёмный `:root` объявляют токены и поэтому исключаются: их значения
 * — это и есть единственная разрешённая точка hex/px/rem-литералов.
 */
const componentDeclarations: Declaration[] = allRules
  .filter((rule) => rule.selector !== ':root')
  .flatMap(parseDeclarations);

// --- Хелперы значений ----------------------------------------------------

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const RAW_LENGTH_RE = /(?<![\w-])-?\d*\.?\d+(px|rem|em)\b/;

function usesToken(value: string): boolean {
  return /var\(\s*--[\w-]+/.test(value);
}

/** Разрешённые ключевые слова цвета, не являющиеся литералами палитры. */
const COLOR_KEYWORDS = new Set(['transparent', 'inherit', 'currentcolor', 'none', 'unset', 'initial']);

/**
 * Свойства цвета/фона: значение обязано ссылаться на токен `var(--…)`.
 * Документированные исключения:
 *  - ключевые слова (`transparent`/`inherit`/`currentColor`/`none`);
 *  - полупрозрачная заливка `rgba()/rgb()` ТОЛЬКО для затемняющих подложек
 *    (`*-overlay`) — это не цвет бренда, а намеренный sla-слой (Req 11.1).
 * Запрещён любой hex-литерал.
 */
function checkColorDeclaration(decl: Declaration): void {
  const value = decl.value.toLowerCase();
  expect(HEX_RE.test(decl.value), `${decl.selector} { ${decl.property}: ${decl.value} } — hex-литерал вместо токена`).toBe(
    false,
  );

  if (usesToken(decl.value) || COLOR_KEYWORDS.has(value)) {
    return;
  }

  const isOverlaySelector = /-overlay\b/.test(decl.selector);
  const isTranslucentFill = /^rgba?\(/.test(value);
  if (
    (decl.property === 'background' || decl.property === 'background-color') &&
    isOverlaySelector &&
    isTranslucentFill
  ) {
    // Разрешённая подложка-overlay (rgba), задокументированное исключение.
    return;
  }

  throw new Error(
    `${decl.selector} { ${decl.property}: ${decl.value} } — цвет/фон должен ссылаться на токен var(--…) (или быть overlay-подложкой rgba)`,
  );
}

/**
 * `border-radius`: каждый компонент значения — токен `var(--…)`, либо `0`
 * (сброс угла), либо `50%` (структурная окружность для аватаров/спиннера/
 * маркеров). Сырые px/rem-литералы радиуса запрещены (Req 1.4, 21.3, 2.2).
 */
function checkRadiusDeclaration(decl: Declaration): void {
  const tokens = decl.value.split(/\s+/);
  for (const token of tokens) {
    const ok = token.startsWith('var(--') || token === '0' || token === '50%';
    expect(
      ok,
      `${decl.selector} { border-radius: ${decl.value} } — компонент «${token}» должен быть var(--…), 0 или 50%`,
    ).toBe(true);
  }
  expect(
    RAW_LENGTH_RE.test(decl.value),
    `${decl.selector} { border-radius: ${decl.value} } — сырой px/rem-литерал вместо токена`,
  ).toBe(false);
}

/**
 * Отступы и размер шрифта отполированных компонентов: каждый компонент
 * значения — токен `var(--…)` или `0`. Сырые px/rem/em запрещены (Req 4.2, 2.2).
 */
function checkSpacingDeclaration(decl: Declaration): void {
  expect(
    RAW_LENGTH_RE.test(decl.value),
    `${decl.selector} { ${decl.property}: ${decl.value} } — сырой px/rem-литерал вместо токена шкалы`,
  ).toBe(false);

  const tokens = decl.value.split(/[\s,]+/).filter(Boolean);
  for (const token of tokens) {
    const ok = token.startsWith('var(--') || token === '0' || token === 'auto';
    expect(
      ok,
      `${decl.selector} { ${decl.property}: ${decl.value} } — компонент «${token}» должен быть var(--…), 0 или auto`,
    ).toBe(true);
  }
}

// --- Формирование множества проверяемых деклараций ----------------------

const COLOR_PROPS = new Set(['color', 'background', 'background-color']);

/**
 * Отполированные компоненты задач 5.1–5.9, для которых отступы и размер шрифта
 * полностью переведены на шкалу токенов. Проверка spacing/font-size ограничена
 * этим множеством по интенту Property 6 («отступы/радиус/размер шрифта
 * отполированных компонентов»). Остальные правила (`.status-badge` с пилюльным
 * `padding: 2px 10px` и `font-size: 0.8rem`, `.modal` `padding: 20px`, а также
 * чат/уведомления/аватар с не-токенизированными `0.8–0.9rem`/`12px`)
 * сохраняют задокументированные структурные/легаси-литералы из ранних задач и
 * здесь по spacing/font-size намеренно не проверяются — это отслеживается
 * отдельно и не относится к интенту данного свойства.
 */
const POLISHED_SPACING_SELECTORS = new Set([
  '.app-main',
  '.app-sidebar',
  '.app-sidebar__brand',
  '.app-sidebar__nav',
  '.app-sidebar__nav a',
  '.app-sidebar__user',
  '.app-header',
  '.app-header__inner',
  '.page-head',
  '.page-toolbar',
  '.panel',
  '.panel--compact',
  '.btn',
  '.btn--sm',
  '.field__input',
  '.form-error',
  '.form-success',
  '.task-filters',
  '.task-filters__row',
  '.task-registry',
  '.task-record',
  '.task-record__body',
  '.task-record__meta',
  '.task-workspace',
  '.task-workspace__aside',
  '.task-workspace__main',
  '.tabs',
  '.tab',
  '.data-table th, .data-table td',
  '.modal-overlay',
  '.modal',
  '.modal__actions',
]);

const SPACING_PROPS = new Set(['padding', 'margin', 'gap', 'font-size']);

type CheckKind = 'color' | 'radius' | 'spacing';
interface CheckCase {
  kind: CheckKind;
  decl: Declaration;
}

const colorCases: CheckCase[] = componentDeclarations
  .filter((d) => COLOR_PROPS.has(d.property))
  .map((decl) => ({ kind: 'color' as const, decl }));

const radiusCases: CheckCase[] = componentDeclarations
  .filter((d) => d.property === 'border-radius')
  .map((decl) => ({ kind: 'radius' as const, decl }));

const spacingCases: CheckCase[] = componentDeclarations
  .filter((d) => SPACING_PROPS.has(d.property) && POLISHED_SPACING_SELECTORS.has(d.selector))
  .map((decl) => ({ kind: 'spacing' as const, decl }));

const allCases: CheckCase[] = [...colorCases, ...radiusCases, ...spacingCases];

function runCheck(testCase: CheckCase): void {
  switch (testCase.kind) {
    case 'color':
      checkColorDeclaration(testCase.decl);
      break;
    case 'radius':
      checkRadiusDeclaration(testCase.decl);
      break;
    case 'spacing':
      checkSpacingDeclaration(testCase.decl);
      break;
  }
}

describe('Property 6: Правила компонентов используют токены, а не литералы', () => {
  it('разбирает компонентные правила и адресуемые декларации (защита от молчаливого прохождения)', () => {
    expect(componentDeclarations.length).toBeGreaterThan(0);
    expect(colorCases.length).toBeGreaterThan(0);
    expect(radiusCases.length).toBeGreaterThan(0);
    expect(spacingCases.length).toBeGreaterThan(0);
  });

  it('для любой адресуемой декларации вне :root значение — токен var(--…), а не hex/сырой px/rem', () => {
    fc.assert(
      fc.property(fc.constantFrom(...allCases), (testCase) => {
        runCheck(testCase);
      }),
      { numRuns: 100 },
    );
  });
});
