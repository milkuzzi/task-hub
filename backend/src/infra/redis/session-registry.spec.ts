import type Redis from 'ioredis';
import { SessionRecord, SessionRegistry } from './session-registry';

/**
 * Минимальная in-memory реализация ioredis, покрывающая операции, используемые
 * {@link SessionRegistry}: строковые ключи, множества и конвейер `multi()`.
 * Позволяет тестировать логику реестра без живого Redis.
 */
class FakeRedis {
  private strings = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) ? 1 : 0;
  }

  async del(...keys: string[]): Promise<number> {
    return this.delSync(...keys);
  }

  /** Синхронное удаление, разделяемое прямыми вызовами и конвейером. */
  delSync(...keys: string[]): number {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) {
        removed += 1;
      }
      this.sets.delete(key);
    }
    return removed;
  }

  setSync(key: string, value: string): void {
    this.strings.set(key, value);
  }

  saddSync(key: string, member: string): void {
    const set = this.sets.get(key) ?? new Set<string>();
    set.add(member);
    this.sets.set(key, set);
  }

  sremSync(key: string, member: string): void {
    this.sets.get(key)?.delete(member);
  }

  /** Конвейер команд: операции выполняются при вызове exec(). */
  multi(): FakePipeline {
    return new FakePipeline(this);
  }
}

/** Цепочечный конвейер, имитирующий ChainableCommander ioredis. */
class FakePipeline {
  private readonly ops: Array<() => void> = [];

  constructor(private readonly store: FakeRedis) {}

  set(key: string, value: string): this {
    this.ops.push(() => this.store.setSync(key, value));
    return this;
  }

  sadd(key: string, member: string): this {
    this.ops.push(() => this.store.saddSync(key, member));
    return this;
  }

  srem(key: string, member: string): this {
    this.ops.push(() => this.store.sremSync(key, member));
    return this;
  }

  del(key: string): this {
    this.ops.push(() => {
      this.store.delSync(key);
    });
    return this;
  }

  expire(key: string, ttl: number): this {
    void key;
    void ttl;
    return this;
  }

  async exec(): Promise<void> {
    for (const op of this.ops) {
      op();
    }
  }
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date();
  return {
    tokenId: 'tok-1',
    userId: 'user-1',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('SessionRegistry', () => {
  let fake: FakeRedis;
  let registry: SessionRegistry;

  beforeEach(() => {
    fake = new FakeRedis();
    registry = new SessionRegistry(fake as unknown as Redis);
  });

  it('регистрирует сессию и подтверждает её валидность', async () => {
    const record = makeRecord();
    await registry.register(record);

    expect(await registry.isValid(record.tokenId)).toBe(true);
    expect(await registry.get(record.tokenId)).toEqual(record);
    expect(await registry.listUserTokens(record.userId)).toEqual([record.tokenId]);
  });

  it('возвращает null для неизвестного токена', async () => {
    expect(await registry.get('missing')).toBeNull();
    expect(await registry.isValid('missing')).toBe(false);
  });

  it('аннулирует конкретную сессию', async () => {
    const record = makeRecord();
    await registry.register(record);

    await registry.revoke(record.tokenId);

    expect(await registry.isValid(record.tokenId)).toBe(false);
    expect(await registry.listUserTokens(record.userId)).toEqual([]);
  });

  it('аннулирует все сессии пользователя и возвращает их число', async () => {
    await registry.register(makeRecord({ tokenId: 'a' }));
    await registry.register(makeRecord({ tokenId: 'b' }));
    await registry.register(makeRecord({ tokenId: 'c', userId: 'user-2' }));

    const revoked = await registry.revokeAllForUser('user-1');

    expect(revoked).toBe(2);
    expect(await registry.isValid('a')).toBe(false);
    expect(await registry.isValid('b')).toBe(false);
    // Сессии другого пользователя не затронуты.
    expect(await registry.isValid('c')).toBe(true);
  });
});
