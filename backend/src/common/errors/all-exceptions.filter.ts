import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { sendJson, setResponseStatus, type HttpResponseLike } from '../http';
import { AppException } from './app-exception';
import { ERROR_CODE_REGISTRY, ErrorCode, errorCodeForStatus } from './error-codes';
import { buildErrorResponse, type ErrorResponseBody } from './error-response';

/**
 * Глобальный фильтр исключений (Req 1.1).
 *
 * Приводит все ошибки приложения к единому формату `{ code, message, details? }`
 * с локализованным русским сообщением и семантическим HTTP-статусом:
 * - {@link AppException} — доменные ошибки с уже заданным кодом и сообщением;
 * - {@link HttpException} — встроенные ошибки NestJS (guard-ы, пайпы валидации
 *   и т. п.) приводятся к коду по их HTTP-статусу;
 * - прочие (непредвиденные) ошибки — к внутренней ошибке `500` с обобщённым
 *   русским сообщением; детали исходной ошибки наружу не раскрываются.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const response = httpContext.getResponse<HttpResponseLike>();
    const request = httpContext.getRequest<{ method?: string; url?: string }>();

    const { status, body } = this.resolve(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Необработанная ошибка при обработке запроса ${request.method ?? 'UNKNOWN'} ${
          request.url ?? ''
        }`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    setResponseStatus(response, status);
    sendJson(response, body);
  }

  /** Определяет HTTP-статус и тело ответа в едином формате для исключения. */
  private resolve(exception: unknown): {
    status: number;
    body: ErrorResponseBody;
  } {
    if (exception instanceof AppException) {
      return { status: exception.getStatus(), body: exception.toErrorResponse() };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    const descriptor = ERROR_CODE_REGISTRY[ErrorCode.INTERNAL_ERROR];
    return {
      status: descriptor.status,
      body: buildErrorResponse(ErrorCode.INTERNAL_ERROR, descriptor.message),
    };
  }

  /**
   * Преобразует встроенное `HttpException` NestJS в единый формат.
   *
   * Код выбирается по HTTP-статусу. Сообщение остаётся локализованным
   * (берётся из реестра), а исходные сведения исключения (в т. ч. список
   * нарушений валидации от `ValidationPipe`) помещаются в `details`.
   */
  private fromHttpException(exception: HttpException): {
    status: number;
    body: ErrorResponseBody;
  } {
    const status = exception.getStatus();
    const code = errorCodeForStatus(status);
    const message = ERROR_CODE_REGISTRY[code].message;
    const details = this.extractDetails(exception);
    return { status, body: buildErrorResponse(code, message, details) };
  }

  /**
   * Извлекает детали из ответа встроенного исключения.
   *
   * Для ответа-объекта (например, `{ statusCode, error, message }` от
   * `ValidationPipe`) возвращает поле `message`, если оно несёт полезную
   * детализацию (массив нарушений). Строковый ответ деталей не добавляет,
   * так как сообщение уже локализовано из реестра.
   */
  private extractDetails(exception: HttpException): unknown {
    const payload = exception.getResponse();
    if (typeof payload !== 'object' || payload === null) {
      return undefined;
    }

    const messageField = (payload as { message?: unknown }).message;
    if (Array.isArray(messageField)) {
      return messageField;
    }

    return undefined;
  }
}
