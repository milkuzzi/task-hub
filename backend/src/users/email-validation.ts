import { isEmail } from 'class-validator';

/**
 * Минимально допустимая длина адреса электронной почты (Req 4.1).
 * Самый короткий технически допустимый адрес вида `a@b.cd` — 6 символов.
 */
export const EMAIL_MIN_LENGTH = 6;

/** Максимально допустимая длина адреса электронной почты (Req 4.1). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Результат проверки адреса электронной почты для команды создания первичного
 * администратора. При неуспехе несёт локализованную причину отклонения,
 * пригодную для вывода в Консоль сервера (Req 4.3).
 */
export type EmailValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Чистая проверка адреса электронной почты первичного администратора (Req 4.1, 4.3).
 *
 * Проверки выполняются по порядку и возвращают первую обнаруженную причину
 * отклонения:
 * 1. наличие непустого значения (Req 4.3 — отсутствие параметра);
 * 2. длина в диапазоне 6–254 символов (Req 4.1);
 * 3. соответствие формату адреса электронной почты (Req 4.3).
 *
 * Функция не имеет побочных эффектов и пригодна для property-based-тестирования
 * (см. задачу 3.2, Property 11).
 *
 * @param email Проверяемое значение (может быть `undefined`, если параметр не передан).
 * @returns `{ valid: true }` для корректного адреса либо `{ valid: false, reason }`.
 */
export function validatePrimaryAdminEmail(email: string | undefined): EmailValidationResult {
  if (email === undefined || email.length === 0) {
    return {
      valid: false,
      reason: 'не указан обязательный параметр — адрес электронной почты.',
    };
  }

  if (email.length < EMAIL_MIN_LENGTH || email.length > EMAIL_MAX_LENGTH) {
    return {
      valid: false,
      reason: `длина адреса электронной почты должна быть от ${EMAIL_MIN_LENGTH} до ${EMAIL_MAX_LENGTH} символов.`,
    };
  }

  if (!isEmail(email)) {
    return {
      valid: false,
      reason: 'адрес электронной почты имеет недопустимый формат.',
    };
  }

  return { valid: true };
}
