import { getToken, setToken, clearToken } from '../auth/tokenStorage';

// Set at build time via GitHub Actions (VITE_API_BASE_URL repo variable);
// falls back to a placeholder for local dev against `wrangler dev`.
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Access tokens are short-lived by design (the session that actually grants
// authority lives server-side and can be revoked instantly). Concurrent
// requests that all hit a stale token share one in-flight refresh instead of
// each racing their own.
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const { token: newToken } = (await res.json()) as { token: string };
    setToken(newToken);
    return true;
  } catch {
    return false;
  }
}

function bounceToLogin(): never {
  clearToken();
  window.location.hash = '#/login';
  throw new ApiError(401, 'Session expired, please log in again.');
}

async function request<T>(path: string, init: RequestInit = {}, isRetry = false): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

  if (res.status === 401 && !isRetry && path !== '/auth/refresh') {
    refreshPromise ??= tryRefresh().finally(() => {
      refreshPromise = null;
    });
    if (await refreshPromise) return request<T>(path, init, true);
    bounceToLogin();
  }

  if (res.status === 401) bounceToLogin();

  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
