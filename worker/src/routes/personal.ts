import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { newId } from '../lib/ids';
import { mapPersonalEvent, type PersonalEventRow } from '../lib/personalEvents';
import {
  assertOneOf,
  assertOptionalString,
  assertRecurrenceInput,
  assertSafeInt,
  assertString,
  assertTimeRange,
  assertTimezone,
  LIMITS,
  readJsonBody,
  ValidationError,
} from '../lib/validate';

function validatePersonalEventInput(body: Partial<PersonalEventInput>): void {
  if (body.title !== undefined) assertString(body.title, 'title', LIMITS.TITLE);
  if (body.description !== undefined) assertOptionalString(body.description, 'description', LIMITS.DESCRIPTION);
  if (body.timezone !== undefined) assertTimezone(body.timezone, 'timezone');
  if (body.availability !== undefined) assertOneOf(body.availability, 'availability', ['busy', 'considering', 'free'] as const);

  if (body.startAt != null) assertSafeInt(body.startAt, 'startAt');
  if (body.endAt != null) assertSafeInt(body.endAt, 'endAt');
  if (body.startAt != null && body.endAt != null) {
    assertTimeRange(body.startAt, body.endAt, 'event', LIMITS.MAX_EVENT_DURATION_MS);
  }

  // Normalized in place, same reasoning as eventWrites.ts's guild-event path.
  if (body.recurrence) {
    body.recurrence = assertRecurrenceInput(body.recurrence, 'recurrence') as NonNullable<PersonalEventInput['recurrence']>;
  }
}

export const personalRoutes = new Hono<AppEnv>();

interface PersonalEventInput {
  title: string;
  description?: string | null;
  timezone: string;
  availability?: 'busy' | 'considering' | 'free';
  startAt?: number | null;
  endAt?: number | null;
  isRecurring?: boolean;
  recurrence?: {
    freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    interval: number;
    byWeekday: number[] | null;
    byMonthDay: number | null;
    startDate: string;
    startTime: string;
    durationMinutes: number;
    endType: 'never' | 'on_date' | 'after_count';
    endDate: string | null;
    endCount: number | null;
  };
}

personalRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM personal_events WHERE user_id = ? AND status = 'active' ORDER BY COALESCE(start_at, 0) DESC`,
  )
    .bind(userId)
    .all<PersonalEventRow>();
  return c.json(results.map(mapPersonalEvent));
});

personalRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(`SELECT * FROM personal_events WHERE id = ?`)
    .bind(c.req.param('id'))
    .first<PersonalEventRow>();
  // Personal events are private to their owner -- not visible to anyone else,
  // including people who share a server.
  if (!row || row.user_id !== userId) return c.text('Not found', 404);
  return c.json(mapPersonalEvent(row));
});

personalRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await readJsonBody<PersonalEventInput>(c);
  validatePersonalEventInput(body);
  if (body.isRecurring && !body.recurrence) throw new ValidationError('recurrence is required when isRecurring is true');

  const { results: countRows } = await c.env.DB.prepare(
    `SELECT COUNT(*) as n FROM personal_events WHERE user_id = ? AND status = 'active'`,
  )
    .bind(userId)
    .all<{ n: number }>();
  if ((countRows[0]?.n ?? 0) >= LIMITS.MAX_PERSONAL_EVENTS_PER_USER) {
    throw new ValidationError(`You've reached the maximum of ${LIMITS.MAX_PERSONAL_EVENTS_PER_USER} personal events`);
  }

  const id = newId();
  const now = Date.now();
  const r = body.isRecurring ? body.recurrence : undefined;

  await c.env.DB.prepare(
    `INSERT INTO personal_events
       (id, user_id, title, description, timezone, start_at, end_at, status, availability, is_recurring,
        freq, interval, by_weekday, by_month_day, rule_start_date, rule_start_time,
        duration_minutes, end_type, rule_end_date, end_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      body.title.trim(),
      body.description?.trim() || null,
      body.timezone,
      r ? null : (body.startAt ?? null),
      r ? null : (body.endAt ?? null),
      body.availability ?? 'busy',
      r ? 1 : 0,
      r?.freq ?? null,
      r?.interval ?? null,
      r?.byWeekday && r.byWeekday.length > 0 ? r.byWeekday.join(',') : null,
      r?.byMonthDay ?? null,
      r?.startDate ?? null,
      r?.startTime ?? null,
      r?.durationMinutes ?? null,
      r?.endType ?? null,
      r?.endDate ?? null,
      r?.endCount ?? null,
      now,
      now,
    )
    .run();

  return c.json({ id }, 201);
});

personalRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT user_id FROM personal_events WHERE id = ?`)
    .bind(id)
    .first<{ user_id: string }>();
  if (!existing || existing.user_id !== userId) return c.text('Not found', 404);

  const body = await readJsonBody<Partial<PersonalEventInput>>(c);
  validatePersonalEventInput(body);
  const r = body.isRecurring ? body.recurrence : undefined;

  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    values.push(val);
  };

  if (body.title !== undefined) add('title', body.title.trim());
  if (body.description !== undefined) add('description', body.description?.trim() || null);
  if (body.timezone !== undefined) add('timezone', body.timezone);
  if (body.availability !== undefined) add('availability', body.availability);

  // Same pattern as guild events: isRecurring being present is what marks this
  // as a full schedule edit, so partial updates (e.g. just renaming) never
  // clobber the timing fields.
  if (body.isRecurring !== undefined) {
    add('is_recurring', r ? 1 : 0);
    add('start_at', r ? null : (body.startAt ?? null));
    add('end_at', r ? null : (body.endAt ?? null));
    add('freq', r?.freq ?? null);
    add('interval', r?.interval ?? null);
    add('by_weekday', r?.byWeekday && r.byWeekday.length > 0 ? r.byWeekday.join(',') : null);
    add('by_month_day', r?.byMonthDay ?? null);
    add('rule_start_date', r?.startDate ?? null);
    add('rule_start_time', r?.startTime ?? null);
    add('duration_minutes', r?.durationMinutes ?? null);
    add('end_type', r?.endType ?? null);
    add('rule_end_date', r?.endDate ?? null);
    add('end_count', r?.endCount ?? null);
  }

  values.push(id);
  await c.env.DB.prepare(`UPDATE personal_events SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return c.json({ ok: true });
});

personalRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT user_id FROM personal_events WHERE id = ?`)
    .bind(id)
    .first<{ user_id: string }>();
  if (!existing || existing.user_id !== userId) return c.text('Not found', 404);

  await c.env.DB.prepare(`DELETE FROM personal_events WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

personalRoutes.post('/:id/occurrences/:date/cancel', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(`SELECT user_id FROM personal_events WHERE id = ?`)
    .bind(id)
    .first<{ user_id: string }>();
  if (!existing || existing.user_id !== userId) return c.text('Not found', 404);

  await c.env.DB.prepare(
    `INSERT INTO personal_event_overrides (id, personal_event_id, occurrence_date, is_cancelled)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(personal_event_id, occurrence_date) DO UPDATE SET is_cancelled = 1`,
  )
    .bind(newId(), id, c.req.param('date'))
    .run();
  return c.json({ ok: true });
});
