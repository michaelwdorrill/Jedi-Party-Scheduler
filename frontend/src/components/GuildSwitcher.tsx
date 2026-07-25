import { useGuild } from '../auth/GuildContext';

export default function GuildSwitcher() {
  const { guilds, selectedGuildId, selectGuild, loading } = useGuild();

  if (loading) return null;

  if (guilds.length === 0) {
    return <span className="text-xs text-slate-500">No shared servers found</span>;
  }

  return (
    <select
      value={selectedGuildId ?? ''}
      onChange={(e) => selectGuild(e.target.value)}
      className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
    >
      {guilds.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
