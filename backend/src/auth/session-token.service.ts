import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { AccessTokenPayload, AuthPrincipal, AuthSession } from './auth.types';

/**
 * Выпуск и проверка JWT access-токенов поверх реестра серверных сессий
 * (Req 5.7, 19.10).
 *
 * Access-токены короткоживущие и подписываются секретом из конфигурации (HS256).
 * Каждой сессии соответствует запись в Redis ({@link SessionRegistry}) с
 * идентификатором токена `jti`. При проверке недостаточно валидной подписи:
 * токен считается действительным только при наличии активной записи сессии,
 * что позволяет мгновенно аннулировать токены (Req 3.4, 8.6, 19.10).
 *
 * Метод {@link SessionTokenService.verify} используется как HTTP-guard-ом
 * ({@link SessionAuthGuard}), так и Socket.IO-Gateway при авторизации
 * подключения — единая точка проверки для запросов и сокетов.
 */
@Injectable()
export class SessionTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionRegistry,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Выпускает новый access-токен для пользователя и регистрирует сессию в Redis
   * (Req 5.7). Срок жизни токена и записи сессии совпадает
   * ({@link AuthConfig.accessTokenTtlSeconds}).
   *
   * @param user Активная учётная запись, для которой создаётся сессия.
   * @returns Подписанный токен и метаданные сессии.
   */
  async issue(user: Pick<User, 'id' | 'role'>): Promise<AuthSession> {
    const tokenId = randomUUID();
    const ttlSeconds = this.config.auth.accessTokenTtlSeconds;
    const issuedAt = this.clock.now();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);

    const payload: AccessTokenPayload = { sub: user.id, jti: tokenId, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ttlSeconds });

    await this.sessions.register({
      tokenId,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      createdAt: issuedAt.toISOString(),
    });

    return { accessToken, tokenId, userId: user.id, role: user.role, expiresAt };
  }

  /**
   * Проверяет access-токен и возвращает аутентифицированный субъект.
   *
   * Порядок: проверка подписи и срока действия токена средствами JWT, затем
   * проверка валидности сессии по реестру (токен не аннулирован — Req 19.10).
   * Любая неуспешная проверка приводит к {@link AuthenticationException} (401)
   * без раскрытия причины.
   *
   * @param token Открытый JWT access-токен.
   * @returns Субъект {@link AuthPrincipal} при валидном токене и активной сессии.
   * @throws AuthenticationException Если токен недействителен или сессия аннулирована.
   */
  async verify(token: string): Promise<AuthPrincipal> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new AuthenticationException('Сессия недействительна. Выполните вход повторно.');
    }

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      !this.isRole(payload.role)
    ) {
      throw new AuthenticationException('Сессия недействительна. Выполните вход повторно.');
    }

    const valid = await this.sessions.isValid(payload.jti);
    if (!valid) {
      throw new AuthenticationException('Сессия недействительна. Выполните вход повторно.');
    }

    return { userId: payload.sub, tokenId: payload.jti, role: payload.role };
  }

  /** Проверяет, что значение является допустимой ролью. */
  private isRole(value: unknown): value is Role {
    return typeof value === 'string' && Object.values(Role).includes(value as Role);
  }
}
