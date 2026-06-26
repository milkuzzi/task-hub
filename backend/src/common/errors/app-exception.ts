import { HttpException } from '@nestjs/common';
import { ERROR_CODE_REGISTRY, ErrorCode, type ErrorCodeValue } from './error-codes';
import { buildErrorResponse, type ErrorResponseBody } from './error-response';

/**
 * Базовое доменное исключение Системы.
 *
 * Наследует {@link HttpException}, чтобы корректно интегрироваться с механизмом
 * NestJS, но всегда несёт стабильный {@link ErrorCodeValue}, локализованное
 * русское сообщение и необязательные детали. Семантический HTTP-статус
 * определяется кодом ошибки через {@link ERROR_CODE_REGISTRY} (Req 1.1).
 *
 * Тело ответа уже сформировано в едином формате `{ code, message, details? }`
 * и используется глобальным фильтром исключений без дополнительных
 * преобразований.
 */
export class AppException extends HttpException {
  /** Стабильный машиночитаемый код ошибки. */
  readonly code: ErrorCodeValue;
  /** Необязательные дополнительные сведения об ошибке. */
  readonly details?: unknown;

  /**
   * @param code Код ошибки из реестра {@link ErrorCode}.
   * @param message Переопределённое русское сообщение; при отсутствии берётся
   *   сообщение по умолчанию для данного кода.
   * @param details Необязательные дополнительные сведения (не должны раскрывать
   *   содержимое недоступных ресурсов, Req 2.12).
   */
  constructor(code: ErrorCodeValue, message?: string, details?: unknown) {
    const descriptor = ERROR_CODE_REGISTRY[code];
    const resolvedMessage = message ?? descriptor.message;
    super(buildErrorResponse(code, resolvedMessage, details), descriptor.status);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /** Возвращает тело ответа об ошибке в едином формате. */
  toErrorResponse(): ErrorResponseBody {
    return buildErrorResponse(this.code, this.message, this.details);
  }
}

/**
 * Ошибка валидации входных данных или выхода за допустимые границы (HTTP 400).
 * Применяется до внесения изменений в состояние (Req 9.3 и др.).
 */
export class ValidationException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.VALIDATION_ERROR, message, details);
  }
}

/**
 * Пользователь не аутентифицирован либо токен недействителен (HTTP 401).
 * (Req 8.7, 19.10)
 */
export class AuthenticationException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.UNAUTHENTICATED, message, details);
  }
}

/**
 * Отказ в доступе из-за отсутствия прав (HTTP 403).
 * Не раскрывает содержимое недоступного ресурса (Req 2.6, 2.12, 6.8, 10.14).
 */
export class AccessDeniedException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.ACCESS_DENIED, message, details);
  }
}

/**
 * Ресурс недоступен в пределах видимости пользователя (HTTP 404).
 * Используется, чтобы не раскрывать существование чужих задач (Req 2.12).
 */
export class EntityNotFoundException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.NOT_FOUND, message, details);
  }
}

/**
 * Конфликт с текущим состоянием данных (HTTP 409).
 * Например, занятый адрес электронной почты при восстановлении (Req 7.5).
 */
export class StateConflictException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.CONFLICT, message, details);
  }
}

/**
 * Семантически недопустимая операция в текущем состоянии (HTTP 422).
 * Например, недопустимый переход статуса задачи (Req 10.15).
 */
export class UnprocessableException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.UNPROCESSABLE, message, details);
  }
}

/**
 * Превышение допустимой частоты запросов (HTTP 429). (Req 19.2)
 */
export class RateLimitException extends AppException {
  constructor(message?: string, details?: unknown) {
    super(ErrorCode.RATE_LIMITED, message, details);
  }
}
