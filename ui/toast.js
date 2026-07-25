let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toast-host';
  document.body.appendChild(host);
  return host;
}

export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  ensureHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, 2800);
}
