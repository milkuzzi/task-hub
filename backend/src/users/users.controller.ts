import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Role } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { readSingleMultipartFile, setResponseHeaders, type HttpResponseLike } from '../common/http';
import { AuthService, SessionAuthGuard, AuthenticatedRequest } from '../auth';
import { ClockService } from '../clock';
import { UserRepository } from '../repositories';
import {
  AdminUserView,
  DeletedUserView,
  DirectoryUserView,
  toAdminUser,
  toDeletedUser,
  toDirectoryUser,
} from './user-representation';
import { UsersService } from './users.service';
import { UsersExcelService, UsersImportResult } from './users-excel.service';
import { InviteUserDto, RestoreUserDto, UpdateUserDto } from './dto';
import { UploadedFile as ProfileUploadedFile } from './profile.types';

/** Режим удаления Пользователя (Req 8.1). */
type DeleteMode = 'soft' | 'hard';

/** Единый лимит размера аватара — 5 МБ. */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Единый лимит размера Excel-файла импорта Пользователей — 5 МБ. */
const USERS_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * HTTP-слой администрирования Пользователей (Req 2, 3, 5, 6, 7, 8).
 *
 * Тонкий контроллер над {@link UsersService}: разбирает HTTP-запрос, вызывает
 * доменный метод и формирует представление. Все маршруты требуют действующей
 * Сессии ({@link SessionAuthGuard}). Проверка роли Администратора и доменные
 * инварианты выполняются в сервисе; контроллер дополнительно ограничивает
 * чтение списков ролью Администратора (как и прежде для `list`). Доменные
 * исключения преобразуются глобальным фильтром в единый формат
 * `{ code, message }` (Req 1.1).
 */
@Controller('users')
@UseGuards(SessionAuthGuard)
export class UsersController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly usersExcel: UsersExcelService,
    private readonly userRepository: UserRepository,
    private readonly clock: ClockService,
  ) {}

  /**
   * Список активных Пользователей для раздела администрирования (Req 5.1).
   *
   * Доступно только Администратору. Пользователи отсортированы по дате создания
   * (новые → старые); признак `locked` вычисляется относительно текущего момента
   * (Req 5.9, 5.10).
   */
  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<AdminUserView[]> {
    this.assertAdmin(req);
    const now = this.clock.now();
    const users = await this.userRepository.listActiveWithMaxLink();
    return users.map((user) => toAdminUser(user, now));
  }

  /**
   * Список удалённых Пользователей с сохранёнными адресами для восстановления
   * (Req 7.3, 8.2). Доступно только Администратору.
   */
  @Get('deleted')
  async listDeleted(@Req() req: AuthenticatedRequest): Promise<DeletedUserView[]> {
    this.assertAdmin(req);
    const users = await this.userRepository.listDeletedWithEmails();
    return users.map(toDeletedUser);
  }

  /**
   * Справочник активных Пользователей для выбора Исполнителей/Менеджеров при
   * создании и назначении Задач (Req 9.1, 2.4). Доступно любому
   * аутентифицированному Пользователю; возвращает минимальный набор полей.
   */
  @Get('directory')
  async directory(@Req() req: AuthenticatedRequest): Promise<DirectoryUserView[]> {
    this.principal(req);
    const users = await this.userRepository.listActiveWithMaxLink();
    return users.map(toDirectoryUser);
  }

  /** Экспортирует активных и удалённых Пользователей в Excel-файл. */
  @Get('export')
  async exportUsers(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile> {
    const file = await this.usersExcel.exportUsers(this.principal(req).userId);
    setResponseHeaders(res, {
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.content, { type: file.mimeType });
  }

  /** Импортирует Пользователей из Excel-файла: новые получают приглашение, существующим меняется имя. */
  @Post('import')
  async importUsers(@Req() req: AuthenticatedRequest): Promise<UsersImportResult> {
    const file = await readSingleMultipartFile(req as unknown as FastifyRequest, {
      fieldName: 'file',
      maxBytes: USERS_IMPORT_MAX_BYTES,
    });
    return this.usersExcel.importUsers(this.principal(req).userId, file);
  }

  /**
   * Приглашение нового Пользователя по адресу электронной почты (Req 5.1–5.3).
   *
   * Делегирует {@link AuthService.invite}: проверяет роль инициатора, создаёт
   * неактивную учётную запись и ставит в очередь письмо со ссылкой установки
   * пароля.
   */
  @Post('invite')
  async invite(
    @Body() dto: InviteUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserView> {
    const created = await this.authService.invite(this.principal(req).userId, dto.email, dto.name);
    return this.toAdminUserById(created.id);
  }

  /**
   * Передача роли администратора активному Пользователю (Req 3).
   *
   * Делегирует {@link UsersService.transferAdmin}: бывший Администратор
   * становится Исполнителем, его сессии аннулируются ≤5с, уведомления ставятся
   * в очередь. Проверка прав инициатора — внутри сервиса.
   */
  @Post(':id/transfer-admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async transferAdmin(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.usersService.transferAdmin(this.principal(req).userId, id);
  }

  /**
   * Восстановление удалённого Пользователя по выбранному сохранённому адресу
   * (Req 7.2–7.6). Делегирует {@link UsersService.restoreUser}.
   */
  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @Body() dto: RestoreUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserView> {
    const restored = await this.usersService.restoreUser(this.principal(req).userId, id, dto.email);
    return this.toAdminUserById(restored.id);
  }

  /**
   * Изменение адреса электронной почты и/или имени Пользователя (Req 6.2, 6.3).
   *
   * Поле `name` отображается на доменное `displayName`. Делегирует
   * {@link UsersService.updateProfile} (проверка прав Администратора — внутри).
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserView> {
    const patch: { email?: string; displayName?: string } = {};
    if (dto.email !== undefined) {
      patch.email = dto.email;
    }
    if (dto.name !== undefined) {
      patch.displayName = dto.name;
    }
    await this.usersService.updateProfile(this.principal(req).userId, id, patch);
    return this.toAdminUserById(id);
  }

  /**
   * Изменение аватара выбранного Пользователя Администратором.
   *
   * Поле формы — `avatar`. Авторитетные проверки прав, формата и размера
   * выполняет {@link UsersService.setAvatar}; контроллер только преобразует
   * multipart-файл в доменный тип и возвращает обновлённую запись списка.
   */
  @Post(':id/avatar')
  async uploadAvatar(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUserView> {
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
    await this.usersService.setAvatar(this.principal(req).userId, id, uploaded);
    return this.toAdminUserById(id);
  }

  /**
   * Удаление Пользователя в режиме `soft`/`hard` (Req 8.1–8.8).
   *
   * Подтверждение операции запрашивается в интерфейсе до вызова (Req 8.9, 8.10).
   * Делегирует {@link UsersService.deleteUser}.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @Query('mode') mode: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.usersService.deleteUser(this.principal(req).userId, id, this.parseMode(mode));
  }

  /**
   * Формирует представление `AdminUser` по идентификатору, подгружая привязку
   * MAX. Используется после операций, возвращающих доменную сущность.
   */
  private async toAdminUserById(id: string): Promise<AdminUserView> {
    const user = await this.userRepository.findByIdWithMaxLink(id);
    if (user === null) {
      throw new EntityNotFoundException('Учётная запись не найдена.');
    }
    return toAdminUser(user, this.clock.now());
  }

  /** Проверяет и нормализует режим удаления из query-параметра (Req 8.1). */
  private parseMode(mode: string | undefined): DeleteMode {
    if (mode !== 'soft' && mode !== 'hard') {
      throw new ValidationException('Недопустимый режим удаления: ожидается «soft» или «hard».');
    }
    return mode;
  }

  /**
   * Проверяет, что инициатор запроса — Администратор (Req 5.1).
   * @throws AccessDeniedException Если роль инициатора не {@link Role.ADMIN}.
   */
  private assertAdmin(req: AuthenticatedRequest): void {
    if (this.principal(req).role !== Role.ADMIN) {
      throw new AccessDeniedException(
        'Доступ к разделу администрирования имеет только Администратор.',
      );
    }
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
