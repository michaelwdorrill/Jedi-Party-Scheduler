import { useMemo, useState } from 'react';
import type { Friend, Group } from '../types';
import InviteePicker from './InviteePicker';
import { buttonClass, cardClass, controlClass } from './ui';

// specs/0011 / IDEAS item 36: a group is a list of people, valid only while
// they share a server. Michael's own framing of the picker: pick someone,
// and anyone who doesn't share a server with your picks so far disappears
// from the list -- never the twain shall meet. This computes that
// client-side, from each candidate's own `guildIds` (already scoped to just
// the servers they share with the caller -- see listFriendsAcrossGuilds),
// so no round trip is needed as the roster changes. It is a UX prediction,
// not the real check: the server re-validates the actual roster on save
// (assertValidRoster), the same way every other client-side validation in
// this app is a convenience in front of a server-side one.
function commonServerIds(callerGuildIds: string[], selected: Friend[]): Set<string> {
  let running = new Set(callerGuildIds);
  for (const member of selected) {
    if (!member.guildIds) continue; // the caller themself, or a fixed-guild fetch -- nothing to narrow by
    running = new Set(member.guildIds.filter((id) => running.has(id)));
  }
  return running;
}

export default function GroupEditor({
  friends,
  callerGuildIds,
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
  // The caller's own currently active servers -- the starting point the
  // running intersection narrows from. See commonServerIds above.
  callerGuildIds: string[];
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

  const selectedFriends = useMemo(() => friends.filter((f) => memberIds.includes(f.id)), [friends, memberIds]);
  const runningServers = useMemo(() => commonServerIds(callerGuildIds, selectedFriends), [callerGuildIds, selectedFriends]);

  // A candidate stays pickable if they're already selected (so you can still
  // see and untick them) or if adding them would leave at least one server
  // in common. Someone with no `guildIds` at all (shouldn't happen for a
  // real candidate, since listFriendsAcrossGuilds only returns people who
  // share something with the caller) is left pickable rather than hidden --
  // failing open here just means the server's own check catches it on save.
  const pickable = friends.filter(
    (f) => memberIds.includes(f.id) || !f.guildIds || f.guildIds.some((id) => runningServers.has(id)),
  );
  const narrowedAway = friends.length - pickable.length;

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
        friends={pickable}
        selectedUserIds={memberIds}
        onToggleUser={toggle}
      />
      {narrowedAway > 0 && (
        <p className="text-xs text-faint">
          {narrowedAway} {narrowedAway === 1 ? 'person is' : 'people are'} hidden here because they don't share a
          server with everyone picked so far.
        </p>
      )}
      {runningServers.size === 0 && memberIds.length > 1 && (
        <p className="text-xs text-danger-text">
          This roster doesn't share any server -- pick a smaller group or remove someone before saving.
        </p>
      )}
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
          disabled={!name.trim() || runningServers.size === 0}
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
