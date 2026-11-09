import { authEpoch, getToken, setToken, clearToken } from '../auth/tokenStorage';

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

// Pass-13 review (P13-06). `false` from tryRefresh used to mean two different
// things -- "this authentication is dead" and "this work belongs to an
// identity that is no longer current" -- and the caller treated both as the
// first, clearing the stored token and bouncing to login. So the epoch guard
// added for P12-05 turned a silent re-login into a silent logout: a refresh
// begun as account A, discarded correctly when account B was installed,
// then took B's token with it on the way out.
//
// The distinction is drawn in `request` rather than here, by comparing the
// epoch it started in against the one it returns to. That also covers a
// request that attached to an in-flight refresh belonging to a previous
// epoch, which a return value from tryRefresh alone could not.
async function tryRefresh(): Promise<boolean> {
  // Pass-12 review (P12-05). The epoch this refresh belongs to, captured
  // before the await, so a response that arrives after the user has logged out
  // -- or logged in as someone else -- can be recognised as belonging to an
  // identity that is no longer current and dropped instead of installed.
  //
  // Without this the late response reinstated a live token in localStorage for
  // an account the user had just left, and logout's revocation could not have
  // covered it: the session being revoked was this successor's predecessor.
  // Rotation is what made the successor outlive it, so the two halves of
  // P12-04 and this fix belong together.
  const startedAt = authEpoch();
  const token = getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const { token: newToken } = (await res.json()) as { token: string };
    if (authEpoch() !== startedAt) return false;
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
  const startedEpoch = authEpoch();
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

  if (res.status === 401 && !isRetry && path !== '/auth/refresh') {
    refreshPromise ??= tryRefresh().finally(() => {
      refreshPromise = null;
    });
    const refreshed = await refreshPromise;
    // Whoever is logged in now is not who this request was for. Fail it, and
    // leave their session completely alone -- no token clearing, no redirect.
    if (authEpoch() !== startedEpoch) {
      throw new ApiError(401, 'That session has ended.');
    }
    if (refreshed) return request<T>(path, init, true);
    bounceToLogin();
  }

  // Pass-14 review (P14-04). The same identity check as the branch above, on
  // the branch that actually clears credentials.
  //
  // The P13-06 guard was put only on the first 401, so a request RETRIED with
  // isRetry=true skipped it entirely and its own terminal 401 cleared the
  // token and redirected unconditionally. The sequence: an expired request
  // refreshes successfully, and while its retry is in flight the user logs out
  // and signs in as someone else -- the retry's correct 401 for the old
  // session then logged the new one out. An obsolete request must be abandoned
  // without touching whoever is signed in now.
  if (res.status === 401) {
    if (authEpoch() !== startedEpoch) throw new ApiError(401, 'That session has ended.');
    bounceToLogin();
  }

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
