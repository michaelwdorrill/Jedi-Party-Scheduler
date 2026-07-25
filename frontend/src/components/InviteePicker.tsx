import type { Friend, Group } from '../types';

export default function InviteePicker({
  friends,
  groups,
  selectedUserIds,
  selectedGroupIds,
  onToggleUser,
  onToggleGroup,
}: {
  friends: Friend[];
  groups?: Group[];
  selectedUserIds: string[];
  selectedGroupIds?: string[];
  onToggleUser: (userId: string) => void;
  onToggleGroup?: (groupId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {groups && groups.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Groups</div>
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const checked = selectedGroupIds?.includes(g.id) ?? false;
              return (
                <button
                  type="button"
                  key={g.id}
                  onClick={() => onToggleGroup?.(g.id)}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    checked
                      ? 'border-indigo-500 bg-indigo-600 text-white'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {g.name} ({g.members.length})
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Friends</div>
        {friends.length === 0 ? (
          <p className="text-sm text-slate-500">
            No friends yet — friends are people who share this server and have also logged in.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {friends.map((f) => {
              const checked = selectedUserIds.includes(f.id);
              return (
                <button
                  type="button"
                  key={f.id}
                  onClick={() => onToggleUser(f.id)}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    checked
                      ? 'border-indigo-500 bg-indigo-600 text-white'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {f.globalName ?? f.username}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
