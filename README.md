# @spidey52/drizzle-redis-cache

Redis-backed [Drizzle ORM](https://orm.drizzle.team/) query cache with table-version invalidation, a
per-instance skip list and TTL per table, fail-open behaviour, hourly hit/miss stats, and an admin API + UI.

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

const redis = createRedisClient(); // REDIS_URL or REDIS_HOST/PORT/PASSWORD/DB
const queryCache = new DrizzleRedisCache(redis, {
  strategy: 'all',                          // or 'explicit': only selects with .$withCache()
  defaultTtlSeconds: 300,
  skipTables: ['order.sell_orders', 'order.order_voucher'], // hot tables: never cached here
  ttlByTable: { 'master.category': 3600 },  // a query takes the smallest TTL of its tables
  adminCredentials: { username: process.env.CACHE_ADMIN_USER!, password: process.env.CACHE_ADMIN_PASS! },
  stats: new RedisHourlyStatsPlugin(redis),
  onError: (err, op) => logger.warn({ err, op }, 'query cache bypassed'),
});

const db = drizzle(pool, { schema, cache: queryCache });

// Admin API + HTML stub that loads the hosted UI (Bun / Hono: `c.req.raw`)
const admin = createCacheAdminHandler(queryCache, {
  basePath: '/admin/cache',
  // readOnly: true,                       // block enable/TTL/flush/credentials
  // cors: ['https://ui.example.com'],     // a separately hosted ui/index.html?api=...
});
```

## How invalidation works

Every table has a version counter in Redis, `ns:ver:<schema.table>`. A write to a table is one `INCR`.
A cached result carries the versions of the tables it was read under; a read whose versions differ is a
miss. Nothing is deleted on write, stale entries expire on their TTL.

- **Shared namespace, shared invalidation.** Instances that use the same `namespace` share the counters,
  so a write in one service invalidates the others. Behaviour (`strategy`, `skipTables`, `ttlByTable`) is
  per instance and comes from its options.
- **Skip list bypasses the cache, never the invalidation.** A query touching a skipped table is not
  looked up or stored by this instance, but a write to that table still bumps its version for everyone.
- **Race safe.** `get` remembers the versions it read; the matching `put` stores under those versions,
  so a read that overlapped a write lands under the old version and is never served.
- **Tags.** `$withCache({ tag })` entries are keyed by the tag and deleted by `db.$cache.invalidate({ tags })`.
  With `autoInvalidate: false` they have no table versions and live for their TTL.
- **Views** (Drizzle reports no tables) with `autoInvalidate` are never cached: nothing could invalidate them.

## Fail-open

Every Redis error in `get`, `put` and `onMutate` is swallowed, reported through `onError`, and treated as
a miss. `createRedisClient` disables ioredis's offline queue and sets a 250 ms command timeout, so a
Redis outage costs misses, not stalled queries. The cache can slow a query down; it cannot fail one.

By default the Redis write on a miss runs in the background (`awaitPut: false`), so a miss costs the
query alone.

## Options

| Option | Default | |
| --- | --- | --- |
| `namespace` | `drizzle` | Redis key prefix. Instances sharing it invalidate each other. |
| `strategy` | `all` | `all` caches every select; `explicit` only `.$withCache()`. |
| `defaultTtlSeconds` | `300` | Clamped 1 s – 1 h. Changeable at runtime from the admin API (shared). |
| `skipTables` | `[]` | `schema.table` strings or Table objects never cached by this instance. |
| `ttlByTable` | `{}` | TTL per table; a multi-table query takes the smallest. |
| `awaitPut` | `false` | Await the Redis write on a miss. |
| `compatV1` | `false` | Also maintain v1 `table:*` index sets and delete their members on writes, for a mixed v1/v2 rollout. |
| `adminCredentials` | none | Used when Redis holds none; stored on first use. Nothing is ever seeded by default. |
| `onError` | noop | `(err, 'get' \| 'put' \| 'onMutate' \| 'meta')`. |
| `stats` | none | `RedisHourlyStatsPlugin` or any `CacheStatsCollector`. |
| `metaRefreshIntervalMs` | `60000` | How often the shared enabled flag and TTL are re-read (in the background). |

Table names are what Drizzle reports: `schema.table`, or the bare name for `public`.

## Admin API

All endpoints under `basePath`, Basic auth, except `GET /api/status`.

| | |
| --- | --- |
| `GET /` | HTML stub loading the hosted UI |
| `GET /api/status` | `{ configured, readOnly }`, no auth |
| `GET /api?hours=24` | stats, health, key counts, table versions, instance config |
| `GET /api/health`, `GET /api/config` | |
| `POST /api/enabled` `{enabled}` | shared on/off switch |
| `POST /api/ttl` `{seconds}` | shared default TTL |
| `POST /api/credentials` `{username,password}` | |
| `POST /api/flush` `{tables?}` | with tables: bump their versions; without: delete every query and version key |
| `POST /api/latency-test` `{samples?}` | |

Without credentials anywhere the authenticated endpoints answer **503** and the UI says so.

## Admin UI

Plain ES modules in `ui/`, no build step. The HTML stub loads them from jsDelivr pinned to this
package version's git tag (`CACHE_ADMIN_UI_VERSION_TAG`), so a later push to `main` cannot change what
a deployed page runs. **Tag each release** (`git tag v2.0.0 && git push --tags`) or pass `uiBaseUrl`.

- **Overview**: hit rate and volume chart with legend and tooltip, tiles with deltas since the last
  refresh, stepped-aside and Redis-failure counts, key counts, busiest tables and most misses with sparklines.
- **Tables**: grouped by schema, sortable (traffic, misses, lowest hit rate, most written, name), filter,
  per-table hourly sparkline, version, skipped and TTL badges, per-table or per-schema flush, CSV export.
  Click a row for a drawer with the table's hourly chart, peak hour and its caching rules.
- **Settings**: default TTL, credentials, flush all, Redis latency test with a histogram, the instance's
  fixed config (skipped tables and TTLs link to their drawers), copy config as JSON.
- Light and dark themes, auto-refresh every 30 s, keyboard shortcuts (`1` `2` `3` views, `R` refresh,
  `/` filter, `Esc`, `?`), and the view, window, filter, sort and open table live in the URL hash.

Local preview without Redis: `bun scripts/dev-ui.ts`, then <http://localhost:4499/admin/cache> (admin / admin).

## Upgrading from 1.x

- Cached values have a new format; old entries are treated as misses and overwritten. Flushing on deploy
  is fine but not required.
- During a rollout where v1 and v2 instances share a namespace, run v2 with `compatV1: true`; otherwise
  v1 entries are not invalidated by v2 writes (and vice versa) until their TTL. Switch it off afterwards.
- Admin credentials are no longer seeded (`admin` / `admin`). Existing installs keep the credentials
  already in Redis; new ones need `adminCredentials`.
- `flushCache(tables)` now bumps versions and reports `bumpedTables`; `getTableIndexStats()` reports
  versions. The `tableIndexes` API field is kept with `queryKeys: 0`.
- `cors: true` still reflects any origin; prefer an origin list.

## Development

```bash
npm run typecheck
bun test
npm run build
```

## License

MIT
