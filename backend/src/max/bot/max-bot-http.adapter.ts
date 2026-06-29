import { Injectable, Logger } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { AppConfigService } from '../../config';
import { MaxDeliveryPort, MaxDeliveryResult } from '../../notifications/delivery/max-delivery.port';
import { toNotificationView } from '../../notifications/notification-representation';
import { UserRepository } from '../../repositories';
import { MaxBotApiPort, MaxBotKeyboard } from './max-bot-api.port';

const MAX_BOT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_TEXT_LIMIT = 4_000;
const MAX_WEBHOOK_UPDATE_TYPES = ['message_created', 'bot_started'] as const;

interface MaxSubscriptionResponse {
  success?: boolean;
  message?: string;
}

/**
 * Реальный HTTP-адаптер Bot API MAX.
 *
 * Использует актуальный контракт MAX: базовый URL `platform-api2.max.ru` и
 * токен в заголовке `Authorization: <token>`, без query-параметров с секретом.
 */
@Injectable()
export class MaxBotHttpApiAdapter implements MaxBotApiPort, MaxDeliveryPort {
  private readonly logger = new Logger(MaxBotHttpApiAdapter.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly userRepository: UserRepository,
  ) {}

  async reply(maxUserId: string, text: string, keyboard?: MaxBotKeyboard): Promise<void> {
    await this.sendUserText(maxUserId, text, keyboard);
  }

  async deliverNotification(notification: Notification): Promise<MaxDeliveryResult> {
    const link = await this.userRepository.findMaxLinkByUserId(notification.recipientId);
    if (link === null) {
      return { delivered: false, reason: 'У получателя не привязан профиль MAX.' };
    }

    const view = toNotificationView(notification);
    const text = this.fitMessageText(`${view.title}\n${view.body}`);
    try {
      await this.sendUserText(link.maxUserId, text, this.notificationKeyboard(notification));
      return { delivered: true };
    } catch (error) {
      return { delivered: false, reason: this.errorMessage(error) };
    }
  }

  async deleteMessageNotification(): Promise<MaxDeliveryResult> {
    return {
      delivered: false,
      reason:
        'Удаление уведомления в MAX невозможно: связь с отправленным сообщением MAX не сохранена.',
    };
  }

  /**
   * Регистрирует webhook-подписку MAX на публичный URL приложения. Метод
   * идемпотентен на стороне MAX: при повторном старте обновляет подписку тем же
   * endpoint и secret.
   */
  async ensureWebhookSubscription(): Promise<void> {
    const webhookUrl = this.buildWebhookUrl();
    if (webhookUrl === null) {
      return;
    }

    const secret = this.config.max.botWebhookSecret;
    if (secret === '') {
      this.logger.warn(
        'Webhook Бота MAX не зарегистрирован: MAX_BOT_WEBHOOK_SECRET или MAX_BOT_TOKEN не задан.',
      );
      return;
    }

    const response = await this.requestJson<MaxSubscriptionResponse>('/subscriptions', {
      method: 'POST',
      body: {
        url: webhookUrl,
        update_types: [...MAX_WEBHOOK_UPDATE_TYPES],
        secret,
      },
    });

    if (response.success === false) {
      this.logger.warn(
        `MAX отклонил webhook-подписку ${webhookUrl}: ${response.message ?? 'без сообщения'}.`,
      );
      return;
    }

    this.logger.log(`Webhook Бота MAX зарегистрирован: ${webhookUrl}.`);
  }

  async sendUserText(maxUserId: string, text: string, keyboard?: MaxBotKeyboard): Promise<void> {
    const params = new URLSearchParams({ user_id: maxUserId });
    await this.requestJson('/messages', {
      method: 'POST',
      query: params,
      body: { ...this.buildMessageBody(text, keyboard), notify: true },
    });
  }

  private buildMessageBody(text: string, keyboard?: MaxBotKeyboard): Record<string, unknown> {
    return {
      text: this.fitMessageText(text),
      ...(keyboard !== undefined && keyboard.length > 0
        ? {
            attachments: [
              {
                type: 'inline_keyboard',
                payload: { buttons: keyboard },
              },
            ],
          }
        : {}),
    };
  }

  private notificationKeyboard(notification: Notification): MaxBotKeyboard {
    if (notification.taskId === null) {
      return [[{ type: 'open_app', text: 'Открыть' }]];
    }
    const username = this.config.max.botUsername.trim().replace(/^@/, '');
    if (username === '') {
      return [[{ type: 'open_app', text: 'Открыть' }]];
    }
    const url = new URL(`https://max.ru/${encodeURIComponent(username)}`);
    url.searchParams.set('startapp', `task_${notification.taskId}`);
    return [[{ type: 'link', text: 'Открыть задачу', url: url.toString() }]];
  }

  private buildWebhookUrl(): string | null {
    const publicUrl = this.config.app.publicUrl.replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      this.logger.warn(
        `Webhook Бота MAX не зарегистрирован: некорректный PUBLIC_URL «${publicUrl}».`,
      );
      return null;
    }

    if (parsed.protocol !== 'https:' || parsed.hostname === 'localhost') {
      this.logger.warn(
        `Webhook Бота MAX не зарегистрирован: PUBLIC_URL должен быть публичным HTTPS URL на 443, ` +
          `сейчас «${publicUrl}».`,
      );
      return null;
    }

    return `${publicUrl}/max/bot/webhook`;
  }

  private async requestJson<T = unknown>(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
      query?: URLSearchParams;
      body?: unknown;
    },
  ): Promise<T> {
    const url = this.buildApiUrl(path, options.query);
    const response = await this.requestAbsolute(url, {
      method: options.method,
      headers: { 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      const detail = await this.safeReadText(response);
      throw new Error(
        `MAX API ${options.method} ${path} вернул HTTP ${response.status}: ${detail}`,
      );
    }

    return (await this.safeReadJson<T>(response)) ?? ({} as T);
  }

  private buildApiUrl(path: string, query?: URLSearchParams): string {
    const baseUrl = this.config.max.botApiBaseUrl.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const qs = query !== undefined && query.size > 0 ? `?${query.toString()}` : '';
    return `${baseUrl}${normalizedPath}${qs}`;
  }

  private async requestAbsolute(url: string, init: RequestInit): Promise<Response> {
    const token = this.config.max.botToken;
    if (token === '') {
      throw new Error('MAX_BOT_TOKEN не задан.');
    }

    const headers = new Headers(init.headers);
    headers.set('Authorization', token);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_BOT_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (error) {
      throw new Error(`Сетевая ошибка при обращении к MAX API: ${this.errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private fitMessageText(text: string): string {
    if (text.length <= MAX_MESSAGE_TEXT_LIMIT) {
      return text;
    }
    return `${text.slice(0, MAX_MESSAGE_TEXT_LIMIT - 1)}…`;
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<тело ответа недоступно>';
    }
  }

  private async safeReadJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
