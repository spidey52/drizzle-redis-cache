import { CACHE_ADMIN_DEFAULT_PASSWORD, CACHE_ADMIN_DEFAULT_USERNAME, CACHE_TTL_DEFAULT_SECONDS, CACHE_TTL_MAX_SECONDS, CACHE_TTL_MIN_SECONDS } from "./drizzle-redis-cache";

export const CACHE_ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Drizzle Cache Admin</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --text: #e7ecf3;
      --muted: #8b9bb4;
      --accent: #3d8bfd;
      --ok: #3ecf8e;
      --bad: #f07178;
      --border: #2a3548;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1b2a44, var(--bg));
      color: var(--text);
      min-height: 100vh;
    }
    main {
      max-width: 880px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    h1 { font-size: 1.4rem; margin: 0 0 6px; }
    p.sub { color: var(--muted); margin: 0 0 24px; font-size: 0.95rem; }
    .card {
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 18px 16px;
      margin-bottom: 16px;
    }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }
    label { color: var(--muted); font-size: 0.85rem; display: block; margin-bottom: 6px; }
    .value { font-variant-numeric: tabular-nums; font-size: 1.15rem; }
    button, input[type="number"], input[type="text"], input[type="password"] {
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #121a27;
      color: var(--text);
      padding: 10px 14px;
      font: inherit;
    }
    input[type="text"], input[type="password"] { width: 100%; }
    button {
      cursor: pointer;
      background: linear-gradient(180deg, #2b6de0, #1f57b8);
      border-color: #2f66cc;
    }
    button.secondary { background: #182233; border-color: var(--border); }
    button:disabled { opacity: 0.6; cursor: wait; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 0.85rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
    .dot.on { background: var(--ok); }
    .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    canvas {
      width: 100%;
      height: 220px;
      background: #101826;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .hint { color: var(--muted); font-size: 0.8rem; margin-top: 10px; }
    .err { color: var(--bad); font-size: 0.9rem; margin-top: 8px; white-space: pre-wrap; }
    #loginGate {
      position: fixed; inset: 0; display: grid; place-items: center;
      background: rgba(8,12,20,0.72); backdrop-filter: blur(6px); z-index: 20;
    }
    #loginGate.hidden { display: none; }
    #loginCard { width: min(380px, calc(100vw - 32px)); }
    .stack { display: grid; gap: 12px; }
    #appPanel.hidden { display: none; }
    .field-row { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 640px) { .field-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div id="loginGate">
    <section class="card" id="loginCard">
      <h1 style="margin-bottom:8px">Cache admin login</h1>
      <p class="sub" style="margin-bottom:16px">
        First login: <code>${CACHE_ADMIN_DEFAULT_USERNAME}</code> / <code>${CACHE_ADMIN_DEFAULT_PASSWORD}</code> (saved in Redis).
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
        <button type="submit">Sign in</button>
        <div class="err" id="loginError"></div>
      </form>
    </section>
  </div>

  <main id="appPanel" class="hidden">
    <div class="row" style="margin-bottom:18px">
      <div>
        <h1>Drizzle query cache</h1>
        <p class="sub" style="margin:0">Toggle caching, adjust default TTL, and inspect hourly hit rate.</p>
      </div>
      <button id="logoutBtn" class="secondary" type="button">Log out</button>
    </div>

    <section class="card">
      <div class="row">
        <div>
          <label>Status</label>
          <div class="pill" style="margin-top:8px">
            <span id="enabledDot" class="dot"></span>
            <span id="enabledLabel">Loading…</span>
          </div>
        </div>
        <div class="controls">
          <button id="enableBtn" type="button">Enable</button>
          <button id="disableBtn" class="secondary" type="button">Disable</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="row">
        <div>
          <label>Default TTL (seconds)</label>
          <div class="value" id="ttlValue">—</div>
          <div class="hint">Allowed ${CACHE_TTL_MIN_SECONDS}–${CACHE_TTL_MAX_SECONDS}s (default ${CACHE_TTL_DEFAULT_SECONDS}s)</div>
        </div>
        <div class="controls">
          <input id="ttlInput" type="number" min="${CACHE_TTL_MIN_SECONDS}" max="${CACHE_TTL_MAX_SECONDS}" step="1" />
          <button id="ttlSave" type="button">Save TTL</button>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="row" style="margin-bottom:12px">
        <div>
          <label>Hit rate (last 24 local hours)</label>
          <div class="value" id="hitRate">—</div>
        </div>
        <button id="refreshBtn" class="secondary" type="button">Refresh</button>
      </div>
      <canvas id="chart" width="800" height="220"></canvas>
      <div class="hint" id="statsHint">Attach RedisHourlyStatsPlugin to collect hit/miss stats.</div>
      <div class="err" id="error"></div>
    </section>

    <section class="card">
      <label>Change admin credentials (saved in Redis)</label>
      <div class="field-row" style="margin-top:10px">
        <input id="newUser" type="text" placeholder="New username" autocomplete="off" />
        <input id="newPass" type="password" placeholder="New password" autocomplete="new-password" />
      </div>
      <div class="controls" style="margin-top:12px">
        <button id="credsSave" type="button">Update credentials</button>
      </div>
    </section>
  </main>
  <script>
    const apiBase = location.pathname.replace(/\\/index\\.html$/, '').replace(/\\/$/, '');
    const AUTH_KEY = 'drizzle-cache-admin-basic';

    const loginGate = document.getElementById('loginGate');
    const appPanel = document.getElementById('appPanel');
    const loginError = document.getElementById('loginError');
    const errorEl = document.getElementById('error');

    function getAuthHeader() {
      return sessionStorage.getItem(AUTH_KEY) || '';
    }

    function setAuth(username, password) {
      sessionStorage.setItem(AUTH_KEY, 'Basic ' + btoa(username + ':' + password));
    }

    function clearAuth() {
      sessionStorage.removeItem(AUTH_KEY);
    }

    function showApp() {
      loginGate.classList.add('hidden');
      appPanel.classList.remove('hidden');
    }

    function showLogin() {
      clearAuth();
      appPanel.classList.add('hidden');
      loginGate.classList.remove('hidden');
    }

    const api = (path, init) => fetch(apiBase + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: getAuthHeader(),
        ...(init && init.headers),
      },
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) {
        showLogin();
        throw new Error(body.error || 'Unauthorized');
      }
      if (!r.ok) throw new Error(body.error || body.message || r.statusText || 'Request failed');
      return body;
    });

    const enabledDot = document.getElementById('enabledDot');
    const enabledLabel = document.getElementById('enabledLabel');
    const ttlValue = document.getElementById('ttlValue');
    const ttlInput = document.getElementById('ttlInput');
    const hitRate = document.getElementById('hitRate');
    const statsHint = document.getElementById('statsHint');
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');

    function setBusy(busy) {
      for (const id of ['enableBtn','disableBtn','ttlSave','refreshBtn','credsSave']) {
        document.getElementById(id).disabled = busy;
      }
    }

    function drawChart(stats) {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#101826';
      ctx.fillRect(0, 0, w, h);
      if (!stats.length) return;

      const pad = 24;
      const rates = stats.map((s) => s.hitRate || 0);
      const max = 1;
      ctx.strokeStyle = '#2a3548';
      ctx.beginPath();
      ctx.moveTo(pad, pad);
      ctx.lineTo(pad, h - pad);
      ctx.lineTo(w - pad, h - pad);
      ctx.stroke();

      ctx.strokeStyle = '#3d8bfd';
      ctx.lineWidth = 2;
      ctx.beginPath();
      rates.forEach((rate, i) => {
        const x = pad + (i * (w - pad * 2)) / Math.max(rates.length - 1, 1);
        const y = h - pad - rate * (h - pad * 2) / max;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    async function refresh() {
      errorEl.textContent = '';
      setBusy(true);
      try {
        const data = await api('/api');
        enabledDot.classList.toggle('on', !!data.enabled);
        enabledLabel.textContent = data.enabled ? 'Caching enabled' : 'Caching disabled';
        ttlValue.textContent = data.ttlSeconds + 's';
        ttlInput.value = data.ttlSeconds;
        const stats = data.stats || [];
        const latest = stats[stats.length - 1];
        const total = latest ? (latest.hits + latest.misses) : 0;
        hitRate.textContent = total
          ? ((latest.hits / total) * 100).toFixed(1) + '% this hour'
          : 'n/a';
        statsHint.textContent = stats.some((s) => s.hits + s.misses > 0)
          ? 'Hourly buckets use the process local timezone.'
          : 'No stats yet — attach RedisHourlyStatsPlugin or wait for traffic.';
        drawChart(stats);
        showApp();
      } catch (err) {
        if (!getAuthHeader()) loginError.textContent = String(err.message || err);
        else errorEl.textContent = String(err.message || err);
      } finally {
        setBusy(false);
      }
    }

    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      loginError.textContent = '';
      const username = document.getElementById('loginUser').value;
      const password = document.getElementById('loginPass').value;
      setAuth(username, password);
      try {
        await refresh();
      } catch (err) {
        showLogin();
        loginError.textContent = String(err.message || err);
      }
    };

    document.getElementById('logoutBtn').onclick = () => showLogin();

    document.getElementById('enableBtn').onclick = async () => {
      setBusy(true);
      try { await api('/api/enabled', { method: 'POST', body: JSON.stringify({ enabled: true }) }); await refresh(); }
      catch (err) { errorEl.textContent = String(err.message || err); setBusy(false); }
    };
    document.getElementById('disableBtn').onclick = async () => {
      setBusy(true);
      try { await api('/api/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) }); await refresh(); }
      catch (err) { errorEl.textContent = String(err.message || err); setBusy(false); }
    };
    document.getElementById('ttlSave').onclick = async () => {
      setBusy(true);
      try {
        await api('/api/ttl', { method: 'POST', body: JSON.stringify({ seconds: Number(ttlInput.value) }) });
        await refresh();
      } catch (err) { errorEl.textContent = String(err.message || err); setBusy(false); }
    };
    document.getElementById('credsSave').onclick = async () => {
      setBusy(true);
      errorEl.textContent = '';
      try {
        const username = document.getElementById('newUser').value;
        const password = document.getElementById('newPass').value;
        await api('/api/credentials', { method: 'POST', body: JSON.stringify({ username, password }) });
        setAuth(username, password);
        document.getElementById('newPass').value = '';
        errorEl.textContent = '';
        alert('Credentials updated');
      } catch (err) {
        errorEl.textContent = String(err.message || err);
      } finally {
        setBusy(false);
      }
    };
    document.getElementById('refreshBtn').onclick = () => refresh();

    if (getAuthHeader()) refresh();
  </script>
</body>
</html>`;