import { getTableName, is, Table } from 'drizzle-orm';
import { Cache, type MutationOption } from 'drizzle-orm/cache/core';
import type { CacheConfig } from 'drizzle-orm/cache/core/types';
import { Redis, type RedisOptions } from 'ioredis';
import { timingSafeEqual } from 'node:crypto';
import type {
  CacheStatsCollector,
  HourlyCacheStats,
  TableCacheStats,
  WindowCacheStats,
} from './cache-stats-plugin';

export { RedisHourlyStatsPlugin } from './cache-stats-plugin';
export type {
  CacheSkipReason,
  CacheStatsCollector,
  HourlyCacheStats,
  RedisHourlyStatsPluginOptions,
  TableCacheStats,
  WindowCacheStats,
} from './cache-stats-plugin';

export const CACHE_TTL_MIN_SECONDS = 1;
export const CACHE_TTL_MAX_SECONDS = 60 * 60;
export const CACHE_TTL_DEFAULT_SECONDS = 60 * 5;

/** Version counters of tables nobody writes to any more fall out of Redis after this. */
const VERSION_KEY_TTL_SECONDS = 60 * 60 * 24 * 30;

/** How long the versions read by `get` are kept for the matching `put`. */
const PENDING_VERSIONS_TTL_MS = 60_000;
const PENDING_VERSIONS_SWEEP_AT = 10_000;

/** Format tag of the stored value; anything else is treated as a miss and overwritten. */
const ENVELOPE_VERSION = 2;

/** drizzle-orm stores a table's schema under this well-known symbol (drizzle-orm/table.js). */
const TABLE_SCHEMA_SYMBOL = Symbol.for('drizzle:Schema');

/**
 * @deprecated v1 seeded these into Redis on first use. v2 never seeds credentials: pass
 * `adminCredentials` or set them through the admin API. Kept so existing imports compile.
 */
export const CACHE_ADMIN_DEFAULT_USERNAME = 'admin';
/** @deprecated See {@link CACHE_ADMIN_DEFAULT_USERNAME}. */
export const CACHE_ADMIN_DEFAULT_PASSWORD = 'admin';

export type CreateRedisClientConfig = {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /**
   * Queue commands while the connection is down (ioredis default). Off by default here: a command
   * issued while Redis is unreachable fails at once, and the cache treats it as a miss, instead of
   * every query in the process waiting for the reconnect.
   */
  enableOfflineQueue?: boolean;
  /** Retries per command before it fails (default 1). */
  maxRetriesPerRequest?: number;
  /** Per-command timeout in ms (default 250). A slow Redis then costs a miss, not a stall. */
  commandTimeoutMs?: number;
  /** Anything else is passed to ioredis as-is. */
  redisOptions?: RedisOptions;
};

export type CacheErrorOp = 'get' | 'put' | 'onMutate' | 'meta';

export type DrizzleRedisCacheOptions = {
  /** Default TTL in seconds (default 300). Clamped to 1s–1h for API updates. */
  defaultTtlSeconds?: number;
  /** Redis key prefix (default `drizzle`). Instances sharing a namespace invalidate each other. */
  namespace?: string;
  /** `all` = cache every select; `explicit` = only with `.$withCache()`. */
  strategy?: 'all' | 'explicit';
  /** How long local enabled/TTL flags are trusted before Redis refresh (default 60s). */
  metaRefreshIntervalMs?: number;
  /** Optional hit/miss collector. */
  stats?: CacheStatsCollector;
  /**
   * Tables whose queries this instance never caches, as `schema.table` strings (`public` tables by
   * bare name) or Table objects. A query touching any of them bypasses the cache. Writes to them
   * still bump their version, so other instances on the namespace are still invalidated.
   */
  skipTables?: ReadonlyArray<string | Table>;
  /**
   * TTL in seconds per table (`schema.table`). A query takes the smallest configured TTL among its
   * tables, or the default when none of them is configured.
   */
  ttlByTable?: Record<string, number>;
  /**
   * Await the Redis write on a miss (default false). By default the write runs in the background
   * so a miss costs the query alone; errors go to `onError`.
   */
  awaitPut?: boolean;
  /**
   * Interoperate with v1 instances on the same namespace during a rollout: also maintain the v1
   * `table:*` index sets and delete their members on writes. Costs what v1 cost; switch off once
   * every instance runs v2.
   */
  compatV1?: boolean;
  /**
   * Admin credentials used when Redis holds none. Without this and without stored credentials the
   * admin API answers 503. Nothing is ever seeded by default.
   */
  adminCredentials?: { username: string; password: string };
  /** Receives every swallowed Redis error (the cache fails open). Default: nothing. */
  onError?: (err: unknown, op: CacheErrorOp) => void;
};

export function createRedisClient(config: CreateRedisClientConfig = {}): Redis {
  const base: RedisOptions = {
    enableOfflineQueue: config.enableOfflineQueue ?? false,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 1,
    commandTimeout: config.commandTimeoutMs ?? 250,
    ...config.redisOptions,
  };
  if (config.url) return new Redis(config.url, base);
  if (!config.host && config.port == null && !config.password && process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL, base);
  }
  return new Redis({
    ...base,
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

/**
 * The name Drizzle reports in a query's metadata: `schema.table`, or the bare name for `public`.
 * Strings are taken as given.
 */
function toTableName(table: string | Table): string {
  if (!is(table, Table)) return table;
  const schema = (table as unknown as Record<symbol, string | undefined>)[TABLE_SCHEMA_SYMBOL];
  const name = getTableName(table);
  return schema ? `${schema}.${name}` : name;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

type Versions = Record<string, string>;

type Envelope = {
  v: typeof ENVELOPE_VERSION;
  /** table → version counter at the time the rows were read */
  t: Versions;
  /**
   * whatever Drizzle handed `put`: a rows array for relational queries, the driver's whole result
   * object (`{ command, rowCount, rows, fields, ... }`) for node-postgres selects. Returned as-is.
   */
  r: unknown;
};

type Pending = { at: number; versions: Versions | null; skip: boolean };

/**
 * Redis-backed Drizzle query cache.
 *
 * Invalidation is by table version: every table has a counter (`ns:ver:<table>`) that a write bumps
 * with one INCR. A cached result carries the versions it was read under, and a read whose versions
 * differ is a miss. Nothing is deleted on write; stale entries expire on their TTL. Instances on the
 * same namespace share the counters, so a write in one process invalidates the others.
 *
 * Every Redis failure is swallowed (reported through `onError`) and treated as a miss: the cache can
 * slow a query down, never fail it.
 */
export class DrizzleRedisCache extends Cache {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly cacheStrategy: 'all' | 'explicit';
  private readonly metaRefreshIntervalMs: number;
  private readonly stats: CacheStatsCollector | null;
  private readonly fallbackTtlSeconds: number;
  private readonly skipTables: ReadonlySet<string>;
  private readonly ttlByTable: ReadonlyMap<string, number>;
  private readonly awaitPut: boolean;
  private readonly compatV1: boolean;
  private readonly adminCredentials: { username: string; password: string } | null;
  private readonly onError: (err: unknown, op: CacheErrorOp) => void;

  private enabled = true;
  private defaultTtlSeconds: number;
  private metaCheckedAt = 0;
  private metaRefreshInFlight: Promise<void> | null = null;
  /** versions read by `get`, consumed by the `put` of the same key (race safety) */
  private readonly pending = new Map<string, Pending>();

  constructor(redis: Redis, options: DrizzleRedisCacheOptions = {}) {
    super();
    this.redis = redis;
    this.namespace = options.namespace ?? 'drizzle';
    this.cacheStrategy = options.strategy ?? 'all';
    this.metaRefreshIntervalMs = options.metaRefreshIntervalMs ?? 60_000;
    this.stats = options.stats ?? null;
    this.fallbackTtlSeconds = this.clampTtl(options.defaultTtlSeconds ?? CACHE_TTL_DEFAULT_SECONDS);
    this.defaultTtlSeconds = this.fallbackTtlSeconds;
    this.skipTables = new Set((options.skipTables ?? []).map(toTableName));
    this.ttlByTable = new Map(
      Object.entries(options.ttlByTable ?? {}).map(([table, ttl]) => [table, this.clampTtl(ttl)]),
    );
    this.awaitPut = options.awaitPut ?? false;
    this.compatV1 = options.compatV1 ?? false;
    this.adminCredentials = options.adminCredentials ?? null;
    this.onError = options.onError ?? (() => undefined);
  }

  strategy(): 'all' | 'explicit' {
    return this.cacheStrategy;
  }

  // --- Redis key helpers ---

  private key(kind: 'query' | 'ver' | 'table' | 'meta', name: string): string {
    return `${this.namespace}:${kind}:${name}`;
  }

  private versionKeys(tables: string[]): string[] {
    return tables.map((t) => this.key('ver', t));
  }

  private static versionsFrom(tables: string[], raw: (string | null)[]): Versions {
    const out: Versions = {};
    tables.forEach((t, i) => {
      out[t] = raw[i] ?? '0';
    });
    return out;
  }

  private static sameVersions(tables: string[], a: Versions, b: Versions): boolean {
    return tables.every((t) => (a[t] ?? '0') === (b[t] ?? '0'));
  }

  // --- Admin credentials (Redis is source of truth; options seed it; nothing seeds by default) ---

  /**
   * The stored credentials, else the configured ones (stored on first use so the admin API can
   * change them later), else `null`.
   */
  async getAdminCredentials(): Promise<{ username: string; password: string } | null> {
    const userKey = this.key('meta', 'admin_username');
    const passKey = this.key('meta', 'admin_password');
    const [usernameRaw, passwordRaw] = await this.redis.mget(userKey, passKey);
    if (usernameRaw && passwordRaw) return { username: usernameRaw, password: passwordRaw };
    if (!this.adminCredentials) return null;
    await this.redis.mset(userKey, this.adminCredentials.username, passKey, this.adminCredentials.password);
    return { ...this.adminCredentials };
  }

  /** @deprecated Use {@link getAdminCredentials}. Throws when none are configured. */
  async ensureAdminCredentials(): Promise<{ username: string; password: string }> {
    const creds = await this.getAdminCredentials();
    if (!creds) throw new Error('Admin credentials are not configured');
    return creds;
  }

  async verifyAdminCredentials(username: string, password: string): Promise<boolean> {
    const creds = await this.getAdminCredentials();
    if (!creds) return false;
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
    } catch (err) {
      this.onError(err, 'meta');
      // keep last known values
    } finally {
      this.metaCheckedAt = Date.now();
    }
  }

  /**
   * Refresh the runtime flags in the background when they are stale. Never awaited on the query
   * path: a query uses the last known values, and only one refresh runs at a time.
   */
  private refreshMetaIfStale(): void {
    if (this.metaRefreshInFlight) return;
    if (Date.now() - this.metaCheckedAt < this.metaRefreshIntervalMs) return;
    this.metaRefreshInFlight = this.refreshMeta().finally(() => {
      this.metaRefreshInFlight = null;
    });
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

  /** The instance's fixed configuration, for the admin page. */
  getConfig(): {
    namespace: string;
    strategy: 'all' | 'explicit';
    skipTables: string[];
    ttlByTable: Record<string, number>;
    awaitPut: boolean;
    compatV1: boolean;
  } {
    return {
      namespace: this.namespace,
      strategy: this.cacheStrategy,
      skipTables: [...this.skipTables].sort(),
      ttlByTable: Object.fromEntries(this.ttlByTable),
      awaitPut: this.awaitPut,
      compatV1: this.compatV1,
    };
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
    pendingVersions: number;
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

    await this.refreshMeta();
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
      pendingVersions: this.pending.size,
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
    /** version counters (v1 called these table indexes) */
    tableIndexKeys: number;
    sampledKeys: number;
    approxBytes: number | null;
    memorySupported: boolean;
  }> {
    const [queryKeysList, versionKeysList] = await Promise.all([
      this.scanKeys(`${this.namespace}:query:*`),
      this.scanKeys(`${this.namespace}:ver:*`),
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
      tableIndexKeys: versionKeysList.length,
      sampledKeys: sample.length,
      approxBytes,
      memorySupported,
    };
  }

  /** Every table with a version counter, highest version (most written) first. */
  async getTableVersions(): Promise<{ table: string; version: number }[]> {
    const keys = await this.scanKeys(`${this.namespace}:ver:*`);
    if (keys.length === 0) return [];
    const prefix = `${this.namespace}:ver:`;
    const values = await this.redis.mget(...keys);
    return keys
      .map((key, i) => ({
        table: key.startsWith(prefix) ? key.slice(prefix.length) : key,
        version: Number(values[i] ?? 0),
      }))
      .sort((a, b) => b.version - a.version);
  }

  /** @deprecated v2 has no per-table key index; this reports the version counters instead. */
  async getTableIndexStats(): Promise<{ table: string; queryKeys: number; version: number }[]> {
    return (await this.getTableVersions()).map((v) => ({ ...v, queryKeys: 0 }));
  }

  /**
   * Make cached results unreadable. With tables: bump their versions (one INCR each; entries then
   * expire on their TTL). Without: delete every query key and every version counter in the
   * namespace. Does not clear stats or admin meta.
   */
  async flushCache(
    tables?: string[],
  ): Promise<{ deletedQueries: number; deletedTableIndexes: number; bumpedTables: string[] }> {
    if (tables?.length) {
      const unique = [...new Set(tables.map(String).filter(Boolean))];
      const pipeline = this.redis.pipeline();
      for (const table of unique) {
        pipeline.incr(this.key('ver', table));
        pipeline.expire(this.key('ver', table), VERSION_KEY_TTL_SECONDS);
        if (this.compatV1) pipeline.del(this.key('table', table));
      }
      await pipeline.exec();
      return { deletedQueries: 0, deletedTableIndexes: 0, bumpedTables: unique };
    }

    const [queryKeys, versionKeys, tableKeys] = await Promise.all([
      this.scanKeys(`${this.namespace}:query:*`),
      this.scanKeys(`${this.namespace}:ver:*`),
      this.compatV1 ? this.scanKeys(`${this.namespace}:table:*`) : Promise.resolve([] as string[]),
    ]);
    const pipeline = this.redis.pipeline();
    for (const key of queryKeys) pipeline.del(key);
    for (const key of versionKeys) pipeline.del(key);
    for (const key of tableKeys) pipeline.del(key);
    if (queryKeys.length || versionKeys.length || tableKeys.length) await pipeline.exec();
    this.pending.clear();
    return {
      deletedQueries: queryKeys.length,
      deletedTableIndexes: versionKeys.length + tableKeys.length,
      bumpedTables: [],
    };
  }

  // --- Drizzle Cache API ---

  /**
   * The query's own config wins; else the smallest `ttlByTable` entry among its tables, so a join
   * is never kept longer than its most volatile configured table; else the default.
   */
  private ttlFor(tables: string[], config?: CacheConfig): number {
    if (config?.px != null) return Math.max(1, Math.ceil(config.px / 1000));
    if (config?.ex != null) return config.ex;
    let ttl: number | null = null;
    for (const table of tables) {
      const t = this.ttlByTable.get(table);
      if (t != null && (ttl === null || t < ttl)) ttl = t;
    }
    return ttl ?? this.defaultTtlSeconds;
  }

  private touchesSkippedTable(tables: string[]): boolean {
    if (this.skipTables.size === 0) return false;
    return tables.some((t) => this.skipTables.has(t));
  }

  private rememberPending(key: string, entry: Pending): void {
    if (this.pending.size >= PENDING_VERSIONS_SWEEP_AT) {
      const cutoff = Date.now() - PENDING_VERSIONS_TTL_MS;
      for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
    }
    this.pending.set(key, entry);
  }

  private takePending(key: string): Pending | null {
    const entry = this.pending.get(key);
    if (!entry) return null;
    this.pending.delete(key);
    return Date.now() - entry.at <= PENDING_VERSIONS_TTL_MS ? entry : null;
  }

  override async get(
    key: string,
    tables: string[],
    isTag: boolean,
    isAutoInvalidate?: boolean,
  ): Promise<any[] | undefined> {
    this.refreshMetaIfStale();
    if (!this.enabled) {
      this.stats?.recordSkipped?.(tables, 'disabled');
      return undefined;
    }

    // A select Drizzle found no tables for (a view) but that should invalidate on writes: there is
    // nothing to invalidate it with, so it is never cached. A tagged or time-only query is fine.
    if (tables.length === 0 && !isTag && isAutoInvalidate) {
      this.rememberPending(key, { at: Date.now(), versions: null, skip: true });
      return undefined;
    }

    if (this.touchesSkippedTable(tables)) {
      this.stats?.recordSkipped?.(tables, 'skip_table');
      this.rememberPending(key, { at: Date.now(), versions: null, skip: true });
      return undefined;
    }

    const qKey = this.key('query', key);
    try {
      let versions: Versions = {};
      let raw: string | null;
      if (tables.length > 0) {
        const pipeline = this.redis.pipeline();
        pipeline.mget(...this.versionKeys(tables));
        pipeline.get(qKey);
        const results = await pipeline.exec();
        if (!results) throw new Error('empty pipeline result');
        const [[mgetErr, mgetRaw], [getErr, getRaw]] = results;
        if (mgetErr) throw mgetErr;
        if (getErr) throw getErr;
        versions = DrizzleRedisCache.versionsFrom(tables, mgetRaw as (string | null)[]);
        raw = getRaw as string | null;
      } else {
        raw = await this.redis.get(qKey);
      }

      if (raw == null) {
        this.rememberPending(key, { at: Date.now(), versions, skip: false });
        this.stats?.recordMiss(tables);
        return undefined;
      }

      const envelope = JSON.parse(raw) as Partial<Envelope> | null;
      const fresh =
        envelope != null &&
        typeof envelope === 'object' &&
        envelope.v === ENVELOPE_VERSION &&
        'r' in envelope &&
        (tables.length === 0 ||
          DrizzleRedisCache.sameVersions(tables, envelope.t ?? {}, versions));
      if (!fresh) {
        this.rememberPending(key, { at: Date.now(), versions, skip: false });
        this.stats?.recordMiss(tables);
        return undefined;
      }

      this.stats?.recordHit(tables);
      return envelope.r as any[];
    } catch (err) {
      this.onError(err, 'get');
      this.stats?.recordBypassed?.(tables);
      return undefined;
    }
  }

  override async put(
    key: string,
    response: any,
    tables: string[],
    _isTag = false,
    config?: CacheConfig,
  ): Promise<void> {
    const pending = this.takePending(key);
    if (!this.enabled || pending?.skip) return;
    if (this.touchesSkippedTable(tables)) return;

    const write = async () => {
      let versions: Versions;
      if (pending?.versions && tables.every((t) => t in pending.versions!)) {
        versions = pending.versions;
      } else if (tables.length > 0) {
        // `get` was not seen for this key (or saw other tables): read the versions now
        versions = DrizzleRedisCache.versionsFrom(
          tables,
          await this.redis.mget(...this.versionKeys(tables)),
        );
      } else {
        versions = {};
      }

      const envelope: Envelope = { v: ENVELOPE_VERSION, t: versions, r: response };
      const serialized = JSON.stringify(envelope);

      const qKey = this.key('query', key);
      const pipeline = this.redis.pipeline();
      if (config?.exat != null) {
        pipeline.set(qKey, serialized);
        pipeline.expireat(qKey, config.exat);
      } else if (config?.pxat != null) {
        pipeline.set(qKey, serialized);
        pipeline.pexpireat(qKey, config.pxat);
      } else if (config?.px != null) {
        pipeline.set(qKey, serialized, 'PX', config.px);
      } else {
        pipeline.set(qKey, serialized, 'EX', this.ttlFor(tables, config));
      }
      if (this.compatV1) {
        for (const table of tables) {
          pipeline.sadd(this.key('table', table), key);
          pipeline.expire(this.key('table', table), CACHE_TTL_MAX_SECONDS);
        }
      }
      // a pipeline resolves even when a command failed (OOM, MISCONF, wrong type): surface the first
      const failed = (await pipeline.exec())?.find(([err]) => err);
      if (failed) throw failed[0];
    };

    const run = write().catch((err) => {
      this.onError(err, 'put');
      this.stats?.recordBypassed?.(tables);
    });
    if (this.awaitPut) await run;
  }

  override async onMutate(params: MutationOption): Promise<void> {
    const tags = toArray(params.tags);
    const tables = toArray(params.tables).map(toTableName);
    if (tags.length === 0 && tables.length === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      for (const table of tables) {
        pipeline.incr(this.key('ver', table));
        pipeline.expire(this.key('ver', table), VERSION_KEY_TTL_SECONDS);
      }
      for (const tag of tags) pipeline.del(this.key('query', tag));

      if (this.compatV1 && tables.length > 0) {
        // v1 instances on this namespace only notice deletes: do what v1 did for their entries
        const members = await Promise.all(
          tables.map((table) => this.redis.smembers(this.key('table', table))),
        );
        for (const list of members) for (const key of list) pipeline.del(this.key('query', key));
        for (const table of tables) pipeline.del(this.key('table', table));
      }

      await pipeline.exec();
    } catch (err) {
      this.onError(err, 'onMutate');
    }
  }
}
