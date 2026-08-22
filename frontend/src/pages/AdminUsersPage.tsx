import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface AdminUser {
  id: string;
  username: string;
  globalName: string | null;
  notificationsEnabled: boolean;
  lastLoginAt: number | null;
  // When someone reached a valid Discord profile but was turned away for
  // sharing no allow-listed server, this is set and lastLoginAt is not.
  lastLoginAttemptAt: number | null;
  // Includes departed memberships, flagged -- filtering them out server-side
  // is what made "left this server" look like "was never in it".
  guilds: { id: string; name: string; isMember: boolean }[];
}

interface UsersPage {
  users: AdminUser[];
  nextCursor: string | null;
}

// Owner-only (idea 11). The link to this page is hidden from everyone else,
// but that's UX, not a security control -- the actual gate is the worker's
// /admin/* middleware, and this page fails closed on a 403 rather than
// trusting the caller's own `user.isOwner` read to mean anything.
export default function AdminUsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const loadPage = async (after?: string) => {
    try {
      const page = await api.get<UsersPage>(`/admin/users${after ? `?after=${after}` : ''}`);
      setUsers((prev) => (after ? [...prev, ...page.users] : page.users));
      setCursor(page.nextCursor);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else throw e;
    }
  };

  useEffect(() => {
    setLoading(true);
    loadPage().finally(() => setLoading(false));
  }, []);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await loadPage(cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  if (forbidden || (user && !user.isOwner)) {
    return <p className="text-sm text-slate-400">You don't have access to this page.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">All users</h1>
      <p className="text-sm text-slate-500">
        Owner-only. Users, which servers they're in, and when they last logged in -- no event
        content, per the Privacy Policy.
      </p>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Servers</th>
                <th className="px-3 py-2 font-medium">Last login</th>
                <th className="px-3 py-2 font-medium">DMs</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-slate-800">
                  <td className="px-3 py-2">
                    {u.globalName ?? u.username}
                    <span className="ml-1 text-xs text-slate-500">@{u.username}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {u.guilds.length === 0 ? (
                      '—'
                    ) : (
                      <span className="flex flex-wrap gap-x-2">
                        {u.guilds.map((g) => (
                          <span
                            key={g.id}
                            className={g.isMember ? '' : 'text-slate-600 line-through'}
                            title={g.isMember ? undefined : 'No longer a member of this server'}
                          >
                            {g.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {u.lastLoginAt ? (
                      DateTime.fromMillis(u.lastLoginAt).toRelative()
                    ) : u.lastLoginAttemptAt ? (
                      <span
                        className="text-amber-500"
                        title="Signed in with Discord but was turned away for sharing no allow-listed server"
                      >
                        turned away {DateTime.fromMillis(u.lastLoginAttemptAt).toRelative()}
                      </span>
                    ) : (
                      'never'
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{u.notificationsEnabled ? 'on' : 'off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && (
        <button
          disabled={loadingMore}
          onClick={loadMore}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
