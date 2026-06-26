import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticationException } from '../common/errors';
import { AuthPrincipal } from './auth.types';
import { SessionTokenService } from './session-token.service';

/** HTTP-запрос с присоединённым аутентифицированным субъектом. */
export interface AuthenticatedRequest extends Request {
  /** Субъект, установленный {@link SessionAuthGuard} после проверки токена. */
  user?: AuthPrincipal;
}

/**
 * Guard проверки валидности сессии при каждом HTTP-запросе (Req 5.7, 19.10).
 *
 * Извлекает access-токен из заголовка `Authorization: Bearer <token>`,
 * проверяет его подпись/срок и валидность сессии через
 * {@link SessionTokenService.verify}. При успехе присоединяет
 * {@link AuthPrincipal} к запросу (`request.user`); иначе отклоняет запрос
 * {@link AuthenticationException} (401). Аннулированные сессии перестают
 * проходить проверку немедленно, без ожидания истечения токена (Req 19.10).
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessionTokens: SessionTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
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
