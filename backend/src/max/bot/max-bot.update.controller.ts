import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MAX_BOT_API_PORT, MaxBotApiPort, MaxBotKeyboard } from './max-bot-api.port';
import { MaxBotAuthService } from './max-bot-auth.service';
import { MaxBotWebhookGuard } from './max-bot-webhook.guard';

type JsonRecord = Record<string, unknown>;

@Controller('max/bot/webhook')
@UseGuards(MaxBotWebhookGuard)
export class MaxBotUpdateController {
  private readonly logger = new Logger(MaxBotUpdateController.name);

  constructor(
    private readonly auth: MaxBotAuthService,
    @Inject(MAX_BOT_API_PORT) private readonly api: MaxBotApiPort,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Body() update: unknown): Promise<{ ok: true }> {
    const body = this.asRecord(update);
    if (body === null) {
      return { ok: true };
    }
    const maxUserId = this.extractMaxUserId(body);
    if (maxUserId === null) {
      this.logger.warn('Webhook MAX пропущен: не найден идентификатор пользователя.');
      return { ok: true };
    }

    try {
      const updateType = this.stringField(body, 'update_type') ?? this.stringField(body, 'type');
      if (updateType === 'bot_started') {
        const result = await this.auth.handleBotStarted(maxUserId, this.extractPayload(body));
        await this.sendLaunchReply(
          maxUserId,
          result.handled
            ? (result.message ?? 'Откройте Систему поручений в mini-app.')
            : 'Откройте Систему поручений в mini-app.',
        );
      } else if (updateType === 'message_created') {
        await this.sendLaunchReply(maxUserId, 'Работа с задачами доступна в mini-app.');
      }
    } catch (error) {
      this.logger.warn(
        `Webhook MAX для пользователя «${maxUserId}» не обработан: ${this.errorMessage(error)}.`,
      );
      await this.safeLaunchReply(maxUserId, 'Откройте Систему поручений в mini-app.');
    }
    return { ok: true };
  }

  private launchKeyboard(): MaxBotKeyboard {
    return [[{ type: 'open_app', text: 'Открыть' }]];
  }

  private sendLaunchReply(maxUserId: string, text: string): Promise<void> {
    return this.api.reply(maxUserId, text, this.launchKeyboard());
  }

  private async safeLaunchReply(maxUserId: string, text: string): Promise<void> {
    try {
      await this.sendLaunchReply(maxUserId, text);
    } catch (error) {
      this.logger.warn(`Не удалось отправить кнопку mini-app: ${this.errorMessage(error)}.`);
    }
  }

  private extractMaxUserId(update: JsonRecord): string | null {
    const message = this.asRecord(update.message);
    const sender = this.asRecord(message?.sender);
    const user = this.asRecord(update.user);
    return (
      this.stringOrNumberField(update, 'user_id') ??
      this.stringOrNumberField(user, 'user_id') ??
      this.stringOrNumberField(user, 'id') ??
      this.stringOrNumberField(sender, 'user_id') ??
      this.stringOrNumberField(sender, 'id')
    );
  }

  private extractPayload(update: JsonRecord): string | null {
    const body = this.asRecord(update.body);
    return (
      this.stringField(update, 'payload') ??
      this.stringField(update, 'start_payload') ??
      this.stringField(body, 'payload') ??
      this.stringField(body, 'start_payload')
    );
  }

  private asRecord(value: unknown): JsonRecord | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonRecord)
      : null;
  }

  private stringField(record: JsonRecord | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  private stringOrNumberField(record: JsonRecord | null, key: string): string | null {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
