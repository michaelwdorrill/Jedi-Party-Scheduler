import { useState } from 'react';
import type { Friend, Group } from '../types';
import InviteePicker from './InviteePicker';

export default function GroupEditor({
  friends,
  initial,
  onSave,
  onCancel,
}: {
  friends: Friend[];
  initial?: Group;
  onSave: (data: { name: string; memberUserIds: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(
    initial?.members.map((m) => m.id) ?? [],
  );

  const toggle = (id: string) =>
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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

      <InviteePicker
        friends={friends}
        selectedUserIds={memberIds}
        onToggleUser={toggle}
      />

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), memberUserIds: memberIds })}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
