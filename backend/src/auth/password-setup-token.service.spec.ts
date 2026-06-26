import { AppConfigService } from '../config';
import { RedisService } from '../infra';
import { PasswordSetupTokenService } from './password-setup-token.service';

/**
 * Модульные тесты {@link PasswordSetupTokenService} с in-memory подменой Redis:
 * выпуск токена с TTL, одноразовое потребление через GETDEL, отказ для
 * неизвестного токена (Req 5.6, 15.2, 15.3, 19.5–19.7).
 */
describe('PasswordSetupTokenService (Req 5.6, 15.2, 19.5-19.7)', () => {
  const TTL = 86400;
  let store: Map<string, string>;
  let redis: RedisService;
  let config: AppConfigService;
  let service: PasswordSetupTokenService;

  beforeEach(() => {
    store = new Map<string, string>();
    redis = {
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      getDel: jest.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
    } as unknown as RedisService;
    config = { limits: { passwordSetupTtlSeconds: TTL } } as unknown as AppConfigService;
    service = new PasswordSetupTokenService(redis, config);
  });

  it('выпускает токен и сохраняет его с TTL = passwordSetupTtlSeconds (Req 15.2)', async () => {
    const token = await service.issue('user-1');
    expect(token).toBeTruthy();
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), 'user-1', TTL);
  });

  it('хранит хеш токена, а не сам секрет', async () => {
    const token = await service.issue('user-1');
    const storedKeys = [...store.keys()];
    expect(storedKeys.some((k) => k.includes(token))).toBe(false);
  });

  it('потребляет токен один раз и возвращает userId (Req 5.5)', async () => {
    const token = await service.issue('user-1');
    await expect(service.consume(token)).resolves.toBe('user-1');
  });

  it('отклоняет повторное использование того же токена (Req 5.6, 19.6)', async () => {
    const token = await service.issue('user-1');
    await service.consume(token);
    await expect(service.consume(token)).resolves.toBeNull();
  });

  it('возвращает null для неизвестного токена (Req 19.7)', async () => {
    await expect(service.consume('nonexistent')).resolves.toBeNull();
  });
});
