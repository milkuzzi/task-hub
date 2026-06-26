import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config';
import { SENDPULSE_API_BASE_URL, SENDPULSE_REQUEST_TIMEOUT_MS } from './mailer.constants';
import { EmailMessage, MailerProvider } from './mailer.types';

/** Ответ эндпоинта выдачи токена SendPulse (OAuth client_credentials). */
interface SendPulseTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Кэшированный токен доступа с моментом истечения (UTC, мс). */
interface CachedToken {
  value: string;
  expiresAtMs: number;
}

/**
 * Адаптер отправки почты через HTTP API SendPulse (Req 1.6).
 *
 * Реализует {@link MailerProvider}: получает OAuth-токен по
 * `client_credentials`, кэширует его до истечения срока действия и отправляет
 * письмо через эндпоинт `/smtp/emails`. Каждый сетевой вызов ограничен
 * таймаутом 30 секунд; при ошибке/недоступности сервиса метод бросает
 * исключение, а повторные попытки выполняет воркер очереди (Req 1.7).
 *
 * Реальные учётные данные требуются только в среде исполнения; в тестах вместо
 * этого адаптера инъецируется мок {@link MailerProvider}.
 */
@Injectable()
export class SendPulseClient implements MailerProvider {
  private cachedToken: CachedToken | null = null;

  constructor(private readonly config: AppConfigService) {}

  /** Отправляет письмо через SendPulse SMTP API (один сетевой вызов). */
  async send(message: EmailMessage): Promise<void> {
    const token = await this.authenticate();
    const { senderEmail, senderName } = this.config.sendpulse;

    const payload = {
      email: {
        subject: message.subject,
        html: Buffer.from(message.html, 'utf-8').toString('base64'),
        text: message.text ?? '',
        from: { name: senderName, email: senderEmail },
        to: [{ email: message.to }],
      },
    };

    const response = await this.request('/smtp/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await this.safeReadText(response);
      throw new Error(`SendPulse отклонил отправку письма (HTTP ${response.status}): ${detail}`);
    }
  }

  /**
   * Возвращает действующий токен доступа, переиспользуя кэшированный, пока он
   * не истёк (с запасом 5 секунд), иначе запрашивает новый.
   */
  private async authenticate(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken !== null && this.cachedToken.expiresAtMs > now + 5_000) {
      return this.cachedToken.value;
    }

    const { apiUserId, apiSecret } = this.config.sendpulse;
    const response = await this.request('/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: apiUserId,
        client_secret: apiSecret,
      }),
    });

    if (!response.ok) {
      const detail = await this.safeReadText(response);
      throw new Error(`Не удалось получить токен SendPulse (HTTP ${response.status}): ${detail}`);
    }

    const data = (await response.json()) as SendPulseTokenResponse;
    this.cachedToken = {
      value: data.access_token,
      expiresAtMs: now + data.expires_in * 1_000,
    };
    return data.access_token;
  }

  /** Выполняет HTTP-запрос к SendPulse с таймаутом 30 секунд. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SENDPULSE_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${SENDPULSE_API_BASE_URL}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Сетевая ошибка при обращении к SendPulse: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Безопасно читает тело ответа как текст, не бросая исключений. */
  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<тело ответа недоступно>';
    }
  }
}
