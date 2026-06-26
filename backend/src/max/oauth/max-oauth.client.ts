import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config';
import {
  MAX_OAUTH_REQUEST_TIMEOUT_MS,
  MAX_OAUTH_TOKEN_PATH,
  MAX_OAUTH_USERINFO_PATH,
} from './max-oauth.constants';
import { MaxOAuthExchangeError, MaxOAuthPort } from './max-oauth.port';

/** Ответ эндпоинта обмена кода авторизации на токен доступа MAX. */
interface MaxTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Ответ эндпоинта сведений о профиле MAX. */
interface MaxUserInfoResponse {
  /** Стабильный идентификатор профиля MAX. */
  id?: string | number;
}

/**
 * HTTP-адаптер обмена кода авторизации OAuth MAX на идентификатор профиля
 * (`maxUserId`) — реализация {@link MaxOAuthPort} по умолчанию (Req 16.1, 16.3).
 *
 * Выполняет стандартный поток OAuth2 `authorization_code`: обмен `authCode` на
 * токен доступа, затем запрос сведений о профиле для извлечения стабильного
 * `maxUserId`. Каждый сетевой вызов ограничен таймаутом 30 секунд; любая
 * неуспешная операция (отклонённая авторизация, недействительный код,
 * недоступность сервиса, некорректный ответ) приводит к
 * {@link MaxOAuthExchangeError}, который прикладной слой трактует как отказ во
 * входе (Req 16.3).
 *
 * Реальные учётные данные MAX требуются только в среде исполнения; в тестах
 * вместо этого адаптера к токену {@link MAX_OAUTH_PORT} привязывается мок, что
 * исключает сетевые вызовы.
 */
@Injectable()
export class MaxOAuthHttpClient implements MaxOAuthPort {
  constructor(private readonly config: AppConfigService) {}

  async exchangeAuthCode(authCode: string): Promise<string> {
    if (typeof authCode !== 'string' || authCode.trim() === '') {
      throw new MaxOAuthExchangeError('Пустой код авторизации MAX.');
    }

    const accessToken = await this.requestAccessToken(authCode);
    const maxUserId = await this.requestMaxUserId(accessToken);
    return maxUserId;
  }

  /** Обменивает код авторизации на токен доступа MAX (один сетевой вызов). */
  private async requestAccessToken(authCode: string): Promise<string> {
    const { oauthClientId, oauthClientSecret, oauthRedirectUri } = this.config.max;

    const response = await this.request(MAX_OAUTH_TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
        redirect_uri: oauthRedirectUri,
      }),
    });

    if (!response.ok) {
      const detail = await this.safeReadText(response);
      throw new MaxOAuthExchangeError(
        `MAX отклонил обмен кода авторизации (HTTP ${response.status}): ${detail}`,
      );
    }

    const data = (await this.safeReadJson<MaxTokenResponse>(response)) ?? {};
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new MaxOAuthExchangeError('Ответ MAX не содержит токен доступа.');
    }
    return data.access_token;
  }

  /** Запрашивает сведения о профиле MAX и извлекает стабильный `maxUserId`. */
  private async requestMaxUserId(accessToken: string): Promise<string> {
    const response = await this.request(MAX_OAUTH_USERINFO_PATH, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const detail = await this.safeReadText(response);
      throw new MaxOAuthExchangeError(
        `MAX отклонил запрос сведений о профиле (HTTP ${response.status}): ${detail}`,
      );
    }

    const data = (await this.safeReadJson<MaxUserInfoResponse>(response)) ?? {};
    const id = data.id;
    if (id === undefined || id === null || `${id}` === '') {
      throw new MaxOAuthExchangeError('Ответ MAX не содержит идентификатор профиля.');
    }
    return `${id}`;
  }

  /** Выполняет HTTP-запрос к сервису OAuth MAX с таймаутом 30 секунд. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const baseUrl = this.config.max.botApiBaseUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_OAUTH_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MaxOAuthExchangeError(`Сетевая ошибка при обращении к OAuth MAX: ${reason}`, {
        cause: error,
      });
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

  /** Безопасно разбирает тело ответа как JSON, возвращая `null` при ошибке. */
  private async safeReadJson<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
