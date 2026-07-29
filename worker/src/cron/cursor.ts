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

export type CursorName =
  | 'reminders_single'
  | 'reminders_recurring'
  | 'voice_recurring'
  // The global (multi-guild) scans. These were bounded with a LIMIT in the
  // previous pass but had no cursor, so the same ordering returned the same
  // prefix on every tick and the row after the limit was never selected at
  // all. See migration 0012.
  | 'single_winner_polls'
  | 'multi_winner_closed'
  | 'confirmed_options'
  | 'poll_deadline_reminders'
  | 'voice_fixed'
  | 'voice_multi_winner'
  | 'idle_groups'
  // Source-independent retry consumers (F-04-H2, migration 0014): due rows
  // scanned by next_attempt_at directly, not reached through whatever
  // event/poll/group source query originally created them.
  | 'due_notification_retries'
  | 'due_nudge_retries';

// The single-event scan orders by (start_at, id), so its key is both.
export interface EventKey {
  startAt: number;
  id: string;
}

// Reads one persisted cursor directly, bypassing the per-tick store.
//
// The sweeps themselves go through CursorStore below; this is for callers
// outside a tick that want the durable value -- chiefly tests asserting that
// a pass actually persisted where it stopped, which is the property worth
// checking and the one an in-memory read would not prove.
export async function readCursorKey(env: Env, name: CursorName): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT cursor_key FROM cron_cursors WHERE name = ?`)
    .bind(name)
    .first<{ cursor_key: string | null }>();
  return row?.cursor_key ?? null;
}

// All of a tick's cursors, read once at the start and written once at the end.
//
// Keeping this to two statements is what makes cursoring the global scans
// affordable at all. A read plus a write per sweep is two statements of pure
// bookkeeping each; across the ten cursored sweeps that is twenty statements
// of fixed overhead on a Free plan whose entire per-invocation allowance is
// fifty.
//
// The write is *one multi-row UPSERT*, not a batch of per-cursor statements.
// That distinction is the correction from the Pass 9 review: an earlier
// version of this class built one prepared statement per dirty cursor and
// handed them to `DB.batch()`, and this comment claimed that made cursor
// persistence cost two queries. It did not. A batch is a transaction around
// n statements, not a way to turn n statements into one -- D1 counts each
// statement in the batch against the per-invocation query limit, so a first
// tick that dirtied all ten cursors really spent eleven, and the tick's
// modelled cost understated its actual cost by nine.
//
// Ten cursors is thirty bound parameters, comfortably inside D1's hundred.
//
// Reads are served from the in-memory map after load, and writes are buffered
// until flush(), so a sweep that advances its cursor several times within a
// tick still costs nothing extra.
export class CursorStore {
  private keys = new Map<string, string | null>();
  private dirty = new Set<CursorName>();

  private constructor(private env: Env) {}

  static async load(env: Env): Promise<CursorStore> {
    const store = new CursorStore(env);
    const { results } = await env.DB.prepare(`SELECT name, cursor_key FROM cron_cursors`).all<{
      name: string;
      cursor_key: string | null;
    }>();
    for (const row of results) store.keys.set(row.name, row.cursor_key);
    return store;
  }

  get(name: CursorName): string | null {
    return this.keys.get(name) ?? null;
  }

  // `null` means the pass completed and the next tick should start over.
  set(name: CursorName, key: string | null): void {
    if (this.keys.get(name) === key && this.keys.has(name)) return;
    this.keys.set(name, key);
    this.dirty.add(name);
  }

  // Called once at the end of the tick. Unchanged cursors write nothing --
  // the common case for a sweep with no eligible rows is that its cursor
  // stays where it was.
  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    const now = Date.now();
    const names = [...this.dirty];
    const values = names.map(() => '(?, 0, ?, ?)').join(', ');
    const binds = names.flatMap((name) => [name, this.keys.get(name) ?? null, now]);
    this.dirty.clear();
    await this.env.DB.prepare(
      `INSERT INTO cron_cursors (name, position, cursor_key, updated_at) VALUES ${values}
       ON CONFLICT(name) DO UPDATE SET cursor_key = excluded.cursor_key, updated_at = excluded.updated_at`,
    )
      .bind(...binds)
      .run();
  }
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
