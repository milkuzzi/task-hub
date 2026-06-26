import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UploadFile } from '../../attachments';
import { MAX_BOT_API_PORT, MaxBotApiPort, MaxBotAttachmentRef } from './max-bot-api.port';
import {
  MaxBotActorDto,
  MaxBotMessageSeenDto,
  MaxBotSendMessageDto,
  MaxBotSetMuteDto,
  MaxBotUnsubscribeTaskDto,
} from './max-bot.dto';
import { MaxBotService } from './max-bot.service';
import { MaxBotWebhookGuard } from './max-bot-webhook.guard';

/**
 * Webhook-контроллер Бота MAX (Req 16.4).
 *
 * Принимает входящие обновления Бота MAX и маршрутизирует их в
 * {@link MaxBotService}, не содержа бизнес-логики. Все маршруты защищены
 * {@link MaxBotWebhookGuard} (общий секрет webhook, Req 16.4) и валидируются
 * {@link ValidationPipe} (whitelist + transform), поэтому в сервис попадают
 * только корректные команды от доверенного источника.
 *
 * Исходящее взаимодействие с платформой (отправка списка Задач, загрузка
 * содержимого прикреплённых файлов) абстрагировано портом
 * {@link MaxBotApiPort}, что позволяет тестировать маршрутизацию без обращения к
 * реальному Bot API MAX.
 *
 * Команды Бота, влияющие на отписки/заглушение (Req 16.5, 16.6, 16.9), меняют
 * только фильтрацию канала MAX; Уведомления на сайте остаются неизменными
 * (Req 16.13).
 */
@Controller('max/bot/webhook')
@UseGuards(MaxBotWebhookGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class MaxBotWebhookController {
  constructor(
    private readonly bot: MaxBotService,
    @Inject(MAX_BOT_API_PORT) private readonly api: MaxBotApiPort,
  ) {}

  /**
   * Возвращает Пользователю список его Задач (Req 16.7).
   *
   * Получает видимые Задачи через {@link MaxBotService.listTasks} и отправляет их
   * Пользователю через Бот MAX ({@link MaxBotApiPort.sendTaskList}).
   */
  @Post('tasks/list')
  @HttpCode(HttpStatus.OK)
  async listTasks(@Body() dto: MaxBotActorDto): Promise<{ count: number }> {
    const tasks = await this.bot.listTasks(dto.maxUserId);
    await this.api.sendTaskList(
      dto.maxUserId,
      tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    );
    return { count: tasks.length };
  }

  /**
   * Отправляет Сообщение в Чат Задачи с прикреплением Вложений (Req 16.8, 16.10,
   * 16.11).
   *
   * Содержимое прикреплённых файлов загружается из Бота MAX через
   * {@link MaxBotApiPort.downloadAttachment} ДО отправки; единый лимит размера и
   * количества применяется {@link MaxBotService.sendMessageFromBot} (Req 16.10,
   * 16.11).
   */
  @Post('messages/send')
  @HttpCode(HttpStatus.NO_CONTENT)
  async sendMessage(@Body() dto: MaxBotSendMessageDto): Promise<void> {
    const files = await this.resolveAttachments(dto);
    await this.bot.sendMessageFromBot(dto.maxUserId, dto.taskId, dto.text, files);
  }

  /**
   * Отмечает Сообщение просмотренным в Боте MAX, очищая Уведомление о нём
   * (Req 16.12).
   */
  @Post('messages/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async messageSeen(@Body() dto: MaxBotMessageSeenDto): Promise<void> {
    await this.bot.onMessageSeen(dto.maxUserId, dto.messageId);
  }

  /** Заглушает или снимает заглушение Чата Задачи (Req 16.9). */
  @Post('mute')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setMute(@Body() dto: MaxBotSetMuteDto): Promise<void> {
    await this.bot.setMuteFromBot(dto.maxUserId, dto.taskId, dto.muted);
  }

  /** Полностью отписывает Пользователя от Уведомлений через Бот MAX (Req 16.5). */
  @Post('unsubscribe/all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribeAll(@Body() dto: MaxBotActorDto): Promise<void> {
    await this.bot.unsubscribeAll(dto.maxUserId);
  }

  /** Возобновляет получение всех Уведомлений через Бот MAX (снятие полной отписки, Req 16.5). */
  @Post('unsubscribe/all/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resubscribeAll(@Body() dto: MaxBotActorDto): Promise<void> {
    await this.bot.resubscribeAll(dto.maxUserId);
  }

  /** Отписывает Пользователя от Уведомлений конкретной Задачи (Req 16.6). */
  @Post('unsubscribe/task')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribeTask(@Body() dto: MaxBotUnsubscribeTaskDto): Promise<void> {
    await this.bot.unsubscribeTask(dto.maxUserId, dto.taskId);
  }

  /**
   * Загружает содержимое прикреплённых к Сообщению файлов из Бота MAX и
   * приводит их к {@link UploadFile} для сохранения Вложений (Req 16.10).
   */
  private async resolveAttachments(dto: MaxBotSendMessageDto): Promise<UploadFile[]> {
    const metas = dto.attachments ?? [];
    const files: UploadFile[] = [];
    for (const meta of metas) {
      const ref: MaxBotAttachmentRef = {
        originalName: meta.originalName,
        mimeType: meta.mimeType,
        downloadToken: meta.downloadToken,
        ...(meta.declaredSize !== undefined ? { declaredSize: meta.declaredSize } : {}),
      };
      files.push(await this.api.downloadAttachment(ref));
    }
    return files;
  }
}
