import { ValidationException } from '../common/errors';

/** Минимальная длина отображаемого имени после trim. */
export const DISPLAY_NAME_MIN_LENGTH = 1;

/** Максимальная длина отображаемого имени пользователя. */
export const DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Проверяет и нормализует отображаемое имя пользователя.
 *
 * Имя обязательно при добавлении пользователя, хранится без краевых пробелов и
 * не должно превышать 200 символов.
 */
export function validateDisplayName(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
    throw new ValidationException('Имя пользователя не может быть пустым.');
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new ValidationException('Имя пользователя не должно превышать 200 символов.');
  }
  return trimmed;
}
