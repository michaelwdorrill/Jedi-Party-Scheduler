import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../lib/async';
import { ErrorState, Loading, buttonClass, cardClass } from '../components/ui';

interface AdminGuildRef {
  id: string;
  name: string;
  isMember: boolean;
}

interface AdminUser {
  id: string;
  username: string;
  globalName: string | null;
  guilds: AdminGuildRef[];
}

interface UsersPage {
  users: AdminUser[];
  nextCursor: string | null;
}

interface ServerRef {
  id: string;
  name: string;
}

// Owner-only (same gate as AdminUsersPage), and deliberately built on top of
// GET /admin/users rather than a new endpoint -- it already returns exactly
// the shape this needs (every registered user, and which servers each is or
// was a member of), and paging through it here is the only new logic.
//
// Membership toggles in the matrix are a client-side what-if, never written
// back -- picking a hypothetical group and seeing whether it has a common
// server is the same question assertValidRoster() answers on the real write
// path (specs/0011 / IDEAS item 36), and answering it here first is cheaper
// than finding out via a rejected group save or a drifted event.
export default function AdminVenueOverlapPage() {
  const { user } = useAuth();
  const [people, setPeople] = useState<AdminUser[]>([]);
  const [servers, setServers] = useState<ServerRef[]>([]);
  // userId -> guildId -> "is a member", seeded from the fetch and then free to
  // toggle locally.
  const [membership, setMembership] = useState<Record<string, Record<string, boolean>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const all: AdminUser[] = [];
      let cursor: string | null = null;
      do {
        const page: UsersPage = await api.get<UsersPage>(`/admin/users${cursor ? `?after=${cursor}` : ''}`);
        all.push(...page.users);
        cursor = page.nextCursor;
      } while (cursor);

      const serverNames = new Map<string, string>();
      const memberMap: Record<string, Record<string, boolean>> = {};
      for (const p of all) {
        memberMap[p.id] = {};
        for (const g of p.guilds) {
          serverNames.set(g.id, g.name);
          memberMap[p.id][g.id] = g.isMember;
        }
      }

      setPeople(all);
      setServers([...serverNames.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
      setMembership(memberMap);
      setSelected(new Set());
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMember = (userId: string, guildId: string) => {
    setMembership((prev) => ({
      ...prev,
      [userId]: { ...prev[userId], [guildId]: !prev[userId]?.[guildId] },
    }));
  };

  if (forbidden || (user && !user.isOwner)) {
    return <p className="text-sm text-muted">You don't have access to this page.</p>;
  }

  const selectedPeople = people.filter((p) => selected.has(p.id));
  const common =
    selectedPeople.length === 0 ? [] : servers.filter((s) => selectedPeople.every((p) => membership[p.id]?.[s.id]));
  const names = selectedPeople.map((p) => p.globalName ?? p.username).join(', ');

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">Venue overlap</h1>
      <p className="text-sm text-faint">
        Owner-only. Pick people below to see which server, if any, every one of them shares -- the
        same intersection rule <code className="rounded bg-raised px-1 text-xs">commonServerSet()</code> enforces
        for a real group. Toggling a membership cell explores a hypothetical; it never changes
        anyone's actual membership.
      </p>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div
            className={cardClass(
              'md',
              selectedPeople.length === 0
                ? 'text-sm text-muted'
                : common.length === 0
                  ? 'border-danger/60 bg-danger-surface/40'
                  : 'border-success/50 bg-success-surface/40',
            )}
          >
            {selectedPeople.length === 0 ? (
              <p>Check people below to see where they could all meet.</p>
            ) : common.length === 0 ? (
              <>
                <p className="font-display text-lg uppercase tracking-wide text-danger-text">
                  No common server -- this group is impossible
                </p>
                <p className="mt-1 text-sm text-ink-dim">{names} don't all share a single server.</p>
              </>
            ) : (
              <>
                <p className="font-semibold text-success-text">{names} can all meet on:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {common.map((s) => (
                    <span key={s.id} className="rounded-full bg-raised px-3 py-1 text-xs">
                      {s.name}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-[240px_1fr]">
            <div className={cardClass('sm', 'space-y-1')}>
              <h2 className="mb-1 text-sm font-semibold text-muted">Group ({selectedPeople.length})</h2>
              {people.map((p) => (
                <label key={p.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-raised">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)} />
                  {p.globalName ?? p.username}
                </label>
              ))}
            </div>

            <div className={cardClass('sm', 'overflow-x-auto')}>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="px-2 py-1"></th>
                    {servers.map((s) => (
                      <th key={s.id} className="whitespace-nowrap px-2 py-1 font-medium text-muted">
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id} className={selected.has(p.id) ? 'bg-raised/40' : undefined}>
                      <th className="whitespace-nowrap px-2 py-1 text-left font-medium">{p.globalName ?? p.username}</th>
                      {servers.map((s) => (
                        <td key={s.id} className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={!!membership[p.id]?.[s.id]}
                            onChange={() => toggleMember(p.id, s.id)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button onClick={load} className={buttonClass('secondary', 'sm')}>
            Refresh from server
          </button>
        </>
      )}
    </div>
  );
}
