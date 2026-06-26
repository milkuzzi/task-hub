import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

// Feature: ui-ux-redesign, Property 7: Запрет шаблонов AI-slop

/**
 * Источник истины — единственный файл стилей `frontend/src/styles/global.css`,
 * лежащий рядом с этим тестом. Структурный property-тест разбирает его как
 * текст и падает с понятным сообщением при неразбираемом правиле (а не молча
 * пропускает декларации), чтобы запреты Req 8.2/8.3/21.1/21.2/21.4/21.5 не
 * обходились.
 *
 * Validates: Requirements 8.2, 8.3, 21.1, 21.2, 21.4, 21.5
 */
const GLOBAL_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'global.css');

/**
 * Удаляет блочные комментарии `/* ... *\/`, чтобы фигурные скобки, селекторо-
 * подобные слова и значения внутри пояснений не мешали разбору правил.
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
 * пропуская `@keyframes`/`@font-face` (там нет адресуемых деклараций
 * поверхностей). Балансировка фигурных скобок; при незакрытом правиле функция
 * БРОСАЕТ исключение с понятным сообщением — правило не пропускается молча.
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

// --- Определение правил поверхностей/карточек ----------------------------

/**
 * Имена селекторов, обозначающих поверхности и карточки/панели приложения.
 * Совпадение по имени дополняет детекцию по фону-поверхности, чтобы охватить и
 * те правила, что задают рамку/тень без явной заливки поверхностью.
 */
const SURFACE_NAME_RE =
  /(?:\bcard\b|\bpanel\b|task-record|task-workspace|auth-panel|chat-msg|chat-composer|attachment-tile|notif-item|metric-panel|\bmodal\b|\bviewer\b|app-header|status-badge)/;

/** Ссылается ли значение фона на токен поверхности (--color-surface / -2). */
function hasSurfaceBackground(body: string): boolean {
  return /background(?:-color)?\s*:\s*var\(\s*--color-surface(?:-2)?\s*\)/.test(body);
}

/**
 * Правило считается «поверхностью/карточкой», если оно заливается токеном
 * поверхности ЛИБО его селектор соответствует имени карточки/панели. Базовый и
 * тёмный `:root` исключаются — это объявление токенов, а не поверхность.
 */
function isSurfaceRule(rule: StyleRule): boolean {
  if (rule.selector === ':root') {
    return false;
  }
  return hasSurfaceBackground(rule.body) || SURFACE_NAME_RE.test(rule.selector);
}

// --- Детекторы запрещённых приёмов AI-slop -------------------------------

/**
 * Тонкая рамка 1px вокруг поверхности: `border: 1px ...` или
 * `border-width: 1px`. Боковые рамки (`border-left`/`border-top` и т.п.) сюда
 * не относятся — они проверяются отдельно (акцентная полоса) либо являются
 * функциональными индикаторами (вкладки/навигация).
 */
function hasThinBorder(body: string): boolean {
  return (
    /(?:^|[\s;])border\s*:\s*[^;]*\b1px\b/.test(body) ||
    /border-width\s*:\s*1px\b/.test(body)
  );
}

/**
 * «Широкая мягкая тень» уровня всплывающего слоя. Распознаётся ссылка на токен
 * `--shadow-popover`, а также сырая `box-shadow` с большим радиусом размытия
 * (>4px). НЕ считаются широкой мягкой тенью: узкая тень поверхности
 * (`--shadow-surface`, 0 1px 2px) и сплошное фокус-кольцо (`--focus-ring`,
 * радиус размытия 0) — это функциональные приёмы, а не декоративный «ghost».
 */
function hasWideSoftShadow(body: string): boolean {
  const match = /(?:^|[\s;])box-shadow\s*:\s*([^;]+);/.exec(body);
  if (!match) {
    return false;
  }
  const value = match[1]!.toLowerCase();

  if (value === 'none') {
    return false;
  }
  if (/var\(\s*--shadow-popover\s*\)/.test(value)) {
    return true;
  }
  if (/var\(\s*--shadow-surface\s*\)/.test(value) || /var\(\s*--focus-ring\s*\)/.test(value)) {
    return false;
  }
  // Сырая тень: третье числовое значение — радиус размытия. >4px => мягкая.
  const lengths = value.match(/-?\d*\.?\d+px/g);
  if (lengths && lengths.length >= 3) {
    const blur = Math.abs(parseFloat(lengths[2]!));
    if (blur > 4) {
      return true;
    }
  }
  return false;
}

/**
 * Акцентная боковая полоса: непрозрачный левый бордюр (`border-left` /
 * `border-inline-start`) ненулевой ширины. Прозрачный или нулевой бордюр —
 * не акцент.
 */
function hasLeftAccentBorder(body: string): boolean {
  const re = /border-(?:left|inline-start)(?:-(?:width|color|style))?\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const value = m[1]!.toLowerCase().trim();
    if (value === 'transparent' || value === 'none' || /^0(?:px)?\b/.test(value)) {
      continue;
    }
    // Ненулевая боковая граница с видимым цветом/шириной — акцентная полоса.
    return true;
  }
  return false;
}

/**
 * Градиентная заливка текста: `background-clip: text` /
 * `-webkit-background-clip: text` (как правило в паре с прозрачным
 * `-webkit-text-fill-color` поверх градиента).
 */
function hasGradientTextClip(body: string): boolean {
  return (
    /(?:-webkit-)?background-clip\s*:\s*text\b/.test(body) ||
    /-webkit-text-fill-color\s*:\s*transparent\b/.test(body)
  );
}

/** Стеклянный эффект по умолчанию: размытие подложки `backdrop-filter: blur`. */
function hasGlassBlur(body: string): boolean {
  return /(?:-webkit-)?backdrop-filter\s*:\s*[^;]*blur/.test(body);
}

/** Является ли тело псевдоэлемента акцентной полосой (абсолютная цветная планка). */
function isAccentBarPseudoBody(body: string): boolean {
  const positioned = /position\s*:\s*(?:absolute|fixed)\b/.test(body);
  if (!positioned) {
    return false;
  }
  const bgMatch = /background(?:-color)?\s*:\s*([^;]+);/.exec(body);
  if (!bgMatch) {
    return false;
  }
  const bg = bgMatch[1]!.toLowerCase().trim();
  // Прозрачная/отсутствующая заливка — не акцентная планка.
  return !(bg === 'transparent' || bg === 'none');
}

/** Базовый селектор без псевдокласса/псевдоэлемента (для сопоставления полос). */
function baseSelector(selector: string): string {
  return selector
    .split(',')
    .map((part) => part.trim().replace(/::?[\w-]+(?:\([^)]*\))?/g, '').trim())
    .filter(Boolean)
    .join(', ');
}

// --- Сбор данных ---------------------------------------------------------

const cssText = stripComments(readFileSync(GLOBAL_CSS_PATH, 'utf8'));
const allRules: StyleRule[] = [];
collectRules(cssText, allRules);

const surfaceRules = allRules.filter(isSurfaceRule);
const surfaceBaseSelectors = new Set(surfaceRules.map((rule) => baseSelector(rule.selector)));

/**
 * Базовые селекторы поверхностей/карточек, к которым прикреплён псевдоэлемент
 * `::before`/`::after`, оформленный как акцентная полоса (Req 21.4). В дизайне
 * таких нет — множество должно остаться пустым.
 */
const accentBarPseudoBases = new Set<string>();
for (const rule of allRules) {
  for (const part of rule.selector.split(',')) {
    const trimmed = part.trim();
    const pseudo = /^(.*?)::(?:before|after)$/.exec(trimmed);
    if (!pseudo) {
      continue;
    }
    const base = pseudo[1]!.trim().replace(/:[\w-]+(?:\([^)]*\))?$/g, '').trim();
    if (!base) {
      continue;
    }
    const baseIsSurface = surfaceBaseSelectors.has(base) || SURFACE_NAME_RE.test(base);
    if (baseIsSurface && isAccentBarPseudoBody(rule.body)) {
      accentBarPseudoBases.add(base);
    }
  }
}

/** Проверяет одно правило поверхности/карточки на все запреты AI-slop. */
function assertNoSlop(rule: StyleRule): void {
  const label = rule.selector.slice(0, 80);

  // Req 8.2 / 21.5: запрет «ghost-card» (1px рамка + широкая мягкая тень).
  const ghostCard = hasThinBorder(rule.body) && hasWideSoftShadow(rule.body);
  expect(
    ghostCard,
    `${label} — «ghost-card»: одновременно рамка 1px и широкая мягкая тень на одной поверхности (Req 8.2, 21.5)`,
  ).toBe(false);

  // Req 8.3 / 21.4: запрет акцентной боковой полосы (левый бордюр).
  expect(
    hasLeftAccentBorder(rule.body),
    `${label} — акцентная боковая полоса (border-left/inline-start) на карточке/поверхности (Req 8.3, 21.4)`,
  ).toBe(false);

  // Req 8.3 / 21.4: запрет акцентной полосы через псевдоэлемент ::before/::after.
  expect(
    accentBarPseudoBases.has(baseSelector(rule.selector)),
    `${label} — акцентная полоса через псевдоэлемент ::before/::after (Req 8.3, 21.4)`,
  ).toBe(false);

  // Req 21.1: запрет градиентной заливки текста.
  expect(
    hasGradientTextClip(rule.body),
    `${label} — градиентная заливка текста (background-clip: text) (Req 21.1)`,
  ).toBe(false);

  // Req 21.2: запрет стеклянного эффекта по умолчанию (backdrop-filter: blur).
  expect(
    hasGlassBlur(rule.body),
    `${label} — стеклянный эффект по умолчанию (backdrop-filter: blur) (Req 21.2)`,
  ).toBe(false);
}

describe('Property 7: Запрет шаблонов AI-slop', () => {
  it('разбирает правила поверхностей/карточек (защита от молчаливого прохождения)', () => {
    expect(allRules.length).toBeGreaterThan(0);
    expect(surfaceRules.length).toBeGreaterThan(0);
  });

  it('ни одно правило поверхности/карточки не содержит запрещённых приёмов AI-slop', () => {
    fc.assert(
      fc.property(fc.constantFrom(...surfaceRules), (rule) => {
        assertNoSlop(rule);
      }),
      { numRuns: 100 },
    );
  });
});
