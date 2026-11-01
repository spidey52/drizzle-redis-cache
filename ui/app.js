// Drizzle Cache Admin — plain ES modules, no build step.
// Served from the package's git tag by jsDelivr, or standalone with ?api=<admin base>.
import { clearAuth, createApi, hasStoredAuth, setAuth } from './api.js';
import { createChart } from './chart.js';
import { toast } from './toast.js';

const cfg = window.__DRIZZLE_CACHE_ADMIN__ || {};
const params = new URLSearchParams(location.search);
const apiBase = String(
  cfg.apiBase || params.get('api') || location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, ''),
).replace(/\/$/, '');
const defaults = cfg.defaults || {};
const ttlMin = defaults.ttlMinSeconds ?? 1;
const ttlMax = defaults.ttlMaxSeconds ?? 3600;
const AUTO_REFRESH_MS = 30_000;
const VIEWS = ['overview', 'tables', 'settings'];
const SORTS = {
  traffic: ['Traffic', (a, b) => b.total - a.total],
  misses: ['Misses', (a, b) => b.misses - a.misses],
  hitrate: ['Lowest hit rate', (a, b) => (a.total ? a.hitRate : 2) - (b.total ? b.hitRate : 2)],
  version: ['Most written', (a, b) => b.version - a.version],
  name: ['Name', (a, b) => a.name.localeCompare(b.name)],
};

const store = {
  get: (k, fallback) => {
    try {
      const v = localStorage.getItem('dcache:' + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem('dcache:' + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

const state = {
  readOnly: cfg.readOnly === true,
  view: 'overview',
  hours: 24,
  sort: 'traffic',
  filter: '',
  table: null, // open drawer
  data: null,
  prev: null, // previous window sums, for deltas
  loadedAt: null,
  collapsed: new Set(store.get('collapsed', [])),
  timer: null,
  tick: null,
  busy: false,
};

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const root = document.getElementById('drizzle-cache-admin-root') || document.body;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => Number(n || 0).toLocaleString();
const pct = (r) => ((r || 0) * 100).toFixed(1) + '%';
const signed = (n) => (n > 0 ? '+' + num(n) : n < 0 ? '−' + num(-n) : '±0');
const bytes = (n) => {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const ago = (ms) => (ms == null ? '—' : ms < 1500 ? 'just now' : ms < 90_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);
const windowLabel = () => (state.hours === 168 ? '7 days' : `${state.hours} hours`);

/** stacked hits/misses bars as an inline SVG; long windows are bucketed down to ~48 bars */
function spark(series, { width = 96, height = 20 } = {}) {
  if (!series?.length) return `<svg class="spark" width="${width}" height="${height}"></svg>`;
  const buckets = Math.min(series.length, 48);
  const per = series.length / buckets;
  const bars = [];
  for (let b = 0; b < buckets; b++) {
    let h = 0;
    let m = 0;
    for (let i = Math.floor(b * per); i < Math.floor((b + 1) * per); i++) {
      h += series[i]?.[0] || 0;
      m += series[i]?.[1] || 0;
    }
    bars.push([h, m]);
  }
  const max = Math.max(1, ...bars.map(([h, m]) => h + m));
  const bw = width / buckets;
  const rects = bars
    .map(([h, m], i) => {
      const total = h + m;
      if (!total) return '';
      const th = (total / max) * height;
      const hh = (h / total) * th;
      const x = (i * bw).toFixed(1);
      const w = Math.max(1, bw - 1).toFixed(1);
      return `<rect class="m" x="${x}" y="${(height - th).toFixed(1)}" width="${w}" height="${(th - hh).toFixed(1)}"/><rect class="h" x="${x}" y="${(height - hh).toFixed(1)}" width="${w}" height="${hh.toFixed(1)}"/>`;
    })
    .join('');
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects}</svg>`;
}

const bar = (rate) => `<span class="bar"><span style="width:${Math.round((rate || 0) * 100)}%"></span></span><em>${pct(rate)}</em>`;
const badges = (t) => `${t.skipped ? ' <i class="tag">skipped</i>' : ''}${t.ttl != null ? ` <i class="tag ttl">ttl ${t.ttl}s</i>` : ''}`;

// ---------------------------------------------------------------------------------------------
// URL state: #view?h=24&q=...&sort=...&t=schema.table
// ---------------------------------------------------------------------------------------------

function readHash() {
  const [view, qs] = location.hash.replace(/^#/, '').split('?');
  const p = new URLSearchParams(qs || '');
  if (VIEWS.includes(view)) state.view = view;
  const h = Number(p.get('h'));
  state.hours = [6, 24, 168].includes(h) ? h : 24;
  state.filter = p.get('q') || '';
  state.sort = p.get('sort') in SORTS ? p.get('sort') : 'traffic';
  state.table = p.get('t') || null;
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.hours !== 24) p.set('h', String(state.hours));
  if (state.filter) p.set('q', state.filter);
  if (state.sort !== 'traffic') p.set('sort', state.sort);
  if (state.table) p.set('t', state.table);
  const qs = p.toString();
  const next = `#${state.view}${qs ? '?' + qs : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
  const btn = $('themeBtn');
  if (btn) btn.textContent = theme === 'light' ? '☾' : '☀';
}
const initialTheme = store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = initialTheme;

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

root.innerHTML = `
  <div id="login" class="gate hidden">
    <form class="card login" id="loginForm" autocomplete="on">
      <div class="brand"><span class="logo"></span><div><h1>Drizzle Cache</h1><p>Admin</p></div></div>
      <label>Username <input name="username" required autocomplete="username" /></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password" /></label>
      <p class="err hidden" id="loginError"></p>
      <button class="primary" type="submit">Sign in</button>
      <p class="muted small">Credentials are set by the service (<code>adminCredentials</code>) and can be changed in Settings.</p>
    </form>
  </div>

  <div id="app" class="hidden">
    <header class="top">
      <div class="brand"><span class="logo"></span><div><h1>Drizzle Cache</h1><p id="nsLine">—</p></div></div>
      <nav class="tabs" id="tabs">
        <button data-view="overview">Overview <kbd>1</kbd></button>
        <button data-view="tables">Tables <kbd>2</kbd></button>
        <button data-view="settings">Settings <kbd>3</kbd></button>
      </nav>
      <div class="actions">
        <span class="updated muted small" id="updated"></span>
        <div class="seg" id="range"><button data-h="6">6h</button><button data-h="24">24h</button><button data-h="168">7d</button></div>
        <label class="switch" title="Cache enabled (shared by every instance on this namespace)">
          <input type="checkbox" id="enabledToggle" /><span></span><em id="enabledLabel">Enabled</em>
        </label>
        <button id="refreshBtn" class="icon" title="Refresh (R)">↻</button>
        <button id="themeBtn" class="icon" title="Theme">☀</button>
        <button id="helpBtn" class="icon" title="Shortcuts (?)">?</button>
        <button id="signOut" class="ghost">Sign out</button>
      </div>
    </header>

    <div class="banners">
      <div class="banner warn hidden" id="readOnlyBanner">Read-only: settings and flush are disabled for this deployment.</div>
      <div class="banner bad hidden" id="disabledBanner">Cache is <b>disabled</b>: every query goes to the database. All instances on this namespace are affected.</div>
      <div class="banner bad hidden" id="redisBanner"></div>
    </div>

    <main id="main"><div class="skeleton"><div></div><div></div><div></div><div class="wide"></div></div></main>
    <div class="loader hidden" id="loader"><div class="spinner"></div></div>

    <aside class="drawer hidden" id="drawer"><div class="drawerInner" id="drawerInner"></div></aside>
    <div class="scrim hidden" id="scrim"></div>
  </div>

  <div class="modal hidden" id="modal">
    <div class="card dialog">
      <h2 id="modalTitle"></h2>
      <div id="modalBody" class="muted"></div>
      <div class="row end"><button class="ghost" id="modalCancel">Cancel</button><button class="danger" id="modalOk">Flush</button></div>
    </div>
  </div>
`;

const api = createApi(apiBase, { onUnauthorized: () => showLogin('Session expired, sign in again.') });

function showLogin(message) {
  clearInterval(state.timer);
  clearInterval(state.tick);
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  const err = $('loginError');
  err.textContent = message || '';
  err.classList.toggle('hidden', !message);
  $('bootLoader')?.classList.add('hidden');
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('bootLoader')?.classList.add('hidden');
  applyTheme(initialTheme);
  clearInterval(state.timer);
  clearInterval(state.tick);
  state.timer = setInterval(() => {
    if (state.view !== 'settings' && document.visibilityState === 'visible') void load({ silent: true });
  }, AUTO_REFRESH_MS);
  state.tick = setInterval(renderUpdated, 1000);
}

function renderUpdated() {
  const el = $('updated');
  if (!el || !state.loadedAt) return;
  el.textContent = `updated ${ago(Date.now() - state.loadedAt)} · auto ${AUTO_REFRESH_MS / 1000}s`;
}

function setBusy(on) {
  state.busy = on;
  $('loader').classList.toggle('hidden', !on);
  $('refreshBtn').classList.toggle('spin', on);
}

function dialog(title, bodyHtml, okLabel = 'Flush') {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalOk').textContent = okLabel;
    $('modalOk').classList.toggle('hidden', okLabel === null);
    $('modal').classList.remove('hidden');
    const done = (v) => {
      $('modal').classList.add('hidden');
      $('modalOk').onclick = $('modalCancel').onclick = null;
      resolve(v);
    };
    $('modalOk').onclick = () => done(true);
    $('modalCancel').onclick = () => done(false);
  });
}

async function flush(tables, what) {
  const ok = await dialog(
    `Flush ${what}?`,
    `<p>Bumps the version of ${tables.length === 1 ? 'the table' : `${tables.length} tables`}. Cached rows that read ${tables.length === 1 ? 'it' : 'them'} become unreadable at once and expire on their TTL.</p><p>Every instance on this namespace is affected.</p>`,
  );
  if (!ok) return false;
  try {
    await api('/api/flush', { method: 'POST', body: JSON.stringify({ tables }) });
    toast(`Flushed ${what}`, 'ok');
    await load({ silent: true });
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

function sumWindow(stats) {
  return (stats || []).reduce(
    (a, s) => ({ hits: a.hits + (s.hits || 0), misses: a.misses + (s.misses || 0), skipped: a.skipped + (s.skipped || 0), bypassed: a.bypassed + (s.bypassed || 0) }),
    { hits: 0, misses: 0, skipped: 0, bypassed: 0 },
  );
}

async function load({ silent = false } = {}) {
  if (!silent) setBusy(true);
  try {
    const data = await api(`/api?hours=${state.hours}`);
    state.prev = state.data && state.data.hours === data.hours ? sumWindow(state.data.stats) : null;
    state.data = data;
    state.loadedAt = Date.now();
    state.readOnly = data.readOnly === true || cfg.readOnly === true;
    render();
    renderUpdated();
  } catch (err) {
    if (!silent) toast(err.message || 'Failed to load', 'bad');
  } finally {
    if (!silent) setBusy(false);
  }
}

/** every table merged from stats, versions, hourly series and config */
function allTables(data) {
  const tables = new Map();
  const touch = (name) => {
    const [schema, table] = name.includes('.') ? name.split(/\.(.+)/) : ['public', name];
    if (!tables.has(name)) tables.set(name, { name, schema, table, hits: 0, misses: 0, version: 0, skipped: false, ttl: null, series: [] });
    return tables.get(name);
  };
  for (const s of data.tableStats || []) Object.assign(touch(s.table), { hits: s.hits || 0, misses: s.misses || 0 });
  for (const v of data.tableVersions || []) touch(v.table).version = v.version || 0;
  for (const t of data.config?.skipTables || []) touch(t).skipped = true;
  for (const [t, ttl] of Object.entries(data.config?.ttlByTable || {})) touch(t).ttl = ttl;
  for (const [t, series] of Object.entries(data.tableHourly || {})) touch(t).series = series;
  for (const t of tables.values()) {
    t.total = t.hits + t.misses;
    t.hitRate = t.total ? t.hits / t.total : 0;
  }
  return [...tables.values()];
}

function buildTree(list) {
  const schemas = new Map();
  for (const t of list) {
    const s = schemas.get(t.schema) || { schema: t.schema, tables: [], hits: 0, misses: 0, versions: 0 };
    s.tables.push(t);
    s.hits += t.hits;
    s.misses += t.misses;
    s.versions += t.version;
    schemas.set(t.schema, s);
  }
  const cmp = SORTS[state.sort][1];
  return [...schemas.values()]
    .map((s) => ({ ...s, total: s.hits + s.misses, hitRate: s.hits + s.misses ? s.hits / (s.hits + s.misses) : 0, tables: s.tables.sort(cmp) }))
    .sort((a, b) => b.total - a.total || a.schema.localeCompare(b.schema));
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

let chart = null;

function render() {
  const d = state.data;
  if (!d) return;
  writeHash();
  const health = d.health || {};
  $('nsLine').textContent = `${health.namespace || d.config?.namespace || '—'} · ${d.config?.strategy || health.strategy || '—'}`;
  $('enabledToggle').checked = d.enabled !== false;
  $('enabledToggle').disabled = state.readOnly;
  $('enabledLabel').textContent = d.enabled !== false ? 'Enabled' : 'Disabled';
  $('readOnlyBanner').classList.toggle('hidden', !state.readOnly);
  $('disabledBanner').classList.toggle('hidden', d.enabled !== false);
  $('redisBanner').classList.toggle('hidden', health.ok !== false);
  $('redisBanner').textContent = health.ok === false ? `Redis unreachable: ${health.redisError || 'ping failed'}. Queries run against the database (fail-open).` : '';
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === state.hours));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));

  const main = $('main');
  if (state.view === 'overview') renderOverview(main, d);
  else if (state.view === 'tables') renderTables(main, d);
  else renderSettings(main, d);
  renderDrawer();
}

function tile({ label, value, sub, delta, tone }) {
  return `<div class="tile ${tone || ''}"><span>${label}</span><b>${value}${delta != null ? `<small class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${signed(delta)}</small>` : ''}</b><small>${sub || ''}</small></div>`;
}

function renderOverview(main, d) {
  const w = sumWindow(d.stats);
  const p = state.prev;
  const total = w.hits + w.misses;
  const keys = d.keyStats || {};
  const list = allTables(d);
  const busiest = [...list].sort(SORTS.traffic[1]).slice(0, 7);
  const wasteful = [...list].filter((t) => t.misses > 0).sort(SORTS.misses[1]).slice(0, 7);

  main.innerHTML = `
    <section class="tiles">
      ${tile({ label: `Hit rate · ${windowLabel()}`, value: total ? pct(w.hits / total) : 'n/a', sub: `${num(w.hits)} hits · ${num(w.misses)} misses` })}
      ${tile({ label: 'Hits', value: num(w.hits), delta: p ? w.hits - p.hits : null, sub: 'since last refresh →' })}
      ${tile({ label: 'Misses', value: num(w.misses), delta: p ? w.misses - p.misses : null, sub: 'queries that ran on the database' })}
      ${tile({ label: 'Stepped aside', value: num(w.skipped), sub: 'disabled, or a skipped table' })}
      ${tile({ label: 'Redis failures', value: num(w.bypassed), sub: w.bypassed ? 'served by the database instead' : 'none in this window', tone: w.bypassed ? 'bad' : 'ok' })}
      ${tile({ label: 'Cached queries', value: keys.queryKeys != null ? num(keys.queryKeys) : '—', sub: `${keys.memorySupported ? '~' + bytes(keys.approxBytes) : 'memory n/a'} · ${num(keys.tableIndexKeys)} table versions` })}
      ${tile({ label: 'Default TTL', value: `${d.ttlSeconds}s`, sub: `${Object.keys(d.config?.ttlByTable || {}).length} per-table overrides · ${(d.config?.skipTables || []).length} skipped` })}
      ${tile({ label: 'Redis', value: d.health?.ok ? 'OK' : 'Down', sub: `flags refreshed ${ago(d.health?.metaAgeMs)}`, tone: d.health?.ok ? 'ok' : 'bad' })}
    </section>
    <section class="card chartCard">
      <div class="row between wrap">
        <h2>Hit rate and volume <span class="muted small">${windowLabel()}</span></h2>
        <div class="row legend small muted"><i class="sw line"></i>hit rate <i class="sw ok"></i>hits <i class="sw bad"></i>misses <button class="ghost small" id="csvBtn">Export CSV</button></div>
      </div>
      <div class="chartWrap" id="chartWrap"><canvas id="chart"></canvas><div class="tooltip" id="tooltip"></div></div>
    </section>
    <div class="cols">
      <section class="card">
        <div class="row between"><h2>Busiest tables</h2><button class="ghost small" data-goto="tables" data-sort="traffic">All →</button></div>
        ${miniList(busiest)}
      </section>
      <section class="card">
        <div class="row between"><h2>Most misses</h2><button class="ghost small" data-goto="tables" data-sort="misses">All →</button></div>
        ${miniList(wasteful, 'misses')}
      </section>
    </div>
  `;
  chart = createChart({ wrap: $('chartWrap'), canvas: $('chart'), tooltip: $('tooltip') });
  chart.setStats(d.stats || []);
  $('csvBtn').onclick = () => exportHourlyCsv(d.stats || []);
  main.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => {
    state.sort = b.dataset.sort;
    setView('tables');
  }));
  wireRows(main);
}

function miniList(rows, emphasis = 'total') {
  if (!rows.length) return '<p class="muted">No table traffic in this window.</p>';
  return `<table class="grid mini"><thead><tr><th>Table</th><th></th><th class="r">${emphasis === 'misses' ? 'Misses' : 'Hits'}</th><th class="r">Hit rate</th></tr></thead><tbody>
    ${rows.map((t) => `<tr class="rowlink" data-table="${esc(t.name)}"><td class="mono">${esc(t.name)}${badges(t)}</td><td>${spark(t.series, { width: 72, height: 16 })}</td><td class="r">${num(emphasis === 'misses' ? t.misses : t.hits)}</td><td class="r">${bar(t.hitRate)}</td></tr>`).join('')}
  </tbody></table>`;
}

function wireRows(container) {
  container.querySelectorAll('[data-table]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;
      openDrawer(el.dataset.table);
    };
  });
}

function renderTables(main, d) {
  const list = allTables(d);
  const q = state.filter.trim().toLowerCase();
  const filtered = q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  const tree = buildTree(filtered);
  const canFlush = !state.readOnly;
  const matchCount = filtered.length;

  main.innerHTML = `
    <section class="card">
      <div class="row between wrap">
        <h2>Tables by schema <span class="muted small">${q ? `${matchCount} of ${list.length}` : list.length} tables · ${tree.length} schemas</span></h2>
        <div class="row wrap">
          <input id="filter" placeholder="Filter…  ( / )" value="${esc(state.filter)}" />
          <select id="sort" title="Sort tables within each schema">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}" ${k === state.sort ? 'selected' : ''}>${label}</option>`).join('')}</select>
          <button class="ghost small" id="expandAll">Expand all</button>
          <button class="ghost small" id="collapseAll">Collapse all</button>
          <button class="ghost small" id="tablesCsv">Export CSV</button>
        </div>
      </div>
      <p class="muted small">Window: ${windowLabel()}. Version is the table's write counter; every write bumps it and makes older cached rows unreadable. <i class="tag">skipped</i> tables are never cached by this instance; <i class="tag ttl">ttl</i> marks a per-table TTL. Click a row for details.</p>
      <div class="tree">
        ${tree.length ? tree.map((s) => schemaBlock(s, canFlush)).join('') : '<p class="muted">Nothing matches.</p>'}
      </div>
    </section>
  `;

  const filter = $('filter');
  filter.oninput = () => {
    state.filter = filter.value;
    const pos = filter.selectionStart;
    renderTables(main, d);
    const f = $('filter');
    f.focus();
    f.setSelectionRange(pos, pos);
    writeHash();
  };
  $('sort').onchange = (e) => {
    state.sort = e.target.value;
    renderTables(main, d);
    writeHash();
  };
  $('expandAll').onclick = () => {
    state.collapsed.clear();
    store.set('collapsed', []);
    renderTables(main, d);
  };
  $('collapseAll').onclick = () => {
    tree.forEach((s) => state.collapsed.add(s.schema));
    store.set('collapsed', [...state.collapsed]);
    renderTables(main, d);
  };
  $('tablesCsv').onclick = () => exportTablesCsv(filtered);
  main.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('button')) return;
      const s = el.dataset.toggle;
      state.collapsed.has(s) ? state.collapsed.delete(s) : state.collapsed.add(s);
      store.set('collapsed', [...state.collapsed]);
      renderTables(main, d);
    };
  });
  main.querySelectorAll('[data-flush]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const tables = el.dataset.flush.split(',');
      void flush(tables, tables.length === 1 ? tables[0] : `${tables.length} tables in ${el.dataset.schema}`);
    };
  });
  wireRows(main);
}

function schemaBlock(s, canFlush) {
  const open = !state.collapsed.has(s.schema);
  const all = s.tables.map((t) => t.name).join(',');
  const skipped = s.tables.filter((t) => t.skipped).length;
  return `
    <div class="schema ${open ? 'open' : ''}">
      <div class="schemaRow" data-toggle="${esc(s.schema)}">
        <span class="chev">${open ? '▾' : '▸'}</span>
        <span class="name"><b class="mono">${esc(s.schema)}</b> <span class="muted small">${s.tables.length} table${s.tables.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}</span></span>
        <span></span>
        <span class="cell r">${num(s.hits)} <small>hits</small></span>
        <span class="cell r">${num(s.misses)} <small>misses</small></span>
        <span class="cell r">${s.total ? bar(s.hitRate) : '<em class="muted">—</em>'}</span>
        <span class="cell r"><small>v</small>${num(s.versions)}</span>
        ${canFlush ? `<button class="ghost small" data-flush="${esc(all)}" data-schema="${esc(s.schema)}">Flush schema</button>` : '<span></span>'}
      </div>
      ${open ? `<div class="tables">${s.tables.map((t) => tableRow(t, canFlush)).join('')}</div>` : ''}
    </div>`;
}

function tableRow(t, canFlush) {
  return `
    <div class="tableRow rowlink ${t.skipped ? 'skipped' : ''} ${state.table === t.name ? 'selected' : ''}" data-table="${esc(t.name)}">
      <span class="chev"></span>
      <span class="mono name">${esc(t.table)}${badges(t)}</span>
      <span>${spark(t.series)}</span>
      <span class="cell r">${num(t.hits)}</span>
      <span class="cell r">${num(t.misses)}</span>
      <span class="cell r">${t.total ? bar(t.hitRate) : '<em class="muted">—</em>'}</span>
      <span class="cell r mono"><small>v</small>${num(t.version)}</span>
      ${canFlush ? `<button class="ghost small" data-flush="${esc(t.name)}">Flush</button>` : '<span></span>'}
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Drawer: one table
// ---------------------------------------------------------------------------------------------

let drawerChart = null;

function openDrawer(name) {
  state.table = name;
  writeHash();
  renderDrawer();
  if (state.view === 'tables') document.querySelectorAll('.tableRow').forEach((r) => r.classList.toggle('selected', r.dataset.table === name));
}

function closeDrawer() {
  state.table = null;
  writeHash();
  renderDrawer();
  document.querySelectorAll('.tableRow.selected').forEach((r) => r.classList.remove('selected'));
}

function renderDrawer() {
  const drawer = $('drawer');
  const scrim = $('scrim');
  if (!state.table || !state.data) {
    drawer.classList.add('hidden');
    scrim.classList.add('hidden');
    return;
  }
  const t = allTables(state.data).find((x) => x.name === state.table);
  if (!t) {
    closeDrawer();
    return;
  }
  const stats = state.data.stats || [];
  const series = t.series.length ? t.series : stats.map(() => [0, 0]);
  const peakIdx = series.reduce((best, [h, m], i) => (h + m > (series[best][0] + series[best][1]) ? i : best), 0);
  const peak = series[peakIdx] ? series[peakIdx][0] + series[peakIdx][1] : 0;
  const active = series.filter(([h, m]) => h + m > 0).length;
  const cfgLines = [
    t.skipped ? '<li>Never cached by this instance (<code>skipTables</code>). Writes still bump its version.</li>' : '',
    t.ttl != null ? `<li>Per-table TTL <b>${t.ttl}s</b>; a query joining it takes the smallest TTL of its tables.</li>` : '',
    !t.skipped && t.ttl == null ? `<li>Default TTL ${state.data.ttlSeconds}s, strategy <b>${esc(state.data.config?.strategy)}</b>.</li>` : '',
  ].join('');

  drawer.classList.remove('hidden');
  scrim.classList.remove('hidden');
  $('drawerInner').innerHTML = `
    <div class="row between">
      <div><p class="muted small mono">${esc(t.schema)}</p><h2 class="mono big">${esc(t.table)}${badges(t)}</h2></div>
      <div class="row"><button class="ghost small" id="copyName" title="Copy schema.table">Copy</button><button class="icon ghost" id="closeDrawer" title="Close (Esc)">✕</button></div>
    </div>
    <div class="tiles compact">
      ${tile({ label: 'Hit rate', value: t.total ? pct(t.hitRate) : 'n/a', sub: windowLabel() })}
      ${tile({ label: 'Hits', value: num(t.hits) })}
      ${tile({ label: 'Misses', value: num(t.misses) })}
      ${tile({ label: 'Version', value: num(t.version), sub: 'writes since the counter began' })}
    </div>
    <div class="chartWrap small" id="drawerChartWrap"><canvas id="drawerChart"></canvas><div class="tooltip" id="drawerTooltip"></div></div>
    <p class="muted small">Peak hour ${peak ? `${num(peak)} queries, ${chart?.formatHourLabel(stats[peakIdx]) || ''}` : '—'} · ${active} of ${series.length} hours with traffic.</p>
    <h3>Caching</h3>
    <ul class="plain small">${cfgLines}</ul>
    <h3>Actions</h3>
    <p class="muted small">Flushing bumps the version: every cached row that read this table becomes unreadable at once, on every instance of this namespace.</p>
    <div class="row"><button class="danger" id="drawerFlush" ${state.readOnly ? 'disabled' : ''}>Flush ${esc(t.table)}</button></div>
  `;
  drawerChart = createChart({ wrap: $('drawerChartWrap'), canvas: $('drawerChart'), tooltip: $('drawerTooltip') });
  drawerChart.setStats(series.map(([hits, misses], i) => ({ hour: stats[i]?.hour, hourStart: stats[i]?.hourStart, hits, misses, hitRate: hits + misses ? hits / (hits + misses) : 0 })));
  $('closeDrawer').onclick = closeDrawer;
  $('copyName').onclick = async () => {
    try {
      await navigator.clipboard.writeText(t.name);
      toast('Copied ' + t.name, 'ok');
    } catch {
      toast('Clipboard unavailable', 'bad');
    }
  };
  $('drawerFlush').onclick = () => flush([t.name], t.name);
  scrim.onclick = closeDrawer;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function renderSettings(main, d) {
  const c = d.config || {};
  const ro = state.readOnly;
  const keys = d.keyStats || {};
  main.innerHTML = `
    <div class="cols">
      <section class="card">
        <h2>Default TTL</h2>
        <p class="muted small">Seconds a cached result lives when the query and its tables set nothing else. Shared by every instance on this namespace.</p>
        <form id="ttlForm" class="row"><input type="number" name="seconds" min="${ttlMin}" max="${ttlMax}" value="${d.ttlSeconds}" ${ro ? 'disabled' : ''} /><span class="muted small">s</span><button class="primary" ${ro ? 'disabled' : ''}>Save</button></form>
      </section>
      <section class="card">
        <h2>Credentials</h2>
        <p class="muted small">Stored in Redis for this namespace. Changing them signs everyone out.</p>
        <form id="credForm" class="col">
          <input name="username" placeholder="New username" required autocomplete="off" ${ro ? 'disabled' : ''} />
          <input name="password" type="password" placeholder="New password" required autocomplete="new-password" ${ro ? 'disabled' : ''} />
          <button class="primary" ${ro ? 'disabled' : ''}>Update</button>
        </form>
      </section>
      <section class="card">
        <h2>Flush everything</h2>
        <p class="muted small">Deletes every cached query and every table version in <b class="mono">${esc(c.namespace || '')}</b>. Stats and credentials stay.</p>
        <button class="danger" id="flushAll" ${ro ? 'disabled' : ''}>Flush all</button>
      </section>
      <section class="card">
        <h2>Redis latency</h2>
        <p class="muted small">Round trips from this instance: PING and GET on a probe key.</p>
        <div class="row wrap"><button class="ghost" id="latencyBtn">Run 20 samples</button><span id="latencyOut" class="mono small muted"></span></div>
        <div id="latencyBars" class="latency"></div>
      </section>
      <section class="card span2">
        <div class="row between"><h2>This instance</h2><button class="ghost small" id="copyConfig">Copy as JSON</button></div>
        <p class="muted small">Fixed at construction. Other instances on the same namespace may differ; invalidation is shared, these settings are not.</p>
        <dl class="kv">
          <dt>Namespace</dt><dd class="mono">${esc(c.namespace)}</dd>
          <dt>Strategy</dt><dd>${esc(c.strategy)} <span class="muted small">${c.strategy === 'all' ? '— every select is cached unless its table is skipped' : '— only selects with $withCache()'}</span></dd>
          <dt>Skipped tables</dt><dd class="mono">${(c.skipTables || []).length ? c.skipTables.map((t) => `<a href="#" data-table="${esc(t)}">${esc(t)}</a>`).join('<br>') : '<span class="muted">none</span>'}</dd>
          <dt>TTL per table</dt><dd class="mono">${Object.keys(c.ttlByTable || {}).length ? Object.entries(c.ttlByTable).map(([t, s]) => `<a href="#" data-table="${esc(t)}">${esc(t)}</a> → ${s}s`).join('<br>') : '<span class="muted">none</span>'}</dd>
          <dt>Write on miss</dt><dd>${c.awaitPut ? 'awaited' : 'in the background'}</dd>
          <dt>v1 compatibility</dt><dd>${c.compatV1 ? 'on — maintaining v1 index sets' : 'off'}</dd>
          <dt>Stats plugin</dt><dd>${d.health?.statsPlugin ? 'on' : 'off'}</dd>
          <dt>Pending versions</dt><dd>${num(d.health?.pendingVersions)} <span class="muted small">reads waiting for their write</span></dd>
          <dt>Keys</dt><dd>${num(keys.queryKeys)} cached queries · ${num(keys.tableIndexKeys)} table versions · ${keys.memorySupported ? '~' + bytes(keys.approxBytes) + ' from ' + keys.sampledKeys + ' sampled' : 'memory usage not supported'}</dd>
          <dt>Redis</dt><dd>${d.health?.ok ? 'OK' : esc(d.health?.redisError || 'error')} <span class="muted small">flags refreshed ${ago(d.health?.metaAgeMs)}</span></dd>
        </dl>
      </section>
    </div>
  `;

  $('ttlForm').onsubmit = async (e) => {
    e.preventDefault();
    const seconds = Number(new FormData(e.target).get('seconds'));
    try {
      const r = await api('/api/ttl', { method: 'POST', body: JSON.stringify({ seconds }) });
      toast(`Default TTL is now ${r.ttlSeconds}s`, 'ok');
      await load({ silent: true });
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  $('credForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/credentials', { method: 'POST', body: JSON.stringify({ username: f.get('username'), password: f.get('password') }) });
      toast('Credentials updated, sign in again', 'ok');
      clearAuth();
      showLogin();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  $('flushAll').onclick = async () => {
    const ok = await dialog('Flush everything?', '<p>Every cached query and table version in this namespace is deleted. Every instance on the namespace sees misses until it refills.</p>', 'Flush all');
    if (!ok) return;
    try {
      const r = await api('/api/flush', { method: 'POST', body: '{}' });
      toast(`Deleted ${num(r.deletedQueries)} cached queries`, 'ok');
      await load({ silent: true });
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  $('latencyBtn').onclick = async () => {
    $('latencyOut').textContent = 'running…';
    $('latencyBars').innerHTML = '';
    try {
      const r = await api('/api/latency-test', { method: 'POST', body: JSON.stringify({ samples: 20 }) });
      $('latencyOut').textContent = `GET avg ${r.get.avgMs} ms · p95 ${r.get.p95Ms} ms · max ${r.get.maxMs} ms · PING p95 ${r.ping.p95Ms} ms`;
      const max = Math.max(0.1, ...r.get.valuesMs);
      $('latencyBars').innerHTML = r.get.valuesMs.map((v) => `<i style="height:${Math.max(2, (v / max) * 40)}px" title="${v} ms"></i>`).join('');
    } catch (err) {
      $('latencyOut').textContent = err.message;
    }
  };
  $('copyConfig').onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(c, null, 2));
      toast('Config copied', 'ok');
    } catch {
      toast('Clipboard unavailable', 'bad');
    }
  };
  main.querySelectorAll('a[data-table]').forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    openDrawer(a.dataset.table);
  }));
}

// ---------------------------------------------------------------------------------------------
// Export, navigation, shortcuts
// ---------------------------------------------------------------------------------------------

function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportHourlyCsv(stats) {
  const lines = ['hour,hourStart,hits,misses,skipped,bypassed,hitRate'];
  for (const s of stats) lines.push([s.hour, s.hourStart, s.hits || 0, s.misses || 0, s.skipped || 0, s.bypassed || 0, (s.hitRate || 0).toFixed(4)].join(','));
  download(`drizzle-cache-hourly-${state.hours}h.csv`, lines.join('\n'));
}

function exportTablesCsv(tables) {
  const lines = ['table,schema,hits,misses,hitRate,version,skipped,ttl'];
  for (const t of tables) lines.push([t.name, t.schema, t.hits, t.misses, t.hitRate.toFixed(4), t.version, t.skipped, t.ttl ?? ''].join(','));
  download(`drizzle-cache-tables-${state.hours}h.csv`, lines.join('\n'));
}

function setView(view) {
  state.view = view;
  render();
}

function showShortcuts() {
  void dialog(
    'Keyboard shortcuts',
    `<dl class="kv keys">
      <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt><dd>Overview, Tables, Settings</dd>
      <dt><kbd>R</kbd></dt><dd>Refresh</dd>
      <dt><kbd>/</kbd></dt><dd>Filter tables</dd>
      <dt><kbd>Esc</kbd></dt><dd>Close drawer or dialog</dd>
      <dt><kbd>?</kbd></dt><dd>This list</dd>
    </dl><p class="muted small">Views, window, filter, sort and the open table live in the URL, so a link reproduces what you see.</p>`,
    null,
  );
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  setAuth(f.get('username'), f.get('password'));
  try {
    await api('/api/health');
    showApp();
    await load();
  } catch (err) {
    clearAuth();
    showLogin(err.message);
  }
};
$('signOut').onclick = () => {
  clearAuth();
  showLogin();
};
$('refreshBtn').onclick = () => load();
$('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light') || render();
$('helpBtn').onclick = showShortcuts;
$('tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (b?.dataset.view) setView(b.dataset.view);
};
$('range').onclick = (e) => {
  if (!e.target.dataset.h) return;
  state.hours = Number(e.target.dataset.h);
  void load();
};
$('enabledToggle').onchange = async (e) => {
  const enabled = e.target.checked;
  try {
    await api('/api/enabled', { method: 'POST', body: JSON.stringify({ enabled }) });
    toast(enabled ? 'Cache enabled' : 'Cache disabled for every instance on this namespace', enabled ? 'ok' : 'bad');
    await load({ silent: true });
  } catch (err) {
    toast(err.message, 'bad');
    e.target.checked = !enabled;
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) $('modalCancel').click();
    else if (state.table) closeDrawer();
    return;
  }
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('app').classList.contains('hidden')) return;
  if (e.key === 'r') void load();
  else if (e.key === '?') showShortcuts();
  else if (e.key === '1') setView('overview');
  else if (e.key === '2') setView('tables');
  else if (e.key === '3') setView('settings');
  else if (e.key === '/') {
    e.preventDefault();
    if (state.view !== 'tables') setView('tables');
    $('filter')?.focus();
  }
});
window.addEventListener('resize', () => {
  chart?.redraw();
  drawerChart?.redraw();
});
window.addEventListener('hashchange', () => {
  const before = state.hours;
  readHash();
  if (before !== state.hours) void load();
  else render();
});

(async () => {
  readHash();
  try {
    const status = await (await fetch(`${apiBase}/api/status`)).json();
    if (status && status.configured === false) {
      showLogin('No admin credentials are configured on the server. Pass `adminCredentials` to DrizzleRedisCache.');
      $('loginForm').querySelector('button').disabled = true;
      return;
    }
  } catch {
    /* an old server without /api/status: fall through to the normal flow */
  }
  if (!hasStoredAuth()) return showLogin();
  try {
    await api('/api/health');
    showApp();
    await load();
  } catch {
    showLogin();
  }
})();
