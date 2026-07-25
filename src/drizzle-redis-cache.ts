import { timingSafeEqual } from 'node:crypto';
import { getTableName, is, Table } from 'drizzle-orm';
import { Cache, type MutationOption } from 'drizzle-orm/cache/core';
import type { CacheConfig } from 'drizzle-orm/cache/core/types';
import { Redis } from 'ioredis';
import type { CacheStatsCollector, HourlyCacheStats } from './cache-stats-plugin';

export type { CacheStatsCollector, HourlyCacheStats, RedisHourlyStatsPluginOptions } from './cache-stats-plugin';
export { RedisHourlyStatsPlugin } from './cache-stats-plugin';

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

  async flushStats(): Promise<void> {
    await this.stats?.flush();
  }

  async destroy(): Promise<void> {
    await this.stats?.destroy();
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
    _tables: string[],
    _isTag: boolean,
    _isAutoInvalidate?: boolean,
  ): Promise<any[] | undefined> {
    await this.refreshMetaIfStale();
    if (!this.enabled) {
      this.stats?.recordMiss();
      return undefined;
    }

    const raw = await this.redis.get(this.key('query', key));
    if (raw == null) {
      this.stats?.recordMiss();
      return undefined;
    }

    this.stats?.recordHit();
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
