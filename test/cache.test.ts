import { describe, expect, it } from 'bun:test';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import type { Redis } from 'ioredis';
import { DrizzleRedisCache, type DrizzleRedisCacheOptions } from '../src/drizzle-redis-cache';
import { FakeRedis } from './fake-redis';

const make = (options: DrizzleRedisCacheOptions = {}) => {
  const redis = new FakeRedis();
  const errors: string[] = [];
  const cache = new DrizzleRedisCache(redis as unknown as Redis, {
    awaitPut: true, // tests observe the write
    onError: (_err, op) => errors.push(op),
    ...options,
  });
  return { redis, cache, errors };
};

const rows = [{ id: 1, name: 'a' }];
const T = ['master.company', 'order.sell_orders'];

describe('get / put', () => {
  it('misses, stores under the current table versions, then hits', async () => {
    const { cache, redis } = make();
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
    await cache.put('k1', rows, T, false);
    expect(await cache.get('k1', T, false, true)).toEqual(rows);
    expect(redis.ttlOf('drizzle:query:k1')).toBe(300);
  });

  it('a write to any table the query read makes it a miss (version bump, no delete)', async () => {
    const { cache, redis } = make();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    await cache.onMutate({ tables: ['order.sell_orders'] });
    expect(redis.log.some((c) => c[0] === 'del')).toBe(false);
    expect(await redis.get('drizzle:ver:order.sell_orders')).toBe('1');
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
  });

  it('a write to an unrelated table does not invalidate', async () => {
    const { cache } = make();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    await cache.onMutate({ tables: ['logistic.trips'] });
    expect(await cache.get('k1', T, false, true)).toEqual(rows);
  });

  it('returns whatever shape Drizzle stored: the node-postgres result object, not only arrays', async () => {
    const { cache } = make();
    const pgResult = { command: 'SELECT', rowCount: 1, rows, fields: [{ name: 'id' }], oid: null };
    await cache.get('k1', T, false, true);
    await cache.put('k1', pgResult, T, false);
    expect(await cache.get('k1', T, false, true)).toEqual(pgResult);
  });

  it('a tagged query with no tables (autoInvalidate off) is cached and hits', async () => {
    const { cache } = make();
    expect(await cache.get('order:42', [], true, false)).toBeUndefined();
    await cache.put('order:42', rows, [], true);
    expect(await cache.get('order:42', [], true, false)).toEqual(rows);
    await cache.onMutate({ tags: 'order:42' });
    expect(await cache.get('order:42', [], true, false)).toBeUndefined();
  });

  it('a view (no tables) that wants auto-invalidation is never cached', async () => {
    const { cache, redis } = make();
    expect(await cache.get('view', [], false, true)).toBeUndefined();
    await cache.put('view', rows, [], false);
    expect(redis.keys().filter((k) => k.startsWith('drizzle:query:'))).toEqual([]);
  });

  it('a stale put after a concurrent write is never read (race safety)', async () => {
    const { cache } = make();
    // read starts: versions captured
    await cache.get('k1', T, false, true);
    // a write lands before the slow read finishes
    await cache.onMutate({ tables: ['master.company'] });
    // the read's old rows are stored under the versions it started with
    await cache.put('k1', [{ id: 1, name: 'old' }], T, false);
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
  });

  it('entries written by v1 (no envelope) are a miss and get overwritten', async () => {
    const { cache, redis } = make();
    await redis.set('drizzle:query:k1', JSON.stringify([{ id: 'legacy' }]));
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
    await cache.put('k1', rows, T, false);
    expect(await cache.get('k1', T, false, true)).toEqual(rows);
  });

  it('strategy is reported as configured', () => {
    expect(make().cache.strategy()).toBe('all');
    expect(make({ strategy: 'explicit' }).cache.strategy()).toBe('explicit');
  });
});

describe('skipTables', () => {
  it('bypasses get and put for a query touching a skipped table, but writes still bump versions', async () => {
    const { cache, redis } = make({ skipTables: ['order.sell_orders'] });
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
    await cache.put('k1', rows, T, false);
    expect(redis.keys().filter((k) => k.startsWith('drizzle:query:'))).toEqual([]);
    // no query reads at all (the only MGET is the background meta refresh)
    expect(
      redis.log.filter((c) => (c[0] === 'get' || c[0] === 'mget') && !c[1]?.startsWith('drizzle:meta:')),
    ).toEqual([]);

    await cache.onMutate({ tables: ['order.sell_orders'] });
    expect(await redis.get('drizzle:ver:order.sell_orders')).toBe('1');
  });

  it('still caches queries on other tables', async () => {
    const { cache } = make({ skipTables: ['order.sell_orders'] });
    await cache.get('k2', ['master.company'], false, true);
    await cache.put('k2', rows, ['master.company'], false);
    expect(await cache.get('k2', ['master.company'], false, true)).toEqual(rows);
  });

  it('accepts Table objects and keeps their schema', async () => {
    const master = pgSchema('master');
    const company = master.table('company', { id: text('id') });
    const plain = pgTable('notices', { id: text('id') });
    const { cache } = make({ skipTables: [company, plain] });
    expect(cache.getConfig().skipTables).toEqual(['master.company', 'notices']);
  });
});

describe('TTL', () => {
  it('uses the smallest per-table TTL among the query tables', async () => {
    const { cache, redis } = make({ ttlByTable: { 'master.company': 3600, 'order.sell_orders': 20 } });
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    expect(redis.ttlOf('drizzle:query:k1')).toBe(20);
  });

  it('a configured per-table TTL applies even when it is longer than the default', async () => {
    const { cache, redis } = make({ ttlByTable: { 'master.categories': 3600 } });
    await cache.get('k1', ['master.categories'], false, true);
    await cache.put('k1', rows, ['master.categories'], false);
    expect(redis.ttlOf('drizzle:query:k1')).toBe(3600);
    // a join with an unconfigured table still takes the configured one, not the default
    await cache.get('k2', ['master.categories', 'master.products'], false, true);
    await cache.put('k2', rows, ['master.categories', 'master.products'], false);
    expect(redis.ttlOf('drizzle:query:k2')).toBe(3600);
  });

  it('honours the query config over defaults', async () => {
    const { cache, redis } = make();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false, { ex: 7 });
    expect(redis.ttlOf('drizzle:query:k1')).toBe(7);
  });
});

describe('fail open', () => {
  it('get returns undefined, put and onMutate resolve, when Redis is down', async () => {
    const { cache, redis, errors } = make();
    redis.fail = true;
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
    await expect(cache.put('k1', rows, T, false)).resolves.toBeUndefined();
    await expect(cache.onMutate({ tables: T })).resolves.toBeUndefined();
    // the background meta refresh fails too and is reported, never thrown
    expect(errors.filter((op) => op !== 'meta')).toEqual(['get', 'put', 'onMutate']);
  });

  it('a write that fails inside the pipeline (OOM, MISCONF) is reported, not swallowed', async () => {
    const { cache, redis, errors } = make();
    redis.failWrites = true;
    await cache.get('k1', T, false, true);
    await expect(cache.put('k1', rows, T, false)).resolves.toBeUndefined();
    expect(errors).toContain('put');
    redis.failWrites = false;
    expect(await cache.get('k1', T, false, true)).toBeUndefined();
  });

  it('put does not throw in background mode either', async () => {
    const { cache, redis, errors } = make({ awaitPut: false });
    redis.fail = true;
    await expect(cache.put('k1', rows, T, false)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toContain('put');
  });

  it('recovers when Redis is back', async () => {
    const { cache, redis } = make();
    redis.fail = true;
    await cache.get('k1', T, false, true);
    redis.fail = false;
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    expect(await cache.get('k1', T, false, true)).toEqual(rows);
  });
});

describe('disabled', () => {
  it('neither reads nor writes while disabled, and resumes when enabled', async () => {
    const { cache, redis } = make();
    await cache.disable();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    expect(redis.keys().filter((k) => k.startsWith('drizzle:query:'))).toEqual([]);
    await cache.enable();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    expect(await cache.get('k1', T, false, true)).toEqual(rows);
  });
});

describe('compatV1', () => {
  it('maintains v1 index sets and deletes their members on writes', async () => {
    const { cache, redis } = make({ compatV1: true });
    await redis.sadd('drizzle:table:order.sell_orders', 'v1key');
    await redis.set('drizzle:query:v1key', '[]');
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    expect(await redis.smembers('drizzle:table:master.company')).toEqual(['k1']);

    await cache.onMutate({ tables: ['order.sell_orders'] });
    expect(await redis.get('drizzle:query:v1key')).toBeNull();
    expect(await redis.get('drizzle:query:k1')).toBeNull();
    expect(await redis.get('drizzle:ver:order.sell_orders')).toBe('1');
  });
});

describe('flush and admin data', () => {
  it('flushing tables bumps their versions; flushing all deletes everything', async () => {
    const { cache, redis } = make();
    await cache.get('k1', T, false, true);
    await cache.put('k1', rows, T, false);
    const partial = await cache.flushCache(['master.company']);
    expect(partial.bumpedTables).toEqual(['master.company']);
    expect(await cache.get('k1', T, false, true)).toBeUndefined();

    const all = await cache.flushCache();
    expect(all.deletedQueries).toBe(1);
    expect(redis.keys().filter((k) => k.startsWith('drizzle:ver:'))).toEqual([]);
  });

  it('reports table versions and config', async () => {
    const { cache } = make({ skipTables: ['b.hot'], ttlByTable: { 'a.ref': 3600 } });
    await cache.onMutate({ tables: ['a.ref', 'b.hot', 'b.hot'] });
    expect(await cache.getTableVersions()).toEqual([
      { table: 'b.hot', version: 2 },
      { table: 'a.ref', version: 1 },
    ]);
    expect(cache.getConfig()).toMatchObject({
      namespace: 'drizzle',
      strategy: 'all',
      skipTables: ['b.hot'],
      ttlByTable: { 'a.ref': 3600 },
      compatV1: false,
    });
  });

  it('never seeds admin credentials; configured ones are stored on first use', async () => {
    expect(await make().cache.getAdminCredentials()).toBeNull();
    const { cache, redis } = make({ adminCredentials: { username: 'ops', password: 's3cret' } });
    expect(await cache.getAdminCredentials()).toEqual({ username: 'ops', password: 's3cret' });
    expect(await redis.get('drizzle:meta:admin_username')).toBe('ops');
    expect(await cache.verifyAdminCredentials('ops', 's3cret')).toBe(true);
    expect(await cache.verifyAdminCredentials('ops', 'nope')).toBe(false);
  });
});
