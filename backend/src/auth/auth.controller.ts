import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticationException, EntityNotFoundException } from '../common/errors';
import { UserRepository } from '../repositories';
import { RateLimit, RateLimitGuard } from '../security';
import { CurrentUserView, toCurrentUser } from '../users/user-representation';
import { AuthService } from './auth.service';
import { AuthSession } from './auth.types';
import { SessionAuthGuard, AuthenticatedRequest } from './session-auth.guard';
import { LoginDto, MaxLoginDto, SetPasswordDto, ChangePasswordDto } from './dto';

/** Ответ успешной аутентификации: токен Сессии и профиль (контракт `auth-api.ts`). */
interface AuthSessionResponse {
  /** Подписанный JWT access-токен для заголовка `Authorization: Bearer`. */
  token: string;
  /** Профиль аутентифицированного Пользователя. */
  user: CurrentUserView;
}

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
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthSessionResponse> {
    const session = await this.authService.login(dto.email, dto.password, req.ip ?? '');
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
  async max(@Body() dto: MaxLoginDto): Promise<AuthSessionResponse> {
    const session = await this.authService.loginWithMax(dto.authCode);
    return this.toSessionResponse(session);
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
  async logout(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.authService.revokeAllSessions(this.principal(req).userId);
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
  async refresh(@Req() req: AuthenticatedRequest): Promise<AuthSessionResponse> {
    const session = await this.authService.refreshSession(this.principal(req));
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
