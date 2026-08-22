# 0006 — Calendar-first, not server-first

**Status:** Built
**Covers:** `IDEAS.md` item 5 · **Phase:** 3 · **Ships in:** v0.3

## The complaint

> "It's too server heavy — I want this to be a calendar app. People shouldn't
> be thinking of this a server at a time... the main goal should be to see
> your calendar across all servers."

Idea 5 was originally written as a *view* change ("land on just your
calendar"). It isn't one. The server-scoping is structural, and a landing
view built on today's API would still have to pick a server first.

## Why a landing view alone couldn't fix it

Before this change, **the only event-listing endpoint in the app was
`GET /guilds/:guildId/events`**. There was no way to ask "what's on for me"
without naming a server. `CalendarPage` didn't just default to a guild — it
early-returned when none was selected:

```ts
if (!selectedGuildId) return;
```

So "your calendar across all servers" wasn't a rearrangement of existing
pieces; the piece didn't exist.

## The counterintuitive part: cross-guild is *cheaper*

The instinct is that spanning every server multiplies cost, and
`validate.ts` even warns about exactly that shape:

> "one user can be an active member of many guilds, so '300 events' becomes
> 4,200 the moment someone is in fourteen of them."

That warning is about **"every event in every guild I'm in"** — which is the
*server browse* view, not this one. The personal calendar asks a narrower
question: *events I organize or am invited to*. That's bounded by the
caller's own invite rows, not by guild size. The per-guild route was already
paying that same cost and then **adding** a guild filter on top.

So the new endpoint is the old one minus a `WHERE` clause, not plus a join
over everything.

## What was built

### `GET /me/events?from=&to=`

Returns the same occurrence shape the guild route returns, across every guild
where the caller is still an active member, plus their own personal time
blocks. Each occurrence gains `guildId` and `guildName` so the UI can label
and colour by server without a second lookup.

### One implementation, two scopes

The whole event-loading and occurrence-expansion body moved out of
`routes/guilds.ts` into **`lib/calendar.ts`**'s `buildCalendarOccurrences(env,
userId, from, to, scope)`. Both routes now call it; the only difference is
the guild predicate:

| Caller | Predicate |
|---|---|
| `GET /guilds/:id/events` | `e.guild_id = ?` (caller already authorized against that guild) |
| `GET /me/events` | `EXISTS (…user_guild_membership… AND is_member = 1 AND verified_at >= cutoff)` |

Keeping it one implementation is not tidiness. That block handles resolved
vs unresolved polls, multi-winner confirmed options, recurrence expansion and
per-occurrence overrides. Two copies would drift, and the symptom would be
*"the calendar disagrees with itself depending on which view you opened"* —
the worst class of bug to debug in a scheduling app.

### The membership predicate is load-bearing

`event_invites` rows are **not** deleted when someone leaves a server (the
same fact behind idea 15). So without the membership `EXISTS`, a departed
member's stale invite rows would keep that server's events on their personal
calendar indefinitely. The `verified_at >= now - MEMBERSHIP_GRACE_MS` bound
is the same freshness rule the cron's recipient queries use — a row nothing
has confirmed for over a day stops counting, rather than trusting a row of
unbounded age.

Both are covered by tests: a departed guild's events disappear, and a
membership stale past the grace window does too.

## The boundary that does not move

**Server stays load-bearing for invitation.** `filterActiveGuildMembers` is
what stops an event on one server pulling in someone you only share a
*different* server with. Nothing here relaxes that, and nothing should:
servers stop mattering for **viewing**, and keep mattering for **who you can
add**. That distinction is the whole design, not an implementation detail.

## Frontend (remaining)

- `CalendarPage` loads `/me/events` and no longer requires a selected guild.
- The calendar becomes the landing route.
- The guild switcher demotes from global nav to a contextual control; server
  becomes a label/filter on the calendar rather than a mode you're in.
- `New Event` already has its own server picker (Phase 0, idea 7), so the
  creation path was already aligned.

## Not in scope

The **free/busy-only server browse** ("see what else is going on in a server,
without event detail") is the other half of idea 5. It's a genuinely
different query with a privacy dimension — it shows blocks for events you are
*not* invited to — and should be designed against `lib/freeBusy.ts`'s
existing guarantees rather than bolted onto this endpoint. Deferred, and the
personal calendar does not depend on it.
