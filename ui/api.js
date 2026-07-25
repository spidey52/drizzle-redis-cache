const AUTH_KEY = 'drizzle-cache-admin-basic';

export function getAuthHeader() {
  return localStorage.getItem(AUTH_KEY) || '';
}

export function hasStoredAuth() {
  return Boolean(getAuthHeader());
}

export function setAuth(username, password) {
  localStorage.setItem(AUTH_KEY, 'Basic ' + btoa(username + ':' + password));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

export function createApi(apiBase, { onUnauthorized } = {}) {
  return async function api(path, init) {
    const response = await fetch(apiBase + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: getAuthHeader(),
        ...(init && init.headers),
      },
    });

    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      onUnauthorized?.();
      throw new Error(body.error || 'Unauthorized');
    }
    if (!response.ok) {
      throw new Error(body.error || body.message || response.statusText || 'Request failed');
    }
    return body;
  };
}
