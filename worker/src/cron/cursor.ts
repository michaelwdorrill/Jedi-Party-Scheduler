import type { Env } from '../env';

// Resumable scan positions for the cron sweeps. See migration 0010 for why
// these exist: without them a budget-limited tick rescans the same prefix
// every time and starves everything past it.

export type CursorName = 'reminders_single' | 'reminders_recurring' | 'voice_recurring';

export async function readCursor(env: Env, name: CursorName): Promise<number> {
  const row = await env.DB.prepare(`SELECT position FROM cron_cursors WHERE name = ?`)
    .bind(name)
    .first<{ position: number }>();
  return row?.position ?? 0;
}

// `position` is where the *next* tick should start. Callers pass 0 when they
// reached the end of the scan, which is what makes it wrap.
export async function writeCursor(env: Env, name: CursorName, position: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cron_cursors (name, position, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
  )
    .bind(name, position, Date.now())
    .run();
}
