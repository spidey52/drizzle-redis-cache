/**
 * Redis-backed Drizzle query cache + optional hourly stats + admin HTTP handlers.
 *
 * Peer dependencies: **drizzle-orm**, **ioredis**
 */
export {
  CACHE_ADMIN_DEFAULT_PASSWORD,
  CACHE_ADMIN_DEFAULT_USERNAME,
  CACHE_TTL_DEFAULT_SECONDS,
  CACHE_TTL_MAX_SECONDS,
  CACHE_TTL_MIN_SECONDS,
  createRedisClient,
  DrizzleRedisCache,
  RedisHourlyStatsPlugin,
  type CacheStatsCollector,
  type CreateRedisClientConfig,
  type DrizzleRedisCacheOptions,
  type HourlyCacheStats,
  type RedisHourlyStatsPluginOptions,
} from './drizzle-redis-cache';

export {
  createCacheAdminHandler,
  createCacheAdminNodeHandler,
  type CacheAdminFetchHandler,
  type CacheAdminHandlerOptions,
} from './cache-admin-handler';

export { CACHE_ADMIN_HTML } from './cache-admin-html';
