/**
 * Клиентское представление времени в часовом поясе Москвы (MSK = UTC+3).
 *
 * Backend оперирует абсолютными моментами времени (UTC) и сериализует их в ISO-
 * строки. Клиент отображает их в настенном времени Москвы в формате
 * `ДД.ММ.ГГГГ ЧЧ:ММ` (Req 1.2). Логика зеркалит серверный `ClockService`,
 * чтобы форматирование совпадало на обеих сторонах.
 */

/** Смещение MSK относительно UTC в минутах (UTC+3, без перехода на лето). */
export const MSK_OFFSET_MINUTES = 180;

/** Смещение MSK относительно UTC в миллисекундах. */
export const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000;

/** Регулярное выражение строки формата `ДД.ММ.ГГГГ ЧЧ:ММ`. */
const MSK_STRING_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

/** Дополняет число ведущими нулями до требуемой длины. */
function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** Приводит вход (Date | ISO-строка | epoch-ms) к корректному `Date`. */
function toDate(input: Date | string | number): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('formatMsk: ожидается корректная дата');
  }
  return date;
}

/**
 * Форматирует абсолютный момент времени в строку MSK вида `ДД.ММ.ГГГГ ЧЧ:ММ`.
 * Точность — до минуты. (Req 1.2)
 */
export function formatMsk(input: Date | string | number): string {
  const date = toDate(input);

  // Сдвигаем момент на смещение MSK и читаем поля как UTC, чтобы получить
  // настенное время в Москве независимо от часового пояса браузера.
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);

  const day = pad(msk.getUTCDate(), 2);
  const month = pad(msk.getUTCMonth() + 1, 2);
  const year = pad(msk.getUTCFullYear(), 4);
  const hours = pad(msk.getUTCHours(), 2);
  const minutes = pad(msk.getUTCMinutes(), 2);

  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

/**
 * Разбирает строку MSK формата `ДД.ММ.ГГГГ ЧЧ:ММ` в абсолютный момент времени
 * (UTC). Секунды и миллисекунды считаются нулевыми. (Req 1.2)
 *
 * @throws TypeError если строка не соответствует формату или содержит
 * недопустимую дату/время.
 */
export function parseMsk(value: string): Date {
  const match = MSK_STRING_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(`parseMsk: строка «${value}» не соответствует формату ДД.ММ.ГГГГ ЧЧ:ММ`);
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);

  const mskAsUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const result = new Date(mskAsUtcMs - MSK_OFFSET_MS);

  // Защита от переполнения полей (например, 32.13.2024 или 25:61):
  // повторное форматирование должно вернуть исходную строку.
  if (formatMsk(result) !== value) {
    throw new TypeError(`parseMsk: строка «${value}» содержит недопустимую дату или время`);
  }

  return result;
}

/** Регулярное выражение строки `<input type="datetime-local">` (`ГГГГ-ММ-ДДTЧЧ:ММ`). */
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * Преобразует абсолютный момент времени (UTC) в значение для
 * `<input type="datetime-local">`, отображающее настенное время Москвы
 * (MSK = UTC+3) в формате `ГГГГ-ММ-ДДTЧЧ:ММ` (Req 1.2).
 *
 * Используется при предзаполнении формы редактирования Задачи, чтобы поле
 * Дедлайна показывало то же московское время, что и карточка Задачи.
 */
export function toMskInputValue(input: Date | string | number): string {
  const date = toDate(input);
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);

  const year = pad(msk.getUTCFullYear(), 4);
  const month = pad(msk.getUTCMonth() + 1, 2);
  const day = pad(msk.getUTCDate(), 2);
  const hours = pad(msk.getUTCHours(), 2);
  const minutes = pad(msk.getUTCMinutes(), 2);

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Разбирает значение `<input type="datetime-local">` (`ГГГГ-ММ-ДДTЧЧ:ММ`),
 * трактуя его как настенное время Москвы (MSK = UTC+3), и возвращает абсолютный
 * момент времени (UTC, Req 1.2).
 *
 * @throws TypeError если строка не соответствует формату или содержит
 * недопустимую дату/время.
 */
export function fromMskInputValue(value: string): Date {
  const match = DATETIME_LOCAL_PATTERN.exec(value);
  if (match === null) {
    throw new TypeError(
      `fromMskInputValue: строка «${value}» не соответствует формату ГГГГ-ММ-ДДTЧЧ:ММ`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);

  const mskAsUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const result = new Date(mskAsUtcMs - MSK_OFFSET_MS);

  // Защита от переполнения полей: повторное форматирование возвращает исходную строку.
  if (toMskInputValue(result) !== value) {
    throw new TypeError(
      `fromMskInputValue: строка «${value}» содержит недопустимую дату или время`,
    );
  }

  return result;
}
