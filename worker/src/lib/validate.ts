// Hand-rolled runtime validation for untrusted request bodies/queries -- no
// external schema library, consistent with this codebase's existing
// minimal-dependency style (see jwt.ts). TypeScript's `c.req.json<T>()`
// generic is purely a compile-time annotation; it does nothing at runtime,
// so every field an attacker controls needs an explicit check here.
//
// Route handlers call these directly and let them throw; router.ts's
// app.onError() turns a ValidationError into a clean 400 with the message,
// so no route needs its own try/catch.

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
  MAX_FREE_BUSY_USERS: 100,
  MAX_QUERY_RANGE_MS: 366 * 24 * 60 * 60 * 1000, // ~1 year, for free-busy/calendar queries
  MAX_WINDOW_SPAN_MS: 60 * 24 * 60 * 60 * 1000, // 60 days
  MIN_WINDOW_BLOCK_MINUTES: 30,
  MAX_WINDOW_BLOCK_MINUTES: 14 * 24 * 60, // 2 weeks -- generous upper bound
  MAX_WINDOW_CANDIDATES: 20_000,
  MAX_RECURRENCE_INTERVAL: 1000,
  MAX_RECURRENCE_COUNT: 3650, // ~10 years of daily occurrences
  MAX_EVENT_DURATION_MS: 366 * 24 * 60 * 60 * 1000, // a year -- generous ceiling for e.g. long travel blocks
} as const;

// Global request-body size cap. Applied before any JSON parsing (see
// router.ts) so an oversized payload never reaches route logic or gets
// buffered into memory unnecessarily.
export const MAX_BODY_BYTES = 64 * 1024;
