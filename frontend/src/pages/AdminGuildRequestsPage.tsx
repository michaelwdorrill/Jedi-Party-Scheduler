import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../lib/async';
import { ErrorState, InlineError, Loading, buttonClass } from '../components/ui';

interface GuildRequest {
  id: string;
  guildId: string;
  guildName: string;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  decidedAt: number | null;
}

// Owner-only (specs/0015's admin fallback for the emailed decision links --
// useful if an email is lost, delayed, or the owner just wants to review
// history). Same fail-closed posture as AdminUsersPage.tsx: the actual gate
// is the worker's /admin/* middleware, not this page's own read of
// `user.isOwner`.
export default function AdminGuildRequestsPage() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<GuildRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setRequests(await api.get<GuildRequest[]>('/admin/guild-requests'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(describeError(e));
    }
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, []);

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setDeciding(id);
    try {
      await api.post(`/admin/guild-requests/${id}/${action}`);
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setDeciding(null);
    }
  };

  if (forbidden || (user && !user.isOwner)) {
    return <p className="text-sm text-muted">You don't have access to this page.</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Guild requests</h1>
      <p className="text-sm text-faint">
        Owner-only. Requests to add this bot to a server (idea 9) — the fallback for the emailed
        approve/reject links, in case one is lost or expires.
      </p>

      {loading ? (
        <Loading />
      ) : error && requests.length === 0 ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted">No requests yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-edge">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Server</th>
                <th className="px-3 py-2 font-medium">Requested by</th>
                <th className="px-3 py-2 font-medium">Requested</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t border-edge">
                  <td className="px-3 py-2">
                    {r.guildName}
                    <span className="ml-1 text-xs text-faint">{r.guildId}</span>
                  </td>
                  <td className="px-3 py-2 text-muted">{r.requestedBy}</td>
                  <td className="px-3 py-2 text-muted">{DateTime.fromMillis(r.requestedAt).toRelative()}</td>
                  <td className="px-3 py-2 text-muted">{r.status}</td>
                  <td className="px-3 py-2">
                    {r.status === 'pending' && (
                      <span className="flex gap-2">
                        <button
                          disabled={deciding === r.id}
                          onClick={() => void decide(r.id, 'approve')}
                          className={buttonClass('primary', 'sm')}
                        >
                          Approve
                        </button>
                        <button
                          disabled={deciding === r.id}
                          onClick={() => void decide(r.id, 'reject')}
                          className={buttonClass('secondary', 'sm')}
                        >
                          Reject
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && requests.length > 0 && <InlineError message={error} />}
    </div>
  );
}
