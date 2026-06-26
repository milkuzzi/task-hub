import { AppConfigService } from '../../config';
import { buildRedisOptions } from './redis.constants';

/** Создаёт заглушку AppConfigService с заданной секцией redis. */
function configWith(redis: AppConfigService['redis']): AppConfigService {
  return { redis } as AppConfigService;
}

describe('buildRedisOptions', () => {
  it('мапит host/port/db и задаёт maxRetriesPerRequest=null для BullMQ', () => {
    const options = buildRedisOptions(configWith({ host: 'cache', port: 6380, db: 2 }));

    expect(options.host).toBe('cache');
    expect(options.port).toBe(6380);
    expect(options.db).toBe(2);
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it('не добавляет поле password при его отсутствии', () => {
    const options = buildRedisOptions(configWith({ host: 'localhost', port: 6379, db: 0 }));

    expect('password' in options).toBe(false);
  });

  it('добавляет password при наличии в конфигурации', () => {
    const options = buildRedisOptions(
      configWith({ host: 'localhost', port: 6379, db: 0, password: 'secret' }),
    );

    expect(options.password).toBe('secret');
  });
});
