import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '../api/client';
import type { Guild } from '../types';
import { useAuth } from './AuthContext';

const SELECTED_GUILD_KEY = 'jps_selected_guild';

interface GuildContextValue {
  guilds: Guild[];
  selectedGuildId: string | null;
  selectGuild: (guildId: string) => void;
  loading: boolean;
  refreshGuilds: () => Promise<void>;
}

const GuildContext = createContext<GuildContextValue | null>(null);

export function GuildProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_GUILD_KEY),
  );
  const [loading, setLoading] = useState(true);

  const refreshGuilds = useMemo(
    () => async () => {
      if (!isAuthenticated) {
        setGuilds([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const list = await api.get<Guild[]>('/guilds');
        setGuilds(list);
        setSelectedGuildId((current) => {
          if (current && list.some((g) => g.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } finally {
        setLoading(false);
      }
    },
    [isAuthenticated],
  );

  useEffect(() => {
    void refreshGuilds();
  }, [refreshGuilds]);

  useEffect(() => {
    if (selectedGuildId) localStorage.setItem(SELECTED_GUILD_KEY, selectedGuildId);
  }, [selectedGuildId]);

  return (
    <GuildContext.Provider
      value={{ guilds, selectedGuildId, selectGuild: setSelectedGuildId, loading, refreshGuilds }}
    >
      {children}
    </GuildContext.Provider>
  );
}

export function useGuild(): GuildContextValue {
  const ctx = useContext(GuildContext);
  if (!ctx) throw new Error('useGuild must be used within a GuildProvider');
  return ctx;
}
