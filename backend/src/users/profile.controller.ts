import { Body, Controller, Delete, Get, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  AccessDeniedException,
  EntityNotFoundException,
  StateConflictException,
  ValidationException,
} from '../common/errors';
import { readSingleMultipartFile } from '../common/http';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { MAX_OAUTH_PORT, MaxOAuthExchangeError, type MaxOAuthPort } from '../max/oauth';
import { UserRepository } from '../repositories';
import { MaxProfile, UploadedFile as ProfileUploadedFile } from './profile.types';
import { CurrentUserView, toCurrentUser } from './user-representation';
import { UsersService } from './users.service';
import { LinkMaxDto, UpdateMaxNotificationsDto, UpdateProfileDto } from './dto';

/**
 * Единый лимит размера загружаемого аватара — 5 МБ (Req 3.1, 3.3 спеки;
 * исходное ТЗ Req 6.4, 6.9).
 *
 * Задаётся при streaming-разборе multipart-запроса и дополнительно
 * перепроверяется {@link UsersService.setAvatar} по значению
 * `AppConfigService.limits.avatarMaxBytes` — источнику истины (двойной
 * контроль, Req 3.3).
 */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/**
 * HTTP-слой собственного профиля текущего Пользователя (Req 3 спеки;
 * исходное ТЗ Req 6.4, 6.6, 16.2, 19.8).
 *
 * Тонкий контроллер над {@link UsersService}: разбирает HTTP-запрос, вызывает
 * доменный метод и формирует представление {@link CurrentUserView}. Пользователь
 * управляет ИСКЛЮЧИТЕЛЬНО собственным профилем — идентификатор инициатора
 * берётся из аутентифицированной Сессии и передаётся одновременно как инициатор
 * и как цель операции (Req 3.1, 3.2). Все маршруты требуют действующей Сессии
 * ({@link SessionAuthGuard}). Проверки формата/размера аватара, верификации
 * привязки MAX и доменные инварианты выполняются в сервисе; доменные исключения
 * преобразуются глобальным фильтром в единый формат `{ code, message }`
 * (Req 1.1). Глобальный префикс `/api` применяется в `main.ts`.
 */
@Controller('profile')
@UseGuards(SessionAuthGuard)
export class ProfileController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userRepository: UserRepository,
    @Inject(MAX_OAUTH_PORT)
    private readonly maxOAuth: MaxOAuthPort,
  ) {}

  /**
   * Загрузка собственного аватара (Req 3.1, 3.3; исходное ТЗ Req 6.4, 6.9).
   *
   * Поле формы — `avatar` (контракт `frontend/src/lib/auth-api.ts`). Лимит 5 МБ
   * задаётся при streaming-разборе и перепроверяется сервисом; неподдерживаемый
   * формат или превышение размера отклоняются {@link ValidationException}, а
   * прежние данные профиля сохраняются (Req 3.3). Делегирует
   * {@link UsersService.setAvatar}, передавая идентификатор текущего
   * Пользователя одновременно как инициатор и как цель (Пользователь меняет
   * только собственный аватар, Req 3.1). Возвращает обновлённый профиль
   * `CurrentUser`.
   */
  @Post('avatar')
  async uploadAvatar(@Req() req: AuthenticatedRequest): Promise<CurrentUserView> {
    const userId = this.principal(req).userId;
    const file = await readSingleMultipartFile(req as unknown as FastifyRequest, {
      fieldName: 'avatar',
      maxBytes: AVATAR_MAX_BYTES,
    });
    const uploaded: ProfileUploadedFile = {
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.size,
      buffer: file.buffer,
    };
    await this.usersService.setAvatar(userId, userId, uploaded);
    return this.currentUser(userId);
  }

  /**
   * Изменение собственного отображаемого имени.
   *
   * Делегирует {@link UsersService.updateProfile}: на текущих доменных правилах
   * это доступно только активному Администратору, но цель всегда равна текущему
   * пользователю, поэтому через `/profile` нельзя менять чужие данные.
   */
  @Patch()
  async updateProfile(
    @Body() dto: UpdateProfileDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CurrentUserView> {
    const userId = this.principal(req).userId;
    await this.usersService.updateProfile(userId, userId, { displayName: dto.name });
    return this.currentUser(userId);
  }

  /**
   * Привязка собственного профиля MAX по коду авторизации OAuth (Req 3.2;
   * исходное ТЗ Req 6.6, 16.2).
   *
   * Порядок:
   * 1. обмен одноразового `authCode` на идентификатор профиля MAX
   *    (`maxUserId`) через порт {@link MaxOAuthPort}; успешный обмен означает
   *    верификацию профиля на стороне MAX;
   * 2. делегирование {@link UsersService.linkMax} с верифицированным профилем —
   *    сервис отклоняет неверифицированный/чужой профиль и конфликт привязки
   *    (Req 6.9); `ownerUserId` не задаётся (порт его не предоставляет), поэтому
   *    проверка совпадения владельца в сервисе не применяется.
   *
   * Любой неуспех обмена на стороне MAX ({@link MaxOAuthExchangeError}, в т.ч.
   * когда интеграция MAX не настроена и адаптер сигнализирует недоступность)
   * приводится к доменной {@link ValidationException} и возвращается клиенту в
   * едином формате `{ code, message }` глобальным фильтром (Req 9.6). Возвращает
   * обновлённый профиль `CurrentUser`.
   */
  @Post('max')
  async linkMax(
    @Body() dto: LinkMaxDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CurrentUserView> {
    const userId = this.principal(req).userId;

    let maxUserId: string;
    try {
      maxUserId =
        dto.redirectUri === undefined
          ? await this.maxOAuth.exchangeAuthCode(dto.authCode)
          : await this.maxOAuth.exchangeAuthCode(dto.authCode, dto.redirectUri);
    } catch (error) {
      // Неуспех обмена кода авторизации MAX (включая ненастроенную интеграцию)
      // трактуется как доменная ошибка привязки (Req 3.2, 9.6).
      const reason = error instanceof MaxOAuthExchangeError ? error.message : String(error);
      throw new ValidationException(
        `Не удалось привязать профиль MAX: обмен кода авторизации не выполнен (${reason}).`,
      );
    }

    // Успешный обмен означает верификацию профиля на стороне MAX; `ownerUserId`
    // не задаётся, так как порт его не возвращает (Req 6.9).
    const maxProfile: MaxProfile = { maxUserId, verified: true };
    await this.usersService.linkMax(userId, maxProfile);
    return this.currentUser(userId);
  }

  /**
   * Отвязка собственного профиля MAX.
   *
   * Удаляет связь `MaxLink` текущего пользователя и возвращает обновлённый
   * `CurrentUser` с `maxLinked=false`. Операция идемпотентна: повторный вызов
   * без активной привязки возвращает текущий профиль без ошибки.
   */
  @Delete('max')
  async unlinkMax(@Req() req: AuthenticatedRequest): Promise<CurrentUserView> {
    const userId = this.principal(req).userId;
    await this.usersService.unlinkMax(userId);
    return this.currentUser(userId);
  }

  @Get('max/notifications')
  async getMaxNotifications(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ linked: boolean; muted: boolean }> {
    const link = await this.userRepository.findMaxLinkByUserId(this.principal(req).userId);
    return link === null ? { linked: false, muted: true } : { linked: true, muted: link.mutedAll };
  }

  @Patch('max/notifications')
  async updateMaxNotifications(
    @Body() dto: UpdateMaxNotificationsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ linked: true; muted: boolean }> {
    const userId = this.principal(req).userId;
    const link = await this.userRepository.findMaxLinkByUserId(userId);
    if (link === null) {
      throw new StateConflictException('Профиль MAX не привязан к учётной записи.');
    }
    const updated = await this.userRepository.setMaxMutedAllByUserId(userId, dto.muted);
    return { linked: true, muted: updated.mutedAll };
  }

  /**
   * Формирует представление `CurrentUser` по идентификатору, подгружая привязку
   * MAX. Используется после операций обновления собственного профиля.
   */
  private async currentUser(userId: string): Promise<CurrentUserView> {
    const user = await this.userRepository.findByIdWithMaxLink(userId);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    return toCurrentUser(user);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
