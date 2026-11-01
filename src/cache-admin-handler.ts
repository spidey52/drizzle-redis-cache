import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_CACHE_ADMIN_UI_BASE_URL,
  renderCacheAdminHtml,
} from './cache-admin-html';
import type { DrizzleRedisCache } from './drizzle-redis-cache';

export type CacheAdminFetchHandler = (req: Request) => Promise<Response>;

export type CacheAdminHandlerOptions = {
  basePath?: string;
  /** Hosted `ui/` folder URL (no trailing slash). Defaults to the jsDelivr folder of this version. */
  uiBaseUrl?: string;
  /** @deprecated Use `uiBaseUrl`. */
  uiScriptUrl?: string;
  /**
   * Allow a separately hosted UI (`ui/index.html?api=...`) to call the API from another origin.
   * `true` reflects any origin; a list allows only those origins.
   */
  cors?: boolean | string[];
  /** When true, mutation endpoints (enable/TTL/credentials/flush) return 403. */
  readOnly?: boolean;
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

type CorsPolicy = { allow: (origin: string | null) => string | null };

function corsPolicy(option: boolean | string[] | undefined): CorsPolicy | null {
  if (!option) return null;
  if (option === true) return { allow: (origin) => origin || '*' };
  const allowed = new Set(option.map((o) => o.replace(/\/$/, '')));
  return { allow: (origin) => (origin && allowed.has(origin.replace(/\/$/, '')) ? origin : null) };
}

function corsHeaders(req: Request, policy: CorsPolicy | null): HeadersInit {
  if (!policy) return {};
  const origin = policy.allow(req.headers.get('origin'));
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
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

/**
 * 503 when no credentials exist anywhere (nothing is seeded), 401 when the request has none or
 * wrong ones, null when the caller may proceed.
 */
async function requireAdmin(cache: DrizzleRedisCache, req: Request): Promise<Response | null> {
  if ((await cache.getAdminCredentials()) == null) {
    return json(
      {
        error:
          'Admin credentials are not configured. Pass `adminCredentials` to DrizzleRedisCache or set them with setAdminCredentials().',
      },
      503,
    );
  }
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

function withCors(response: Response, req: Request, policy: CorsPolicy | null): Response {
  const extra = corsHeaders(req, policy);
  if (Object.keys(extra).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseHours(raw: string | null): number {
  const n = Number(raw ?? 24);
  if (!Number.isFinite(n)) return 24;
  return Math.max(1, Math.min(Math.floor(n), 24 * 31));
}

/** Fetch handler for Bun / Hono (`c.req.raw`) / any Fetch runtime. */
export function createCacheAdminHandler(
  cache: DrizzleRedisCache,
  options: CacheAdminHandlerOptions = {},
): CacheAdminFetchHandler {
  const cors = corsPolicy(options.cors);
  const readOnly = options.readOnly === true;

  return async (req) => {
    const url = new URL(req.url);
    const path = stripBasePath(url.pathname, options.basePath);
    const method = req.method.toUpperCase();

    try {
      if (method === 'OPTIONS' && cors) {
        return new Response(null, { status: 204, headers: corsHeaders(req, cors) });
      }

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        const apiBase =
          (options.basePath ? options.basePath.replace(/\/$/, '') : '') ||
          url.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
        const html = renderCacheAdminHtml({
          apiBase,
          uiBaseUrl: options.uiBaseUrl ?? DEFAULT_CACHE_ADMIN_UI_BASE_URL,
          uiScriptUrl: options.uiScriptUrl,
          readOnly,
        });
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (!path.startsWith('/api')) {
        return withCors(json({ error: 'Not found' }, 404), req, cors);
      }

      // the only unauthenticated endpoint: lets the UI tell "no credentials configured" from "sign in"
      if (method === 'GET' && path === '/api/status') {
        return withCors(
          json({ configured: (await cache.getAdminCredentials()) != null, readOnly }),
          req,
          cors,
        );
      }

      const authError = await requireAdmin(cache, req);
      if (authError) return withCors(authError, req, cors);

      if (method === 'GET' && path === '/api') {
        const hours = parseHours(url.searchParams.get('hours'));
        const [enabled, ttlSeconds, window, health, keyStats, tableVersions] = await Promise.all([
          cache.isCacheEnabled(),
          cache.getDefaultTtlSeconds(),
          cache.getWindowStats(hours),
          cache.getHealth(),
          cache.getKeyStats(),
          cache.getTableVersions(),
        ]);
        return withCors(
          json({
            enabled,
            ttlSeconds,
            hours,
            stats: window.stats,
            health,
            keyStats,
            config: cache.getConfig(),
            tableVersions,
            /** @deprecated v1 field; v2 has no per-table key index */
            tableIndexes: tableVersions.map((v) => ({ ...v, queryKeys: 0 })),
            tableStats: window.tableStats,
            tableHourly: window.tableHourly ?? {},
            readOnly,
          }),
          req,
          cors,
        );
      }

      if (method === 'GET' && path === '/api/health') {
        return withCors(json({ ...(await cache.getHealth()), readOnly }), req, cors);
      }

      if (method === 'GET' && path === '/api/config') {
        return withCors(json({ ...cache.getConfig(), readOnly }), req, cors);
      }

      if (method === 'POST' && path === '/api/latency-test') {
        const body = await readBody<{ samples?: number }>(req);
        const samples =
          typeof body?.samples === 'number' && Number.isFinite(body.samples)
            ? body.samples
            : 20;
        return withCors(json(await cache.measureLatency(samples)), req, cors);
      }

      if (method === 'POST' && path === '/api/enabled') {
        if (readOnly) return withCors(json({ error: 'Admin is read-only' }, 403), req, cors);
        const body = await readBody<{ enabled?: boolean }>(req);
        if (typeof body?.enabled !== 'boolean') {
          return withCors(json({ error: 'Body must include boolean `enabled`' }, 400), req, cors);
        }
        await cache.setEnabled(body.enabled);
        return withCors(json({ enabled: body.enabled }), req, cors);
      }

      if (method === 'POST' && path === '/api/ttl') {
        if (readOnly) return withCors(json({ error: 'Admin is read-only' }, 403), req, cors);
        const body = await readBody<{ seconds?: number }>(req);
        if (typeof body?.seconds !== 'number' || !Number.isFinite(body.seconds)) {
          return withCors(json({ error: 'Body must include numeric `seconds`' }, 400), req, cors);
        }
        return withCors(
          json({ ttlSeconds: await cache.setDefaultTtlSeconds(body.seconds) }),
          req,
          cors,
        );
      }

      if (method === 'POST' && path === '/api/credentials') {
        if (readOnly) return withCors(json({ error: 'Admin is read-only' }, 403), req, cors);
        const body = await readBody<{ username?: string; password?: string }>(req);
        if (!body?.username || !body?.password) {
          return withCors(
            json({ error: 'Body must include username and password' }, 400),
            req,
            cors,
          );
        }
        await cache.setAdminCredentials(body.username, body.password);
        return withCors(json({ ok: true }), req, cors);
      }

      if (method === 'POST' && path === '/api/flush') {
        if (readOnly) return withCors(json({ error: 'Admin is read-only' }, 403), req, cors);
        const body = await readBody<{ tables?: string[] }>(req);
        const tables = Array.isArray(body?.tables)
          ? body.tables.filter((t): t is string => typeof t === 'string' && t.length > 0)
          : undefined;
        const result = await cache.flushCache(tables?.length ? tables : undefined);
        return withCors(json({ ok: true, ...result }), req, cors);
      }

      return withCors(json({ error: 'Not found' }, 404), req, cors);
    } catch (err) {
      return withCors(
        json({ error: err instanceof Error ? err.message : 'Internal error' }, 500),
        req,
        cors,
      );
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
