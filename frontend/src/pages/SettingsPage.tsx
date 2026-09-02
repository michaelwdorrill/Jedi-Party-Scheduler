import { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE_URL, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { clearToken, getToken } from '../auth/tokenStorage';
import TimezoneSelect from '../components/TimezoneSelect';
import { buttonClass, cardClass } from '../components/ui';
import { getScenery, setScenery, type Scenery } from '../lib/scenery';

export default function SettingsPage() {
  const { user, refreshUser, logout } = useAuth();
  const [scenery, setSceneryState] = useState<Scenery>(getScenery);
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    user?.notificationsEnabled ?? true,
  );
  const [freeBusyVisible, setFreeBusyVisible] = useState(user?.freeBusyVisible ?? true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.patch('/me', { timezone, notificationsEnabled, freeBusyVisible });
      await refreshUser();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  // Fetched with the session token and turned into a local download, so the
  // export never travels through anything but the user's own browser.
  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/me/export`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `uncle-owen-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        'Permanently delete your account?\n\nThis removes your profile, personal time blocks, RSVPs, votes, group memberships, and every event you organised. It cannot be undone.',
      )
    ) {
      return;
    }
    if (prompt('Type DELETE to confirm.') !== 'DELETE') return;

    setDeleting(true);
    try {
      await api.delete('/me');
      // The account (and every session with it) is already gone server-side,
      // so there's nothing left to revoke -- clearing the token first is what
      // makes logout() skip the revocation it would otherwise queue.
      clearToken();
      await logout();
      window.location.hash = '#/login';
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <div className={cardClass('md', 'space-y-3')}>
        <div>
          <label className="mb-1 block text-sm text-muted">
            Default timezone (used to display events and pick times)
          </label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>

        <label className="flex items-start gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => setNotificationsEnabled(e.target.checked)}
            className="mt-0.5"
          />
          Send me Discord DMs for invites and reminders
        </label>

        <label className="flex items-start gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={freeBusyVisible}
            onChange={(e) => setFreeBusyVisible(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Let people I share a server with see when I'm busy
            <span className="block text-xs text-faint">
              They only ever see opaque blocks of time — never the name, game, or people involved.
              Turn this off and they see nothing at all for you.
            </span>
          </span>
        </label>

        <button
          disabled={saving}
          onClick={handleSave}
          className={buttonClass('primary', 'lg')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <p className="text-sm text-success-text">Saved.</p>}
      </div>

      <div className={cardClass('md', 'space-y-3')}>
        <h2 className="font-semibold">Scenery</h2>
        <p className="text-sm text-muted">
          How much desert the app carries. Colours, type and layout are the same either way
          &mdash; this only adds or removes the scenery.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['homestead', 'Homestead'],
              ['twin-suns', 'Twin suns'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scenery === value}
              onClick={() => {
                setScenery(value);
                setSceneryState(value);
              }}
              className={buttonClass(scenery === value ? 'primary' : 'secondary', 'lg', 'flex-1')}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-faint">
          {scenery === 'homestead'
            ? 'Sunset behind the header, sand grain, and vaporators on the horizon.'
            : 'Just the mark. Quieter, and kinder to a low-contrast screen.'}
        </p>
      </div>

      <div className={cardClass('md', 'space-y-3')}>
        <h2 className="font-semibold">Servers</h2>
        <p className="text-sm text-muted">
          Run a Discord server and want this app there too? If you administer it, you can ask.
        </p>
        <Link to="/add-bot" className="text-sm text-accent-text underline">
          Add the bot to another server
        </Link>
      </div>

      <div className={cardClass('md', 'space-y-3')}>
        <h2 className="font-semibold">Your data</h2>
        <p className="text-sm text-muted">
          See the{' '}
          <Link to="/privacy" className="text-accent-text underline">
            Privacy Policy
          </Link>{' '}
          for what's stored and why.
        </p>
        <button
          disabled={exporting}
          onClick={handleExport}
          className={buttonClass('secondary')}
        >
          {exporting ? 'Preparing…' : 'Download my data'}
        </button>
      </div>

      {user?.isOwner && (
        <div className={cardClass('md', 'space-y-3')}>
          <h2 className="font-semibold">Owner</h2>
          <Link to="/admin/users" className="block text-sm text-accent-text underline">
            View all users
          </Link>
          <Link to="/admin/guild-requests" className="block text-sm text-accent-text underline">
            Guild requests
          </Link>
        </div>
      )}

      <div className="space-y-3 rounded-lg border border-danger/50 bg-danger-surface/40 p-4">
        <h2 className="font-semibold text-danger-text">Delete account</h2>
        <p className="text-sm text-muted">
          Permanently removes everything: your profile, personal time blocks, RSVPs, poll votes,
          group memberships, and every event you organised. Immediate and irreversible.
        </p>
        <button
          disabled={deleting}
          onClick={handleDelete}
          className="rounded-md border border-danger/70 bg-danger-surface/55 px-3 py-1.5 text-sm text-danger-text hover:bg-danger-surface/80 disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </div>
  );
}
