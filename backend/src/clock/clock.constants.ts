/**
 * Константы и токены для {@link ClockService}.
 */

/**
 * Смещение часового пояса Москвы (MSK) относительно UTC в минутах.
 * MSK = UTC+3, фиксированное смещение без перехода на летнее время.
 * (Req 1.2)
 */
export const MSK_OFFSET_MINUTES = 180;

/** Смещение MSK относительно UTC в миллисекундах. */
export const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000;

/**
 * Источник «текущего момента». Выделен в отдельный провайдер, чтобы в тестах
 * можно было детерминированно подменять время, не трогая глобальный `Date`.
 */
export interface NowProvider {
  /** Возвращает текущий момент как абсолютный момент времени (UTC). */
  now(): Date;
}

/** DI-токен для инъекции {@link NowProvider}. */
export const NOW_PROVIDER = Symbol('NOW_PROVIDER');

/** Провайдер по умолчанию: системное время. */
export const systemNowProvider: NowProvider = {
  now: (): Date => new Date(),
};
