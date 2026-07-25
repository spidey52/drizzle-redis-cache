import {
  CACHE_ADMIN_DEFAULT_PASSWORD,
  CACHE_ADMIN_DEFAULT_USERNAME,
  CACHE_TTL_DEFAULT_SECONDS,
  CACHE_TTL_MAX_SECONDS,
  CACHE_TTL_MIN_SECONDS,
} from './drizzle-redis-cache';

/** Hosted UI folder (CSS + ES modules). Push `ui/` to GitHub to update without npm bump. */
export const DEFAULT_CACHE_ADMIN_UI_BASE_URL =
  'https://cdn.jsdelivr.net/gh/spidey52/drizzle-redis-cache@main/ui';

/** @deprecated Prefer {@link DEFAULT_CACHE_ADMIN_UI_BASE_URL}. */
export const DEFAULT_CACHE_ADMIN_UI_SCRIPT_URL = `${DEFAULT_CACHE_ADMIN_UI_BASE_URL}/app.js`;

export type CacheAdminHtmlOptions = {
  /** Absolute or relative API base (no trailing slash), e.g. `/admin/cache`. */
  apiBase?: string;
  /** Base URL of the hosted `ui/` folder (no trailing slash). */
  uiBaseUrl?: string;
  /** @deprecated Use `uiBaseUrl`. Full URL to `app.js` — base is derived by stripping `/app.js`. */
  uiScriptUrl?: string;
  /** When true, UI hides mutation controls. */
  readOnly?: boolean;
};

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeJsString(value: string): string {
  return JSON.stringify(value);
}

function resolveUiBaseUrl(options: CacheAdminHtmlOptions): string {
  if (options.uiBaseUrl) return options.uiBaseUrl.replace(/\/$/, '');
  if (options.uiScriptUrl) {
    return options.uiScriptUrl.replace(/\/app\.js$/i, '').replace(/\/$/, '');
  }
  return DEFAULT_CACHE_ADMIN_UI_BASE_URL;
}

/** Thin HTML stub that loads remote CSS + ES module UI. */
export function renderCacheAdminHtml(options: CacheAdminHtmlOptions = {}): string {
  const apiBase = options.apiBase ?? '';
  const uiBase = resolveUiBaseUrl(options);
  const cssUrl = `${uiBase}/app.css`;
  const jsUrl = `${uiBase}/app.js`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Drizzle Cache Admin</title>
  <link rel="stylesheet" href="${escapeHtmlAttr(cssUrl)}" />
  <style>
    .boot-loader{position:fixed;inset:0;display:grid;place-items:center;background:#0b1017;color:#8b9bb4;font-family:system-ui,sans-serif}
    .boot-loader.hidden{display:none}
    .boot-spinner{width:36px;height:36px;border-radius:50%;border:3px solid rgba(232,238,247,.15);border-top-color:#4d9fff;animation:boot-spin .7s linear infinite;margin:0 auto 12px}
    @keyframes boot-spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div id="drizzle-cache-admin-root">
    <div class="boot-loader" id="bootLoader">
      <div>
        <div class="boot-spinner" aria-hidden="true"></div>
        <div style="text-align:center">Loading cache admin…</div>
      </div>
    </div>
  </div>
  <script>
    window.__DRIZZLE_CACHE_ADMIN__ = {
      apiBase: ${escapeJsString(apiBase)},
      readOnly: ${options.readOnly === true ? 'true' : 'false'},
      defaults: {
        username: ${escapeJsString(CACHE_ADMIN_DEFAULT_USERNAME)},
        password: ${escapeJsString(CACHE_ADMIN_DEFAULT_PASSWORD)},
        ttlMinSeconds: ${CACHE_TTL_MIN_SECONDS},
        ttlMaxSeconds: ${CACHE_TTL_MAX_SECONDS},
        ttlDefaultSeconds: ${CACHE_TTL_DEFAULT_SECONDS},
      },
    };
  </script>
  <script type="module" src="${escapeHtmlAttr(jsUrl)}"></script>
</body>
</html>`;
}

/** @deprecated Use {@link renderCacheAdminHtml}. */
export const CACHE_ADMIN_HTML = renderCacheAdminHtml();
