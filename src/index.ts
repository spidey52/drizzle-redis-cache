/**
 * Redis-backed Drizzle query cache + optional hourly stats + admin HTTP handlers.
 *
 * Peer dependencies: **drizzle-orm**, **ioredis**
 *
 * Admin UI is loaded from the `ui/` folder of this package's git tag (jsDelivr).
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
  type CacheErrorOp,
  type CacheSkipReason,
  type CacheStatsCollector,
  type CreateRedisClientConfig,
  type DrizzleRedisCacheOptions,
  type HourlyCacheStats,
  type RedisHourlyStatsPluginOptions,
  type TableCacheStats,
  type WindowCacheStats,
} from './drizzle-redis-cache';

export {
  createCacheAdminHandler,
  createCacheAdminNodeHandler,
  type CacheAdminFetchHandler,
  type CacheAdminHandlerOptions,
} from './cache-admin-handler';

export {
  CACHE_ADMIN_HTML,
  CACHE_ADMIN_UI_VERSION_TAG,
  DEFAULT_CACHE_ADMIN_UI_BASE_URL,
  DEFAULT_CACHE_ADMIN_UI_SCRIPT_URL,
  renderCacheAdminHtml,
  type CacheAdminHtmlOptions,
} from './cache-admin-html';
