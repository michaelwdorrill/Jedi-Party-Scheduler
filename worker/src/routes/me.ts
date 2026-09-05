import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import { requirePolicyAcceptance } from '../lib/authMiddleware';
import { CURRENT_POLICY_VERSION } from '../lib/policy';
import { buildCalendarOccurrences } from '../lib/calendar';
import { chunkIds, placeholders } from '../lib/d1';
import { deleteUserCompletely, isGuildMember, isOwner, listFriends, listFriendsAcrossGuilds, mapUser, type UserRow } from '../lib/db';
import { commonServerSet } from '../lib/groups';
import { assertBoolean, assertTimezone, LIMITS, readJsonBody, ValidationError } from '../lib/validate';

export const meRoutes = new Hono<AppEnv>();

const PROFILE_COLUMNS = `id, username, global_name, avatar_hash, timezone, notifications_enabled, free_busy_visible, accepted_policy_version, accepted_policy_at`;

// Four routes in this file are deliberately NOT gated on policy acceptance
// (docs/specs/0012): this one, GET /export, DELETE /, and POST /accept-policy.
//
// They are what makes the gate a gate rather than a wall. The export and the
// deletion endpoints live behind requireAuth, so a logged-out person cannot
// take their data with them or leave properly -- "agree or you cannot use the
// app" has to leave someone who will not agree a way out. This one is how the
// frontend learns it needs to show the screen at all.
//
// Every other route in this file carries requirePolicyAcceptance explicitly,
// rather than the group being gated and these four opting out, because a
// route added later should fail closed: forgetting to gate a new route is the
// mistake worth making impossible-by-omission, and here it costs a visible
// missing argument rather than a silent hole.
meRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  if (!row) return c.text('User not found', 404);
  return c.json({
    ...mapUser(row, isOwner(c.env, userId)),
    // The frontend reads the current version from here rather than holding a
    // copy of it -- two constants in two deployables that must agree is the
    // drift check:env-parity exists to catch elsewhere.
    policyVersion: CURRENT_POLICY_VERSION,
    acceptedPolicyVersion: row.accepted_policy_version,
  });
});

// Recording the agreement. Idempotent: agreeing twice is not an error, and
// the timestamp moves to the most recent one.
meRoutes.post('/accept-policy', async (c) => {
  const userId = c.get('userId');
  await c.env.DB.prepare(
    `UPDATE users SET accepted_policy_version = ?, accepted_policy_at = ? WHERE id = ?`,
  )
    .bind(CURRENT_POLICY_VERSION, Date.now(), userId)
    .run();
  c.set('acceptedPolicyVersion', CURRENT_POLICY_VERSION);
  return c.json({ ok: true, policyVersion: CURRENT_POLICY_VERSION });
});

meRoutes.patch('/', requirePolicyAcceptance, async (c) => {
  const userId = c.get('userId');
  const body = await readJsonBody<{
    timezone?: string;
    notificationsEnabled?: boolean;
    freeBusyVisible?: boolean;
  }>(c);
  if (body.timezone !== undefined) assertTimezone(body.timezone, 'timezone');
  if (body.notificationsEnabled !== undefined) assertBoolean(body.notificationsEnabled, 'notificationsEnabled');
  if (body.freeBusyVisible !== undefined) assertBoolean(body.freeBusyVisible, 'freeBusyVisible');

  await c.env.DB.prepare(
    `UPDATE users SET
       timezone = COALESCE(?, timezone),
       notifications_enabled = COALESCE(?, notifications_enabled),
       free_busy_visible = COALESCE(?, free_busy_visible),
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.timezone ?? null,
      body.notificationsEnabled === undefined ? null : body.notificationsEnabled ? 1 : 0,
      body.freeBusyVisible === undefined ? null : body.freeBusyVisible ? 1 : 0,
      Date.now(),
      userId,
    )
    .run();

  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  return c.json(mapUser(row!, isOwner(c.env, userId)));
});

// Right to erasure. Irreversible and immediate -- no soft-delete, no grace
// period, nothing retained for analytics.
meRoutes.delete('/', async (c) => {
  const userId = c.get('userId');
  await deleteUserCompletely(c.env, userId);
  return c.json({ ok: true });
});

// Everything this app holds about the caller, in one JSON payload (GDPR
// right of access / data portability).
meRoutes.get('/export', async (c) => {
  c.header('Cache-Control', 'no-store, private');
  const userId = c.get('userId');
  const tables: Record<string, string> = {
    profile: `SELECT ${PROFILE_COLUMNS}, created_at, updated_at, last_login_at FROM users WHERE id = ?`,
    serverMemberships: `SELECT guild_id, nickname, is_member, verified_at FROM user_guild_membership WHERE user_id = ?`,
    personalEvents: `SELECT * FROM personal_events WHERE user_id = ?`,
    organisedEvents: `SELECT * FROM events WHERE organizer_id = ?`,
    invitations: `SELECT * FROM event_invites WHERE user_id = ?`,
    attendance: `SELECT * FROM event_attendance WHERE user_id = ?`,
    pollVotes: `SELECT * FROM event_poll_votes WHERE user_id = ?`,
    windowAvailability: `SELECT * FROM event_window_availability WHERE user_id = ?`,
    groupsCreated: `SELECT * FROM groups WHERE created_by = ?`,
    groupMemberships: `SELECT * FROM group_members WHERE user_id = ?`,
    notificationsSent: `SELECT * FROM notification_log WHERE user_id = ?`,
    // IDEAS item 2 / specs/0017. Columns are listed explicitly rather than
    // `SELECT *`, and that is the whole point of the difference from every
    // other line here: this table holds encrypted OAuth credentials, and a
    // wildcard would put them in a file the user downloads and may well email
    // to themselves. An export is a right of access to *your data*, not to the
    // app's keys for acting on your behalf.
    googleCalendar: `SELECT google_account_email, calendar_id, sync_enabled, status, last_synced_at,
                       connected_at, updated_at
                     FROM google_calendar_connections WHERE user_id = ?`,
    googleCalendarLinks: `SELECT event_id, occurrence_date, synced_title, synced_start_at, synced_end_at, synced_at
                          FROM google_event_links WHERE user_id = ?`,
  };

  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const [key, sql] of Object.entries(tables)) {
    const { results } = await c.env.DB.prepare(sql).bind(userId).all();
    out[key] = results;
  }
  return c.json(out);
});

// The cross-guild personal calendar -- everything you organize or are
// invited to, across every server you're still an active member of, plus your
// own personal time blocks. This is what makes the app calendar-first rather
// than server-first (docs/specs/0006): there was previously no way to ask
// "what's on for me" without first picking a server.
//
// Cheaper than it sounds, and cheaper than the per-guild route it
// generalizes: both are bounded by what the caller is personally attached to,
// not by how much exists in a guild. See lib/calendar.ts.
meRoutes.get('/events', requirePolicyAcceptance, async (c) => {
  const userId = c.get('userId');
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new ValidationError('from and to (unix ms) are required');
  }
  if (to <= from) throw new ValidationError('to must be after from');
  if (to - from > LIMITS.MAX_QUERY_RANGE_MS) throw new ValidationError('from/to range is too large');

  return c.json(await buildCalendarOccurrences(c.env, userId, from, to));
});

// Every group the caller is a member of. The only group-listing endpoint
// there is: the per-guild GET /guilds/:id/groups was removed in v0.4.3
// (IDEAS item 34), which is why the event form's invitee picker reads this
// one too.
//
// specs/0011 / IDEAS item 36: a group is no longer scoped to one server, so
// this no longer joins `user_guild_membership` to filter which groups show
// up -- `group_members` alone is the visibility rule now (decided: group
// membership is enough on its own; the boundary that second join used to
// enforce now lives at the event level, where a group with an unreachable
// member can't be used to create one). Each group carries its current
// common-server set instead of a single guild, computed the same way
// GET /groups/:id does.
meRoutes.get('/groups', requirePolicyAcceptance, async (c) => {
  const userId = c.get('userId');

  const { results: groups } = await c.env.DB.prepare(
    `SELECT gr.id, gr.name, gr.game, gr.idle_reminder_days, gr.created_by
     FROM groups gr
     JOIN group_members mine ON mine.group_id = gr.id AND mine.user_id = ?
     ORDER BY gr.name`,
  )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      game: string | null;
      idle_reminder_days: number;
      created_by: string;
    }>();

  // One chunked query for every group's members rather than one per group --
  // same reason the per-guild route did it that way.
  const membersByGroup = new Map<string, { id: string; username: string; global_name: string | null; avatar_hash: string | null }[]>();
  for (const chunk of chunkIds(groups.map((g) => g.id))) {
    const { results } = await c.env.DB.prepare(
      `SELECT gm.group_id, u.id, u.username, u.global_name, u.avatar_hash
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<{ group_id: string; id: string; username: string; global_name: string | null; avatar_hash: string | null }>();
    for (const row of results) {
      if (!membersByGroup.has(row.group_id)) membersByGroup.set(row.group_id, []);
      membersByGroup.get(row.group_id)!.push(row);
    }
  }

  // One common-server-set computation per group, not one query per group --
  // MAX_GROUP_MEMBERS bounds each roster, and a person is realistically in a
  // handful of groups, so this is cheap without needing a bulk variant.
  const commonServersByGroup = new Map<string, { id: string; name: string }[]>();
  for (const g of groups) {
    const memberIds = (membersByGroup.get(g.id) ?? []).map((m) => m.id);
    commonServersByGroup.set(g.id, await commonServerSet(c.env, memberIds));
  }

  return c.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      game: g.game,
      idleReminderDays: g.idle_reminder_days,
      createdBy: g.created_by,
      commonServers: commonServersByGroup.get(g.id) ?? [],
      members: (membersByGroup.get(g.id) ?? []).map((m) => ({
        id: m.id,
        username: m.username,
        globalName: m.global_name,
        avatarHash: m.avatar_hash,
      })),
    })),
  );
});

// guild_id is optional now (specs/0011 / IDEAS item 36): the New Event
// form's invitee picker still passes it, since an invitee is always scoped
// to one event's one server. The group picker omits it and gets everyone
// the caller shares any active server with, each tagged with which of the
// caller's own servers -- see listFriendsAcrossGuilds.
meRoutes.get('/friends', requirePolicyAcceptance, async (c) => {
  const userId = c.get('userId');
  const guildId = c.req.query('guild_id');
  if (!guildId) return c.json(await listFriendsAcrossGuilds(c.env, userId));
  if (!(await isGuildMember(c.env, userId, guildId))) return c.text('Forbidden', 403);

  return c.json(await listFriends(c.env, userId, guildId));
});
