# @spidey52/drizzle-redis-cache

Redis-backed [Drizzle ORM](https://orm.drizzle.team/) query cache with optional hourly hit/miss stats and a small admin HTTP UI.

## Install

```bash
npm install @spidey52/drizzle-redis-cache ioredis drizzle-orm
```

## Usage

```ts
import {
  createRedisClient,
  DrizzleRedisCache,
  RedisHourlyStatsPlugin,
  createCacheAdminHandler,
} from '@spidey52/drizzle-redis-cache';
import { drizzle } from 'drizzle-orm/node-postgres';

const redis = createRedisClient(); // REDIS_URL / REDIS_HOST / …
const queryCache = new DrizzleRedisCache(redis, {
  strategy: 'all', // or 'explicit'
  stats: new RedisHourlyStatsPlugin(redis),
});

const db = drizzle(pool, { schema, cache: queryCache });

// Admin UI (Fetch / Hono / Bun)
const admin = createCacheAdminHandler(queryCache, { basePath: '/admin/cache' });
```

Default admin credentials (seeded into Redis once): `admin` / `admin`. Change them from the UI.

## License

MIT
