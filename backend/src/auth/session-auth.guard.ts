import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthenticationException } from '../common/errors';
import { AuthPrincipal } from './auth.types';
import { readSessionCookie } from './session-cookie';
import { SessionTokenService } from './session-token.service';

/** HTTP-запрос с присоединённым аутентифицированным субъектом. */
export interface AuthenticatedRequest {
  /** HTTP-заголовки запроса. */
  headers: Record<string, string | string[] | undefined>;
  /** IP-адрес клиента, если adapter смог его определить. */
  ip?: string;
  /** Низкоуровневый socket для fallback-определения IP. */
  socket?: { remoteAddress?: string };
  /** Субъект, установленный {@link SessionAuthGuard} после проверки токена. */
  user?: AuthPrincipal;
}

/**
 * Guard проверки валидности сессии при каждом HTTP-запросе (Req 5.7, 19.10).
 *
 * Извлекает access-токен из legacy заголовка `Authorization: Bearer <token>`
 * либо из HttpOnly cookie `taskhub_session`, проверяет его подпись/срок и
 * валидность сессии через {@link SessionTokenService.verify}. Явный Bearer
 * имеет приоритет над cookie, чтобы MAX mini-app не ломалась из-за устаревшей
 * браузерной cookie сайта. При успехе присоединяет {@link AuthPrincipal} к
 * запросу (`request.user`); иначе отклоняет запрос
 * {@link AuthenticationException} (401). Аннулированные сессии перестают
 * проходить проверку немедленно, без ожидания истечения токена (Req 19.10).
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessionTokens: SessionTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token =
      this.extractBearerToken(firstHeaderValue(request.headers.authorization)) ??
      readSessionCookie(firstHeaderValue(request.headers.cookie));
    if (token === null) {
      throw new AuthenticationException('Требуется вход в систему.');
    }

    request.user = await this.sessionTokens.verify(token);
    return true;
  }

  /**
   * Извлекает токен из заголовка `Authorization` схемы Bearer.
   * @returns Токен либо `null`, если заголовок отсутствует или имеет иную схему.
   */
  private extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) {
      return null;
    }
    const [scheme, value] = header.split(' ');
    if (scheme !== 'Bearer' || value === undefined || value.trim() === '') {
      return null;
    }
    return value.trim();
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
