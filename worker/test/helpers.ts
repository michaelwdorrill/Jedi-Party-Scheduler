import { vi } from 'vitest';
import type { Env } from '../src/env';
import { createTestDb, type ShimDatabase } from './d1shim';
import type { EventRow } from '../src/lib/events';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface TestContext {
  db: ShimDatabase;
  env: Env;
}

export function makeEnv(db: ShimDatabase, plan: 'free' | 'paid' = 'free'): Env {
  return {
    DB: db as unknown as D1Database,
    WORKERS_PLAN: plan,
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_BOT_TOKEN: 'bot-token',
    JWT_SIGNING_KEY: 'test-signing-key-at-least-32-characters-long',
    FRONTEND_URL: 'https://example.test/app',
    OWNER_DISCORD_ID: 'owner',
  } as Env;
}

export function setup(plan: 'free' | 'paid' = 'free'): TestContext {
  const db = createTestDb();
  return { db, env: makeEnv(db, plan) };
}

// ---------------------------------------------------------------------------
// Discord stubbing
// ---------------------------------------------------------------------------

export interface FetchRule {
  // Matched as a substring of the request URL.
  match: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  // Throw instead of responding, modelling a network failure.
  networkError?: boolean;
}

export interface FetchStub {
  calls: string[];
  restore: () => void;
}

// Replaces global fetch with a rule table. Anything unmatched throws, so a
// test can never silently pass because it accidentally hit the real network.
export function stubFetch(rules: FetchRule[]): FetchStub {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const rule = rules.find((r) => url.includes(r.match));
    if (!rule) throw new Error(`Unstubbed fetch to ${url}`);
    if (rule.networkError) throw new TypeError('network failure');
    return new Response(rule.body === undefined ? '' : JSON.stringify(rule.body), {
      status: rule.status,
      headers: { 'Content-Type': 'application/json', ...(rule.headers ?? {}) },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export const DM_CHANNEL_RULE: FetchRule = {
  match: '/users/@me/channels',
  status: 200,
  body: { id: 'dm-channel-1' },
};

export function membershipRule(status: number, body: unknown = {}): FetchRule {
  return { match: '/members/', status, body };
}

export function dmSendRule(status: number, headers?: Record<string, string>): FetchRule {
  return { match: '/messages', status, body: { id: 'message-1' }, headers };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export async function seedGuild(db: ShimDatabase, id = 'guild-1', isActive = 1): Promise<string> {
  await db.prepare(`INSERT INTO guilds (id, name, is_active, added_at) VALUES (?, ?, ?, ?)`)
    .bind(id, `Guild ${id}`, isActive, Date.now())
    .run();
  return id;
}

export async function seedUser(db: ShimDatabase, id: string): Promise<string> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO users (id, username, global_name, avatar_hash, timezone, notifications_enabled,
       created_at, updated_at, last_login_at, last_login_attempt_at)
     VALUES (?, ?, NULL, NULL, 'America/New_York', 1, ?, ?, ?, ?)`,
  )
    .bind(id, `user-${id}`, now, now, now, now)
    .run();
  return id;
}

// verifiedAgoMs controls how stale the membership row is, which is the single
// most important dimension in the membership tests.
export async function seedMembership(
  db: ShimDatabase,
  userId: string,
  guildId: string,
  { verifiedAgoMs = 0, isMember = 1 }: { verifiedAgoMs?: number; isMember?: number } = {},
): Promise<void> {
  await db.prepare(
    `INSERT INTO user_guild_membership (user_id, guild_id, is_member, verified_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(userId, guildId, isMember, Date.now() - verifiedAgoMs)
    .run();
}

export async function seedEvent(
  db: ShimDatabase,
  {
    id,
    guildId = 'guild-1',
    organizerId,
    title = 'Test event',
    startAt = Date.now() + 2 * HOUR_MS,
    endAt = Date.now() + 3 * HOUR_MS,
    status = 'active',
    isRecurring = 0,
    eventType = 'single',
  }: {
    id: string;
    guildId?: string;
    organizerId: string;
    title?: string;
    startAt?: number | null;
    endAt?: number | null;
    status?: string;
    isRecurring?: number;
    eventType?: string;
  },
): Promise<string> {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at,
       status, poll_mode, poll_resolution_mode, is_recurring, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'America/New_York', ?, ?, ?, 'options', 'single_winner', ?, ?, ?)`,
  )
    .bind(id, guildId, organizerId, title, eventType, startAt, endAt, status, isRecurring, now, now)
    .run();
  return id;
}

export async function seedInvite(db: ShimDatabase, eventId: string, userId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO event_invites (id, event_id, user_id, invited_via, rsvp_status, invited_at)
     VALUES (?, ?, ?, 'individual', 'pending', ?)`,
  )
    .bind(`inv-${eventId}-${userId}`, eventId, userId, Date.now())
    .run();
}

export async function countRows(db: ShimDatabase, table: string, where = '1=1', ...values: unknown[]): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first<{ n: number }>();
  return row?.n ?? 0;
}

export function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

// The stored event row, as updateEvent's callers pass it: the route loads and
// authorizes the event first, and updateEvent needs it both for its revision
// (the optimistic-concurrency token) and to validate the merged result.
export async function loadEventRow(db: ShimDatabase, eventId: string): Promise<EventRow> {
  const row = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!row) throw new Error(`test fixture: no event ${eventId}`);
  return row;
}
