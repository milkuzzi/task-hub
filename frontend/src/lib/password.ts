/**
 * Клиентская валидация пароля (Req 6.7).
 *
 * Backend выполняет авторитетную проверку, но ранний отказ на клиенте сразу
 * показывает причину и экономит запрос. Допустимая длина — от 8 до 128 символов.
 */

/** Минимальная длина пароля (Req 6.7). */
export const PASSWORD_MIN_LENGTH = 8;

/** Максимальная длина пароля (Req 6.7). */
export const PASSWORD_MAX_LENGTH = 128;

/** Результат валидации нового пароля. */
export type PasswordValidation =
  | { ok: true }
  | { ok: false; reason: 'length' };

/** Проверяет длину нового пароля (Req 6.7). */
export function validateNewPassword(password: string): PasswordValidation {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: 'length' };
  }
  return { ok: true };
}
