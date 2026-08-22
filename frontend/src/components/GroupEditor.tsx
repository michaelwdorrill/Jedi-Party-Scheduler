import { useState } from 'react';
import type { Friend, Group } from '../types';
import InviteePicker from './InviteePicker';

export default function GroupEditor({
  friends,
  initial,
  onSave,
  onCancel,
  // The group's owner, who is always one of its members and cannot be
  // unticked here (migration 0017; the server puts them back regardless).
  // Locking the control rather than silently re-adding them keeps the form
  // honest -- an untick that appears to work and then doesn't is worse than
  // one that visibly won't.
  lockedUserId,
}: {
  friends: Friend[];
  initial?: Group;
  onSave: (data: { name: string; game: string | null; idleReminderDays: number; memberUserIds: string[] }) => void;
  onCancel: () => void;
  lockedUserId?: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [game, setGame] = useState(initial?.game ?? '');
  const [idleReminderDays, setIdleReminderDays] = useState(initial?.idleReminderDays ?? 2);
  const [memberIds, setMemberIds] = useState<string[]>(() => {
    const ids = initial?.members.map((m) => m.id) ?? [];
    return lockedUserId && !ids.includes(lockedUserId) ? [lockedUserId, ...ids] : ids;
  });

  const toggle = (id: string) => {
    if (id === lockedUserId) return;
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div>
        <label className="mb-1 block text-sm text-slate-400">Group name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Raid Team"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-slate-400">Default game (optional)</label>
        <input
          value={game}
          onChange={(e) => setGame(e.target.value)}
          placeholder="e.g. Stellaris — pre-fills new events invited via this group"
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-slate-400">
          Nudge the group if idle for (days)
        </label>
        <input
          type="number"
          min={1}
          value={idleReminderDays}
          onChange={(e) => setIdleReminderDays(Math.max(1, Number(e.target.value)))}
          className="w-24 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
        />
      </div>

      <InviteePicker
        friends={friends}
        selectedUserIds={memberIds}
        onToggleUser={toggle}
      />
      {lockedUserId && (
        <p className="text-xs text-slate-500">
          You're always a member of a group you own. To leave it, hand it over or delete it.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim()}
          onClick={() =>
            onSave({ name: name.trim(), game: game.trim() || null, idleReminderDays, memberUserIds: memberIds })
          }
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
