import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { buildHttpsRedirectUrl, isSecureRequest } from './https-redirect.util';

/**
 * Middleware перенаправления HTTP→HTTPS (Req 1.3, 1.4).
 *
 * Если запрос пришёл по незащищённому протоколу, отвечает постоянным
 * перенаправлением (301) на эквивалентный HTTPS-адрес с сохранением исходных
 * пути и параметров запроса. Защищённые запросы пропускаются дальше по цепочке.
 *
 * Вся логика построения адреса вынесена в чистые функции
 * {@link buildHttpsRedirectUrl} и {@link isSecureRequest}.
 */
@Injectable()
export class HttpsRedirectMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const forwardedProtoHeader = req.headers['x-forwarded-proto'];
    const forwardedProto = Array.isArray(forwardedProtoHeader)
      ? forwardedProtoHeader[0]
      : forwardedProtoHeader;

    if (isSecureRequest({ protocol: req.protocol, forwardedProto })) {
      next();
      return;
    }

    const host = req.headers.host;
    if (host === undefined || host.trim().length === 0) {
      // Без заголовка Host построить корректный адрес невозможно —
      // пропускаем запрос дальше, не прерывая обработку.
      next();
      return;
    }

    const target = buildHttpsRedirectUrl({ host, originalUrl: req.originalUrl });
    res.redirect(301, target);
  }
}
