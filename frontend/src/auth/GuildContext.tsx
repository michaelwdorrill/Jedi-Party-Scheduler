import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/async';
import type { Guild } from '../types';
import { useAuth } from './AuthContext';
import { policyAccepted } from '../lib/policyGate';

const SELECTED_GUILD_KEY = 'jps_selected_guild';

interface GuildContextValue {
  guilds: Guild[];
  selectedGuildId: string | null;
  selectGuild: (guildId: string) => void;
  loading: boolean;
  // Set when the server list could not be fetched, so a page can tell "you
  // are in no allow-listed servers" apart from "we could not find out"
  // (idea 24). Those two render the same otherwise -- an empty `guilds` --
  // and the first of them is a message about the user's standing with the
  // app, which is a bad thing to say wrongly.
  error: string | null;
  refreshGuilds: () => Promise<void>;
}

const GuildContext = createContext<GuildContextValue | null>(null);

export function GuildProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  // Not isAuthenticated alone: /guilds is policy-gated, so asking while the
  // agreement screen is up gets a 403 that would otherwise stick
  // (lib/policyGate.ts). Agreeing flips this, which re-runs the fetch below.
  const mayFetch = policyAccepted(isAuthenticated, user);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_GUILD_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshGuilds = useMemo(
    () => async () => {
      if (!mayFetch) {
        setGuilds([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const list = await api.get<Guild[]>('/guilds');
        setGuilds(list);
        setSelectedGuildId((current) => {
          if (current && list.some((g) => g.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } catch (e) {
        setGuilds([]);
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [mayFetch],
  );

  useEffect(() => {
    void refreshGuilds();
  }, [refreshGuilds]);

  useEffect(() => {
    if (selectedGuildId) localStorage.setItem(SELECTED_GUILD_KEY, selectedGuildId);
  }, [selectedGuildId]);

  return (
    <GuildContext.Provider
      value={{ guilds, selectedGuildId, selectGuild: setSelectedGuildId, loading, error, refreshGuilds }}
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
