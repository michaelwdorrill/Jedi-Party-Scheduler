import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { describeError, useAction, useAsync } from '../lib/async';
import { buttonClass, cardClass, InlineError, Select } from './ui';
import type { GoogleCalendarOption, GoogleCalendarStatus } from '../types';

// IDEAS item 2 / docs/specs/0017: the Settings card for Google Calendar sync.
//
// Its own component rather than another block inside SettingsPage, which is
// already six cards long and whose others are all a control bound to a field on
// the user record. This one owns a load, a redirect out to Google and back, a
// second dependent load (the calendar list) and a disconnect that completes
// asynchronously -- state that has no business being interleaved with a
// timezone dropdown.

// What the Worker's /google/callback appends when it sends the browser back
// here. Not free text: each maps to a specific outcome the callback can
// distinguish, and saying which one it was is the difference between "try
// again" and "that won't work until you fix something".
const RETURN_MESSAGES: Record<string, { tone: 'ok' | 'bad'; text: string }> = {
  connected: { tone: 'ok', text: 'Google Calendar connected.' },
  cancelled: { tone: 'bad', text: 'Connection cancelled — nothing was changed.' },
  unverified: {
    tone: 'bad',
    text: "That connection attempt couldn't be verified. Please start it again from this page.",
  },
  no_refresh_token: {
    tone: 'bad',
    text: 'Google did not grant long-term access, so syncing would stop working within the hour. Try connecting again and accept the offline-access prompt.',
  },
  failed: { tone: 'bad', text: "Connecting to Google didn't work. Please try again." },
  // The Worker's OAuth callback rate limit (item 92 / release-bar clause 3).
  // Reachable by an ordinary user only if they retry the connect flow many
  // times in a minute, so the message says the one thing that actually helps:
  // it clears on its own.
  rate_limited: {
    tone: 'bad',
    text: 'Too many connection attempts from your network. Please wait a minute and try again.',
  },
};

function formatSyncedAt(ms: number | null | undefined): string {
  if (!ms) return 'not yet';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ConnectedCalendars() {
  const status = useAsync(() => api.get<GoogleCalendarStatus>('/google/status'), []);
  const action = useAction();
  const [calendars, setCalendars] = useState<GoogleCalendarOption[] | null>(null);
  // Distinct from `calendars === null`, which also describes "still loading"
  // and "never fetched" -- this is specifically "we tried and it failed",
  // which is what the picker being stuck disabled needs to explain rather
  // than leave silent. `calendarsNonce` is what a Retry click bumps to make
  // the effect below run again without duplicating its own fetch logic.
  const [calendarsError, setCalendarsError] = useState(false);
  const [calendarsNonce, setCalendarsNonce] = useState(0);
  const [returnNotice, setReturnNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const reloadStatus = status.reload;

  // The Worker redirects to `#/settings?google=…`, so the parameter lives in
  // the hash rather than in location.search -- the same HashRouter quirk
  // AuthCallbackPage already reads its token out of. Cleared from the URL once
  // read, so a refresh doesn't re-announce a connection that happened minutes
  // ago.
  useEffect(() => {
    const query = window.location.hash.split('?')[1];
    if (!query) return;
    const params = new URLSearchParams(query);
    const outcome = params.get('google');
    if (!outcome) return;
    const pendingId = params.get('pending');
    window.history.replaceState(null, '', window.location.hash.split('?')[0]);

    // A grant comes back parked rather than attached now (F-16 / R01 in the
    // Pass-11 review). Claiming it is an ordinary authenticated request, and
    // that is the whole point: the Worker can finally see *who is signed in*
    // here, which neither the start URL nor the OAuth callback could. If this
    // browser is signed in as someone else -- which is exactly what happens
    // when the connect link came from another person -- the Worker refuses
    // the claim and revokes the grant at Google rather than attaching it.
    if (outcome === 'pending' && pendingId) {
      api
        .post('/google/finalize', { pendingId })
        .then(() => {
          setReturnNotice(RETURN_MESSAGES.connected);
          reloadStatus();
        })
        .catch((e: unknown) => {
          setReturnNotice({ tone: 'bad', text: describeError(e) });
        });
      return;
    }

    setReturnNotice(RETURN_MESSAGES[outcome] ?? RETURN_MESSAGES.failed);
    // `reloadStatus` is useAsync's stable useCallback, so this still runs
    // exactly once on mount -- it is named as a dependency rather than
    // suppressed because it genuinely is one.
  }, [reloadStatus]);

  const connection = status.data;

  // The calendar list is a second round trip through Google, so it is only
  // fetched once we know there is a live connection to ask on behalf of.
  useEffect(() => {
    if (!connection?.connected || connection.status === 'disconnecting') return;
    let cancelled = false;
    setCalendarsError(false);
    api
      .get<GoogleCalendarOption[]>('/google/calendars')
      .then((list) => {
        if (!cancelled) setCalendars(list);
      })
      .catch(() => {
        // Not surfaced as connection.lastError's kind of failure -- that field
        // is about the grant itself, and this can fail for reasons that have
        // nothing to do with it (a slow Google response, a network blip). But
        // it has to be surfaced as *something*: leaving `calendars` at `null`
        // forever disabled both pickers below with nothing on screen to say
        // why, which read as the app being broken rather than one request
        // having failed. `calendarsError` is what lets the picker say so and
        // offer a way to try again, instead of silently sitting there.
        if (!cancelled) setCalendarsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [connection?.connected, connection?.status, calendarsNonce]);

  // Hidden entirely when the operator hasn't provisioned Google on this
  // deployment. A button whose only possible outcome is a 503 is worse than no
  // button -- it advertises a feature and then blames the person who pressed it.
  if (status.loading || !connection?.configured) return null;

  // Two hops on purpose. This returns a URL on the *Worker*, not on Google, and
  // navigating to it top-level is what lets the Worker set the nonce cookie the
  // callback checks -- a cookie it cannot set on this XHR's own response, since
  // the Worker is a different origin and the API client sends no credentials.
  const connect = () =>
    action.run(async () => {
      const { startUrl } = await api.post<{ startUrl: string }>('/google/connect-url');
      window.location.href = startUrl;
    });

  const disconnect = async () => {
    if (
      !confirm(
        'Disconnect Google Calendar?\n\nUpcoming sessions this app added will be removed from that calendar, and its access to your Google account will be revoked. Sessions that have already happened are left alone.',
      )
    ) {
      return;
    }
    if (await action.run(() => api.delete('/google'))) status.reload();
  };

  const update = async (patch: {
    calendarId?: string;
    syncEnabled?: boolean;
    readCalendarId?: string | null;
  }) => {
    if (await action.run(() => api.patch('/google', patch))) status.reload();
  };

  return (
    <div className={cardClass('md', 'space-y-3')}>
      <h2 className="font-semibold">Connected calendars</h2>

      {returnNotice &&
        (returnNotice.tone === 'ok' ? (
          <p className="text-sm text-success-text">{returnNotice.text}</p>
        ) : (
          <InlineError message={returnNotice.text} onDismiss={() => setReturnNotice(null)} />
        ))}

      {action.error && <InlineError message={action.error} onDismiss={action.clearError} />}

      {!connection.connected && (
        <>
          <p className="text-sm text-muted">
            Put the sessions you're committed to on your own Google calendar. Only the title, the
            time, which server it's on and a link back here are sent — never an event's description,
            and never a poll's proposed dates or anything you've declined.
          </p>
          <button disabled={action.pending} onClick={connect} className={buttonClass('primary', 'lg')}>
            {action.pending ? 'Opening Google…' : 'Connect Google Calendar'}
          </button>
        </>
      )}

      {connection.connected && connection.status === 'disconnecting' && (
        <p className="text-sm text-muted">
          Disconnecting — the upcoming entries this app added are being removed from your Google
          calendar, and access will be revoked once that's done. Nothing new is being written in the
          meantime.
        </p>
      )}

      {connection.connected && connection.status !== 'disconnecting' && (
        <>
          <p className="text-sm text-muted">
            Connected as <strong>{connection.accountEmail ?? 'your Google account'}</strong>.
          </p>

          {connection.lastError && (
            <InlineError message={connection.lastError} onRetry={connect} />
          )}

          {calendarsError && (
            <InlineError
              message="Couldn't load your list of Google calendars, so the pickers below are stuck empty."
              onRetry={() => setCalendarsNonce((n) => n + 1)}
            />
          )}

          <div>
            <label className="mb-1 block text-sm text-muted" htmlFor="google-calendar-select">
              Calendar to write to
            </label>
            <Select
              id="google-calendar-select"
              value={connection.calendarId ?? 'primary'}
              onChange={(e) => update({ calendarId: e.target.value })}
              disabled={action.pending || !calendars}
            >
              {calendars ? (
                calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}
                    {c.primary ? ' (default)' : ''}
                  </option>
                ))
              ) : (
                <option value={connection.calendarId ?? 'primary'}>
                  {connection.calendarId ?? 'primary'}
                </option>
              )}
            </Select>
            <p className="mt-1 text-xs text-faint">
              Changing this writes future sessions to the new calendar. Entries already added to the
              old one stay where they are.
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm text-ink-dim">
            <input
              type="checkbox"
              checked={connection.syncEnabled ?? false}
              disabled={action.pending}
              onChange={(e) => update({ syncEnabled: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Sync my sessions to this calendar
              <span className="block text-xs text-faint">
                Last synced: {formatSyncedAt(connection.lastSyncedAt)}. Updates run in the
                background, so a change can take a few minutes to appear.
              </span>
            </span>
          </label>

          <div className="border-t border-line/60 pt-3">
            <label className="mb-1 block text-sm text-muted" htmlFor="google-read-select">
              Read my busy times from
            </label>
            <Select
              id="google-read-select"
              value={connection.readCalendarId ?? ''}
              onChange={(e) => update({ readCalendarId: e.target.value === '' ? null : e.target.value })}
              disabled={action.pending || !calendars}
            >
              {/* Off is the default and the first option, so nobody switches
                  reading on without meaning to. */}
              <option value="">Don't read any of my calendars</option>
              {(calendars ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summary}
                  {c.primary ? ' (default)' : ''}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-faint">
              Optional, and separate from the calendar above. When set, people you're scheduling with
              see you as busy at those times — as blank blocks only, never the titles. Uncle Owen
              reads that one calendar and no others.
            </p>
          </div>

          <button
            disabled={action.pending}
            onClick={disconnect}
            className={buttonClass('secondary')}
          >
            Disconnect
          </button>
        </>
      )}
    </div>
  );
}
