import { NextFunction, Request, Response } from 'express';
import { HttpsRedirectMiddleware } from './https-redirect.middleware';

/**
 * Smoke-тесты проводки перенаправления HTTP→HTTPS (задача 21.3, Req 1.3, 1.4).
 *
 * В отличие от property-теста чистой функции построения адреса
 * ({@link buildHttpsRedirectUrl}), здесь проверяется именно поведение
 * middleware как звена обработки запроса: незащищённые запросы получают
 * постоянное перенаправление (301) на эквивалентный HTTPS-адрес с сохранением
 * пути и query, а защищённые — пропускаются дальше по цепочке. Учитывается
 * терминирование TLS обратным прокси через заголовок `X-Forwarded-Proto`.
 */
describe('HttpsRedirectMiddleware (Req 1.3, 1.4) — smoke', () => {
  let middleware: HttpsRedirectMiddleware;

  /** Минимальная заглушка Request с управляемыми полями. */
  const requestOf = (parts: {
    protocol?: string;
    host?: string | undefined;
    originalUrl?: string;
    forwardedProto?: string | string[];
  }): Request => {
    const headers: Record<string, string | string[] | undefined> = {};
    if (parts.host !== undefined) {
      headers.host = parts.host;
    }
    if (parts.forwardedProto !== undefined) {
      headers['x-forwarded-proto'] = parts.forwardedProto;
    }
    return {
      protocol: parts.protocol ?? 'http',
      originalUrl: parts.originalUrl ?? '/',
      headers,
    } as unknown as Request;
  };

  /** Заглушка Response, фиксирующая вызов redirect(status, url). */
  const responseSpy = (): { res: Response; redirect: jest.Mock } => {
    const redirect = jest.fn();
    const res = { redirect } as unknown as Response;
    return { res, redirect };
  };

  beforeEach(() => {
    middleware = new HttpsRedirectMiddleware();
  });

  it('перенаправляет HTTP-запрос на HTTPS (301) с сохранением пути и query', () => {
    const req = requestOf({
      protocol: 'http',
      host: 'example.com',
      originalUrl: '/tasks/42?filter=open&sort=deadline',
    });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(
      301,
      'https://example.com/tasks/42?filter=open&sort=deadline',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('пропускает запрос, пришедший по HTTPS (собственный протокол сервера)', () => {
    const req = requestOf({ protocol: 'https', host: 'example.com', originalUrl: '/a' });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('пропускает запрос с X-Forwarded-Proto=https (TLS терминирует прокси)', () => {
    const req = requestOf({
      protocol: 'http',
      host: 'example.com',
      originalUrl: '/a',
      forwardedProto: 'https',
    });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('перенаправляет при X-Forwarded-Proto=http', () => {
    const req = requestOf({
      protocol: 'http',
      host: 'example.com',
      originalUrl: '/path?x=1',
      forwardedProto: 'http',
    });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(redirect).toHaveBeenCalledWith(301, 'https://example.com/path?x=1');
    expect(next).not.toHaveBeenCalled();
  });

  it('учитывает первый протокол из списка X-Forwarded-Proto в виде массива', () => {
    const req = requestOf({
      protocol: 'http',
      host: 'example.com',
      originalUrl: '/a',
      forwardedProto: ['https', 'http'],
    });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('пропускает запрос без заголовка Host (построить адрес невозможно)', () => {
    const req = requestOf({ protocol: 'http', host: undefined, originalUrl: '/a' });
    const { res, redirect } = responseSpy();
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });
});
