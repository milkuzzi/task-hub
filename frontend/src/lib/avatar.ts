/**
 * Клиентская валидация аватара перед загрузкой (Req 6.4, 6.9).
 *
 * Backend выполняет авторитетную проверку, но ранний отказ на клиенте экономит
 * трафик и сразу показывает причину. Принимаются растровые изображения
 * поддерживаемых форматов размером не более 5 МБ.
 */

import { http } from './api';

/** Предельный размер аватара — 5 МБ (Req 6.4). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Поддерживаемые MIME-типы растровых изображений (Req 6.4, 6.9). */
export const AVATAR_SUPPORTED_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
];

/** Результат валидации: либо успех, либо ключ сообщения об ошибке. */
export type AvatarValidation =
  | { ok: true }
  | { ok: false; reason: 'type' | 'size' };

/**
 * Проверяет файл аватара по формату и размеру (Req 6.4, 6.9).
 * Возвращает причину отказа для локализованного сообщения в UI.
 */
export function validateAvatar(file: File): AvatarValidation {
  if (!AVATAR_SUPPORTED_TYPES.includes(file.type)) {
    return { ok: false, reason: 'type' };
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return { ok: false, reason: 'size' };
  }
  return { ok: true };
}

/**
 * Загружает байты аватара Пользователя с авторизацией (Req 6.4, 5.7).
 *
 * Backend отдаёт аватар по защищённому эндпоинту `GET /api/avatars/:userId`,
 * поэтому байты запрашиваются общим клиентом `http` (он добавляет Bearer-токен)
 * как `Blob` для последующего показа через Object URL ({@link useAuthedImage}).
 * Если аватар не задан, сервер отвечает 404 — вызывающий обрабатывает это как
 * отсутствие изображения (показ заглушки), не выводя «битую» картинку.
 */
export function fetchAvatarBlob(userId: string): Promise<Blob> {
  return http
    .get<Blob>(`/avatars/${userId}`, { responseType: 'blob' })
    .then((response) => response.data);
}
