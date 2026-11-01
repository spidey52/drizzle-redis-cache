import { describe, expect, it } from 'bun:test';
import type { Redis } from 'ioredis';
import { RedisHourlyStatsPlugin } from '../src/cache-stats-plugin';
import { FakeRedis } from './fake-redis';

describe('RedisHourlyStatsPlugin', () => {
  it('flushes hits, misses, skipped and bypassed per hour and per table, and reports hourly series per table', async () => {
    const redis = new FakeRedis();
    const plugin = new RedisHourlyStatsPlugin(redis as unknown as Redis, { flushIntervalMs: 60_000 });
    plugin.recordHit(['a.x', 'b.y']);
    plugin.recordHit(['a.x']);
    plugin.recordMiss(['a.x']);
    plugin.recordSkipped();
    plugin.recordBypassed();
    await plugin.flush();

    const w = await plugin.getWindowStats(2);
    expect(w.stats).toHaveLength(2);
    const now = w.stats[1]!;
    expect(now).toMatchObject({ hits: 2, misses: 1, skipped: 1, bypassed: 1 });
    expect(now.hitRate).toBeCloseTo(2 / 3);
    expect(w.tableStats).toEqual([
      { table: 'a.x', hits: 2, misses: 1, hitRate: 2 / 3 },
      { table: 'b.y', hits: 1, misses: 0, hitRate: 1 },
    ]);
    expect(w.tableHourly).toEqual({ 'a.x': [[0, 0], [2, 1]], 'b.y': [[0, 0], [1, 0]] });
    await plugin.destroy();
  });

  it('keeps counts locally when the flush fails and retries later', async () => {
    const redis = new FakeRedis();
    const plugin = new RedisHourlyStatsPlugin(redis as unknown as Redis, { flushIntervalMs: 60_000 });
    plugin.recordHit(['a.x']);
    redis.fail = true;
    await plugin.flush();
    redis.fail = false;
    await plugin.flush();
    const w = await plugin.getWindowStats(1);
    expect(w.stats[0]!.hits).toBe(1);
    await plugin.destroy();
  });
});
