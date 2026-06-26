import { Injectable } from '@nestjs/common';
import { ClockService } from '../clock';
import { AppConfigService } from '../config';
import { RedisService } from '../infra';
import { evaluateSlidingWindow } from './sliding-window';
import { RateLimitResult, SensitiveOp } from './security.types';

/** Префикс ключа скользящего окна частоты запросов по источнику. */
const RATE_LIMIT_KEY_PREFIX = 'ratelimit:sensitive:';

/**
 * Ограничитель частоты запросов чувствительных операций (Req 19.1, 19.2).
 *
 * Реализует скользящее окно поверх отсортированного множества Redis (sorted
 * set): метки времени запросов хранятся со счётом, равным моменту запроса.
 * Перед каждым решением устаревшие метки удаляются (`ZREMRANGEBYSCORE`), затем
 * по оставшимся меткам вычисляется решение чистой функцией
 * {@link evaluateSlidingWindow}; допущенный запрос добавляется (`ZADD`).
 *
 * Лимит применяется **на источник целиком**, объединяя все типы чувствительных
 * операций: первые `rateLimitMaxRequests` запросов в окне допускаются, все
 * избыточные отклоняются независимо от типа операции (Req 19.2). Параметр `op`
 * сохраняется в метке для диагностики, но не разделяет окно по типам.
 */
@Injectable()
export class RateLimiter {
  /** Счётчик для уникальности членов множества при совпадении меток времени. */
  private sequence = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly clock: ClockService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Проверяет, допустим ли запрос данной чувствительной операции от указанного
   * источника в пределах скользящего окна.
   *
   * @param source Идентификатор источника (как правило, IP-адрес клиента).
   * @param op Тип чувствительной операции (для диагностики; на лимит не влияет).
   * @returns `{ allowed: true }`, если запрос в пределах лимита, иначе
   *   `{ allowed: false }` — вызывающая сторона выбрасывает
   *   `RateLimitException` (HTTP 429, Req 19.2).
   */
  async check(source: string, op: SensitiveOp): Promise<RateLimitResult> {
    const { rateLimitMaxRequests, rateLimitWindowSeconds } = this.config.limits;
    const windowMs = rateLimitWindowSeconds * 1000;
    const now = this.clock.now().getTime();
    const windowStart = now - windowMs;
    const key = this.keyFor(source);
    const client = this.redis.client;

    // Удаляем истёкшие метки (со счётом ≤ начала окна), затем читаем оставшиеся.
    await client.zremrangebyscore(key, '-inf', windowStart);
    const scores = await client.zrange(key, 0, -1, 'WITHSCORES');
    const existing = this.parseScores(scores);

    const { allowed } = evaluateSlidingWindow(existing, now, windowMs, rateLimitMaxRequests);

    if (allowed) {
      this.sequence = (this.sequence + 1) % Number.MAX_SAFE_INTEGER;
      const member = `${now}:${op}:${this.sequence}`;
      await client.zadd(key, now, member);
    }

    // Ключ живёт не дольше окна: после простоя источника он истекает сам.
    await client.pexpire(key, windowMs);

    return { allowed };
  }

  /** Формирует ключ скользящего окна для источника. */
  private keyFor(source: string): string {
    return `${RATE_LIMIT_KEY_PREFIX}${source}`;
  }

  /**
   * Преобразует плоский ответ `ZRANGE ... WITHSCORES`
   * (`[member, score, member, score, ...]`) в массив меток времени (счётов).
   */
  private parseScores(flat: string[]): number[] {
    const timestamps: number[] = [];
    for (let i = 1; i < flat.length; i += 2) {
      const score = Number(flat[i]);
      if (!Number.isNaN(score)) {
        timestamps.push(score);
      }
    }
    return timestamps;
  }
}
