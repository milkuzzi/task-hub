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
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessDeniedException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatService } from './chat.service';
import { EditMessageDto, SendMessageDto, UpdateChatMuteDto } from './dto';
import {
  ChatMessageHttpView,
  MessageReaderHttpView,
  fromChatMessageView,
  toChatMessage,
  toMessageReader,
} from './chat-representation';

/**
 * HTTP-слой Чата Задачи поверх {@link ChatService} (Req 5.1–5.8).
 *
 * Тонкий контроллер: разбирает HTTP-запрос, вызывает доменный метод и формирует
 * представление контракта `frontend/src/lib/chat-api.ts` (`ChatMessage`,
 * `MessageReader`). Все маршруты требуют действующей Сессии
 * ({@link SessionAuthGuard}). Права (членство в чате для чтения/истории; автор,
 * Менеджер Задачи или Администратор для правки/удаления) и доменные инварианты
 * проверяются в сервисе; контроллер не дублирует бизнес-логику (Req 5.2, 5.3).
 *
 * Realtime-трансляция Сообщений, Статусов и списков прочитавших выполняется
 * самим {@link ChatService} через `ChatGateway` при каждой операции (Req 5.7),
 * поэтому контроллер не рассылает события повторно. Ограничение частоты отправки
 * Сообщений как чувствительной операции применяется внутри
 * {@link ChatService.sendMessage} (`send_message`, Req 5.8, 19.1, 19.2) — здесь
 * не дублируется. Глобальный префикс `/api` применяется в `main.ts`; доменные
 * исключения преобразуются глобальным фильтром в единый формат
 * `{ code, message }` (Req 1.1).
 */
@Controller()
@UseGuards(SessionAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * История Сообщений Чата Задачи Участнику чата (Req 5.1, 11.1, 11.2).
   *
   * Делегирует {@link ChatService.listMessages}; членство в чате проверяет
   * сервис. Сообщения возвращаются в порядке от старых к новым (Req 11.3).
   */
  @Get('tasks/:id/messages')
  async listMessages(
    @Param('id') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ChatMessageHttpView[]> {
    const userId = this.principal(req).userId;
    const messages = await this.chatService.listMessages(userId, taskId);
    return messages.map((message) => toChatMessage(message, taskId));
  }

  @Get('tasks/:id/max-notifications')
  async getMaxNotifications(
    @Param('id') taskId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ muted: boolean }> {
    return { muted: await this.chatService.isMuted(this.principal(req).userId, taskId) };
  }

  @Patch('tasks/:id/max-notifications')
  async updateMaxNotifications(
    @Param('id') taskId: string,
    @Body() dto: UpdateChatMuteDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ muted: boolean }> {
    await this.chatService.setMute(this.principal(req).userId, taskId, dto.muted);
    return { muted: dto.muted };
  }

  /**
   * Отправка Сообщения в Чат Задачи (Req 5.2, 11.3, 11.4).
   *
   * Делегирует {@link ChatService.sendMessage}: валидация длины 1–4000,
   * членство в чате, авто-переход Статуса, ограничение частоты и live-рассылка
   * выполняются сервисом. Ответ несёт сохранённое Сообщение в форме контракта;
   * привязка Вложений по `attachmentIds` — задача 6.
   */
  @Post('tasks/:id/messages')
  async send(
    @Param('id') taskId: string,
    @Body() dto: SendMessageDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ChatMessageHttpView> {
    const userId = this.principal(req).userId;
    return this.chatService.sendMessage(userId, taskId, dto.text, dto.attachmentIds ?? []);
  }

  /**
   * Редактирование текста Сообщения с меткой «изменено» (Req 5.3, 11.5, 11.6).
   *
   * Делегирует {@link ChatService.editMessage}: права (автор/Менеджер
   * Задачи/Администратор) и установку `editedAt` выполняет сервис; отказ при
   * недостатке прав пробрасывается без изменения Сообщения.
   */
  @Patch('messages/:id')
  async edit(
    @Param('id') messageId: string,
    @Body() dto: EditMessageDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ChatMessageHttpView> {
    const userId = this.principal(req).userId;
    const view = await this.chatService.editMessage(userId, messageId, dto.text);
    return fromChatMessageView(view);
  }

  /**
   * Удаление Сообщения с меткой «Сообщение удалено» (Req 5.4, 11.7).
   *
   * Делегирует {@link ChatService.deleteMessage}; права проверяет сервис.
   * Возвращает 204 без тела.
   */
  @Delete('messages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') messageId: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.chatService.deleteMessage(this.principal(req).userId, messageId);
  }

  /**
   * Отметка Сообщения прочитанным текущим Пользователем (Req 5.5, 11.8, 14.4).
   *
   * Делегирует {@link ChatService.markRead}; членство в чате проверяет сервис.
   * Возвращает 204 без тела.
   */
  @Post('messages/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param('id') messageId: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.chatService.markRead(this.principal(req).userId, messageId);
  }

  /**
   * Список прочитавших Сообщение Участников (Req 5.6, 11.8).
   *
   * Делегирует {@link ChatService.listReaders}; членство в чате проверяет
   * сервис. Список отсортирован по моменту прочтения (ранние → поздние).
   */
  @Get('messages/:id/readers')
  async readers(
    @Param('id') messageId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<MessageReaderHttpView[]> {
    const readers = await this.chatService.listReaders(this.principal(req).userId, messageId);
    return readers.map(toMessageReader);
  }

  /** Возвращает аутентифицированный субъект запроса, установленный guard-ом. */
  private principal(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['user']> {
    if (req.user === undefined) {
      throw new AccessDeniedException('Требуется вход в систему.');
    }
    return req.user;
  }
}
