import { HttpStatus } from '@nestjs/common';

/**
 * Реестр стабильных кодов ошибок Системы и их семантики (Req 1.1).
 *
 * Каждый код связан с семантическим HTTP-статусом (400/401/403/404/409/422/429
 * и 500) и локализованным русским сообщением по умолчанию. Коды стабильны и не
 * зависят от языка интерфейса; русский текст предназначен для отображения
 * пользователю.
 */
export const ErrorCode = {
  /** Нарушение валидации входных данных или выход за допустимые границы. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Пользователь не аутентифицирован либо токен недействителен. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** У пользователя нет прав на выполнение действия. */
  ACCESS_DENIED: 'ACCESS_DENIED',
  /** Запрошенный ресурс недоступен в пределах видимости пользователя. */
  NOT_FOUND: 'NOT_FOUND',
  /** Конфликт состояния (например, занятый адрес электронной почты). */
  CONFLICT: 'CONFLICT',
  /** Семантически недопустимая операция (например, недопустимый переход статуса). */
  UNPROCESSABLE: 'UNPROCESSABLE',
  /** Превышена допустимая частота запросов. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Внутренняя ошибка Системы. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** Тип значения кода ошибки из реестра {@link ErrorCode}. */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Описание кода ошибки: семантический HTTP-статус и русское сообщение. */
export interface ErrorCodeDescriptor {
  /** Семантический HTTP-статус ответа. */
  status: HttpStatus;
  /** Локализованное русское сообщение по умолчанию (Req 1.1). */
  message: string;
}

/**
 * Соответствие кодов ошибок их HTTP-статусам и сообщениям по умолчанию.
 *
 * Семантика статусов (см. раздел Error Handling дизайна):
 * - `400` — нарушение валидации/границ;
 * - `401` — не аутентифицирован/невалидный токен;
 * - `403` — нет прав/доступа;
 * - `404` — ресурс недоступен в пределах видимости (без раскрытия чужих данных, Req 2.12);
 * - `409` — конфликт состояния;
 * - `422` — недопустимая операция/переход;
 * - `429` — превышение частоты запросов.
 */
export const ERROR_CODE_REGISTRY: Record<ErrorCodeValue, ErrorCodeDescriptor> = {
  [ErrorCode.VALIDATION_ERROR]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Переданные данные не прошли проверку.',
  },
  [ErrorCode.UNAUTHENTICATED]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Требуется вход в систему.',
  },
  [ErrorCode.ACCESS_DENIED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Недостаточно прав для выполнения действия.',
  },
  [ErrorCode.NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Запрашиваемый ресурс не найден.',
  },
  [ErrorCode.CONFLICT]: {
    status: HttpStatus.CONFLICT,
    message: 'Операция конфликтует с текущим состоянием данных.',
  },
  [ErrorCode.UNPROCESSABLE]: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Операция недопустима в текущем состоянии.',
  },
  [ErrorCode.RATE_LIMITED]: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Превышена допустимая частота запросов. Повторите попытку позже.',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Внутренняя ошибка сервера. Попробуйте повторить запрос позже.',
  },
};

/**
 * Сопоставляет HTTP-статус коду ошибки из реестра.
 *
 * Используется фильтром исключений для приведения встроенных
 * `HttpException` (например, от guard-ов или пайпов валидации) к единому
 * формату. Неизвестные статусы трактуются как внутренняя ошибка.
 */
export function errorCodeForStatus(status: number): ErrorCodeValue {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.VALIDATION_ERROR;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHENTICATED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.ACCESS_DENIED;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ErrorCode.UNPROCESSABLE;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
