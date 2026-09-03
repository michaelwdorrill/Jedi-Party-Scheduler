import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import GroupEditor from '../components/GroupEditor';
import type { Friend, Group } from '../types';
import { describeError, useAction, useAsync } from '../lib/async';
import { Avatar, ErrorState, InlineError, Loading, buttonClass, cardClass } from '../components/ui';

export default function GroupsPage() {
  const { user } = useAuth();
  const { guilds } = useGuild();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);

  const { data, error, loading, reload } = useAsync<Group[]>(() => api.get<Group[]>('/me/groups'), []);
  const groups = data ?? [];
  const action = useAction();

  // specs/0011 / IDEAS item 36: a group is no longer scoped to one server, so
  // there's no server to pick before the picker can load -- it loads once,
  // covering every server the caller is in, the moment the editor opens.
  useEffect(() => {
    if (editing === null) return;
    // A failed roster fetch used to leave the member picker silently empty,
    // which reads as "you have nobody to add" (idea 24).
    api.get<Friend[]>('/me/friends').then(
      (list) => {
        setFriends(list);
        setFriendsError(null);
      },
      (e: unknown) => {
        setFriends([]);
        setFriendsError(describeError(e));
      },
    );
  }, [editing]);

  if (guilds.length === 0) {
    return <p className="text-muted">You don't share any allow-listed servers yet.</p>;
  }

  // `friends` comes from GET /me/friends, which deliberately excludes the
  // caller -- correct for "who can I invite to an event" (its original
  // purpose, still used unmodified by EventFormPage), wrong for "who can go
  // in this group". The picker still needs to be able to render you, because
  // you are always a member of a group you own (migration 0017) and the
  // editor shows that membership as a locked selection rather than hiding
  // it. The server has no such exclusion either -- POST /groups and
  // PATCH /groups/:id validate the whole roster, caller included.
  const pickableMembers = user
    ? [...friends, { id: user.id, username: user.username, globalName: user.globalName, avatarHash: user.avatarHash }].sort(
        (a, b) => (a.globalName ?? a.username).localeCompare(b.globalName ?? b.username),
      )
    : friends;

  const handleSave = async (data: {
    name: string;
    game: string | null;
    idleReminderDays: number;
    memberUserIds: string[];
  }) => {
    if (editing === null) return;
    const body = {
      name: data.name,
      game: data.game,
      idle_reminder_days: data.idleReminderDays,
      member_user_ids: data.memberUserIds,
    };
    // The editor is only closed once the save lands. It used to close first,
    // so a rejected save threw away everything just typed and said nothing.
    const saved = await action.run(() => (editing === 'new' ? api.post('/groups', body) : api.patch(`/groups/${editing.id}`, body)));
    if (!saved) return;
    setEditing(null);
    reload();
  };

  const handleDelete = async (group: Group) => {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    if (await action.run(() => api.delete(`/groups/${group.id}`))) reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Groups</h1>
        {editing === null && (
          <button
            onClick={() => setEditing('new')}
            className={buttonClass()}
          >
            + New Group
          </button>
        )}
      </div>

      {editing !== null && (
        <GroupEditor
          friends={pickableMembers}
          callerGuildIds={guilds.map((g) => g.id)}
          initial={editing === 'new' ? undefined : editing}
          // Only lock yourself in on groups you own -- which is every group
          // you can reach this editor for, since editing is owner-only.
          lockedUserId={editing === 'new' || editing.createdBy === user?.id ? user?.id : undefined}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {action.error && <InlineError message={action.error} onDismiss={action.clearError} />}
      {friendsError && editing !== null && (
        <InlineError message={`Couldn't load who you can add. ${friendsError}`} />
      )}

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : groups.length === 0 ? (
        <p className="text-muted">
          No groups yet. Groups let you invite a whole crew (e.g. "Raid Team") to an event at
          once.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li
              key={g.id}
              className={cardClass('sm', 'flex items-center justify-between')}
            >
              <div>
                <div className="font-medium">
                  {g.name}
                  {g.game && <span className="ml-2 text-sm font-normal text-faint">— {g.game}</span>}
                  {/* specs/0011: a group's venue is now a set, not a single
                      server -- shown here rather than in listings elsewhere,
                      per the spec's own leaning. Empty means no common
                      server: the repair is removing whoever doesn't fit. */}
                  {g.commonServers.length > 0 ? (
                    g.commonServers.map((s) => (
                      <span key={s.id} className="ml-2 rounded bg-raised px-1.5 py-0.5 text-xs font-normal text-muted">
                        {s.name}
                      </span>
                    ))
                  ) : (
                    <span className="ml-2 rounded bg-danger-surface px-1.5 py-0.5 text-xs font-normal text-danger-text">
                      No common server
                    </span>
                  )}
                </div>
                {g.members.length === 0 ? (
                  <div className="text-sm text-muted">No members</div>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                    {g.members.map((m) => (
                      <span key={m.id} className="flex items-center gap-1.5">
                        <Avatar userId={m.id} name={m.globalName ?? m.username} avatarHash={m.avatarHash} />
                        {m.globalName ?? m.username}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {g.createdBy === user?.id && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(g)}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(g)}
                    className="rounded-md border border-danger/60 px-2 py-1 text-xs text-danger-text hover:bg-danger-surface"
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
