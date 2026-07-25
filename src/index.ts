/**
 * Redis-backed Drizzle query cache + optional hourly stats + admin HTTP handlers.
 *
 * Peer dependencies: **drizzle-orm**, **ioredis**
 *
 * Admin UI is loaded from a remote script (default jsDelivr). Update `ui/app.js`
 * on GitHub to ship UI changes without bumping this package.
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
  DEFAULT_CACHE_ADMIN_UI_BASE_URL,
  DEFAULT_CACHE_ADMIN_UI_SCRIPT_URL,
  renderCacheAdminHtml,
  type CacheAdminHtmlOptions,
} from './cache-admin-html';
