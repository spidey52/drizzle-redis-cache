import type { IncomingMessage, ServerResponse } from 'node:http';
import { CACHE_ADMIN_HTML } from './cache-admin-html';
import type { DrizzleRedisCache } from './drizzle-redis-cache';

export type CacheAdminFetchHandler = (req: Request) => Promise<Response>;
export type CacheAdminHandlerOptions = { basePath?: string };



function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function stripBasePath(pathname: string, basePath?: string): string {
  let path = pathname;
  if (basePath) {
    const base = basePath.replace(/\/$/, '');
    if (path === base || path.startsWith(`${base}/`)) {
      path = path.slice(base.length) || '/';
    }
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path || '/';
}

function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

async function requireAdmin(cache: DrizzleRedisCache, req: Request): Promise<Response | null> {
  const creds = parseBasicAuth(req.headers.get('authorization'));
  if (!creds) {
    return json({ error: 'Missing Basic auth' }, 401, {
      'WWW-Authenticate': 'Basic realm="Drizzle Cache Admin"',
    });
  }
  if (!(await cache.verifyAdminCredentials(creds.username, creds.password))) {
    return json({ error: 'Invalid username or password' }, 401, {
      'WWW-Authenticate': 'Basic realm="Drizzle Cache Admin"',
    });
  }
  return null;
}

async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Fetch handler for Bun / Hono (`c.req.raw`) / any Fetch runtime. */
export function createCacheAdminHandler(
  cache: DrizzleRedisCache,
  options: CacheAdminHandlerOptions = {},
): CacheAdminFetchHandler {
  return async (req) => {
    const path = stripBasePath(new URL(req.url).pathname, options.basePath);
    const method = req.method.toUpperCase();

    try {
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        await cache.ensureAdminCredentials();
        return new Response(CACHE_ADMIN_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (!path.startsWith('/api')) return json({ error: 'Not found' }, 404);

      const authError = await requireAdmin(cache, req);
      if (authError) return authError;

      if (method === 'GET' && path === '/api') {
        const [enabled, ttlSeconds, stats] = await Promise.all([
          cache.isCacheEnabled(),
          cache.getDefaultTtlSeconds(),
          cache.getHourlyStats(24),
        ]);
        return json({ enabled, ttlSeconds, stats });
      }

      if (method === 'POST' && path === '/api/enabled') {
        const body = await readBody<{ enabled?: boolean }>(req);
        if (typeof body?.enabled !== 'boolean') {
          return json({ error: 'Body must include boolean `enabled`' }, 400);
        }
        await cache.setEnabled(body.enabled);
        return json({ enabled: body.enabled });
      }

      if (method === 'POST' && path === '/api/ttl') {
        const body = await readBody<{ seconds?: number }>(req);
        if (typeof body?.seconds !== 'number' || !Number.isFinite(body.seconds)) {
          return json({ error: 'Body must include numeric `seconds`' }, 400);
        }
        return json({ ttlSeconds: await cache.setDefaultTtlSeconds(body.seconds) });
      }

      if (method === 'POST' && path === '/api/credentials') {
        const body = await readBody<{ username?: string; password?: string }>(req);
        if (!body?.username || !body?.password) {
          return json({ error: 'Body must include username and password' }, 400);
        }
        await cache.setAdminCredentials(body.username, body.password);
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
    }
  };
}

function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Node `http` / Express adapter around the Fetch handler. */
export function createCacheAdminNodeHandler(
  cache: DrizzleRedisCache,
  options: CacheAdminHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handle = createCacheAdminHandler(cache, options);

  return async (req, res) => {
    const host = req.headers.host ?? 'localhost';
    const protoHeader = req.headers['x-forwarded-proto'];
    const protocol =
      (typeof protoHeader === 'string' ? protoHeader.split(',')[0]?.trim() : undefined) || 'http';

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
      else headers.set(k, v);
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(req);

    const response = await handle(
      new Request(new URL(req.url ?? '/', `${protocol}://${host}`), {
        method,
        headers,
        body: rawBody && rawBody.length > 0 ? new Uint8Array(rawBody) : undefined,
      }),
    );

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
