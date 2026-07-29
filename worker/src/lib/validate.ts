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
//
// PRIVATE_FREE_PROFILE: after nine remediation passes chasing the D1/
// subrequest cost of theoretical maxima (300 invitees, 50 poll options),
// the product decision (Pass 10 review, "code review convergence and
// product-fit protocol") is that this app is a small private tool, not a
// general-purpose scheduler, and the constants below should say so rather
// than keep being optimized toward numbers nobody using it needs:
//
//   supported active population:  ~25 users in a guild
//   invitees per event:            25
//   free/busy targets per request: 25 (MAX_FREE_BUSY_USERS, below)
//   poll options per poll:         20
//   group IDs per request:         10
//
// A request outside these limits is rejected before any mutation, the same
// way an over-budget free/busy request already was -- this is a scope
// decision, not merely "make the old ceiling cheaper to serve." Every one of
// these has an explicit whole-tick/whole-route test at the values below (see
// worker/test/pass10.test.ts) proving the platform-budget invariant holds at
// the values the product actually supports, in addition to the individual
// limits enforced here.
export const LIMITS = {
  TITLE: 200,
  GAME: 100,
  GROUP_NAME: 100,
  DESCRIPTION: 2000,
  CHANNEL_NAME: 100,
  MAX_INVITEES: 25,
  MAX_GROUP_IDS: 10,
  // A guild's whole active population is expected to be about this size --
  // see PRIVATE_FREE_PROFILE above -- so a "group" is a way to name a subset
  // of everyone, not a second, larger population of its own.
  MAX_GROUP_MEMBERS: 25,
  MAX_POLL_OPTIONS: 20,
  // Applied *after* group expansion, not just to the input arrays. Now close
  // to MAX_INVITEES rather than an order of magnitude above it: with guild
  // population and group size both capped at 25, direct and group-derived
  // invitees can never dedupe to more than the guild itself holds, so a
  // materially larger ceiling here would only ever be reached by a guild
  // outside the supported profile.
  MAX_RESOLVED_INVITEES: 25,
  MAX_WINDOW_SUBMISSIONS: 300,
  // Deliberately much smaller than it was. Free/busy is the one endpoint
  // whose cost is a *product* -- users x their events x occurrences in the
  // window -- so every factor has to be small, not just bounded. Asking about
  // 25 people at once already exceeds any real scheduling conversation.
  MAX_FREE_BUSY_USERS: 25,
  MAX_QUERY_RANGE_MS: 366 * 24 * 60 * 60 * 1000, // ~1 year, for calendar queries
  // ...but free/busy gets its own, far tighter range. A calendar view of next
  // year is one user's own events; a *year* of free/busy is 25 people's
  // recurring series expanded day by day, which is where the millions of
  // in-memory occurrence objects came from. Nobody schedules a game night
  // ten months out.
  MAX_FREE_BUSY_RANGE_MS: 62 * 24 * 60 * 60 * 1000, // ~2 months
  // Hard ceiling on expanded occurrences for one free/busy request, across
  // every user and event. The per-factor limits above should keep a real
  // request orders of magnitude below this; it exists so no combination of
  // them can ever be multiplied into an unbounded amount of work.
  MAX_FREE_BUSY_OCCURRENCES: 20_000,
  // The same idea applied to *input* rather than output.
  //
  // MAX_FREE_BUSY_OCCURRENCES bounds the work a request produces, but it can
  // only be consulted once the source events have already been read -- and
  // reading them is itself unbounded work. Every other quota in this file is
  // per guild, and one user can be an active member of many guilds, so
  // "300 events" becomes 4,200 the moment someone is in fourteen of them.
  // Those events then get an override lookup each, one query per 80, which
  // crosses the Free plan's whole 50-query allowance before the occurrence
  // ceiling has anything to say -- and it does so even when every one of
  // those events falls outside the requested window and would expand to
  // nothing at all.
  //
  // So the source set is capped and range-filtered in SQL before any of it
  // is materialised. Exceeding this rejects with the same 422 an over-budget
  // expansion does: "ask about a shorter window" is recoverable advice, and
  // is far more honest than a 500 from the platform mid-request.
  MAX_FREE_BUSY_SOURCE_EVENTS: 400,
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
  // Chosen so the guild calendar's worst-case query count (every visible
  // event, chunked in groups of 80, across the overrides/RSVP/primary-group/
  // recurrence-rule/confirmed-poll-option helpers) stays comfortably inside
  // Cloudflare D1's 50-query Free-plan budget per Worker invocation, not just
  // the 1000-query Paid budget. Still enormous headroom for a friend group.
  MAX_ACTIVE_EVENTS_PER_GUILD: 300,
  MAX_EVENTS_PER_ORGANIZER_PER_GUILD: 300,
  MAX_RECURRING_EVENTS_PER_GUILD: 100,
  MAX_GROUPS_PER_GUILD: 100,
  // Counts *every* event row, cancelled ones included. The active quotas
  // above deliberately exclude cancelled events so a guild that tidies up
  // isn't punished for it -- but that also means create-then-cancel is
  // unlimited, and cancelled rows still occupy the database (and, until the
  // 90-day purge reaches them, still get read). This is the backstop that
  // makes the cycle finite: generous enough that no honest guild will meet
  // it, low enough that churn can't outrun the purge.
  MAX_TOTAL_EVENT_ROWS_PER_GUILD: 2000,
  // Per-occurrence cancels/moves on one recurring series. A series can run for
  // years, but nobody needs to individually override a thousand of its days.
  MAX_OVERRIDES_PER_EVENT: 500,
  MAX_EVENT_DURATION_MS: 366 * 24 * 60 * 60 * 1000, // a year -- generous ceiling for e.g. long travel blocks

  // The other half of PRIVATE_FREE_PROFILE, above. Not enforced as a reject
  // anywhere -- guild membership is synced from Discord at login
  // (lib/db.ts's syncGuildMembership), and refusing someone's login because
  // their server happens to be large is not a request the app should be
  // making. This exists so "supported" has one number: whole-tick and
  // whole-route maximum-state tests are written against a guild this size,
  // not against an arbitrary larger one, and a guild that grows past it is
  // an explicit, documented product limit rather than a silent cliff.
  SUPPORTED_ACTIVE_USERS_PER_GUILD: 25,
} as const;

// Global request-body size cap. router.ts's Content-Length pre-check rejects
// most oversized requests before they reach a route at all, but that header
// is attacker-controlled and absent for chunked transfer -- this streaming
// reader is the real backstop, counting actual bytes as they arrive rather
// than trusting a declared length, and aborting the read as soon as the cap
// is crossed instead of buffering an arbitrarily large body first.
export const MAX_BODY_BYTES = 64 * 1024;

// Thrown when a free/busy request's expansion work exceeds
// MAX_FREE_BUSY_OCCURRENCES. Lives here rather than in freeBusy.ts so the
// personal-event expander can throw it too without importing its caller.
//
// The router maps this to 422: the request is well-formed and authorized, and
// retrying it unchanged will not help -- the caller has to ask for less. It is
// deliberately NOT a partial 200. The response is a list of busy blocks, so an
// omitted commitment is indistinguishable from genuine free time; answering
// partially would tell the caller someone is available at a time the database
// says they are busy.
export class FreeBusyTooLargeError extends Error {
  constructor() {
    super(
      'That free/busy request covers too many commitments to answer accurately. Select fewer people or a shorter date range.',
    );
    this.name = 'FreeBusyTooLargeError';
  }
}

export class BodyTooLargeError extends Error {}

// The caller's read of the object is out of date: someone else changed it
// between their read and their write. Distinct from ValidationError because
// nothing about the request is malformed -- retrying it against fresh state is
// the correct response, which is what 409 tells a client.
export class ConflictError extends Error {
  constructor(message = 'This event was changed by someone else -- reload and try again') {
    super(message);
    this.name = 'ConflictError';
  }
}

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
