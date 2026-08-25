import { Avatar } from './ui';
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
          <div className="mb-1 text-xs uppercase tracking-wide text-faint">Groups</div>
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
                      ? 'border-accent-hover bg-accent text-on-accent'
                      : 'border-edge-strong text-ink-dim hover:bg-raised'
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
        <div className="mb-1 text-xs uppercase tracking-wide text-faint">Friends</div>
        {friends.length === 0 ? (
          <p className="text-sm text-faint">
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
                  className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm ${
                    checked
                      ? 'border-accent-hover bg-accent text-on-accent'
                      : 'border-edge-strong text-ink-dim hover:bg-raised'
                  }`}
                >
                  <Avatar userId={f.id} name={f.globalName ?? f.username} avatarHash={f.avatarHash} />
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
