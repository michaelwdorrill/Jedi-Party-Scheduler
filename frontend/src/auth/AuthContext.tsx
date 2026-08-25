import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '../api/client';
import { describeAuthError } from '../lib/async';
import type { User } from '../types';
import { clearToken, getToken, setToken } from './tokenStorage';
import { revokeOrQueue, startRevocationRetries, type LogoutOutcome } from './pendingRevocation';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (token: string) => Promise<void>;
  // The local session is cleared either way; this reports what happened to
  // the server-side one, so the caller can be honest about it rather than
  // always claiming success.
  logout: () => Promise<LogoutOutcome>;
  // Set when we could not find out who you are -- an unreachable Worker, or a
  // 5xx -- as opposed to finding out you are nobody. Those are different
  // facts, and only one of them justifies sending someone to the login page
  // (idea 24, extended down into auth after the sandbox review).
  //
  // A 401 never lands here: the API client handles it, refreshing the token
  // and then bouncing to /login itself, which is the correct response to a
  // session that really has ended.
  error: string | null;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setError(null);
      setLoading(false);
      return;
    }
    // A stored token that's past its short access-token lifetime is handled
    // transparently by the API client (it silently calls /auth/refresh and
    // retries) as long as the underlying session hasn't been revoked -- so
    // there's no client-side expiry check needed here.
    try {
      const me = await api.get<User>('/me');
      setUser(me);
      setError(null);
    } catch (e) {
      setUser(null);
      // Deliberately not cleared before the request: on a retry the existing
      // error has to stay on screen until this resolves, or the guard sees
      // "no user, no error" for the duration of the round trip and redirects
      // to the login page mid-retry -- the exact thing being fixed.
      //
      // Not `setLoading(true)` up front either, for a smaller reason:
      // SettingsPage calls this after saving, and the guard renders its
      // loading state full-screen, so that would flash the whole app.
      setError(describeAuthError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  // A logout whose network call didn't land leaves a token parked in storage;
  // this retries it now and on every return to connectivity, so the session
  // still gets revoked even though the tab that asked for it is long gone.
  useEffect(() => startRevocationRetries(), []);

  const login = useCallback(
    async (token: string) => {
      setToken(token);
      setLoading(true);
      await refreshUser();
    },
    [refreshUser],
  );

  const logout = useCallback(async () => {
    const token = getToken();
    // Clear the local session first so the UI responds immediately and can't
    // be left half-logged-in by a hanging request.
    clearToken();
    setUser(null);
    setError(null);
    if (!token) return { confirmed: true, queued: false };
    // The token is durably parked before it's used, so a revocation that
    // fails here is retried later rather than lost with the only credential
    // that could have identified the session.
    return revokeOrQueue(token);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, isAuthenticated: !!user, login, logout, error, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
