import { clearAuth, createApi, hasStoredAuth, setAuth } from './api.js';
import { createChart } from './chart.js';
import { toast } from './toast.js';

const cfg = window.__DRIZZLE_CACHE_ADMIN__ || {};
const params = new URLSearchParams(location.search);
const apiBase = String(
  cfg.apiBase ||
    params.get('api') ||
    location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, ''),
).replace(/\/$/, '');

const defaults = cfg.defaults || {};
const defaultUser = defaults.username || 'admin';
const defaultPass = defaults.password || 'admin';
const ttlMin = defaults.ttlMinSeconds ?? 1;
const ttlMax = defaults.ttlMaxSeconds ?? 3600;
const ttlDefault = defaults.ttlDefaultSeconds ?? 300;
const initialReadOnly = cfg.readOnly === true;

let currentView = 'overview';
let autoRefreshTimer = null;
let chart;
let hours = 24;
let lastPayload = null;
let readOnly = initialReadOnly;

const root = document.getElementById('drizzle-cache-admin-root') || document.body;

function ensureBootLoader() {
  let boot = document.getElementById('bootLoader');
  if (boot) return boot;
  boot = document.createElement('div');
  boot.id = 'bootLoader';
  boot.className = 'boot-loader';
  boot.innerHTML = `
    <div class="loader-card">
      <div class="spinner" aria-hidden="true"></div>
      <div>Loading cache admin…</div>
    </div>
  `;
  root.appendChild(boot);
  return boot;
}

const bootLoader = ensureBootLoader();

root.insertAdjacentHTML(
  'beforeend',
  `
  <div id="loginGate" class="hidden">
    <section class="card" id="loginCard">
      <h1 style="margin:0 0 8px;font-size:1.3rem">Cache admin</h1>
      <p class="hint" style="margin:0 0 14px">
        First login: <code>${defaultUser}</code> / <code>${defaultPass}</code> (saved in Redis).
      </p>
      <form id="loginForm" class="stack">
        <div>
          <label for="loginUser">Username</label>
          <input id="loginUser" type="text" autocomplete="username" required />
        </div>
        <div>
          <label for="loginPass">Password</label>
          <input id="loginPass" type="password" autocomplete="current-password" required />
        </div>
        <button class="primary" type="submit">Sign in</button>
        <div class="err" id="loginError"></div>
      </form>
    </section>
  </div>

  <div class="page-loader hidden" id="pageLoader">
    <div class="loader-card">
      <div class="spinner" aria-hidden="true"></div>
      <div id="pageLoaderText">Loading…</div>
    </div>
  </div>

  <div class="modal-backdrop hidden" id="flushModal">
    <div class="modal">
      <h2>Flush cache?</h2>
      <p class="hint" style="margin:0 0 14px">
        Deletes cached query keys and table indexes. Stats and admin credentials are kept.
      </p>
      <div class="controls" style="justify-content:flex-end">
        <button type="button" class="secondary" id="flushCancel">Cancel</button>
        <button type="button" class="primary" id="flushConfirm">Flush all</button>
      </div>
    </div>
  </div>

  <div class="shell" id="appShell" hidden>
    <div id="readonlyBanner" class="readonly-banner hidden">
      Read-only mode — viewing stats only. Mutations are disabled.
    </div>
    <div id="disabledBanner" class="disabled-banner hidden">
      <div><strong>Caching is disabled.</strong> All queries miss Redis until you enable it again.</div>
      <button type="button" class="primary mutate-only" id="enableFromBanner">Enable now</button>
    </div>

    <div class="topbar">
      <div class="brand">
        <h1>Drizzle query cache</h1>
        <p>Live hit rate, volume, keys, and runtime controls · press <span class="kbd">R</span> to refresh</p>
      </div>
      <div class="controls">
        <nav class="nav" id="nav">
          <button type="button" data-view="overview" class="active">Overview</button>
          <button type="button" data-view="tables">Tables</button>
          <button type="button" data-view="settings">Settings</button>
        </nav>
        <button id="logoutBtn" class="secondary" type="button">Log out</button>
      </div>
    </div>

    <div id="view-overview" class="view active">
      <div class="metrics">
        <div class="metric" id="statusMetric">
          <div class="k">Cache status</div>
          <div class="v"><span class="pill" id="enabledPill"><span id="enabledDot" class="dot"></span><span id="enabledLabel">—</span></span></div>
          <div class="s" id="healthBadgeWrap"><span class="badge" id="healthBadge">Redis —</span></div>
        </div>
        <div class="metric">
          <div class="k">Hit rate (hour)</div>
          <div class="v" id="mHitRate">—</div>
          <div class="s" id="mHitRateSub">this local hour</div>
        </div>
        <div class="metric">
          <div class="k">Query keys</div>
          <div class="v" id="mKeys">—</div>
          <div class="s" id="mKeysSub">in namespace</div>
        </div>
        <div class="metric">
          <div class="k">Default TTL</div>
          <div class="v" id="mTtl">—</div>
          <div class="s" id="mMemory">memory n/a</div>
        </div>
      </div>

      <section class="card">
        <div class="row" style="margin-bottom:12px">
          <div>
            <label style="margin:0">Hit rate</label>
            <div class="hint" style="margin:4px 0 0" id="statsHint">Hover the chart for details</div>
          </div>
          <div class="controls">
            <div class="segment" id="rangeSeg">
              <button type="button" data-hours="6">6h</button>
              <button type="button" data-hours="24" class="active">24h</button>
              <button type="button" data-hours="168">7d</button>
            </div>
            <label class="toggle"><input id="autoRefresh" type="checkbox" /> Auto 15s</label>
            <button id="exportBtn" class="secondary" type="button">Export CSV</button>
            <button id="refreshBtn" class="secondary" type="button">Refresh</button>
          </div>
        </div>
        <div class="chart-wrap" id="chartWrap">
          <canvas id="chart"></canvas>
          <div class="tooltip" id="tooltip"></div>
        </div>
        <div class="legend">
          <span><i style="background:var(--accent)"></i>Hit rate %</span>
          <span><i style="background:rgba(62,207,142,0.55)"></i>Hits volume</span>
          <span><i style="background:rgba(240,113,120,0.45)"></i>Misses volume</span>
        </div>
        <div class="err" id="error"></div>
      </section>

      <section class="card mutate-only">
        <div class="row">
          <div>
            <label>Quick controls</label>
            <div class="hint" style="margin:0">Enable or disable caching for all instances (Redis meta).</div>
          </div>
          <div class="controls">
            <button id="enableBtn" class="primary" type="button">Enable</button>
            <button id="disableBtn" class="secondary" type="button">Disable</button>
          </div>
        </div>
      </section>
    </div>

    <div id="view-tables" class="view">
      <section class="card">
        <label>Per-table hit / miss</label>
        <div class="hint" id="tableHitsHint" style="margin:0 0 10px">Same window as the chart (6h / 24h / 7d).</div>
        <div class="table-toolbar">
          <input id="tableHitsSearch" type="search" placeholder="Search tables…" autocomplete="off" />
          <span class="count" id="tableHitsCount">0 shown</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>#</th><th>Table</th><th>Hits</th><th>Misses</th><th>Hit rate</th></tr></thead>
            <tbody id="tableHitsBody"><tr><td colspan="5">No data</td></tr></tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <label>Cached query keys by table index</label>
        <div class="hint" style="margin:0 0 10px">Current Redis set sizes for invalidation indexes.</div>
        <div class="table-toolbar">
          <input id="tableIndexSearch" type="search" placeholder="Search tables…" autocomplete="off" />
          <span class="count" id="tableIndexCount">0 shown</span>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>#</th><th>Table</th><th>Query keys</th><th class="mutate-only"></th></tr></thead>
            <tbody id="tableIndexBody"><tr><td colspan="4">No data</td></tr></tbody>
          </table>
        </div>
      </section>
    </div>

    <div id="view-settings" class="view">
      <section class="card">
        <label>Health</label>
        <div class="hint" id="healthDetails" style="margin-top:8px">—</div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom:12px">
          <div>
            <label style="margin:0">Redis latency test</label>
            <div class="hint" style="margin:4px 0 0">
              Measures round-trip delay from this server to Redis (PING + GET). Useful to spot network lag.
            </div>
          </div>
          <div class="controls">
            <select id="latencySamples" style="min-width:110px">
              <option value="10">10 samples</option>
              <option value="20" selected>20 samples</option>
              <option value="50">50 samples</option>
            </select>
            <button id="latencyTestBtn" class="primary" type="button">Run test</button>
          </div>
        </div>
        <div class="metrics" style="margin:0">
          <div class="metric">
            <div class="k">GET avg</div>
            <div class="v" id="latGetAvg">—</div>
            <div class="s" id="latGetSub">min / p95 / max</div>
          </div>
          <div class="metric">
            <div class="k">PING avg</div>
            <div class="v" id="latPingAvg">—</div>
            <div class="s" id="latPingSub">min / p95 / max</div>
          </div>
          <div class="metric">
            <div class="k">Samples</div>
            <div class="v" id="latSamples">—</div>
            <div class="s" id="latProbe">probe key</div>
          </div>
          <div class="metric">
            <div class="k">Verdict</div>
            <div class="v" id="latVerdict">—</div>
            <div class="s">based on GET avg</div>
          </div>
        </div>
      </section>

      <section class="card mutate-only">
        <div class="row">
          <div>
            <label>Flush cache keys</label>
            <div class="hint" style="margin:0">
              Deletes cached query keys and table indexes. Stats and admin credentials are kept.
              Per-table flush is also available on the Tables tab.
            </div>
          </div>
          <div class="controls">
            <button id="flushBtn" class="secondary" type="button">Flush all keys…</button>
          </div>
        </div>
      </section>

      <section class="card mutate-only">
        <div class="row">
          <div>
            <label>Default TTL (seconds)</label>
            <div class="value" id="ttlValue">—</div>
            <div class="hint">Allowed ${ttlMin}–${ttlMax}s (default ${ttlDefault}s)</div>
          </div>
          <div class="controls">
            <input id="ttlInput" type="number" min="${ttlMin}" max="${ttlMax}" step="1" />
            <button id="ttlSave" class="primary" type="button">Save TTL</button>
          </div>
        </div>
      </section>

      <section class="card mutate-only">
        <label>Change admin credentials</label>
        <div class="field-row" style="margin-top:10px">
          <input id="newUser" type="text" placeholder="New username" autocomplete="off" />
          <input id="newPass" type="password" placeholder="New password" autocomplete="new-password" />
        </div>
        <div class="controls" style="margin-top:12px">
          <button id="credsSave" class="primary" type="button">Update credentials</button>
        </div>
      </section>
    </div>
  </div>
`,
);

const loginGate = document.getElementById('loginGate');
const appShell = document.getElementById('appShell');
const pageLoader = document.getElementById('pageLoader');
const pageLoaderText = document.getElementById('pageLoaderText');
const loginError = document.getElementById('loginError');
const errorEl = document.getElementById('error');
const flushModal = document.getElementById('flushModal');

function showBoot() {
  bootLoader.classList.remove('hidden');
}
function hideBoot() {
  bootLoader.classList.add('hidden');
}
function showPageLoader(text = 'Loading…') {
  pageLoaderText.textContent = text;
  pageLoader.classList.remove('hidden');
}
function hidePageLoader() {
  pageLoader.classList.add('hidden');
}

function applyReadOnlyUi() {
  document.getElementById('readonlyBanner').classList.toggle('hidden', !readOnly);
  document.querySelectorAll('.mutate-only').forEach((el) => {
    el.classList.toggle('hidden-readonly', readOnly);
  });
}

function showLogin() {
  clearAuth();
  stopAutoRefresh();
  hideBoot();
  hidePageLoader();
  flushModal.classList.add('hidden');
  appShell.hidden = true;
  loginGate.classList.remove('hidden');
}

function showApp() {
  hideBoot();
  hidePageLoader();
  loginGate.classList.add('hidden');
  appShell.hidden = false;
  applyReadOnlyUi();
  requestAnimationFrame(() => chart?.redraw());
}

const api = createApi(apiBase, { onUnauthorized: showLogin });

chart = createChart({
  wrap: document.getElementById('chartWrap'),
  canvas: document.getElementById('chart'),
  tooltip: document.getElementById('tooltip'),
});

function setBusy(busy) {
  for (const id of [
    'enableBtn',
    'disableBtn',
    'ttlSave',
    'refreshBtn',
    'credsSave',
    'autoRefresh',
    'exportBtn',
    'flushBtn',
    'flushConfirm',
    'latencyTestBtn',
  ]) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === 'view-' + view);
  });
  document.querySelectorAll('#nav button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'overview') requestAnimationFrame(() => chart.redraw());
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function renderTables(data) {
  const hitsBody = document.getElementById('tableHitsBody');
  const indexBody = document.getElementById('tableIndexBody');
  const tableStats = data.tableStats || [];
  const tableIndexes = data.tableIndexes || [];
  const windowHours = data.hours || hours;
  const hint = document.getElementById('tableHitsHint');
  if (hint) {
    hint.textContent = `Same window as the chart — last ${windowHours} local hour${windowHours === 1 ? '' : 's'}.`;
  }

  hitsBody.innerHTML = tableStats.length
    ? tableStats
        .map(
          (r, i) => `<tr data-table="${escapeAttr(r.table)}">
            <td class="sn">${i + 1}</td>
            <td>${escapeHtml(r.table)}</td>
            <td>${Number(r.hits).toLocaleString()}</td>
            <td>${Number(r.misses).toLocaleString()}</td>
            <td>${((r.hitRate || 0) * 100).toFixed(1)}%</td>
          </tr>`,
        )
        .join('')
    : '<tr class="empty-row"><td colspan="5">No table hit data yet</td></tr>';

  indexBody.innerHTML = tableIndexes.length
    ? tableIndexes
        .map(
          (r, i) => `<tr data-table="${escapeAttr(r.table)}">
            <td class="sn">${i + 1}</td>
            <td>${escapeHtml(r.table)}</td>
            <td>${Number(r.queryKeys).toLocaleString()}</td>
            <td class="mutate-only">${
              readOnly
                ? ''
                : `<button type="button" class="secondary flush-table" data-table="${escapeAttr(r.table)}">Flush</button>`
            }</td>
          </tr>`,
        )
        .join('')
    : `<tr class="empty-row"><td colspan="${readOnly ? 3 : 4}">No table indexes</td></tr>`;

  applyTableFilter('tableHitsBody', 'tableHitsSearch', 'tableHitsCount');
  applyTableFilter('tableIndexBody', 'tableIndexSearch', 'tableIndexCount');
  applyReadOnlyUi();
}

function applyTableFilter(bodyId, searchId, countId) {
  const q = (document.getElementById(searchId)?.value || '').trim().toLowerCase();
  const rows = [...document.querySelectorAll(`#${bodyId} tr[data-table]`)];
  let shown = 0;
  for (const row of rows) {
    const name = (row.dataset.table || '').toLowerCase();
    const match = !q || name.includes(q);
    row.classList.toggle('is-hidden', !match);
    if (match) {
      shown += 1;
      const sn = row.querySelector('td.sn');
      if (sn) sn.textContent = String(shown);
    }
  }
  const countEl = document.getElementById(countId);
  if (countEl) {
    const total = rows.length;
    countEl.textContent = q ? `${shown} / ${total} shown` : `${total} shown`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll('"', '&quot;');
}

function updateMetrics(data) {
  readOnly = data.readOnly === true || initialReadOnly;
  const enabled = !!data.enabled;
  const statusMetric = document.getElementById('statusMetric');
  const enabledPill = document.getElementById('enabledPill');
  const disabledBanner = document.getElementById('disabledBanner');
  const chartWrapEl = document.getElementById('chartWrap');

  document.getElementById('enabledDot').classList.toggle('on', enabled);
  document.getElementById('enabledLabel').textContent = enabled
    ? 'Caching enabled'
    : 'Caching disabled';
  enabledPill.classList.toggle('on', enabled);
  enabledPill.classList.toggle('off', !enabled);
  statusMetric.classList.toggle('status-on', enabled);
  statusMetric.classList.toggle('status-off', !enabled);
  disabledBanner.classList.toggle('hidden', enabled);
  chartWrapEl.classList.toggle('cache-off', !enabled);

  document.getElementById('mTtl').textContent = data.ttlSeconds + 's';
  document.getElementById('ttlValue').textContent = data.ttlSeconds + 's';
  document.getElementById('ttlInput').value = data.ttlSeconds;

  const health = data.health || {};
  const badge = document.getElementById('healthBadge');
  const ok = health.redis === 'pong';
  badge.textContent = ok ? 'Redis OK' : 'Redis error';
  badge.className = 'badge ' + (ok ? 'ok' : 'bad');

  const keys = data.keyStats || {};
  document.getElementById('mKeys').textContent =
    keys.queryKeys != null ? Number(keys.queryKeys).toLocaleString() : '—';
  document.getElementById('mKeysSub').textContent =
    `${keys.tableIndexKeys ?? 0} table indexes · ns ${keys.namespace || health.namespace || '—'}`;
  document.getElementById('mMemory').textContent = keys.memorySupported
    ? `~${formatBytes(keys.approxBytes)}`
    : 'memory n/a';

  document.getElementById('healthDetails').textContent = [
    `namespace=${health.namespace}`,
    `strategy=${health.strategy}`,
    `metaAge=${health.metaAgeMs == null ? 'n/a' : Math.round(health.metaAgeMs / 1000) + 's'}`,
    `statsPlugin=${health.statsPlugin ? 'yes' : 'no'}`,
    health.redisError ? `error=${health.redisError}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const stats = data.stats || [];
  const latest = stats[stats.length - 1];
  const hits = latest?.hits || 0;
  const misses = latest?.misses || 0;
  const total = hits + misses;
  document.getElementById('mHitRate').textContent = total ? chart.pct(latest.hitRate) : 'n/a';
  document.getElementById('mHitRateSub').textContent = total
    ? `${hits.toLocaleString()} hits / ${total.toLocaleString()} req`
    : 'no traffic this hour';
  document.getElementById('statsHint').textContent = stats.some(
    (s) => (s.hits || 0) + (s.misses || 0) > 0,
  )
    ? `Showing last ${data.hours || hours} local hours — hover for % and counts`
    : 'No stats yet — attach RedisHourlyStatsPlugin or wait for traffic';

  renderTables(data);
  applyReadOnlyUi();
}

async function refresh({ silent = false } = {}) {
  errorEl.textContent = '';
  if (!silent) {
    if (!appShell.hidden) showPageLoader('Refreshing…');
    setBusy(true);
  }
  try {
    const data = await api(`/api?hours=${hours}`);
    lastPayload = data;
    chart.setStats(data.stats || []);
    updateMetrics(data);
    showApp();
  } catch (err) {
    if (!hasStoredAuth()) {
      showLogin();
      loginError.textContent = String(err.message || err);
    } else if (!appShell.hidden) {
      errorEl.textContent = String(err.message || err);
      hidePageLoader();
      toast(String(err.message || err), 'err');
    } else {
      showLogin();
      loginError.textContent = String(err.message || err);
    }
  } finally {
    if (!silent) {
      setBusy(false);
      hidePageLoader();
    }
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    if (!appShell.hidden && currentView === 'overview') void refresh({ silent: true });
  }, 15_000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function exportCsv() {
  const stats = lastPayload?.stats || [];
  if (!stats.length) {
    toast('No stats to export', 'err');
    return;
  }
  const lines = ['hour,hourStart,hits,misses,hitRate'];
  for (const s of stats) {
    lines.push(
      [
        s.hour,
        JSON.stringify(s.hourStart || ''),
        s.hits || 0,
        s.misses || 0,
        (s.hitRate || 0).toFixed(4),
      ].join(','),
    );
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `drizzle-cache-stats-${hours}h.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV exported', 'ok');
}

document.getElementById('nav').onclick = (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setView(btn.dataset.view);
};

document.getElementById('rangeSeg').onclick = async (e) => {
  const btn = e.target.closest('button[data-hours]');
  if (!btn) return;
  hours = Number(btn.dataset.hours);
  document.querySelectorAll('#rangeSeg button').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
  await refresh();
};

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  setAuth(
    document.getElementById('loginUser').value,
    document.getElementById('loginPass').value,
  );
  loginGate.classList.add('hidden');
  showBoot();
  await refresh();
};

document.getElementById('logoutBtn').onclick = () => showLogin();
document.getElementById('refreshBtn').onclick = () => refresh();
document.getElementById('exportBtn').onclick = () => exportCsv();
document.getElementById('autoRefresh').onchange = (e) => {
  if (e.target.checked) startAutoRefresh();
  else stopAutoRefresh();
};

document.getElementById('enableBtn').onclick = async () => {
  await setEnabled(true);
};
document.getElementById('enableFromBanner').onclick = async () => {
  await setEnabled(true);
};
document.getElementById('disableBtn').onclick = async () => {
  await setEnabled(false);
};

async function setEnabled(enabled) {
  showPageLoader(enabled ? 'Enabling…' : 'Disabling…');
  setBusy(true);
  try {
    await api('/api/enabled', { method: 'POST', body: JSON.stringify({ enabled }) });
    await refresh({ silent: true });
    toast(enabled ? 'Caching enabled' : 'Caching disabled', enabled ? 'ok' : 'err');
  } catch (err) {
    errorEl.textContent = String(err.message || err);
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
}

document.getElementById('flushBtn').onclick = () => flushModal.classList.remove('hidden');
document.getElementById('flushCancel').onclick = () => flushModal.classList.add('hidden');
document.getElementById('flushConfirm').onclick = async () => {
  flushModal.classList.add('hidden');
  showPageLoader('Flushing…');
  setBusy(true);
  try {
    const result = await api('/api/flush', { method: 'POST', body: JSON.stringify({}) });
    await refresh({ silent: true });
    toast(`Flushed ${result.deletedQueries} queries`, 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
};

document.getElementById('tableHitsSearch').addEventListener('input', () => {
  applyTableFilter('tableHitsBody', 'tableHitsSearch', 'tableHitsCount');
});
document.getElementById('tableIndexSearch').addEventListener('input', () => {
  applyTableFilter('tableIndexBody', 'tableIndexSearch', 'tableIndexCount');
});

document.getElementById('tableIndexBody').onclick = async (e) => {
  const btn = e.target.closest('button.flush-table');
  if (!btn || readOnly) return;
  const table = btn.dataset.table;
  if (!table) return;
  showPageLoader(`Flushing ${table}…`);
  setBusy(true);
  try {
    const result = await api('/api/flush', {
      method: 'POST',
      body: JSON.stringify({ tables: [table] }),
    });
    await refresh({ silent: true });
    toast(`Flushed ${table}: ${result.deletedQueries} keys`, 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
};

document.getElementById('latencyTestBtn').onclick = async () => {
  const samples = Number(document.getElementById('latencySamples').value) || 20;
  showPageLoader('Running latency test…');
  setBusy(true);
  try {
    const result = await api('/api/latency-test', {
      method: 'POST',
      body: JSON.stringify({ samples }),
    });
    const get = result.get;
    const ping = result.ping;
    document.getElementById('latGetAvg').textContent = `${get.avgMs} ms`;
    document.getElementById('latGetSub').textContent =
      `${get.minMs} / ${get.p95Ms} / ${get.maxMs} ms`;
    document.getElementById('latPingAvg').textContent = `${ping.avgMs} ms`;
    document.getElementById('latPingSub').textContent =
      `${ping.minMs} / ${ping.p95Ms} / ${ping.maxMs} ms`;
    document.getElementById('latSamples').textContent = String(result.samples);
    document.getElementById('latProbe').textContent = result.probeKey || 'probe key';

    let verdict = 'OK';
    if (get.avgMs > 20) verdict = 'Slow';
    else if (get.avgMs > 5) verdict = 'Fair';
    else verdict = 'Fast';
    document.getElementById('latVerdict').textContent = verdict;
    toast(`GET avg ${get.avgMs} ms (${verdict})`, get.avgMs > 20 ? 'err' : 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
};

document.getElementById('ttlSave').onclick = async () => {
  showPageLoader('Saving TTL…');
  setBusy(true);
  try {
    await api('/api/ttl', {
      method: 'POST',
      body: JSON.stringify({ seconds: Number(document.getElementById('ttlInput').value) }),
    });
    await refresh({ silent: true });
    toast('TTL updated', 'ok');
  } catch (err) {
    errorEl.textContent = String(err.message || err);
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
};

document.getElementById('credsSave').onclick = async () => {
  showPageLoader('Updating credentials…');
  setBusy(true);
  try {
    const username = document.getElementById('newUser').value;
    const password = document.getElementById('newPass').value;
    await api('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setAuth(username, password);
    document.getElementById('newPass').value = '';
    toast('Credentials updated', 'ok');
  } catch (err) {
    toast(String(err.message || err), 'err');
  } finally {
    setBusy(false);
    hidePageLoader();
  }
};

window.addEventListener('resize', () => {
  if (!appShell.hidden) chart.redraw();
});

window.addEventListener('keydown', (e) => {
  if (appShell.hidden) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    void refresh();
  }
});

if (hasStoredAuth()) {
  showBoot();
  loginGate.classList.add('hidden');
  void refresh();
} else {
  showLogin();
}
