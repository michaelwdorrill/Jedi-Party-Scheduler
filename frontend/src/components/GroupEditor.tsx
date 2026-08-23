import { useState } from 'react';
import type { Friend, Group } from '../types';
import InviteePicker from './InviteePicker';
import { buttonClass, cardClass, controlClass } from './ui';

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
    <div className={cardClass('md', 'space-y-4')}>
      <div>
        <label className="mb-1 block text-sm text-muted">Group name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Raid Team"
          className={controlClass('lg', 'w-full')}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-muted">Default game (optional)</label>
        <input
          value={game}
          onChange={(e) => setGame(e.target.value)}
          placeholder="e.g. Stellaris — pre-fills new events invited via this group"
          className={controlClass('lg', 'w-full')}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm text-muted">
          Nudge the group if idle for (days)
        </label>
        <input
          type="number"
          min={1}
          value={idleReminderDays}
          onChange={(e) => setIdleReminderDays(Math.max(1, Number(e.target.value)))}
          className={controlClass('lg', 'w-24')}
        />
      </div>

      <InviteePicker
        friends={friends}
        selectedUserIds={memberIds}
        onToggleUser={toggle}
      />
      {lockedUserId && (
        <p className="text-xs text-faint">
          You're always a member of a group you own. To leave it, hand it over or delete it.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className={buttonClass('secondary')}
        >
          Cancel
        </button>
        <button
          disabled={!name.trim()}
          onClick={() =>
            onSave({ name: name.trim(), game: game.trim() || null, idleReminderDays, memberUserIds: memberIds })
          }
          className={buttonClass()}
        >
          Save
        </button>
      </div>
    </div>
  );
}
