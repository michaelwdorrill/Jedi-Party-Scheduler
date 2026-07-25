import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useGuild } from '../auth/GuildContext';
import GroupEditor from '../components/GroupEditor';
import type { Friend, Group } from '../types';

export default function GroupsPage() {
  const { user } = useAuth();
  const { selectedGuildId } = useGuild();
  const [groups, setGroups] = useState<Group[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);

  const load = async () => {
    if (!selectedGuildId) return;
    setLoading(true);
    try {
      const [groupList, friendList] = await Promise.all([
        api.get<Group[]>(`/guilds/${selectedGuildId}/groups`),
        api.get<Friend[]>(`/me/friends?guild_id=${selectedGuildId}`),
      ]);
      setGroups(groupList);
      setFriends(friendList);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGuildId]);

  if (!selectedGuildId) {
    return <p className="text-slate-400">You don't share any allow-listed servers yet.</p>;
  }

  const handleSave = async (data: { name: string; memberUserIds: string[] }) => {
    if (editing === 'new') {
      await api.post(`/guilds/${selectedGuildId}/groups`, {
        name: data.name,
        member_user_ids: data.memberUserIds,
      });
    } else if (editing) {
      await api.patch(`/groups/${editing.id}`, {
        name: data.name,
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

      {editing !== null && (
        <GroupEditor
          friends={friends}
          initial={editing === 'new' ? undefined : editing}
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
                <div className="font-medium">{g.name}</div>
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
