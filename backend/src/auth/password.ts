/**
 * Чистые правила валидации пароля Системы (Req 6.7, 5.5).
 *
 * Вынесены в отдельный модуль без побочных эффектов и без зависимостей от
 * NestJS/Redis/БД, что упрощает модульное и property-based-тестирование границ
 * длины пароля независимо от алгоритма хеширования.
 */

/**
 * Результат проверки пароля. При неуспехе несёт локализованную причину
 * отклонения, пригодную для отображения пользователю (Req 6.7).
 */
export type PasswordValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Проверяет длину пароля по заданным границам `[min, max]` включительно
 * (по умолчанию 8–128, Req 6.7, 5.5).
 *
 * Проверки выполняются по порядку и возвращают первую обнаруженную причину
 * отклонения:
 * 1. наличие непустого значения;
 * 2. длина не меньше `min`;
 * 3. длина не больше `max`.
 *
 * @param password Проверяемый пароль (может быть `undefined`, если не передан).
 * @param min Минимально допустимая длина (включительно).
 * @param max Максимально допустимая длина (включительно).
 * @returns `{ valid: true }` либо `{ valid: false, reason }`.
 */
export function validatePasswordLength(
  password: string | undefined,
  min: number,
  max: number,
): PasswordValidationResult {
  if (password === undefined || password.length === 0) {
    return { valid: false, reason: 'не указан обязательный параметр — пароль.' };
  }

  if (password.length < min || password.length > max) {
    return {
      valid: false,
      reason: `длина пароля должна быть от ${min} до ${max} символов.`,
    };
  }

  return { valid: true };
}
