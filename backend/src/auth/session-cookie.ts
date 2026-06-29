import { appendResponseHeader, type HttpResponseLike } from '../common/http';
import { AppConfigService } from '../config';
import { AuthSession } from './auth.types';

export const SESSION_COOKIE_NAME = 'taskhub_session';

/**
 * Минимальный parser Cookie header без дополнительной runtime-зависимости.
 * Нужен guard-ам и Socket.IO handshake, где cookie-parser middleware не участвует.
 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader.trim() === '') {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.split('=');
    const name = rawName?.trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    const value = rawValue.join('=').trim();
    if (value === '') {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function setSessionCookie(
  response: HttpResponseLike,
  session: AuthSession,
  config: AppConfigService,
): void {
  const maxAge = Math.max(0, session.expiresAt.getTime() - Date.now());
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge,
  } as const;

  if (typeof response.cookie === 'function') {
    response.cookie(SESSION_COOKIE_NAME, session.accessToken, cookieOptions);
    return;
  }

  appendResponseHeader(
    response,
    'Set-Cookie',
    serializeSessionCookie(session.accessToken, config, { maxAge }),
  );
}

export function clearSessionCookie(response: HttpResponseLike, config: AppConfigService): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
  } as const;

  if (typeof response.clearCookie === 'function') {
    response.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return;
  }

  appendResponseHeader(
    response,
    'Set-Cookie',
    serializeSessionCookie('', config, {
      maxAge: 0,
      expires: new Date(0),
    }),
  );
}

function serializeSessionCookie(
  value: string,
  config: AppConfigService,
  options: { maxAge: number; expires?: Date },
): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(options.maxAge / 1000)}`,
  ];
  if (options.expires !== undefined) {
    attributes.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (config.isProduction) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}
