import { AppConfigService } from '../config';
import { SendPulseClient } from './sendpulse.client';
import { EmailMessage } from './mailer.types';

describe('SendPulseClient', () => {
  const sendpulse = {
    apiUserId: 'user-id',
    apiSecret: 'secret',
    senderEmail: 'noreply@example.com',
    senderName: 'Система поручений',
  };
  const config = { sendpulse } as unknown as AppConfigService;

  const message: EmailMessage = {
    to: 'user@example.com',
    subject: 'Тема',
    html: '<p>Привет</p>',
  };

  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: jest.fn().mockResolvedValue(body),
      text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    } as unknown as Response;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('получает токен и отправляет письмо через SMTP API', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ result: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new SendPulseClient(config);
    await client.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [authUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(authUrl).toContain('/oauth/access_token');
    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toContain('/smtp/emails');
    expect((sendInit.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('переиспользует кэшированный токен между отправками', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      )
      .mockResolvedValue(jsonResponse({ result: true }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new SendPulseClient(config);
    await client.send(message);
    await client.send(message);

    // 1 запрос токена + 2 запроса отправки.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('бросает исключение при ошибочном ответе отправки', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'bad' }, false, 400));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new SendPulseClient(config);
    await expect(client.send(message)).rejects.toThrow(/SendPulse отклонил/);
  });

  it('бросает исключение при сетевой ошибке', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new SendPulseClient(config);
    await expect(client.send(message)).rejects.toThrow(/Сетевая ошибка/);
  });
});
