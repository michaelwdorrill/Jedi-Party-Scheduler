import { useMemo, useState } from 'react';
import { API_BASE_URL } from '../api/client';
import { Button, Card, PageHeader } from '../components/ui';

// IDEAS item 9 / docs/specs/0015: self-service "add this bot to your server"
// requests, gated by owner approval. Deliberately outside AuthGuard (see
// App.tsx) -- this page drives its own short-lived Discord OAuth round trip
// rather than the site's login session, because that session never carries a
// live Discord token to check "does this person administer guild X" with.
// It still needs an existing account (the Worker checks that server-side),
// so this is public in the sense that anyone can land on it and start the
// flow, not that a total stranger can complete it.

interface Candidate {
  guildId: string;
  guildName: string;
  token?: string;
  alreadyAdded?: boolean;
}

// The Worker's /guild-requests/callback hands this page a base64'd JSON
// array via ?data= after its own OAuth round trip -- see
// routes/guildRequests.ts for the encode side of this exact pair of calls.
function parseCandidates(raw: string | null): Candidate[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(raw))));
  } catch {
    return null;
  }
}

type SubmitOutcome = { kind: 'already_active' | 'already_pending'; message: string } | { kind: 'error'; message: string };

export default function RequestBotPage() {
  // This is a HashRouter, so the query string the Worker appended lives
  // after the '#' -- same parsing AuthCallbackPage.tsx uses for its own
  // token out of the login redirect.
  const candidates = useMemo(
    () => parseCandidates(new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('data')),
    [],
  );
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  const startConnect = () => {
    window.location.href = `${API_BASE_URL}/guild-requests/connect`;
  };

  const submitRequest = async (candidate: Candidate) => {
    setSubmitting(candidate.guildId);
    setOutcome(null);
    try {
      // Not the shared `api` client (api/client.ts): it treats any 401 as
      // this browser's *site* session having expired and bounces to
      // /login, clearing the stored token -- which would be wrong here,
      // since this endpoint isn't authenticated by that session at all.
      const res = await fetch(`${API_BASE_URL}/guild-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: candidate.token }),
      });
      // Every error path this route (and its neighbours in guildRequests.ts)
      // returns is plain text, not JSON -- the same convention the shared
      // `api` client (api/client.ts's `request()`) already follows for every
      // other endpoint in the app. Parsing as JSON unconditionally, before
      // checking res.ok, meant any of those plain-text errors threw here and
      // fell into the catch below as a misleading "Could not reach the
      // server" -- found live on the sandbox both for an expired token and
      // for a request sent with no token at all.
      if (!res.ok) {
        const message = await res.text();
        setOutcome({ kind: 'error', message: message || 'This request link has expired. Please start over.' });
        return;
      }
      const body = (await res.json()) as { status: string; message?: string; botInviteUrl?: string };
      if (body.status === 'created' && body.botInviteUrl) {
        // Discord's own consent screen is what actually adds the bot --
        // approval governs whether the app treats the server as
        // allow-listed, not whether the bot technically joins it.
        window.location.href = body.botInviteUrl;
        return;
      }
      setOutcome({ kind: body.status as 'already_active' | 'already_pending', message: body.message ?? '' });
    } catch {
      setOutcome({ kind: 'error', message: 'Could not reach the server. Please try again.' });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Add the bot to your server" />

      {candidates === null ? (
        <Card>
          <p className="text-sm text-muted">
            If you administer a Discord server and want to use this app there, start here. You'll be
            asked to sign in with Discord so we can confirm which servers you actually manage — this is
            separate from your login on this site, and nothing about your Discord account is stored
            beyond that check.
          </p>
          <p className="mt-2 text-sm text-faint">
            You'll need to have logged into this site at least once already.
          </p>
          <Button className="mt-4" onClick={startConnect}>
            Continue with Discord
          </Button>
        </Card>
      ) : candidates.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            Discord doesn't say you administer any servers. If you expected to see one here, make sure
            you're an owner or have the Manage Server permission on it.
          </p>
        </Card>
      ) : (
        <Card title="Pick a server">
          <ul className="divide-y divide-edge">
            {candidates.map((c) => (
              <li key={c.guildId} className="flex items-center justify-between gap-3 py-3">
                <span className={c.alreadyAdded ? 'text-faint' : undefined}>{c.guildName}</span>
                {c.alreadyAdded ? (
                  <span className="text-sm text-faint">Already added</span>
                ) : (
                  <Button size="sm" disabled={submitting === c.guildId} onClick={() => void submitRequest(c)}>
                    {submitting === c.guildId ? 'Requesting…' : 'Request'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {outcome && (
            <p className={`mt-3 text-sm ${outcome.kind === 'error' ? 'text-danger-text' : 'text-muted'}`}>
              {outcome.kind === 'already_active'
                ? 'This server already has the bot.'
                : outcome.kind === 'already_pending'
                  ? 'A request for this server is already pending review.'
                  : outcome.message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
