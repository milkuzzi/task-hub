import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { contrastRatio, type TaskStatusId, type ThemeName } from '../lib/contrast';

const GLOBAL_CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'global.css');
const DARK_MEDIA_MARKER = '@media (prefers-color-scheme: dark)';
const STATUSES: readonly TaskStatusId[] = ['in_progress', 'waiting', 'done', 'needs_admin', 'cancelled'];
const THEMES: readonly ThemeName[] = ['light', 'dark'];
const MIN_CONTRAST = 4.5;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractDarkMediaBlock(css: string): string {
  const markerIndex = css.indexOf(DARK_MEDIA_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Не найден блок "${DARK_MEDIA_MARKER}" в global.css — тёмная схема отсутствует или объявлена иначе.`);
  }

  const braceStart = css.indexOf('{', markerIndex + DARK_MEDIA_MARKER.length);
  if (braceStart === -1) {
    throw new Error(`Не удалось разобрать тёмный блок: после "${DARK_MEDIA_MARKER}" не найдена открывающая скобка "{".`);
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
    throw new Error('Не удалось разобрать тёмный блок: фигурные скобки @media не сбалансированы (блок не закрыт).');
  }

  return css.slice(braceStart + 1, i);
}

function parseBadgeTokens(source: string, themeLabel: string): Record<TaskStatusId, { bg: string; fg: string }> {
  const result = {} as Record<TaskStatusId, { bg: string; fg: string }>;

  for (const status of STATUSES) {
    const bg = matchToken(source, `--badge-${status}-bg`);
    const fg = matchToken(source, `--badge-${status}-fg`);
    if (bg === null || fg === null) {
      throw new Error(
        `Не удалось разобрать токены бейджа статуса "${status}" в теме "${themeLabel}": bg=${bg ?? 'отсутствует'}, fg=${fg ?? 'отсутствует'}.`,
      );
    }
    result[status] = { bg, fg };
  }

  return result;
}

function matchToken(source: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})\\s*;`);
  const match = re.exec(source);
  return match ? match[1]! : null;
}

const css = stripComments(readFileSync(GLOBAL_CSS_PATH, 'utf8'));
const darkBlock = extractDarkMediaBlock(css);
const lightSource = css.replace(darkBlock, '');

const palettes: Record<ThemeName, Record<TaskStatusId, { bg: string; fg: string }>> = {
  light: parseBadgeTokens(lightSource, 'light'),
  dark: parseBadgeTokens(darkBlock, 'dark'),
};

describe('Property 3: Контраст статусных бейджей в обеих темах', () => {
  it('разобраны токены бейджей для всех статусов в обеих темах и каждая тема визуально отделена', () => {
    for (const theme of THEMES) {
      for (const status of STATUSES) {
        expect(palettes[theme][status].bg).toMatch(HEX_COLOR_RE);
        expect(palettes[theme][status].fg).toMatch(HEX_COLOR_RE);
      }
    }

    for (const status of STATUSES) {
      const light = palettes.light[status];
      const dark = palettes.dark[status];
      expect(
        light.bg !== dark.bg || light.fg !== dark.fg,
        `Статус «${status}» должен иметь отличимые badge-токены между light и dark темами`,
      ).toBe(true);
    }
  });

  it('для каждого статуса и темы contrastRatio(fg, bg) ≥ 4.5', () => {
    fc.assert(
      fc.property(fc.constantFrom(...STATUSES), fc.constantFrom(...THEMES), (status, theme) => {
        const { fg, bg } = palettes[theme][status];
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `Тема «${theme}», статус «${status}»: контраст ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1`,
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }),
      { numRuns: 100 },
    );
  });
});
