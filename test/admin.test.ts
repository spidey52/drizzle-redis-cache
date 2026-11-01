import { describe, expect, it } from 'bun:test';
import type { Redis } from 'ioredis';
import { createCacheAdminHandler } from '../src/cache-admin-handler';
import { DrizzleRedisCache } from '../src/drizzle-redis-cache';
import { FakeRedis } from './fake-redis';

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const base = 'http://x/admin/cache';

describe('admin handler', () => {
  it('answers 503 when no credentials exist anywhere, and says so on /api/status without auth', async () => {
    const cache = new DrizzleRedisCache(new FakeRedis() as unknown as Redis);
    const handle = createCacheAdminHandler(cache, { basePath: '/admin/cache' });
    const res = await handle(new Request(`${base}/api`));
    expect(res.status).toBe(503);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const status = await handle(new Request(`${base}/api/status`));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false, readOnly: false });
  });

  it('401 without or with wrong credentials, 200 with the configured ones', async () => {
    const cache = new DrizzleRedisCache(new FakeRedis() as unknown as Redis, {
      adminCredentials: { username: 'ops', password: 'pw' },
      skipTables: ['order.sell_orders'],
    });
    const handle = createCacheAdminHandler(cache, { basePath: '/admin/cache' });

    expect((await handle(new Request(`${base}/api`))).status).toBe(401);
    expect(
      (await handle(new Request(`${base}/api`, { headers: { authorization: basic('ops', 'x') } }))).status,
    ).toBe(401);

    const ok = await handle(new Request(`${base}/api`, { headers: { authorization: basic('ops', 'pw') } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, any>;
    expect(body.config.skipTables).toEqual(['order.sell_orders']);
    expect(Array.isArray(body.tableVersions)).toBe(true);
    expect(body.health.strategy).toBe('all');
  });

  it('serves the HTML stub without credentials and without default ones in it', async () => {
    const cache = new DrizzleRedisCache(new FakeRedis() as unknown as Redis);
    const handle = createCacheAdminHandler(cache, { basePath: '/admin/cache' });
    const res = await handle(new Request(`${base}/`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('"admin"');
    expect(html).toContain('@v2.0.0/ui/app.js');
  });

  it('CORS: a list allows only those origins; true reflects any', async () => {
    const cache = new DrizzleRedisCache(new FakeRedis() as unknown as Redis, {
      adminCredentials: { username: 'ops', password: 'pw' },
    });
    const listed = createCacheAdminHandler(cache, { basePath: '/admin/cache', cors: ['https://ui.example'] });
    const yes = await listed(new Request(`${base}/api/health`, { headers: { origin: 'https://ui.example', authorization: basic('ops', 'pw') } }));
    expect(yes.headers.get('access-control-allow-origin')).toBe('https://ui.example');
    const no = await listed(new Request(`${base}/api/health`, { headers: { origin: 'https://evil.example', authorization: basic('ops', 'pw') } }));
    expect(no.headers.get('access-control-allow-origin')).toBeNull();

    const any = createCacheAdminHandler(cache, { basePath: '/admin/cache', cors: true });
    const pre = await any(new Request(`${base}/api`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://evil.example');
  });

  it('read-only blocks mutations', async () => {
    const cache = new DrizzleRedisCache(new FakeRedis() as unknown as Redis, {
      adminCredentials: { username: 'ops', password: 'pw' },
    });
    const handle = createCacheAdminHandler(cache, { basePath: '/admin/cache', readOnly: true });
    const res = await handle(
      new Request(`${base}/api/flush`, { method: 'POST', headers: { authorization: basic('ops', 'pw') }, body: '{}' }),
    );
    expect(res.status).toBe(403);
  });
});
