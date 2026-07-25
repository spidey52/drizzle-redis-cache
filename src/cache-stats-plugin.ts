import type { Redis } from 'ioredis';

export type HourlyCacheStats = {
  hour: string;
  hourStart: string;
  hits: number;
  misses: number;
  hitRate: number;
};

export interface CacheStatsCollector {
  recordHit(): void;
  recordMiss(): void;
  flush(): Promise<void>;
  getHourlyStats(hours?: number): Promise<HourlyCacheStats[]>;
  destroy(): Promise<void>;
}

export type RedisHourlyStatsPluginOptions = {
  namespace?: string;
  /** Flush interval in ms (default 15s). */
  flushIntervalMs?: number;
  /** Bucket retention in seconds (default 14 days). */
  retentionSeconds?: number;
};

/** Optional plugin: local counters → Redis hourly buckets (local timezone). */
export class RedisHourlyStatsPlugin implements CacheStatsCollector {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly retentionSeconds: number;
  private hits = 0;
  private misses = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(redis: Redis, options: RedisHourlyStatsPluginOptions = {}) {
    this.redis = redis;
    this.namespace = options.namespace ?? 'drizzle';
    this.retentionSeconds = options.retentionSeconds ?? 60 * 60 * 24 * 14;
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs ?? 15_000);
    this.timer.unref?.();
  }

  private statsKey(hour: string): string {
    return `${this.namespace}:stats:${hour}`;
  }

  private hourBucket(date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    return `${y}${m}${d}${h}`;
  }

  private hourStartLocal(hour: string): string {
    const y = Number(hour.slice(0, 4));
    const m = Number(hour.slice(4, 6));
    const d = Number(hour.slice(6, 8));
    const h = Number(hour.slice(8, 10));
    const date = new Date(y, m - 1, d, h, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    const offsetMin = -date.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }

  private recentHours(count: number): string[] {
    const buckets: string[] = [];
    const cursor = new Date();
    cursor.setMinutes(0, 0, 0);
    for (let i = 0; i < count; i++) {
      buckets.unshift(this.hourBucket(cursor));
      cursor.setHours(cursor.getHours() - 1);
    }
    return buckets;
  }

  recordHit(): void {
    this.hits += 1;
  }

  recordMiss(): void {
    this.misses += 1;
  }

  async flush(): Promise<void> {
    const hits = this.hits;
    const misses = this.misses;
    if (hits === 0 && misses === 0) return;

    this.hits = 0;
    this.misses = 0;

    const key = this.statsKey(this.hourBucket());
    try {
      const pipeline = this.redis.pipeline();
      if (hits > 0) pipeline.hincrby(key, 'hits', hits);
      if (misses > 0) pipeline.hincrby(key, 'misses', misses);
      pipeline.expire(key, this.retentionSeconds);
      await pipeline.exec();
    } catch {
      this.hits += hits;
      this.misses += misses;
    }
  }

  async getHourlyStats(hours = 24): Promise<HourlyCacheStats[]> {
    await this.flush();
    const buckets = this.recentHours(Math.max(1, Math.min(hours, 24 * 31)));
    const pipeline = this.redis.pipeline();
    for (const hour of buckets) pipeline.hgetall(this.statsKey(hour));
    const results = await pipeline.exec();

    return buckets.map((hour, i) => {
      const row = (results?.[i]?.[1] ?? {}) as Record<string, string>;
      const hits = Number(row.hits ?? 0);
      const misses = Number(row.misses ?? 0);
      const total = hits + misses;
      return {
        hour,
        hourStart: this.hourStartLocal(hour),
        hits,
        misses,
        hitRate: total === 0 ? 0 : hits / total,
      };
    });
  }

  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
