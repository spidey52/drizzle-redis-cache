import { getTableName, is, Table } from 'drizzle-orm';
import { Cache, type MutationOption } from 'drizzle-orm/cache/core';
import type { CacheConfig } from 'drizzle-orm/cache/core/types';
import { Redis } from 'ioredis';
import { timingSafeEqual } from 'node:crypto';
import type {
  CacheStatsCollector,
  HourlyCacheStats,
  TableCacheStats,
  WindowCacheStats,
} from './cache-stats-plugin';

export { RedisHourlyStatsPlugin } from './cache-stats-plugin';
export type {
  CacheStatsCollector,
  HourlyCacheStats,
  RedisHourlyStatsPluginOptions,
  TableCacheStats,
  WindowCacheStats
} from './cache-stats-plugin';

export const CACHE_TTL_MIN_SECONDS = 1;
export const CACHE_TTL_MAX_SECONDS = 60 * 60;
export const CACHE_TTL_DEFAULT_SECONDS = 60 * 5;

/** Seeded into Redis only when admin credentials are missing. */
export const CACHE_ADMIN_DEFAULT_USERNAME = 'admin';
export const CACHE_ADMIN_DEFAULT_PASSWORD = 'admin';

export type CreateRedisClientConfig = {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
};

export type DrizzleRedisCacheOptions = {
  /** Default TTL in seconds (default 300). Clamped to 1s–1h for API updates. */
  defaultTtlSeconds?: number;
  /** Redis key prefix (default `drizzle`). */
  namespace?: string;
  /** `all` = cache every select; `explicit` = only with `.$withCache()`. */
  strategy?: 'all' | 'explicit';
  /** How long local enabled/TTL flags are trusted before Redis refresh (default 60s). */
  metaRefreshIntervalMs?: number;
  /** Optional hit/miss collector. */
  stats?: CacheStatsCollector;
};

export function createRedisClient(config: CreateRedisClientConfig = {}): Redis {
  if (config.url) return new Redis(config.url);
  if (!config.host && config.port == null && !config.password && process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL);
  }
  return new Redis({
    host: config.host ?? process.env.REDIS_HOST ?? '127.0.0.1',
    port: config.port ?? Number(process.env.REDIS_PORT || '6379'),
    password: config.password ?? process.env.REDIS_PASSWORD,
    db: config.db ?? Number(process.env.REDIS_DB || '0'),
  });
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function toTableName(table: string | Table): string {
  return is(table, Table) ? getTableName(table) : table;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Redis-backed Drizzle query cache.
 * Strategy defaults to `all`. Runtime enabled/TTL live in Redis and refresh locally ~every minute.
 */
export class DrizzleRedisCache extends Cache {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly cacheStrategy: 'all' | 'explicit';
  private readonly metaRefreshIntervalMs: number;
  private readonly stats: CacheStatsCollector | null;
  private readonly fallbackTtlSeconds: number;

  private enabled = true;
  private defaultTtlSeconds: number;
  private metaCheckedAt = 0;

  constructor(redis: Redis, options: DrizzleRedisCacheOptions = {}) {
    super();
    this.redis = redis;
    this.namespace = options.namespace ?? 'drizzle';
    this.cacheStrategy = options.strategy ?? 'all';
    this.metaRefreshIntervalMs = options.metaRefreshIntervalMs ?? 60_000;
    this.stats = options.stats ?? null;
    this.fallbackTtlSeconds = this.clampTtl(options.defaultTtlSeconds ?? CACHE_TTL_DEFAULT_SECONDS);
    this.defaultTtlSeconds = this.fallbackTtlSeconds;
  }

  strategy(): 'all' | 'explicit' {
    return this.cacheStrategy;
  }

  // --- Redis key helpers ---

  private key(kind: 'query' | 'table' | 'meta', name: string): string {
    return `${this.namespace}:${kind}:${name}`;
  }

  // --- Admin credentials (Redis is source of truth) ---

  async ensureAdminCredentials(): Promise<{ username: string; password: string }> {
    const userKey = this.key('meta', 'admin_username');
    const passKey = this.key('meta', 'admin_password');
    const [usernameRaw, passwordRaw] = await this.redis.mget(userKey, passKey);

    if (usernameRaw && passwordRaw) {
      return { username: usernameRaw, password: passwordRaw };
    }

    const username = usernameRaw || CACHE_ADMIN_DEFAULT_USERNAME;
    const password = passwordRaw || CACHE_ADMIN_DEFAULT_PASSWORD;
    await this.redis.mset(userKey, username, passKey, password);
    return { username, password };
  }

  async verifyAdminCredentials(username: string, password: string): Promise<boolean> {
    const creds = await this.ensureAdminCredentials();
    return (
      timingSafeEqualString(username, creds.username) &&
      timingSafeEqualString(password, creds.password)
    );
  }

  async setAdminCredentials(username: string, password: string): Promise<void> {
    const user = username.trim();
    if (!user || !password) throw new Error('username and password are required');
    await this.redis.mset(
      this.key('meta', 'admin_username'),
      user,
      this.key('meta', 'admin_password'),
      password,
    );
  }

  // --- Runtime meta: enabled + default TTL ---

  private clampTtl(seconds: number): number {
    const n = Math.floor(seconds);
    if (!Number.isFinite(n)) return CACHE_TTL_DEFAULT_SECONDS;
    return Math.min(CACHE_TTL_MAX_SECONDS, Math.max(CACHE_TTL_MIN_SECONDS, n));
  }

  private async refreshMeta(): Promise<void> {
    try {
      const [enabledRaw, ttlRaw] = await this.redis.mget(
        this.key('meta', 'enabled'),
        this.key('meta', 'ttl_seconds'),
      );
      this.enabled = enabledRaw !== '0';
      this.defaultTtlSeconds =
        ttlRaw != null && ttlRaw !== '' ? this.clampTtl(Number(ttlRaw)) : this.fallbackTtlSeconds;
      this.metaCheckedAt = Date.now();
    } catch {
      // keep last known values
    }
  }

  private async refreshMetaIfStale(): Promise<void> {
    if (Date.now() - this.metaCheckedAt >= this.metaRefreshIntervalMs) {
      await this.refreshMeta();
    }
  }

  async enable(): Promise<void> {
    await this.redis.set(this.key('meta', 'enabled'), '1');
    this.enabled = true;
    this.metaCheckedAt = Date.now();
  }

  async disable(): Promise<void> {
    await this.redis.set(this.key('meta', 'enabled'), '0');
    this.enabled = false;
    this.metaCheckedAt = Date.now();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await (enabled ? this.enable() : this.disable());
  }

  async isCacheEnabled(): Promise<boolean> {
    await this.refreshMeta();
    return this.enabled;
  }

  async setDefaultTtlSeconds(seconds: number): Promise<number> {
    const ttl = this.clampTtl(seconds);
    await this.redis.set(this.key('meta', 'ttl_seconds'), String(ttl));
    this.defaultTtlSeconds = ttl;
    this.metaCheckedAt = Date.now();
    return ttl;
  }

  async getDefaultTtlSeconds(): Promise<number> {
    await this.refreshMeta();
    return this.defaultTtlSeconds;
  }

  // --- Stats plugin passthrough ---

  async getHourlyStats(hours = 24): Promise<HourlyCacheStats[]> {
    return this.stats ? this.stats.getHourlyStats(hours) : [];
  }

  async getTableHitStats(hours = 24): Promise<TableCacheStats[]> {
    return this.stats?.getTableStats ? this.stats.getTableStats(hours) : [];
  }

  /** Single pipelined read of hourly + per-table stats for the window. */
  async getWindowStats(hours = 24): Promise<WindowCacheStats> {
    if (this.stats?.getWindowStats) return this.stats.getWindowStats(hours);
    const [stats, tableStats] = await Promise.all([
      this.getHourlyStats(hours),
      this.getTableHitStats(hours),
    ]);
    return { stats, tableStats };
  }

  async flushStats(): Promise<void> {
    await this.stats?.flush();
  }

  async destroy(): Promise<void> {
    await this.stats?.destroy();
  }

  // --- Admin ops: health / keys / flush ---

  getNamespace(): string {
    return this.namespace;
  }

  async getHealth(): Promise<{
    ok: boolean;
    redis: 'pong' | 'error';
    redisError?: string;
    namespace: string;
    strategy: 'all' | 'explicit';
    enabled: boolean;
    defaultTtlSeconds: number;
    metaCheckedAt: number | null;
    metaAgeMs: number | null;
    statsPlugin: boolean;
  }> {
    let redis: 'pong' | 'error' = 'error';
    let redisError: string | undefined;
    try {
      const pong = await this.redis.ping();
      redis = pong === 'PONG' ? 'pong' : 'error';
      if (redis === 'error') redisError = `Unexpected ping reply: ${pong}`;
    } catch (err) {
      redisError = err instanceof Error ? err.message : String(err);
    }

    await this.refreshMeta().catch(() => undefined);
    const metaCheckedAt = this.metaCheckedAt || null;

    return {
      ok: redis === 'pong',
      redis,
      redisError,
      namespace: this.namespace,
      strategy: this.cacheStrategy,
      enabled: this.enabled,
      defaultTtlSeconds: this.defaultTtlSeconds,
      metaCheckedAt,
      metaAgeMs: metaCheckedAt == null ? null : Date.now() - metaCheckedAt,
      statsPlugin: this.stats != null,
    };
  }

  /**
   * Measure Redis round-trip delay from this process (network + Redis).
   * Runs PING and GET samples against a tiny probe key.
   */
  async measureLatency(samples = 20): Promise<{
    samples: number;
    ping: { minMs: number; avgMs: number; maxMs: number; p95Ms: number; valuesMs: number[] };
    get: { minMs: number; avgMs: number; maxMs: number; p95Ms: number; valuesMs: number[] };
    probeKey: string;
  }> {
    const n = Math.max(5, Math.min(Math.floor(samples) || 20, 100));
    const probeKey = this.key('meta', 'latency_probe');
    await this.redis.set(probeKey, '1', 'EX', 60);

    const pingMs: number[] = [];
    const getMs: number[] = [];

    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await this.redis.ping();
      pingMs.push(performance.now() - t0);

      const t1 = performance.now();
      await this.redis.get(probeKey);
      getMs.push(performance.now() - t1);
    }

    const summarize = (valuesMs: number[]) => {
      const sorted = [...valuesMs].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
      return {
        minMs: Number(sorted[0].toFixed(3)),
        avgMs: Number((sum / sorted.length).toFixed(3)),
        maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
        p95Ms: Number(sorted[p95Index].toFixed(3)),
        valuesMs: valuesMs.map((v) => Number(v.toFixed(3))),
      };
    };

    return {
      samples: n,
      ping: summarize(pingMs),
      get: summarize(getMs),
      probeKey,
    };
  }

  private async scanKeys(match: string, count = 250): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', count);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async getKeyStats(sampleSize = 40): Promise<{
    namespace: string;
    queryKeys: number;
    tableIndexKeys: number;
    sampledKeys: number;
    approxBytes: number | null;
    memorySupported: boolean;
  }> {
    const [queryKeysList, tableKeysList] = await Promise.all([
      this.scanKeys(`${this.namespace}:query:*`),
      this.scanKeys(`${this.namespace}:table:*`),
    ]);

    const sample = queryKeysList.slice(0, Math.max(0, sampleSize));
    let approxBytes: number | null = null;
    let memorySupported = false;

    if (sample.length > 0) {
      try {
        let total = 0;
        let measured = 0;
        for (const key of sample) {
          const usage = await this.redis.call('MEMORY', 'USAGE', key);
          if (typeof usage === 'number') {
            total += usage;
            measured += 1;
            memorySupported = true;
          }
        }
        if (measured > 0) {
          approxBytes = Math.round((total / measured) * queryKeysList.length);
        }
      } catch {
        memorySupported = false;
        approxBytes = null;
      }
    }

    return {
      namespace: this.namespace,
      queryKeys: queryKeysList.length,
      tableIndexKeys: tableKeysList.length,
      sampledKeys: sample.length,
      approxBytes,
      memorySupported,
    };
  }

  async getTableIndexStats(): Promise<{ table: string; queryKeys: number }[]> {
    const tableKeys = await this.scanKeys(`${this.namespace}:table:*`);
    const prefix = `${this.namespace}:table:`;
    const pipeline = this.redis.pipeline();
    const tables: string[] = [];
    for (const key of tableKeys) {
      const table = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      tables.push(table);
      pipeline.scard(key);
    }
    const results = await pipeline.exec();
    return tables
      .map((table, i) => ({
        table,
        queryKeys: Number(results?.[i]?.[1] ?? 0),
      }))
      .sort((a, b) => b.queryKeys - a.queryKeys);
  }

  /** Delete cached queries (and table indexes). Does not clear stats or admin meta. */
  async flushCache(tables?: string[]): Promise<{ deletedQueries: number; deletedTableIndexes: number }> {
    if (tables?.length) {
      let deletedQueries = 0;
      const unique = [...new Set(tables.map(String).filter(Boolean))];
      for (const table of unique) {
        const members = await this.redis.smembers(this.key('table', table));
        const pipeline = this.redis.pipeline();
        for (const key of members) pipeline.del(this.key('query', key));
        pipeline.del(this.key('table', table));
        await pipeline.exec();
        deletedQueries += members.length;
      }
      return { deletedQueries, deletedTableIndexes: unique.length };
    }

    const [queryKeys, tableKeys] = await Promise.all([
      this.scanKeys(`${this.namespace}:query:*`),
      this.scanKeys(`${this.namespace}:table:*`),
    ]);
    const pipeline = this.redis.pipeline();
    for (const key of queryKeys) pipeline.del(key);
    for (const key of tableKeys) pipeline.del(key);
    if (queryKeys.length || tableKeys.length) await pipeline.exec();
    return { deletedQueries: queryKeys.length, deletedTableIndexes: tableKeys.length };
  }

  // --- Drizzle Cache API ---

  private async resolveTtlSeconds(config?: CacheConfig): Promise<number> {
    if (config?.px != null) return Math.max(1, Math.ceil(config.px / 1000));
    if (config?.ex != null) return config.ex;
    await this.refreshMetaIfStale();
    return this.defaultTtlSeconds;
  }

  override async get(
    key: string,
    tables: string[],
    _isTag: boolean,
    _isAutoInvalidate?: boolean,
  ): Promise<any[] | undefined> {
    await this.refreshMetaIfStale();
    if (!this.enabled) {
      this.stats?.recordMiss(tables);
      return undefined;
    }

    // If no tables are provided, return undefined, using this for view queries
    if (tables.length === 0) {
      return undefined;
    }

    const raw = await this.redis.get(this.key('query', key));
    if (raw == null) {
      this.stats?.recordMiss(tables);
      return undefined;
    }

    this.stats?.recordHit(tables);
    return JSON.parse(raw) as any[];
  }

  override async put(
    key: string,
    response: any,
    tables: string[],
    _isTag = false,
    config?: CacheConfig,
  ): Promise<void> {
    await this.refreshMetaIfStale();
    if (!this.enabled) return;

    const qKey = this.key('query', key);
    const serialized = JSON.stringify(response);
    const pipeline = this.redis.pipeline();

    if (config?.px != null) {
      pipeline.set(qKey, serialized, 'PX', config.px);
    } else if (config?.exat != null) {
      pipeline.set(qKey, serialized);
      pipeline.expireat(qKey, config.exat);
    } else if (config?.pxat != null) {
      pipeline.set(qKey, serialized);
      pipeline.pexpireat(qKey, config.pxat);
    } else {
      pipeline.set(qKey, serialized, 'EX', await this.resolveTtlSeconds(config));
    }

    for (const table of tables) {
      pipeline.sadd(this.key('table', table), key);
    }

    await pipeline.exec();
  }

  override async onMutate(params: MutationOption): Promise<void> {
    const tags = toArray(params.tags);
    const tables = toArray(params.tables).map(toTableName);
    const keysToDelete = new Set<string>(tags);

    for (const table of tables) {
      for (const key of await this.redis.smembers(this.key('table', table))) {
        keysToDelete.add(key);
      }
    }

    if (keysToDelete.size === 0 && tables.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const key of keysToDelete) pipeline.del(this.key('query', key));
    for (const table of tables) pipeline.del(this.key('table', table));
    await pipeline.exec();
  }
}
