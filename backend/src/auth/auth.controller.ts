import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AppConfigService } from '../config';
import {
  AuthenticationException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { redirectResponse, type HttpResponseLike } from '../common/http';
import { UserRepository } from '../repositories';
import { RateLimit, RateLimitGuard } from '../security';
import { CurrentUserView, toCurrentUser } from '../users/user-representation';
import { AuthService } from './auth.service';
import { AuthSession } from './auth.types';
import { SessionAuthGuard, AuthenticatedRequest } from './session-auth.guard';
import { clearSessionCookie, setSessionCookie } from './session-cookie';
import { LoginDto, MaxLoginDto, SetPasswordDto, ChangePasswordDto } from './dto';

/** Ответ успешной аутентификации: токен Сессии и профиль (контракт `auth-api.ts`). */
interface AuthSessionResponse {
  /** Подписанный JWT access-токен для заголовка `Authorization: Bearer`. */
  token: string;
  /** Профиль аутентифицированного Пользователя. */
  user: CurrentUserView;
}

interface MaxOAuthStartQuery {
  redirect_uri?: string;
  state?: string;
  purpose?: string;
}

const MAX_OAUTH_CALLBACK_PATHS = new Set(['/auth/max/callback', '/profile/max/callback']);

/**
 * HTTP-слой аутентификации и профиля текущей Сессии (Req 5, 6.1, 6.7, 16.1,
 * 19.10).
 *
 * Тонкий контроллер над {@link AuthService}: разбирает запрос, делегирует
 * прикладному сервису и сопоставляет результат с контрактом frontend
 * (`auth-api.ts`). Маршруты без префикса (frontend обращается к `/api/*`, nginx
 * срезает `/api`). Валидация входа выполняется глобальным `ValidationPipe`, а
 * доменные исключения преобразуются глобальным фильтром в единый формат
 * `{ code, message, details? }` (Req 1.1) — собственные pipe/filter не
 * требуются.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly userRepository: UserRepository,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Вход по адресу электронной почты и паролю (Req 5.7, 5.8).
   *
   * Источник запроса (`req.ip`) передаётся в сервис для журналирования попыток
   * входа и блокировки (Req 5.9, 19.3). При успехе возвращает токен Сессии и
   * профиль Пользователя.
   */
  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<AuthSessionResponse> {
    const session = await this.authService.login(
      dto.email,
      dto.password,
      req.ip ?? req.socket?.remoteAddress ?? '',
    );
    setSessionCookie(res, session, this.config);
    return this.toSessionResponse(session);
  }

  /**
   * Вход через OAuth MAX по полученному коду авторизации (Req 16.1, 16.3).
   *
   * При успехе возвращает токен Сессии и профиль Пользователя; при любом отказе
   * сервис возвращает единое исключение аутентификации без раскрытия причины
   * (Req 16.3).
   */
  @Post('max')
  @UseGuards(RateLimitGuard)
  @RateLimit('login')
  async max(
    @Body() dto: MaxLoginDto,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<AuthSessionResponse> {
    const session = await this.authService.loginWithMax(dto.authCode, dto.redirectUri);
    setSessionCookie(res, session, this.config);
    return this.toSessionResponse(session);
  }

  /**
   * Серверный инициатор OAuth MAX. Используется frontend fallback-ом, когда
   * build-time переменные Vite для MAX не заданы: браузер открывает
   * `/api/auth/max/start`, а backend строит redirect на страницу авторизации из
   * серверной конфигурации.
   */
  @Get('max/start')
  @UseGuards(RateLimitGuard)
  @RateLimit('login')
  startMax(@Query() query: MaxOAuthStartQuery, @Res() res: HttpResponseLike): void {
    const redirectUri = this.resolveMaxRedirectUri(query);
    const authorizationUrl = this.buildMaxAuthorizationUrl(redirectUri, query.state);
    redirectResponse(
      res,
      302,
      authorizationUrl ??
        this.buildMaxErrorRedirect(redirectUri, query.state, 'oauth_not_configured'),
    );
  }

  /**
   * Установка пароля по одноразовой ссылке и активация учётной записи
   * (Req 5.5, 6.7). Тело ответа отсутствует (204).
   */
  @Post('set-password')
  @UseGuards(RateLimitGuard)
  @RateLimit('set_password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setPassword(@Body() dto: SetPasswordDto): Promise<void> {
    await this.authService.setPassword(dto.token, dto.password);
  }

  /**
   * Смена собственного пароля аутентифицированным Пользователем (Req 6.1, 6.7).
   *
   * Идентификатор Пользователя берётся из аутентифицированной Сессии — изменить
   * можно только собственный пароль. Тело ответа отсутствует (204).
   */
  @Post('change-password')
  @UseGuards(SessionAuthGuard, RateLimitGuard)
  @RateLimit('change_password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.authService.changePassword(
      this.principal(req).userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /**
   * Профиль текущей Сессии (восстановление состояния после перезагрузки).
   * Доступно только при действующей Сессии (Req 5.7, 19.10).
   */
  @Get('me')
  @UseGuards(SessionAuthGuard)
  async me(@Req() req: AuthenticatedRequest): Promise<CurrentUserView> {
    return this.loadCurrentUser(this.principal(req).userId);
  }

  /**
   * Завершение Сессии на сервере (Req 19.10). Аннулирует все Сессии и токены
   * текущего Пользователя ≤5с. Тело ответа отсутствует (204).
   */
  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<void> {
    await this.authService.revokeAllSessions(this.principal(req).userId);
    clearSessionCookie(res, this.config);
  }

  /**
   * Продление действующей Сессии активного Пользователя (скользящая сессия,
   * Req 2.9; исправление дефекта 9). Доступно только при действующей Сессии:
   * {@link SessionAuthGuard} проверяет валидность токена и записи Сессии перед
   * вызовом, поэтому эндпоинт не создаёт неаутентифицированной поверхности.
   *
   * Выпускает новый короткоживущий токен (новый `jti` и запись Сессии) и
   * аннулирует прежний токен, возвращая новый токен и профиль в том же формате,
   * что и вход. Прежний токен после ответа отклоняется (мгновенная отзываемость
   * сохраняется, Req 3.9).
   */
  @Post('refresh')
  @UseGuards(SessionAuthGuard)
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<AuthSessionResponse> {
    const session = await this.authService.refreshSession(this.principal(req));
    setSessionCookie(res, session, this.config);
    return this.toSessionResponse(session);
  }

  /**
   * Формирует ответ успешной аутентификации: токен и профиль Пользователя,
   * загруженный по идентификатору владельца Сессии.
   */
  private async toSessionResponse(session: AuthSession): Promise<AuthSessionResponse> {
    return {
      token: session.accessToken,
      user: await this.loadCurrentUser(session.userId),
    };
  }

  private buildMaxAuthorizationUrl(redirectUri: string, state: string | undefined): string | null {
    const { oauthAuthorizeUrl, oauthClientId } = this.config.max;
    if (oauthAuthorizeUrl === '' || oauthClientId === '') {
      return null;
    }

    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(oauthAuthorizeUrl);
    } catch {
      return null;
    }

    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', oauthClientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    const normalizedState = typeof state === 'string' ? state.trim() : '';
    if (normalizedState !== '') {
      authorizeUrl.searchParams.set('state', normalizedState);
    }
    return authorizeUrl.toString();
  }

  private buildMaxErrorRedirect(
    redirectUri: string,
    state: string | undefined,
    error: string,
  ): string {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    const normalizedState = typeof state === 'string' ? state.trim() : '';
    if (normalizedState !== '') {
      url.searchParams.set('state', normalizedState);
    }
    return url.toString();
  }

  private resolveMaxRedirectUri(query: MaxOAuthStartQuery): string {
    let publicUrl: URL;
    try {
      publicUrl = new URL(this.config.app.publicUrl);
    } catch {
      throw new ValidationException('PUBLIC_URL должен быть корректным URL для OAuth MAX.');
    }

    const fallbackPath = query.purpose === 'link' ? '/profile/max/callback' : '/auth/max/callback';
    const rawRedirectUri =
      typeof query.redirect_uri === 'string' && query.redirect_uri.trim() !== ''
        ? query.redirect_uri
        : new URL(fallbackPath, publicUrl).toString();

    let redirectUri: URL;
    try {
      redirectUri = new URL(rawRedirectUri);
    } catch {
      throw new ValidationException('redirect_uri OAuth MAX должен быть корректным URL.');
    }

    if (
      redirectUri.origin !== publicUrl.origin ||
      !MAX_OAUTH_CALLBACK_PATHS.has(redirectUri.pathname)
    ) {
      throw new ValidationException('redirect_uri OAuth MAX не разрешён для этого приложения.');
    }
    return redirectUri.toString();
  }

  /**
   * Загружает Пользователя (с привязкой MAX) и сопоставляет его с профилем
   * `CurrentUser`.
   *
   * @throws EntityNotFoundException Если учётная запись не найдена (защитная
   *   проверка; при действующей Сессии не наступает).
   */
  private async loadCurrentUser(userId: string): Promise<CurrentUserView> {
    const user = await this.userRepository.findByIdWithMaxLink(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    return toCurrentUser(user);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    // Guard гарантирует наличие `req.user`; защитная проверка для типобезопасности.
    if (req.user === undefined) {
      throw new AuthenticationException('Требуется вход в систему.');
    }
    return req.user;
  }
}
