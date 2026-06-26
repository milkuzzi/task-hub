import { AppConfigService } from '../../config';
import { MaxOAuthExchangeError } from './max-oauth.port';
import { MaxOAuthHttpClient } from './max-oauth.client';

/**
 * Модульные тесты {@link MaxOAuthHttpClient} (Req 16.1, 16.3) с подменой
 * глобального `fetch` — без обращения к реальному сервису MAX и без настоящих
 * учётных данных.
 */
describe('MaxOAuthHttpClient (Req 16.1, 16.3)', () => {
  const config = {
    max: {
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      oauthRedirectUri: 'https://app.example.com/auth/max/callback',
      botToken: 'bot-token',
      botApiBaseUrl: 'https://api.max.example.com/',
    },
  } as unknown as AppConfigService;

  let fetchMock: jest.Mock;
  let client: MaxOAuthHttpClient;

  const okJson = (body: unknown): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  const errResponse = (status: number, text = 'error'): Response =>
    ({ ok: false, status, json: async () => ({}), text: async () => text }) as unknown as Response;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new MaxOAuthHttpClient(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('обменивает код авторизации на maxUserId через токен и сведения о профиле (Req 16.1)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(okJson({ id: 'max-777' }));

    const maxUserId = await client.exchangeAuthCode('auth-code');

    expect(maxUserId).toBe('max-777');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://api.max.example.com/oauth/token');
    const [userInfoUrl, userInfoInit] = fetchMock.mock.calls[1];
    expect(userInfoUrl).toBe('https://api.max.example.com/oauth/userinfo');
    expect((userInfoInit as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
    });
  });

  it('приводит числовой идентификатор профиля к строке', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 12345 }));

    await expect(client.exchangeAuthCode('auth-code')).resolves.toBe('12345');
  });

  it('бросает MaxOAuthExchangeError при пустом коде авторизации', async () => {
    await expect(client.exchangeAuthCode('   ')).rejects.toBeInstanceOf(MaxOAuthExchangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('бросает MaxOAuthExchangeError, если MAX отклонил обмен кода (Req 16.3)', async () => {
    fetchMock.mockResolvedValueOnce(errResponse(400, 'invalid_grant'));

    await expect(client.exchangeAuthCode('bad-code')).rejects.toBeInstanceOf(MaxOAuthExchangeError);
  });

  it('бросает MaxOAuthExchangeError, если ответ токена не содержит access_token (Req 16.3)', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ token_type: 'Bearer' }));

    await expect(client.exchangeAuthCode('auth-code')).rejects.toBeInstanceOf(
      MaxOAuthExchangeError,
    );
  });

  it('бросает MaxOAuthExchangeError, если профиль MAX не содержит идентификатор (Req 16.3)', async () => {
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ name: 'Без идентификатора' }));

    await expect(client.exchangeAuthCode('auth-code')).rejects.toBeInstanceOf(
      MaxOAuthExchangeError,
    );
  });

  it('оборачивает сетевую ошибку в MaxOAuthExchangeError (Req 16.3)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client.exchangeAuthCode('auth-code')).rejects.toBeInstanceOf(
      MaxOAuthExchangeError,
    );
  });
});
