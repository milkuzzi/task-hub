import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { setResponseHeaders, type HttpResponseLike } from '../common/http';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { UserRepository } from '../repositories';
import { AVATAR_STORAGE, AvatarStorage } from './avatar-storage';

/**
 * HTTP-слой контролируемой отдачи аватаров (Req 6.4, 6.5, 19.8).
 *
 * Аватары хранятся вне веб-корня ({@link AvatarStorage}); отдаются ИСКЛЮЧИТЕЛЬНО
 * через этот контроллер после проверки Сессии, а не статической раздачей
 * (Req 19.8). Любой аутентифицированный Пользователь вправе просматривать
 * аватар другого Пользователя — для отображения участников Задач, чатов и
 * справочников ({@link SessionAuthGuard}). Отсутствие пользователя, отсутствие
 * назначенного аватара или недоступность файла приводят к 404 без раскрытия
 * деталей (Req 2.12). Глобальный префикс `/api` применяется в `main.ts`.
 */
@Controller('avatars')
@UseGuards(SessionAuthGuard)
export class AvatarsController {
  constructor(
    private readonly userRepository: UserRepository,
    @Inject(AVATAR_STORAGE)
    private readonly avatarStorage: AvatarStorage,
  ) {}

  /**
   * Потоковая отдача аватара Пользователя по идентификатору (Req 6.4, 19.8).
   *
   * Находит Пользователя и его `avatarPath`; при отсутствии записи,
   * отсутствии аватара или недоступности файла возвращает 404
   * ({@link EntityNotFoundException}). Содержимое читается из хранилища вне
   * веб-корня и отдаётся как {@link StreamableFile} с MIME-типом, выведенным из
   * расширения сохранённого объекта.
   */
  @Get(':userId')
  async serve(
    @Param('userId') userId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: HttpResponseLike,
  ): Promise<StreamableFile> {
    // Требуется действующая Сессия (любой Пользователь вправе видеть аватары).
    this.principal(req);

    const user = await this.userRepository.findById(userId);
    if (user === null || user.avatarPath === null || user.avatarPath === '') {
      throw new EntityNotFoundException('Аватар не найден.');
    }

    const { stream, contentType } = await this.avatarStorage.read(user.avatarPath);
    setResponseHeaders(res, { 'Content-Type': contentType });
    return new StreamableFile(stream, { type: contentType });
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
