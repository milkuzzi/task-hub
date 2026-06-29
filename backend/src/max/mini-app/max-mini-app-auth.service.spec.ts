import { createHmac } from 'node:crypto';
import { AuthenticationException, StateConflictException } from '../../common/errors';
import { MaxMiniAppAuthService } from './max-mini-app-auth.service';

const NOW = new Date('2026-06-28T18:00:00.000Z');
const BOT_TOKEN = 'test-bot-token';

function signedInitData(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    auth_date: String(Math.floor(NOW.getTime() / 1000)),
    query_id: 'query-1',
    user: JSON.stringify({ id: 12345, first_name: 'Иван' }),
    ...overrides,
  };
  const launchParams = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(launchParams).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

function harness() {
  const users = {
    findActiveUserByMaxUserId: jest.fn(),
    findMaxLinkByMaxUserId: jest.fn(),
    findMaxLinkByUserId: jest.fn(),
    upsertMaxLink: jest.fn(),
    runInTransaction: jest.fn(async (callback: (tx: object) => Promise<void>) => callback({})),
  };
  const auth = { authenticateCredentials: jest.fn() };
  const sessions = { issue: jest.fn() };
  const config = {
    max: { botToken: BOT_TOKEN, miniAppInitDataTtlSeconds: 300 },
  };
  const clock = { now: () => NOW };
  const service = new MaxMiniAppAuthService(
    config as never,
    clock as never,
    users as never,
    auth as never,
    sessions as never,
  );
  return { service, users, auth, sessions };
}

describe('MaxMiniAppAuthService', () => {
  it('проверяет официальную HMAC-схему и возвращает MAX user id', () => {
    const { service } = harness();
    expect(service.validateInitData(signedInitData())).toBe('12345');
  });

  it('отклоняет изменённые, повторяющиеся и просроченные параметры', () => {
    const { service } = harness();
    const tampered = signedInitData().replace('query-1', 'query-2');
    const duplicate = `${signedInitData()}&auth_date=1`;
    const expired = signedInitData({
      auth_date: String(Math.floor(NOW.getTime() / 1000) - 301),
    });

    expect(() => service.validateInitData(tampered)).toThrow(AuthenticationException);
    expect(() => service.validateInitData(duplicate)).toThrow(AuthenticationException);
    expect(() => service.validateInitData(expired)).toThrow(AuthenticationException);
  });

  it('выпускает сессию только для активной существующей привязки', async () => {
    const { service, users, sessions } = harness();
    const user = { id: 'user-1', role: 'EXECUTOR' };
    users.findActiveUserByMaxUserId.mockResolvedValue(user);
    sessions.issue.mockResolvedValue({ userId: 'user-1' });

    await expect(service.login(signedInitData())).resolves.toEqual({ userId: 'user-1' });
    expect(users.findActiveUserByMaxUserId).toHaveBeenCalledWith('12345');
    expect(sessions.issue).toHaveBeenCalledWith(user);
  });

  it('возвращает машинную причину, когда MAX ещё не привязан', async () => {
    const { service, users } = harness();
    users.findActiveUserByMaxUserId.mockResolvedValue(null);

    await expect(service.login(signedInitData())).rejects.toMatchObject({
      details: { reason: 'MAX_NOT_LINKED' },
    });
  });

  it('не заменяет существующую привязку аккаунта к другому MAX', async () => {
    const { service, users, auth, sessions } = harness();
    auth.authenticateCredentials.mockResolvedValue({ id: 'user-1', role: 'EXECUTOR' });
    users.findMaxLinkByMaxUserId.mockResolvedValue(null);
    users.findMaxLinkByUserId.mockResolvedValue({ userId: 'user-1', maxUserId: '999' });

    await expect(
      service.linkAndLogin(signedInitData(), 'user@example.com', 'password', '127.0.0.1'),
    ).rejects.toBeInstanceOf(StateConflictException);
    expect(users.upsertMaxLink).not.toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});
