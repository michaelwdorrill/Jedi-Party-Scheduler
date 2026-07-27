import { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE_URL, api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { clearToken, getToken } from '../auth/tokenStorage';
import TimezoneSelect from '../components/TimezoneSelect';

export default function SettingsPage() {
  const { user, refreshUser, logout } = useAuth();
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
      clearToken();
      logout();
      window.location.hash = '#/login';
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-5">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div>
          <label className="mb-1 block text-sm text-slate-400">
            Default timezone (used to display events and pick times)
          </label>
          <TimezoneSelect value={timezone} onChange={setTimezone} />
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => setNotificationsEnabled(e.target.checked)}
            className="mt-0.5"
          />
          Send me Discord DMs for invites and reminders
        </label>

        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={freeBusyVisible}
            onChange={(e) => setFreeBusyVisible(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Let people I share a server with see when I'm busy
            <span className="block text-xs text-slate-500">
              They only ever see opaque blocks of time — never the name, game, or people involved.
              Turn this off and they see nothing at all for you.
            </span>
          </span>
        </label>

        <button
          disabled={saving}
          onClick={handleSave}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <p className="text-sm text-emerald-400">Saved.</p>}
      </div>

      <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="font-semibold">Your data</h2>
        <p className="text-sm text-slate-400">
          See the{' '}
          <Link to="/privacy" className="text-indigo-400 underline">
            Privacy Policy
          </Link>{' '}
          for what's stored and why.
        </p>
        <button
          disabled={exporting}
          onClick={handleExport}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {exporting ? 'Preparing…' : 'Download my data'}
        </button>
      </div>

      <div className="space-y-3 rounded-lg border border-red-900 bg-red-950/20 p-4">
        <h2 className="font-semibold text-red-300">Delete account</h2>
        <p className="text-sm text-slate-400">
          Permanently removes everything: your profile, personal time blocks, RSVPs, poll votes,
          group memberships, and every event you organised. Immediate and irreversible.
        </p>
        <button
          disabled={deleting}
          onClick={handleDelete}
          className="rounded-md border border-red-700 bg-red-900/40 px-3 py-1.5 text-sm text-red-200 hover:bg-red-900/70 disabled:opacity-50"
        >
          {deleting ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </div>
  );
}
