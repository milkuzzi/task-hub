import { useEffect, useState, type DependencyList } from 'react';
import { ApiError } from './api';

/**
 * Загрузка защищённого изображения с авторизацией и показ через Object URL
 * («fetch-as-blob», Req 1.3, 5.7).
 *
 * Защищённые медиа-эндпоинты (аватары, миниатюры Вложений) требуют заголовок
 * `Authorization: Bearer …`, который добавляет общий axios-клиент (`http`).
 * Простой `<img src="/api/…">` такого заголовка не отправляет, поэтому байты
 * запрашиваются как `Blob` и оборачиваются в Object URL для рендера в `<img>`.
 *
 * Хук берёт асинхронный `fetcher`, возвращающий `Blob`, создаёт Object URL и
 * отдаёт его как `src`. URL освобождается при размонтировании и при изменении
 * входных данных (`deps`), чтобы не было утечек памяти.
 *
 * @param fetcher Функция загрузки `Blob` либо `null`/`undefined`, если
 *   изображение запрашивать не нужно (нет аватара, не-изображение и т. п.).
 * @param deps Зависимости, при изменении которых нужно перезапросить байты
 *   (например, идентификатор пользователя или Вложения).
 */

/** Функция загрузки байтов изображения с авторизацией. */
export type AuthedImageFetcher = () => Promise<Blob>;

/** Состояние загружаемого защищённого изображения. */
export interface AuthedImageState {
  /** Object URL загруженного изображения либо `null`. */
  src: string | null;
  /** Идёт загрузка байтов. */
  loading: boolean;
  /** Загрузка завершилась ошибкой (например, 404 — изображения нет). */
  error: boolean;
  /**
   * Загрузка завершилась ответом 404 — изображения заведомо нет (например, у
   * Пользователя не сохранён аватар, у Вложения нет миниатюры). Отличается от
   * прочих ошибок загрузки (`error && !notFound` — временный/иной сбой), чтобы
   * показывать заглушку именно как «нет изображения», а не деградировать к ней
   * при любой ошибке без необходимости.
   */
  notFound: boolean;
}

export function useAuthedImage(
  fetcher: AuthedImageFetcher | null | undefined,
  deps: DependencyList = [],
): AuthedImageState {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(fetcher));
  const [error, setError] = useState<boolean>(false);
  const [notFound, setNotFound] = useState<boolean>(false);

  useEffect(() => {
    if (fetcher == null) {
      setSrc(null);
      setLoading(false);
      setError(false);
      setNotFound(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    setLoading(true);
    setError(false);
    setNotFound(false);
    setSrc(null);

    fetcher()
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(true);
          // 404 — изображения заведомо нет; отличаем от прочих (временных) сбоев.
          setNotFound(err instanceof ApiError && err.status === 404);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // Перезапрашиваем только при изменении явно указанных зависимостей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { src, loading, error, notFound };
}
