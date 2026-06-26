import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

/**
 * Опции глобального пайпа валидации DTO на границе контроллеров.
 *
 * - `whitelist` — отбрасывает свойства, не описанные в DTO, исключая попадание
 *   незаявленных полей в доменную логику;
 * - `forbidNonWhitelisted` — отвергает запрос с лишними полями явной ошибкой
 *   валидации (HTTP 400 в едином формате через {@link AllExceptionsFilter});
 * - `transform` — приводит входные данные к типам DTO (в т. ч. строковые
 *   query-параметры пагинации к числам через `@Type`);
 * - `enableImplicitConversion` отключён намеренно: приведение типов выполняется
 *   только явными декораторами `@Type`, что исключает неожиданные преобразования.
 *
 * Нарушения валидации преобразуются глобальным фильтром исключений в единый
 * формат `{ code, message, details? }` с локализованным русским сообщением
 * (Req 1.1); список нарушений по полям попадает в `details`.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
};

/**
 * Создаёт настроенный {@link ValidationPipe} для приложения.
 *
 * Используется как при глобальной регистрации через `APP_PIPE`, так и в e2e-тестах,
 * чтобы поведение валидации совпадало с боевым.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe(VALIDATION_PIPE_OPTIONS);
}
