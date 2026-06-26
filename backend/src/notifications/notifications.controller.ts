import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessDeniedException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatNotificationRouter } from './chat-notification-router';
import { NotificationsService } from './notifications.service';
import { MessageSeenDto } from './dto';
import { NotificationView, toNotificationView } from './notification-representation';

/**
 * HTTP-слой Центра уведомлений поверх {@link NotificationsService} и
 * {@link ChatNotificationRouter} (Req 7.1–7.4).
 *
 * Тонкий контроллер: разбирает HTTP-запрос, вызывает доменный метод и формирует
 * представление контракта `frontend/src/lib/notifications-api.ts`
 * (`AppNotification`). Все маршруты требуют действующей Сессии
 * ({@link SessionAuthGuard}). Каждый Пользователь работает только со СВОИМИ
 * Уведомлениями: выборка и скрытие ограничены идентификатором текущего
 * Пользователя в сервисе/репозитории; чужие Уведомления не раскрываются
 * (Req 2.12, 7.4). Глобальный префикс `/api` применяется в `main.ts`; доменные
 * исключения преобразуются глобальным фильтром в единый формат
 * `{ code, message }` (Req 1.1).
 */
@Controller('notifications')
@UseGuards(SessionAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly chatNotifications: ChatNotificationRouter,
  ) {}

  /**
   * Уведомления текущего Пользователя в порядке от новых к старым (Req 7.1,
   * 13.1).
   *
   * Делегирует {@link NotificationsService.listForRecipient}; выборка
   * ограничена получателем, поэтому возвращаются только собственные Уведомления
   * Пользователя (Req 7.4).
   */
  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<NotificationView[]> {
    const userId = this.principal(req).userId;
    const notifications = await this.notificationsService.listForRecipient(userId);
    return notifications.map(toNotificationView);
  }

  /**
   * Очистка Уведомления о Сообщении Чата по факту просмотра (Req 7.2, 14.4,
   * 16.12).
   *
   * Делегирует {@link ChatNotificationRouter.clearMessageNotification} для
   * текущего Пользователя: удаляет соответствующее Уведомление о Сообщении на
   * сайте и инициирует удаление в Боте MAX. Операция идемпотентна — повторный
   * вызов безопасен. Возвращает 204 без тела.
   */
  @Post('messages/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async seen(@Body() dto: MessageSeenDto, @Req() req: AuthenticatedRequest): Promise<void> {
    const userId = this.principal(req).userId;
    await this.chatNotifications.clearMessageNotification(userId, dto.messageId);
  }

  /**
   * Скрытие (удаление) Уведомления текущего Пользователя по идентификатору
   * (Req 7.3, 7.4).
   *
   * Делегирует {@link NotificationsService.dismiss}; удаление допускается только
   * для Уведомления, принадлежащего Пользователю. Обращение к чужому/
   * несуществующему Уведомлению отклоняется как «не найдено» без раскрытия
   * (Req 2.12). Возвращает 204 без тела.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    const userId = this.principal(req).userId;
    await this.notificationsService.dismiss(userId, id);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
