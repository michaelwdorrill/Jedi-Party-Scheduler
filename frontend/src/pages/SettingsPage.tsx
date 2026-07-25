import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import TimezoneSelect from '../components/TimezoneSelect';

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const [timezone, setTimezone] = useState(user?.timezone ?? 'America/New_York');
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    user?.notificationsEnabled ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.patch('/me', { timezone, notificationsEnabled });
      await refreshUser();
      setSaved(true);
    } finally {
      setSaving(false);
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

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(e) => setNotificationsEnabled(e.target.checked)}
          />
          Send me Discord DMs for invites and reminders
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
    </div>
  );
}
