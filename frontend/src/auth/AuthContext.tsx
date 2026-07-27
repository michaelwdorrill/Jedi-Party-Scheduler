import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '../api/client';
import type { User } from '../types';
import { clearToken, getToken, setToken } from './tokenStorage';
import { revokeOrQueue, startRevocationRetries } from './pendingRevocation';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (token: string) => Promise<void>;
  // Resolves false when the server-side session could not be confirmed
  // revoked. The local session is cleared either way -- the caller decides
  // whether to say anything about it.
  logout: () => Promise<boolean>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
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
    } catch {
      setUser(null);
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
    if (!token) return true;
    // The token is durably parked before it's used, so a revocation that
    // fails here is retried later rather than lost with the only credential
    // that could have identified the session.
    return revokeOrQueue(token);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, isAuthenticated: !!user, login, logout, refreshUser }}
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
