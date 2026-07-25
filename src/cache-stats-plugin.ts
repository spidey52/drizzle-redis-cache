import type { Redis } from 'ioredis';

export type HourlyCacheStats = {
  hour: string;
  hourStart: string;
  hits: number;
  misses: number;
  hitRate: number;
};

export type TableCacheStats = {
  table: string;
  hits: number;
  misses: number;
  hitRate: number;
};

export type WindowCacheStats = {
  stats: HourlyCacheStats[];
  tableStats: TableCacheStats[];
};

export interface CacheStatsCollector {
  recordHit(tables?: string[]): void;
  recordMiss(tables?: string[]): void;
  flush(): Promise<void>;
  getHourlyStats(hours?: number): Promise<HourlyCacheStats[]>;
  getTableStats?(hours?: number): Promise<TableCacheStats[]>;
  getWindowStats?(hours?: number): Promise<WindowCacheStats>;
  destroy(): Promise<void>;
}

export type RedisHourlyStatsPluginOptions = {
  namespace?: string;
  /** Flush interval in ms (default 15s). */
  flushIntervalMs?: number;
  /** Bucket retention in seconds (default 14 days). */
  retentionSeconds?: number;
};

const TABLE_HIT_PREFIX = 'th:';
const TABLE_MISS_PREFIX = 'tm:';

/** Optional plugin: local counters → Redis hourly buckets (local timezone). */
export class RedisHourlyStatsPlugin implements CacheStatsCollector {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly retentionSeconds: number;
  private hits = 0;
  private misses = 0;
  private readonly tableHits = new Map<string, number>();
  private readonly tableMisses = new Map<string, number>();
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

  private clampHours(hours: number): number {
    return Math.max(1, Math.min(hours, 24 * 31));
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

  private bumpTable(map: Map<string, number>, tables?: string[]) {
    if (!tables?.length) return;
    for (const table of tables) {
      if (!table) continue;
      map.set(table, (map.get(table) ?? 0) + 1);
    }
  }

  recordHit(tables?: string[]): void {
    this.hits += 1;
    this.bumpTable(this.tableHits, tables);
  }

  recordMiss(tables?: string[]): void {
    this.misses += 1;
    this.bumpTable(this.tableMisses, tables);
  }

  async flush(): Promise<void> {
    const hits = this.hits;
    const misses = this.misses;
    const tableHits = new Map(this.tableHits);
    const tableMisses = new Map(this.tableMisses);
    if (hits === 0 && misses === 0 && tableHits.size === 0 && tableMisses.size === 0) return;

    this.hits = 0;
    this.misses = 0;
    this.tableHits.clear();
    this.tableMisses.clear();

    const key = this.statsKey(this.hourBucket());
    try {
      const pipeline = this.redis.pipeline();
      if (hits > 0) pipeline.hincrby(key, 'hits', hits);
      if (misses > 0) pipeline.hincrby(key, 'misses', misses);

      const tables = new Set([...tableHits.keys(), ...tableMisses.keys()]);
      for (const table of tables) {
        const th = tableHits.get(table) ?? 0;
        const tm = tableMisses.get(table) ?? 0;
        if (th > 0) pipeline.hincrby(key, `${TABLE_HIT_PREFIX}${table}`, th);
        if (tm > 0) pipeline.hincrby(key, `${TABLE_MISS_PREFIX}${table}`, tm);
      }

      pipeline.expire(key, this.retentionSeconds);
      await pipeline.exec();
    } catch {
      this.hits += hits;
      this.misses += misses;
      for (const [t, n] of tableHits) this.tableHits.set(t, (this.tableHits.get(t) ?? 0) + n);
      for (const [t, n] of tableMisses) this.tableMisses.set(t, (this.tableMisses.get(t) ?? 0) + n);
    }
  }

  /** Pipelined HGETALL for the last N hour buckets. */
  private async loadHourlyRows(
    hours: number,
  ): Promise<Array<{ hour: string; row: Record<string, string> }>> {
    const buckets = this.recentHours(this.clampHours(hours));
    const pipeline = this.redis.pipeline();
    for (const hour of buckets) pipeline.hgetall(this.statsKey(hour));
    const results = await pipeline.exec();

    return buckets.map((hour, i) => ({
      hour,
      row: (results?.[i]?.[1] ?? {}) as Record<string, string>,
    }));
  }

  private toHourlyStats(
    rows: Array<{ hour: string; row: Record<string, string> }>,
  ): HourlyCacheStats[] {
    return rows.map(({ hour, row }) => {
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

  private toTableStats(
    rows: Array<{ hour: string; row: Record<string, string> }>,
  ): TableCacheStats[] {
    const agg = new Map<string, { hits: number; misses: number }>();

    for (const { row } of rows) {
      for (const [field, raw] of Object.entries(row)) {
        const n = Number(raw ?? 0);
        if (!Number.isFinite(n) || n === 0) continue;

        if (field.startsWith(TABLE_HIT_PREFIX)) {
          const table = field.slice(TABLE_HIT_PREFIX.length);
          if (!table) continue;
          const cur = agg.get(table) ?? { hits: 0, misses: 0 };
          cur.hits += n;
          agg.set(table, cur);
        } else if (field.startsWith(TABLE_MISS_PREFIX)) {
          const table = field.slice(TABLE_MISS_PREFIX.length);
          if (!table) continue;
          const cur = agg.get(table) ?? { hits: 0, misses: 0 };
          cur.misses += n;
          agg.set(table, cur);
        }
      }
    }

    return [...agg.entries()]
      .map(([table, { hits, misses }]) => {
        const total = hits + misses;
        return {
          table,
          hits,
          misses,
          hitRate: total === 0 ? 0 : hits / total,
        };
      })
      .sort((a, b) => b.hits + b.misses - (a.hits + a.misses));
  }

  async getWindowStats(hours = 24): Promise<WindowCacheStats> {
    await this.flush();
    const rows = await this.loadHourlyRows(hours);
    return {
      stats: this.toHourlyStats(rows),
      tableStats: this.toTableStats(rows),
    };
  }

  async getHourlyStats(hours = 24): Promise<HourlyCacheStats[]> {
    const { stats } = await this.getWindowStats(hours);
    return stats;
  }

  async getTableStats(hours = 24): Promise<TableCacheStats[]> {
    const { tableStats } = await this.getWindowStats(hours);
    return tableStats;
  }

  async destroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
