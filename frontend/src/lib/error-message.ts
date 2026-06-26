import type { TFunction } from 'i18next';
import { ApiError } from '@/lib/api';

/**
 * Возвращает локализованное сообщение об ошибке для слоя представления
 * (Req 16.1, 16.4).
 *
 * Презентационная утилита: не меняет потоки данных, только выбирает русскую
 * подпись. Сетевая ошибка (`ApiError` без ответа сервера, `status === 0`)
 * отображается ключом `errors.network` (Req 16.4); прочие `ApiError` несут уже
 * локализованное серверное сообщение; для не-`ApiError` используется переданная
 * резервная подпись (`fallback`, уже локализованная вызывающим кодом из `ru.ts`).
 */
export function resolveErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  if (err instanceof ApiError) {
    return err.status === 0 ? t('errors.network') : err.message;
  }
  return fallback;
}
