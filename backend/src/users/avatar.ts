import { UploadedFile } from './profile.types';

/**
 * Чистые правила валидации аватара (Req 6.4, 6.5, 6.9).
 *
 * Вынесены в отдельный модуль без побочных эффектов и без зависимостей от
 * NestJS/хранилища, что упрощает модульное и property-based-тестирование границ
 * размера и поддерживаемых форматов независимо от способа хранения.
 */

/**
 * Поддерживаемые MIME-типы растровых изображений для аватара (Req 6.4, 6.5).
 *
 * Аватар принимается только как растровое изображение распространённого
 * формата; векторные форматы (например, `image/svg+xml`) и нерастровые типы не
 * поддерживаются.
 */
export const SUPPORTED_AVATAR_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
];

/**
 * Результат проверки аватара. При неуспехе несёт локализованную причину
 * отклонения, пригодную для отображения пользователю (Req 6.9).
 */
export type AvatarValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Проверяет загружаемый аватар по формату и размеру (Req 6.4, 6.5, 6.9).
 *
 * Проверки выполняются по порядку и возвращают первую обнаруженную причину
 * отклонения:
 * 1. наличие файла;
 * 2. поддерживаемый растровый формат (MIME-тип из {@link SUPPORTED_AVATAR_MIME_TYPES});
 * 3. неотрицательный размер не более `maxBytes` (по умолчанию 5 МБ).
 *
 * Функция не имеет побочных эффектов и пригодна для property-based-тестирования
 * (см. задачу 3.17, Property 17).
 *
 * @param file Метаданные загружаемого аватара (может быть `undefined`).
 * @param maxBytes Максимально допустимый размер в байтах (включительно).
 * @returns `{ valid: true }` либо `{ valid: false, reason }`.
 */
export function validateAvatar(
  file: UploadedFile | undefined,
  maxBytes: number,
): AvatarValidationResult {
  if (file === undefined) {
    return { valid: false, reason: 'не указан обязательный параметр — файл аватара.' };
  }

  if (!SUPPORTED_AVATAR_MIME_TYPES.includes(file.mimeType)) {
    return {
      valid: false,
      reason:
        'неподдерживаемый формат изображения. Допустимы растровые изображения: ' +
        'JPEG, PNG, GIF, WebP, BMP.',
    };
  }

  if (!Number.isFinite(file.sizeBytes) || file.sizeBytes < 0) {
    return { valid: false, reason: 'недопустимый размер файла аватара.' };
  }

  if (file.sizeBytes > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      valid: false,
      reason: `размер аватара превышает допустимый предел в ${maxMb} МБ.`,
    };
  }

  return { valid: true };
}
