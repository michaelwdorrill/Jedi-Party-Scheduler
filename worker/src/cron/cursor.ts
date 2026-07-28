import type { Env } from '../env';

// Resumable scan positions for the cron sweeps.
//
// These are *keyset* cursors: each stores the last key a tick actually
// finished processing, and the next tick resumes strictly after it. See
// migration 0011 for why the original OFFSET form was wrong -- in short, the
// reminder scans' predicate moves every tick, so an offset counted against
// one tick's result set points somewhere else entirely in the next one's, and
// the rows it skips are due reminders that nothing downstream recovers.
//
// The cursor is a fairness mechanism, not a correctness one. Correctness
// comes from the outbox, which will not send a notification twice however
// many times a sweep revisits its event. All the cursor has to guarantee is
// that the scan keeps moving forward, so every event comes up again within a
// bounded number of ticks.

export type CursorName = 'reminders_single' | 'reminders_recurring' | 'voice_recurring';

// The single-event scan orders by (start_at, id), so its key is both.
export interface EventKey {
  startAt: number;
  id: string;
}

export async function readCursorKey(env: Env, name: CursorName): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT cursor_key FROM cron_cursors WHERE name = ?`)
    .bind(name)
    .first<{ cursor_key: string | null }>();
  return row?.cursor_key ?? null;
}

// `null` means the pass completed and the next tick should start over.
export async function writeCursorKey(env: Env, name: CursorName, key: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cron_cursors (name, position, cursor_key, updated_at) VALUES (?, 0, ?, ?)
     ON CONFLICT(name) DO UPDATE SET cursor_key = excluded.cursor_key, updated_at = excluded.updated_at`,
  )
    .bind(name, key, Date.now())
    .run();
}

// `<start_at>:<id>`. Ids are opaque strings that may themselves contain a
// colon, so only the first one separates -- everything after it is the id.
export function encodeEventKey(key: EventKey): string {
  return `${key.startAt}:${key.id}`;
}

export function decodeEventKey(raw: string | null): EventKey | null {
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep <= 0) return null;
  const startAt = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(startAt) || id.length === 0) return null;
  return { startAt, id };
}
