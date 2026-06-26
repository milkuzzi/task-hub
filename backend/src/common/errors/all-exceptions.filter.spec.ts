import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AccessDeniedException, ValidationException } from './app-exception';
import { ErrorCode } from './error-codes';

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Создаёт минимальный мок {@link ArgumentsHost} с перехватом записанного
 * ответа, чтобы проверить итоговый статус и тело без реального HTTP-сервера.
 */
function createHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
  const response = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };
  const request = { method: 'GET', url: '/tasks/42' };

  const host = {
    switchToHttp: () => ({
      getResponse: <T>() => response as unknown as T,
      getRequest: <T>() => request as unknown as T,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('рендерит доменное исключение в едином формате', () => {
    const { host, captured } = createHost();

    filter.catch(new AccessDeniedException(), host);

    expect(captured.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(captured.body).toEqual({
      code: ErrorCode.ACCESS_DENIED,
      message: 'Недостаточно прав для выполнения действия.',
    });
  });

  it('сохраняет переопределённое сообщение и details доменного исключения', () => {
    const { host, captured } = createHost();

    filter.catch(new ValidationException('Дедлайн обязателен.', { field: 'deadline' }), host);

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body).toEqual({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Дедлайн обязателен.',
      details: { field: 'deadline' },
    });
  });

  it('приводит встроенное HttpException к коду по статусу с русским сообщением', () => {
    const { host, captured } = createHost();

    filter.catch(new ForbiddenException(), host);

    expect(captured.statusCode).toBe(HttpStatus.FORBIDDEN);
    expect(captured.body).toEqual({
      code: ErrorCode.ACCESS_DENIED,
      message: 'Недостаточно прав для выполнения действия.',
    });
  });

  it('переносит нарушения ValidationPipe в details', () => {
    const { host, captured } = createHost();
    const violations = ['title must be longer than 1 character'];

    filter.catch(new BadRequestException(violations), host);

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body).toEqual({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Переданные данные не прошли проверку.',
      details: violations,
    });
  });

  it('маскирует непредвиденные ошибки как внутреннюю ошибку 500', () => {
    const { host, captured } = createHost();
    const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    filter.catch(new Error('секретные детали реализации'), host);

    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toEqual({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Внутренняя ошибка сервера. Попробуйте повторить запрос позже.',
    });
    loggerSpy.mockRestore();
  });
});
