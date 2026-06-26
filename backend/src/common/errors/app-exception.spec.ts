import { HttpStatus } from '@nestjs/common';
import {
  AccessDeniedException,
  AppException,
  AuthenticationException,
  EntityNotFoundException,
  RateLimitException,
  StateConflictException,
  UnprocessableException,
  ValidationException,
} from './app-exception';
import { ErrorCode } from './error-codes';

describe('AppException и доменные исключения', () => {
  it('использует сообщение по умолчанию и семантический статус для кода', () => {
    const exception = new AppException(ErrorCode.ACCESS_DENIED);

    expect(exception.code).toBe(ErrorCode.ACCESS_DENIED);
    expect(exception.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(exception.message).toBe('Недостаточно прав для выполнения действия.');
    expect(exception.toErrorResponse()).toEqual({
      code: ErrorCode.ACCESS_DENIED,
      message: 'Недостаточно прав для выполнения действия.',
    });
  });

  it('позволяет переопределить сообщение и добавить details', () => {
    const exception = new AppException(ErrorCode.VALIDATION_ERROR, 'Название обязательно.', {
      field: 'title',
    });

    expect(exception.toErrorResponse()).toEqual({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Название обязательно.',
      details: { field: 'title' },
    });
  });

  it('не включает поле details, когда оно не задано', () => {
    const exception = new AppException(ErrorCode.CONFLICT);

    expect(Object.prototype.hasOwnProperty.call(exception.toErrorResponse(), 'details')).toBe(
      false,
    );
  });

  it.each([
    [new ValidationException(), ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST],
    [new AuthenticationException(), ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED],
    [new AccessDeniedException(), ErrorCode.ACCESS_DENIED, HttpStatus.FORBIDDEN],
    [new EntityNotFoundException(), ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND],
    [new StateConflictException(), ErrorCode.CONFLICT, HttpStatus.CONFLICT],
    [new UnprocessableException(), ErrorCode.UNPROCESSABLE, HttpStatus.UNPROCESSABLE_ENTITY],
    [new RateLimitException(), ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS],
  ])('маппит доменное исключение на код и статус', (exception, code, status) => {
    expect(exception).toBeInstanceOf(AppException);
    expect(exception.code).toBe(code);
    expect(exception.getStatus()).toBe(status);
    expect(exception.message.length).toBeGreaterThan(0);
  });
});
