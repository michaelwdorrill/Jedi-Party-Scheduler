// Hand-rolled runtime validation for untrusted request bodies/queries -- no
// external schema library, consistent with this codebase's existing
// minimal-dependency style (see jwt.ts). TypeScript's `c.req.json<T>()`
// generic is purely a compile-time annotation; it does nothing at runtime,
// so every field an attacker controls needs an explicit check here.
//
// Route handlers call these directly and let them throw; router.ts's
// app.onError() turns a ValidationError into a clean 400 with the message,
// so no route needs its own try/catch.

import { DateTime } from 'luxon';

export class ValidationError extends Error {}

export function assertSafeInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${name} must be a safe integer`);
  }
  return value;
}

export function assertOptionalSafeInt(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return assertSafeInt(value, name);
}

export function assertString(value: unknown, name: string, maxLen: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.trim().length === 0) throw new ValidationError(`${name} is required`);
  if (value.length > maxLen) throw new ValidationError(`${name} must be ${maxLen} characters or fewer`);
  return value;
}

export function assertOptionalString(value: unknown, name: string, maxLen: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${name} must be a string`);
  if (value.length > maxLen) throw new ValidationError(`${name} must be ${maxLen} characters or fewer`);
  return value;
}

export function assertStringArray(value: unknown, name: string, maxItems: number, maxItemLen: number): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array`);
  if (value.length > maxItems) throw new ValidationError(`${name} must have ${maxItems} items or fewer`);
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxItemLen) {
      throw new ValidationError(`${name} entries must be non-empty strings of ${maxItemLen} characters or fewer`);
    }
  }
  return value as string[];
}

export function assertOneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`);
  return value;
}

export function assertTimeRange(startAt: number, endAt: number, name: string, maxDurationMs?: number): void {
  if (endAt <= startAt) throw new ValidationError(`${name} end must be after start`);
  if (maxDurationMs !== undefined && endAt - startAt > maxDurationMs) {
    throw new ValidationError(`${name} span is too large`);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function assertIsoDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new ValidationError(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  const dt = DateTime.fromISO(value);
  if (!dt.isValid || dt.toISODate() !== value) {
    throw new ValidationError(`${name} is not a valid calendar date`);
  }
  return value;
}

export function assertTimeOfDay(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TIME_OF_DAY_RE.test(value)) {
    throw new ValidationError(`${name} must be a 24-hour time (HH:MM)`);
  }
  return value;
}

export function assertTimezone(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new ValidationError(`${name} must be a valid IANA timezone`);
  }
  if (!DateTime.local().setZone(value).isValid) {
    throw new ValidationError(`${name} must be a valid IANA timezone`);
  }
  return value;
}

// Shared shape for both guild-event and personal-event recurrence rules --
// structurally identical, so one validator covers both without either module
// importing the other's type (eventWrites.ts already imports from here).
export interface RecurrenceInputLike {
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
}

// Full recurrence schema. Returns a *normalized* rule (byWeekday deduped,
// sorted, and capped at 7 entries) rather than just validating in place --
// callers should store this return value, not the raw input, since the
// dedup is itself part of the fix for the CPU-amplification path (a rule
// with thousands of duplicate weekday entries multiplies the expander's
// inner loop by that count; see lib/recurrence.ts).
export function assertRecurrenceInput(value: unknown, name = 'recurrence'): RecurrenceInputLike {
  if (typeof value !== 'object' || value === null) throw new ValidationError(`${name} must be an object`);
  const r = value as Record<string, unknown>;

  const freq = assertOneOf(r.freq, `${name}.freq`, ['DAILY', 'WEEKLY', 'MONTHLY'] as const);
  const interval = assertSafeInt(r.interval, `${name}.interval`);
  if (interval < 1 || interval > LIMITS.MAX_RECURRENCE_INTERVAL) {
    throw new ValidationError(`${name}.interval out of range`);
  }

  let byWeekday: number[] | null = null;
  if (freq === 'WEEKLY') {
    if (r.byWeekday != null) {
      if (!Array.isArray(r.byWeekday)) throw new ValidationError(`${name}.byWeekday must be an array`);
      const unique = [...new Set(r.byWeekday)];
      if (unique.length > 7) throw new ValidationError(`${name}.byWeekday must have at most 7 unique values`);
      for (const d of unique) {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
          throw new ValidationError(`${name}.byWeekday values must be integers 0-6`);
        }
      }
      byWeekday = unique.length > 0 ? (unique as number[]).sort((a, b) => a - b) : null;
    }
  } else if (r.byWeekday != null) {
    throw new ValidationError(`${name}.byWeekday is only valid for WEEKLY recurrence`);
  }

  let byMonthDay: number | null = null;
  if (freq === 'MONTHLY') {
    if (r.byMonthDay != null) {
      byMonthDay = assertSafeInt(r.byMonthDay, `${name}.byMonthDay`);
      if (byMonthDay < 1 || byMonthDay > 31) throw new ValidationError(`${name}.byMonthDay must be 1-31`);
    }
  } else if (r.byMonthDay != null) {
    throw new ValidationError(`${name}.byMonthDay is only valid for MONTHLY recurrence`);
  }

  const startDate = assertIsoDate(r.startDate, `${name}.startDate`);
  const startTime = assertTimeOfDay(r.startTime, `${name}.startTime`);
  const durationMinutes = assertSafeInt(r.durationMinutes, `${name}.durationMinutes`);
  if (durationMinutes < 1 || durationMinutes * 60_000 > LIMITS.MAX_EVENT_DURATION_MS) {
    throw new ValidationError(`${name}.durationMinutes out of range`);
  }

  const endType = assertOneOf(r.endType, `${name}.endType`, ['never', 'on_date', 'after_count'] as const);
  let endDate: string | null = null;
  let endCount: number | null = null;
  if (endType === 'on_date') {
    endDate = assertIsoDate(r.endDate, `${name}.endDate`);
  } else if (r.endDate != null) {
    throw new ValidationError(`${name}.endDate is only valid when endType is on_date`);
  }
  if (endType === 'after_count') {
    endCount = assertSafeInt(r.endCount, `${name}.endCount`);
    if (endCount < 1 || endCount > LIMITS.MAX_RECURRENCE_COUNT) {
      throw new ValidationError(`${name}.endCount out of range`);
    }
  } else if (r.endCount != null) {
    throw new ValidationError(`${name}.endCount is only valid when endType is after_count`);
  }

  return { freq, interval, byWeekday, byMonthDay, startDate, startTime, durationMinutes, endType, endDate, endCount };
}

// Product-level limits, gathered in one place so they're easy to review and
// tune together rather than scattered as magic numbers across route files.
export const LIMITS = {
  TITLE: 200,
  GAME: 100,
  GROUP_NAME: 100,
  DESCRIPTION: 2000,
  CHANNEL_NAME: 100,
  MAX_INVITEES: 100,
  MAX_GROUP_IDS: 50,
  MAX_GROUP_MEMBERS: 200,
  MAX_POLL_OPTIONS: 50,
  // Applied *after* group expansion, not just to the input arrays -- up to 50
  // groups x 200 members each could otherwise resolve to a far larger invite
  // set than the direct-array limits alone suggest.
  MAX_RESOLVED_INVITEES: 300,
  MAX_WINDOW_SUBMISSIONS: 300,
  MAX_FREE_BUSY_USERS: 100,
  MAX_QUERY_RANGE_MS: 366 * 24 * 60 * 60 * 1000, // ~1 year, for free-busy/calendar queries
  MAX_WINDOW_SPAN_MS: 60 * 24 * 60 * 60 * 1000, // 60 days
  MIN_WINDOW_BLOCK_MINUTES: 30,
  MAX_WINDOW_BLOCK_MINUTES: 14 * 24 * 60, // 2 weeks -- generous upper bound
  MAX_WINDOW_CANDIDATES: 20_000,
  MAX_RECURRENCE_INTERVAL: 1000,
  MAX_RECURRENCE_COUNT: 3650, // ~10 years of daily occurrences
  MAX_PERSONAL_EVENTS_PER_USER: 500,

  // Aggregate ceilings. Everything above bounds a single object; these bound
  // how many objects can accumulate, which is the part that turns ordinary
  // use into a durable availability problem -- every member's calendar loads
  // and expands the whole visible set, and the cron walks all of it every 15
  // minutes. Generous for a friend group, finite for everyone else.
  MAX_ACTIVE_EVENTS_PER_GUILD: 1000,
  MAX_EVENTS_PER_ORGANIZER_PER_GUILD: 300,
  MAX_RECURRING_EVENTS_PER_GUILD: 100,
  MAX_GROUPS_PER_GUILD: 100,
  // Per-occurrence cancels/moves on one recurring series. A series can run for
  // years, but nobody needs to individually override a thousand of its days.
  MAX_OVERRIDES_PER_EVENT: 500,
  MAX_EVENT_DURATION_MS: 366 * 24 * 60 * 60 * 1000, // a year -- generous ceiling for e.g. long travel blocks
} as const;

// Global request-body size cap. router.ts's Content-Length pre-check rejects
// most oversized requests before they reach a route at all, but that header
// is attacker-controlled and absent for chunked transfer -- this streaming
// reader is the real backstop, counting actual bytes as they arrive rather
// than trusting a declared length, and aborting the read as soon as the cap
// is crossed instead of buffering an arbitrarily large body first.
export const MAX_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {}

export async function readJsonBody<T>(c: { req: { raw: Request } }): Promise<T> {
  const body = c.req.raw.body;
  if (!body) return {} as T;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError('Request body too large');
    }
    chunks.push(value);
  }

  if (total === 0) return {} as T;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(combined);
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
}
