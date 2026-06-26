/**
 * Утилиты контраста по WCAG 2.1 для слоя оформления редизайна Task Hub.
 *
 * Модуль содержит доменные типы палитры/бейджей (отражают значения CSS-токенов
 * в `frontend/src/styles/global.css`) и две чистые функции:
 *  - `relativeLuminance` — относительная яркость sRGB-цвета по формуле WCAG 2.1;
 *  - `contrastRatio` — коэффициент контраста между двумя цветами в диапазоне
 *    `[1, 21]`.
 *
 * Функции не имеют побочных эффектов и служат источником истины для
 * property-тестов доступности (см. раздел Correctness Properties спецификации).
 */

/** sRGB-цвет как 24-битный hex (`#rrggbb`). */
export type HexColor = string;

/** Тема оформления. */
export type ThemeName = 'light' | 'dark';

/** Идентификатор статуса задачи (соответствует автомату статусов). */
export type TaskStatusId =
  | 'in_progress'
  | 'waiting'
  | 'done'
  | 'needs_admin'
  | 'cancelled';

/** Пара цветов «текст/фон» для проверки контраста. */
export interface ColorPair {
  fg: HexColor;
  bg: HexColor;
}

/** Токены бейджа одного статуса в одной теме. */
export interface BadgeTokens {
  bg: HexColor;
  fg: HexColor;
}

/** Полная палитра одной темы, отражающая значения `:root`. */
export interface ThemePalette {
  bg: HexColor;
  surface: HexColor;
  text: HexColor;
  muted: HexColor;
  mutedStrong: HexColor;
  primary: HexColor; // #1f6feb в обеих темах (Req 1.1, 18.4)
  primaryContrast: HexColor; // текст на primary
  link: HexColor; // контрастный текст-ссылка (Req 5.1)
  danger: HexColor; // #c0392b (Req 1.3)
  dangerContrast: HexColor;
  badges: Record<TaskStatusId, BadgeTokens>;
}

/** Разобранный sRGB-цвет: целочисленные каналы в диапазоне [0, 255]. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Регулярное выражение нормализованного 6-значного hex (`#rrggbb`). */
const HEX6_PATTERN = /^#([0-9a-f]{6})$/i;

/** Регулярное выражение сокращённого 3-значного hex (`#rgb`). */
const HEX3_PATTERN = /^#([0-9a-f]{3})$/i;

/**
 * Нормализует hex-цвет к виду `#rrggbb` и разбирает его на каналы sRGB.
 *
 * Принимает как полную форму `#rrggbb`, так и сокращённую `#rgb` (раскрывается
 * дублированием каждого разряда). Ведущий `#` обязателен. Регистр не важен.
 *
 * @throws TypeError если строка не является корректным hex-цветом.
 */
function parseHex(color: HexColor): Rgb {
  if (typeof color !== 'string') {
    throw new TypeError('relativeLuminance: ожидается hex-цвет в формате #rrggbb');
  }

  const value = color.trim();

  let hex6: string;
  const short = HEX3_PATTERN.exec(value);
  const full = HEX6_PATTERN.exec(value);
  if (short !== null && short[1] !== undefined) {
    const digits = short[1];
    const r = digits.charAt(0);
    const g = digits.charAt(1);
    const b = digits.charAt(2);
    hex6 = `${r}${r}${g}${g}${b}${b}`;
  } else if (full !== null && full[1] !== undefined) {
    hex6 = full[1];
  } else {
    throw new TypeError(
      `relativeLuminance: строка «${color}» не является hex-цветом формата #rrggbb`,
    );
  }

  return {
    r: Number.parseInt(hex6.slice(0, 2), 16),
    g: Number.parseInt(hex6.slice(2, 4), 16),
    b: Number.parseInt(hex6.slice(4, 6), 16),
  };
}

/**
 * Линеаризует один sRGB-канал (значение 0..255) в линейное значение [0, 1]
 * по формуле WCAG 2.1.
 */
function linearizeChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Вычисляет относительную яркость sRGB-цвета по формуле WCAG 2.1.
 *
 * Каждый канал линеаризуется, затем суммируется с весами
 * `0.2126·R + 0.7152·G + 0.0722·B`. Результат — число в диапазоне `[0, 1]`,
 * где `0` соответствует чёрному (`#000000`), а `1` — белому (`#ffffff`).
 */
export function relativeLuminance(color: HexColor): number {
  const { r, g, b } = parseHex(color);
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/**
 * Вычисляет коэффициент контраста между двумя sRGB-цветами по WCAG 2.1.
 *
 * Контраст определяется как `(L1 + 0.05) / (L2 + 0.05)`, где `L1` — большая, а
 * `L2` — меньшая из относительных яркостей цветов. Функция симметрична
 * (`contrastRatio(a, b) === contrastRatio(b, a)`), даёт ровно `1` при равных
 * яркостях и всегда возвращает значение в диапазоне `[1, 21]`.
 */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
