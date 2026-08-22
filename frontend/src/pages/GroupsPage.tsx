import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import GroupEditor from '../components/GroupEditor';
import type { Friend, Group } from '../types';

export default function GroupsPage() {
  const { user } = useAuth();
  const { guilds } = useGuild();
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  // Which server a *new* group belongs to. Groups are genuinely per-server
  // (their members have to share one), so unlike the calendar this can't just
  // span everything -- but it's a choice made when creating, not a mode the
  // whole page sits in. Defaults to the first server you're in.
  const [newGroupGuildId, setNewGroupGuildId] = useState('');

  // The server whose roster the picker should offer: the one being edited, or
  // the one chosen for a new group.
  const editorGuildId = editing && editing !== 'new' ? editing.guildId : newGroupGuildId;

  const load = async () => {
    setLoading(true);
    try {
      setGroups(await api.get<Group[]>('/me/groups'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!newGroupGuildId && guilds.length > 0) setNewGroupGuildId(guilds[0].id);
  }, [guilds, newGroupGuildId]);

  // Friends are legitimately server-scoped -- you can only group people you
  // share a server with -- so this reloads whenever the editor's server does.
  useEffect(() => {
    if (!editorGuildId) return;
    api.get<Friend[]>(`/me/friends?guild_id=${editorGuildId}`).then(setFriends);
  }, [editorGuildId]);

  if (guilds.length === 0) {
    return <p className="text-slate-400">You don't share any allow-listed servers yet.</p>;
  }

  // `friends` comes from GET /me/friends, which deliberately excludes the
  // caller -- correct for "who can I invite to an event" (its original
  // purpose, still used unmodified by EventFormPage), wrong for "who can go
  // in this group". The picker still needs to be able to render you, because
  // you are always a member of a group you own (migration 0017) and the
  // editor shows that membership as a locked selection rather than hiding
  // it. The server has no such exclusion either -- PATCH /groups/:id
  // validates member_user_ids against active guild membership only.
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
    if (editing === 'new') {
      await api.post(`/guilds/${newGroupGuildId}/groups`, {
        name: data.name,
        game: data.game,
        idle_reminder_days: data.idleReminderDays,
        member_user_ids: data.memberUserIds,
      });
    } else if (editing) {
      await api.patch(`/groups/${editing.id}`, {
        name: data.name,
        game: data.game,
        idle_reminder_days: data.idleReminderDays,
        member_user_ids: data.memberUserIds,
      });
    }
    setEditing(null);
    await load();
  };

  const handleDelete = async (group: Group) => {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    await api.delete(`/groups/${group.id}`);
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Groups</h1>
        {editing === null && (
          <button
            onClick={() => setEditing('new')}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            + New Group
          </button>
        )}
      </div>

      {editing === 'new' && guilds.length > 1 && (
        <div>
          <label className="mb-1 block text-sm text-slate-400">Server</label>
          <select
            value={newGroupGuildId}
            onChange={(e) => setNewGroupGuildId(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
          >
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {editing !== null && (
        <GroupEditor
          friends={pickableMembers}
          initial={editing === 'new' ? undefined : editing}
          // Only lock yourself in on groups you own -- which is every group
          // you can reach this editor for, since editing is owner-only.
          lockedUserId={editing === 'new' || editing.createdBy === user?.id ? user?.id : undefined}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-slate-400">
          No groups yet. Groups let you invite a whole crew (e.g. "Raid Team") to an event at
          once.
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li
              key={g.id}
              className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 p-3"
            >
              <div>
                <div className="font-medium">
                  {g.name}
                  {g.game && <span className="ml-2 text-sm font-normal text-slate-500">— {g.game}</span>}
                  {/* Which server this group lives on. Needed now that the
                      page lists every server's groups at once. */}
                  {g.guildName && (
                    <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs font-normal text-slate-400">
                      {g.guildName}
                    </span>
                  )}
                </div>
                <div className="text-sm text-slate-400">
                  {g.members.map((m) => m.globalName ?? m.username).join(', ') || 'No members'}
                </div>
              </div>
              {g.createdBy === user?.id && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(g)}
                    className="rounded-md border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(g)}
                    className="rounded-md border border-red-800 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
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
