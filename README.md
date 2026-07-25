# @spidey52/drizzle-redis-cache

Redis-backed [Drizzle ORM](https://orm.drizzle.team/) query cache with optional hourly hit/miss stats and an admin HTTP API.

The **admin UI is hosted separately** (`ui/app.js`). Update that file and consumers get the new UI without bumping this package.

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

const redis = createRedisClient();
const queryCache = new DrizzleRedisCache(redis, {
  strategy: 'all',
  stats: new RedisHourlyStatsPlugin(redis),
});

const db = drizzle(pool, { schema, cache: queryCache });

// Serves API + a thin HTML stub that loads the remote UI script
const admin = createCacheAdminHandler(queryCache, {
  basePath: '/admin/cache',
  // readOnly: true, // block enable/TTL/flush/credentials
  // uiBaseUrl: 'https://cdn.jsdelivr.net/gh/spidey52/drizzle-redis-cache@main/ui',
});
```

Default admin credentials (seeded into Redis once): `admin` / `admin`.

## Admin features

- Hourly chart ranges: **6h / 24h / 7d**, CSV export, keyboard **R** refresh
- Flush all or per-table (confirm modal)
- Redis health, query key counts, approx memory sample
- Per-table hit/miss for the **same hour window** as the chart (stored as fields on each hourly hash)
- `readOnly: true` for view-only deployments
- Toasts instead of alerts

## Admin UI

UI lives in `ui/` and is loaded remotely (no package bump for UI-only changes).

Default base: `https://cdn.jsdelivr.net/gh/spidey52/drizzle-redis-cache@main/ui`


## License

MIT
