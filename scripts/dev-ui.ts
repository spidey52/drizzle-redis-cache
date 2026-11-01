/**
 * Local admin UI preview with no Redis: the in-memory double from the tests, seeded with a day of
 * traffic across a few schemas. `bun scripts/dev-ui.ts` then open http://localhost:4499/admin/cache
 * (admin / admin).
 */
import type { Redis } from 'ioredis';
import { createCacheAdminHandler } from '../src/cache-admin-handler';
import { RedisHourlyStatsPlugin } from '../src/cache-stats-plugin';
import { DrizzleRedisCache } from '../src/drizzle-redis-cache';
import { FakeRedis } from '../test/fake-redis';

const PORT = Number(process.env.PORT || 4499);
const redis = new FakeRedis();
const stats = new RedisHourlyStatsPlugin(redis as unknown as Redis, { flushIntervalMs: 1000 });
const cache = new DrizzleRedisCache(redis as unknown as Redis, {
  adminCredentials: { username: 'admin', password: 'admin' },
  skipTables: ['order.sell_orders', 'order.order_voucher', 'order.order_access'],
  ttlByTable: { 'master.category': 3600, 'master.product': 3600, 'notice.notices': 1800 },
  stats,
  awaitPut: true,
});

// a day of hourly buckets, local time like the plugin
const tables = [
  ['master.company', 0.82, 900],
  ['master.partners', 0.78, 700],
  ['master.category', 0.97, 1200],
  ['master.product', 0.95, 800],
  ['order.sell_orders', 0.08, 2600],
  ['order.order_voucher', 0.05, 1900],
  ['order.order_access', 0.1, 1500],
  ['logistic.trips', 0.6, 300],
  ['logistic.vehicles', 0.7, 250],
  ['notice.notices', 0.99, 4000],
  ['auth.sessions', 0.4, 2200],
  ['public.kv', 0.5, 40],
] as const;
const now = new Date();
for (let h = 23; h >= 0; h--) {
  const d = new Date(now.getTime() - h * 3600_000);
  const key = `drizzle:stats:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}`;
  const load = 0.3 + 0.7 * Math.max(0, Math.sin(((d.getHours() - 6) / 14) * Math.PI));
  let hits = 0;
  let misses = 0;
  for (const [t, rate, perDay] of tables) {
    const n = Math.round((perDay / 24) * load * (0.8 + Math.random() * 0.4));
    const th = Math.round(n * rate);
    hits += th;
    misses += n - th;
    if (th) await redis.hincrby(key, `th:${t}`, th);
    if (n - th) await redis.hincrby(key, `tm:${t}`, n - th);
  }
  await redis.hincrby(key, 'hits', hits);
  await redis.hincrby(key, 'misses', misses);
  await redis.hincrby(key, 'skipped', Math.round(misses * 0.6));
  if (h === 5) await redis.hincrby(key, 'bypassed', 37);
}
for (const [t, , perDay] of tables) {
  for (let i = 0; i < Math.round(perDay / 90); i++) await cache.onMutate({ tables: [t] });
}
for (let i = 0; i < 120; i++) {
  const t = tables[i % tables.length][0];
  await cache.get(`q${i}`, [t], false, true);
  await cache.put(`q${i}`, [{ i }], [t], false);
}

const admin = createCacheAdminHandler(cache, {
  basePath: '/admin/cache',
  uiBaseUrl: `http://localhost:${PORT}/ui`,
});

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/ui/')) {
      const file = Bun.file(new URL(`../ui/${url.pathname.slice(4)}`, import.meta.url));
      return (await file.exists())
        ? new Response(file, { headers: { 'cache-control': 'no-store' } })
        : new Response('not found', { status: 404 });
    }
    if (url.pathname.startsWith('/admin/cache')) return admin(req);
    return Response.redirect('/admin/cache', 302);
  },
});
console.log(`admin UI preview: http://localhost:${PORT}/admin/cache  (admin / admin)`);
