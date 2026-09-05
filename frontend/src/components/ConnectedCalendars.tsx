import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAction, useAsync } from '../lib/async';
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
};

function formatSyncedAt(ms: number | null | undefined): string {
  if (!ms) return 'not yet';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function ConnectedCalendars() {
  const status = useAsync(() => api.get<GoogleCalendarStatus>('/google/status'), []);
  const action = useAction();
  const [calendars, setCalendars] = useState<GoogleCalendarOption[] | null>(null);
  const [returnNotice, setReturnNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  // The Worker redirects to `#/settings?google=…`, so the parameter lives in
  // the hash rather than in location.search -- the same HashRouter quirk
  // AuthCallbackPage already reads its token out of. Cleared from the URL once
  // read, so a refresh doesn't re-announce a connection that happened minutes
  // ago.
  useEffect(() => {
    const query = window.location.hash.split('?')[1];
    if (!query) return;
    const outcome = new URLSearchParams(query).get('google');
    if (!outcome) return;
    setReturnNotice(RETURN_MESSAGES[outcome] ?? RETURN_MESSAGES.failed);
    window.history.replaceState(null, '', window.location.hash.split('?')[0]);
  }, []);

  const connection = status.data;

  // The calendar list is a second round trip through Google, so it is only
  // fetched once we know there is a live connection to ask on behalf of.
  useEffect(() => {
    if (!connection?.connected || connection.status === 'disconnecting') return;
    let cancelled = false;
    api
      .get<GoogleCalendarOption[]>('/google/calendars')
      .then((list) => {
        if (!cancelled) setCalendars(list);
      })
      // Deliberately swallowed rather than surfaced: failing to list calendars
      // does not stop syncing, and connection.lastError below already carries
      // the reason when the grant itself is the problem. Showing two errors for
      // one cause reads as two faults.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connection?.connected, connection?.status]);

  // Hidden entirely when the operator hasn't provisioned Google on this
  // deployment. A button whose only possible outcome is a 503 is worse than no
  // button -- it advertises a feature and then blames the person who pressed it.
  if (status.loading || !connection?.configured) return null;

  const connect = () =>
    action.run(async () => {
      const { authorizeUrl } = await api.post<{ authorizeUrl: string }>('/google/connect-url');
      window.location.href = authorizeUrl;
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

  const update = async (patch: { calendarId?: string; syncEnabled?: boolean }) => {
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
