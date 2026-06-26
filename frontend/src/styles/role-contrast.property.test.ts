import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { contrastRatio, type HexColor, type ThemeName } from '../lib/contrast';

/**
 * Источник истины — единственный файл стилей `global.css`. Читаем его как текст
 * рядом с этим тестом и разбираем значения цветовых токенов для светлой
 * (`:root`) и тёмной (`@media (prefers-color-scheme: dark) { :root { … } }`)
 * палитр. Тёмная палитра наследует значения светлой и переопределяет лишь часть
 * токенов (как и в каскаде CSS).
 *
 * Property 2 требует, чтобы для каждой темы и каждой пары «текст/фон» из ролей
 * интерфейса коэффициент контраста был не ниже порога: 4.5:1 для обычного
 * текста. Перечень пар взят из раздела Correctness Properties дизайна:
 *   - основной текст на поверхности и на фоне;
 *   - muted на поверхности и на фоне;
 *   - muted-strong на соответствующем тинте;
 *   - текст-ссылка на поверхности и на фоне;
 *   - белый текст на primary;
 *   - белый текст на danger.
 *
 * Тинты (`--tint-*`) полупрозрачны (rgba поверх поверхности), поэтому для пары
 * «muted-strong на тинте» эффективный цвет фона вычисляется альфа-композицией
 * тинта над цветом поверхности соответствующей темы.
 */
const stylesDir = dirname(fileURLToPath(import.meta.url));
const cssText = readFileSync(join(stylesDir, 'global.css'), 'utf8');

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function extractLightRoot(css: string): string {
  const start = css.indexOf(':root');
  if (start < 0) {
    throw new Error('role-contrast: не найден блок :root в global.css');
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) {
    throw new Error('role-contrast: не удалось выделить тело :root');
  }
  return css.slice(open + 1, close);
}

function extractDarkRoot(css: string): string {
  const media = css.indexOf('prefers-color-scheme: dark');
  if (media < 0) {
    throw new Error('role-contrast: не найден блок тёмной схемы в global.css');
  }
  const rootIdx = css.indexOf(':root', media);
  const open = css.indexOf('{', rootIdx);
  const close = css.indexOf('}', open);
  if (rootIdx < 0 || open < 0 || close < 0) {
    throw new Error('role-contrast: не удалось выделить тёмный :root');
  }
  return css.slice(open + 1, close);
}

function parseDecls(block: string): Record<string, string> {
  const decls: Record<string, string> = {};
  const re = /(--[a-z0-9_-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    decls[match[1]!.trim()] = match[2]!.trim();
  }
  return decls;
}

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex6 = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex6) {
    const h = hex6[1]!;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const hex3 = /^#([0-9a-f]{3})$/i.exec(v);
  if (hex3) {
    const h = hex3[1]!;
    const dup = (c: string): number => parseInt(c + c, 16);
    return { r: dup(h[0]!), g: dup(h[1]!), b: dup(h[2]!), a: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => p.trim());
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts[3] !== undefined ? Number(parts[3]) : 1,
    };
  }
  throw new Error(`role-contrast: не удалось разобрать цвет «${value}»`);
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): HexColor {
  const channel = (c: number): string =>
    Math.round(Math.max(0, Math.min(255, c)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function composite(fg: Rgba, bg: HexColor): HexColor {
  const base = parseColor(bg);
  return toHex({
    r: fg.a * fg.r + (1 - fg.a) * base.r,
    g: fg.a * fg.g + (1 - fg.a) * base.g,
    b: fg.a * fg.b + (1 - fg.a) * base.b,
  });
}

interface RolePalette {
  text: HexColor;
  muted: HexColor;
  mutedStrong: HexColor;
  primary: HexColor;
  primaryContrast: HexColor;
  link: HexColor;
  danger: HexColor;
  dangerContrast: HexColor;
  bg: HexColor;
  surface: HexColor;
  tintPrimaryOnSurface: HexColor;
  tintDangerOnSurface: HexColor;
  tintSuccessOnSurface: HexColor;
}

const lightDecls = parseDecls(extractLightRoot(cssText));
const darkOverrides = parseDecls(extractDarkRoot(cssText));
const darkDecls = { ...lightDecls, ...darkOverrides };

const REQUIRED_ROLE_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-text',
  '--color-muted',
  '--color-muted-strong',
  '--color-primary',
  '--color-primary-contrast',
  '--color-link',
  '--color-danger',
  '--color-danger-contrast',
  '--tint-primary',
  '--tint-danger',
  '--tint-success',
] as const;

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function buildPalette(decls: Record<string, string>): RolePalette {
  const hex = (name: string): HexColor => {
    const raw = decls[name];
    if (raw === undefined) {
      throw new Error(`role-contrast: отсутствует токен ${name}`);
    }
    return toHex(parseColor(raw));
  };
  const surface = hex('--color-surface');
  const tint = (name: string): HexColor => composite(parseColor(decls[name]!), surface);
  return {
    text: hex('--color-text'),
    muted: hex('--color-muted'),
    mutedStrong: hex('--color-muted-strong'),
    primary: hex('--color-primary'),
    primaryContrast: hex('--color-primary-contrast'),
    link: hex('--color-link'),
    danger: hex('--color-danger'),
    dangerContrast: hex('--color-danger-contrast'),
    bg: hex('--color-bg'),
    surface,
    tintPrimaryOnSurface: tint('--tint-primary'),
    tintDangerOnSurface: tint('--tint-danger'),
    tintSuccessOnSurface: tint('--tint-success'),
  };
}

const palettes: Record<ThemeName, RolePalette> = {
  light: buildPalette(lightDecls),
  dark: buildPalette(darkDecls),
};

interface RolePair {
  label: string;
  threshold: number;
  resolve: (p: RolePalette) => { fg: HexColor; bg: HexColor };
}

const NORMAL_TEXT = 4.5;

const rolePairs: RolePair[] = [
  { label: 'основной текст на поверхности', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.text, bg: p.surface }) },
  { label: 'основной текст на фоне', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.text, bg: p.bg }) },
  { label: 'muted на поверхности', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.muted, bg: p.surface }) },
  { label: 'muted на фоне', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.muted, bg: p.bg }) },
  { label: 'muted-strong на тинте primary', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.mutedStrong, bg: p.tintPrimaryOnSurface }) },
  { label: 'muted-strong на тинте danger', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.mutedStrong, bg: p.tintDangerOnSurface }) },
  { label: 'muted-strong на тинте success', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.mutedStrong, bg: p.tintSuccessOnSurface }) },
  { label: 'текст-ссылка на поверхности', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.link, bg: p.surface }) },
  { label: 'текст-ссылка на фоне', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.link, bg: p.bg }) },
  { label: 'белый текст на primary', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.primaryContrast, bg: p.primary }) },
  { label: 'белый текст на danger', threshold: NORMAL_TEXT, resolve: (p) => ({ fg: p.dangerContrast, bg: p.danger }) },
];

const themes: ThemeName[] = ['light', 'dark'];

describe('Property 2: Порог контраста по ролям текста', () => {
  it('разбирает обе палитры и обязательные role-токены без legacy snapshot-ожиданий', () => {
    for (const token of REQUIRED_ROLE_TOKENS) {
      expect(lightDecls[token], `Светлая тема: отсутствует токен ${token}`).toBeDefined();
      expect(darkDecls[token], `Тёмная тема: отсутствует токен ${token}`).toBeDefined();
    }

    for (const theme of themes) {
      const palette = palettes[theme];
      expect(palette.text, `${theme}: text должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.muted, `${theme}: muted должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.mutedStrong, `${theme}: mutedStrong должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.primary, `${theme}: primary должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.primaryContrast, `${theme}: primaryContrast должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.link, `${theme}: link должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.danger, `${theme}: danger должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.dangerContrast, `${theme}: dangerContrast должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.bg, `${theme}: bg должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.surface, `${theme}: surface должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.tintPrimaryOnSurface, `${theme}: tint primary должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.tintDangerOnSurface, `${theme}: tint danger должен быть hex`).toMatch(HEX_COLOR_RE);
      expect(palette.tintSuccessOnSurface, `${theme}: tint success должен быть hex`).toMatch(HEX_COLOR_RE);
    }

    expect(palettes.light.bg).not.toBe(palettes.dark.bg);
    expect(palettes.light.surface).not.toBe(palettes.dark.surface);
    expect(palettes.light.text).not.toBe(palettes.dark.text);
    expect(rolePairs.length).toBeGreaterThan(0);
  });

  it('для любой темы и любой пары ролей контраст не ниже требуемого порога', () => {
    fc.assert(
      fc.property(fc.constantFrom(...themes), fc.constantFrom(...rolePairs), (theme, pair) => {
        const palette = palettes[theme];
        const { fg, bg } = pair.resolve(palette);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `Тема «${theme}», пара «${pair.label}» (${fg} на ${bg}): контраст ${ratio.toFixed(2)}:1 < ${pair.threshold}:1`,
        ).toBeGreaterThanOrEqual(pair.threshold);
      }),
      { numRuns: 100 },
    );
  });
});
