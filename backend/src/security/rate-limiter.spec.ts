import type Redis from 'ioredis';
import type { ClockService } from '../clock';
import type { AppConfigService } from '../config';
import type { RedisService } from '../infra';
import { RateLimiter } from './rate-limiter';
import type { SensitiveOp } from './security.types';

/**
 * Минимальная in-memory реализация отсортированного множества Redis,
 * покрывающая операции, используемые {@link RateLimiter}: `zadd`, `zrange`
 * (с `WITHSCORES`), `zremrangebyscore`, `pexpire`. Позволяет тестировать логику
 * скользящего окна без живого Redis.
 */
class FakeSortedSetRedis {
  private sets = new Map<string, Array<{ member: string; score: number }>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sets.get(key) ?? [];
    set.push({ member, score });
    this.sets.set(key, set);
    return 1;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores: 'WITHSCORES',
  ): Promise<string[]> {
    void withScores;
    const set = [...(this.sets.get(key) ?? [])].sort((a, b) => a.score - b.score);
    const end = stop === -1 ? set.length - 1 : stop;
    const flat: string[] = [];
    for (let i = start; i <= end && i < set.length; i += 1) {
      const entry = set[i];
      if (entry !== undefined) {
        flat.push(entry.member, String(entry.score));
      }
    }
    return flat;
  }

  async zremrangebyscore(key: string, min: '-inf', max: number): Promise<number> {
    void min;
    const set = this.sets.get(key);
    if (set === undefined) {
      return 0;
    }
    const before = set.length;
    const kept = set.filter((entry) => entry.score > max);
    this.sets.set(key, kept);
    return before - kept.length;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    void key;
    void ms;
    return 1;
  }
}

describe('RateLimiter', () => {
  const windowSeconds = 60;
  const maxRequests = 10;

  function build(): { limiter: RateLimiter; setNow: (ms: number) => void } {
    const fake = new FakeSortedSetRedis();
    const redis = { client: fake as unknown as Redis } as unknown as RedisService;
    let nowMs = 1_000_000;
    const clock = { now: (): Date => new Date(nowMs) } as unknown as ClockService;
    const config = {
      limits: { rateLimitMaxRequests: maxRequests, rateLimitWindowSeconds: windowSeconds },
    } as unknown as AppConfigService;

    return {
      limiter: new RateLimiter(redis, clock, config),
      setNow: (ms: number) => {
        nowMs = ms;
      },
    };
  }

  it('допускает первые 10 запросов и отклоняет 11-й от одного источника', async () => {
    const { limiter } = build();
    for (let i = 0; i < 10; i += 1) {
      const result = await limiter.check('1.2.3.4', 'login');
      expect(result.allowed).toBe(true);
    }
    const eleventh = await limiter.check('1.2.3.4', 'login');
    expect(eleventh.allowed).toBe(false);
  });

  it('считает разные типы операций в одном окне источника (Req 19.2)', async () => {
    const { limiter } = build();
    const ops: readonly SensitiveOp[] = [
      'login',
      'send_message',
      'upload',
      'change_password',
      'set_password',
    ];
    let allowedCount = 0;
    for (let i = 0; i < 12; i += 1) {
      const op = ops[i % ops.length] ?? 'login';
      const result = await limiter.check('5.6.7.8', op);
      if (result.allowed) {
        allowedCount += 1;
      }
    }
    expect(allowedCount).toBe(10);
  });

  it('изолирует разные источники друг от друга', async () => {
    const { limiter } = build();
    for (let i = 0; i < 10; i += 1) {
      await limiter.check('a', 'login');
    }
    expect((await limiter.check('a', 'login')).allowed).toBe(false);
    expect((await limiter.check('b', 'login')).allowed).toBe(true);
  });

  it('снова допускает запрос после выхода старых меток за окно', async () => {
    const { limiter, setNow } = build();
    setNow(1_000_000);
    for (let i = 0; i < 10; i += 1) {
      await limiter.check('c', 'login');
    }
    expect((await limiter.check('c', 'login')).allowed).toBe(false);

    // Сдвигаем время за пределы окна — прежние метки истекают.
    setNow(1_000_000 + windowSeconds * 1000 + 1);
    expect((await limiter.check('c', 'login')).allowed).toBe(true);
  });
});
