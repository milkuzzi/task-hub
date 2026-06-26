import { Inject, Injectable } from '@nestjs/common';
import { MSK_OFFSET_MS, NOW_PROVIDER, NowProvider } from './clock.constants';

/** Регулярное выражение строки формата `ДД.ММ.ГГГГ ЧЧ:ММ`. */
const MSK_STRING_PATTERN = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/;

/**
 * Единая точка работы со временем в Системе.
 *
 * Весь backend оперирует абсолютными моментами времени (`Date`, UTC). Часовой
 * пояс Москвы (MSK = UTC+3) — это представление: преобразование UTC↔MSK и
 * форматирование/разбор строк формата `ДД.ММ.ГГГГ ЧЧ:ММ` выполняются здесь.
 *
 * Источник «сейчас» инъецируется ({@link NOW_PROVIDER}) для детерминированных
 * тестов. (Req 1.2)
 */
@Injectable()
export class ClockService {
  constructor(@Inject(NOW_PROVIDER) private readonly nowProvider: NowProvider) {}

  /** Текущий момент времени (абсолютный, UTC). */
  now(): Date {
    return this.nowProvider.now();
  }

  /**
   * Форматирует абсолютный момент времени в строку MSK вида `ДД.ММ.ГГГГ ЧЧ:ММ`.
   * Точность — до минуты. (Req 1.2)
   */
  formatMsk(date: Date): string {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new TypeError('formatMsk: ожидается корректный экземпляр Date');
    }

    // Сдвигаем момент на смещение MSK и читаем поля как UTC, чтобы получить
    // настенное время в Москве без зависимости от локального пояса процесса.
    const msk = new Date(date.getTime() + MSK_OFFSET_MS);

    const day = this.pad(msk.getUTCDate(), 2);
    const month = this.pad(msk.getUTCMonth() + 1, 2);
    const year = this.pad(msk.getUTCFullYear(), 4);
    const hours = this.pad(msk.getUTCHours(), 2);
    const minutes = this.pad(msk.getUTCMinutes(), 2);

    return `${day}.${month}.${year} ${hours}:${minutes}`;
  }

  /**
   * Разбирает строку MSK формата `ДД.ММ.ГГГГ ЧЧ:ММ` в абсолютный момент времени
   * (UTC). Секунды и миллисекунды считаются нулевыми. (Req 1.2)
   *
   * @throws TypeError если строка не соответствует формату или содержит
   * недопустимую дату/время.
   */
  parseMsk(value: string): Date {
    const match = MSK_STRING_PATTERN.exec(value);
    if (match === null) {
      throw new TypeError(`parseMsk: строка «${value}» не соответствует формату ДД.ММ.ГГГГ ЧЧ:ММ`);
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);

    // Поля трактуются как настенное время MSK; собираем их как UTC и вычитаем
    // смещение MSK, чтобы получить истинный момент в UTC.
    const mskAsUtcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
    const result = new Date(mskAsUtcMs - MSK_OFFSET_MS);

    // Защита от переполнения полей (например, 32.13.2024 или 25:61):
    // повторное форматирование должно вернуть исходную строку.
    if (this.formatMsk(result) !== value) {
      throw new TypeError(`parseMsk: строка «${value}» содержит недопустимую дату или время`);
    }

    return result;
  }

  /** Дополняет число ведущими нулями до требуемой длины. */
  private pad(value: number, length: number): string {
    return String(value).padStart(length, '0');
  }
}
