# 0011 — Groups without servers

**Status:** Draft
**Covers:** `IDEAS.md` item 36, and item 34 (which it subsumes)
**Phase:** TBD — after v0.5

## The change in one sentence

A group stops belonging to a server and becomes a list of people, valid only
while there is at least one server that contains **every** member of it.

## Why, and why this rule

v0.3 moved *viewing* off servers: the calendar spans every server, the guild
switcher is gone, server is a label. `specs/0006` drew the line explicitly and
named the half that was not moving — *"server stays load-bearing for
invitation… Servers stop mattering for viewing; they keep mattering for who
you can add."* This moves that half.

The property being protected is not "groups are filed under servers". It is
**proof that these people already know each other**: `filterActiveGuildMembers`
exists so that knowing someone's user ID is not enough to graft them onto a
roster or DM them a private event's title. Any replacement has to keep that.

Three candidate rules were considered. The chosen one is the third.

- **Adder-anchored star** — you may add someone if *you* share a server with
  them. Cheapest, and stable. Rejected: it lets two people who share nothing
  end up in one group and see each other on an invite list, which loses the
  property above rather than restating it.
- **Pairwise** — every member shares a server with every other member.
  Rejected, and the reason is the interesting part: **it does not deliver what
  it was asked for.** It was chosen with the reason *"otherwise where is
  everyone playing?"* — but A–B can share X, B–C share Y, and A–C share Z,
  satisfying pairwise while no server contains all three. There is then no
  voice channel they can all join. Pairwise is also O(n²) to check, and it has
  no sensible repair: one person leaving one server can invalidate a group,
  with no defensible answer to which of the others the app should eject.
- **The intersection rule (chosen)** — there exists at least one server
  containing every member. It is strictly stronger than pairwise, it is the
  literal statement of "where is everyone playing", it is *cheaper* to check
  (one `GROUP BY`, not n² pairs), and it fails gracefully: a group whose
  members no longer share anything has **no venue**, which is a state that can
  be displayed and blocked on without ejecting anybody.

So: a group is a list of people, plus the invariant that its **common-server
set** is non-empty. An event picks its venue from that set.

## The common-server set

For a roster, one query, and it is the whole mechanism:

```sql
SELECT m.guild_id
  FROM user_guild_membership m
  JOIN guilds g ON g.id = m.guild_id AND g.is_active = 1
 WHERE m.user_id IN (<roster>) AND m.is_member = 1 AND m.verified_at >= ?
 GROUP BY m.guild_id
HAVING COUNT(DISTINCT m.user_id) = <roster size>
```

`user_guild_membership` is already indexed `(user_id, is_member)`, and
`MAX_GROUP_MEMBERS` is 25, so this is one cheap statement. `verified_at >= ?`
uses the same `MEMBERSHIP_GRACE_MS` bound the calendar and the cron's
recipient queries use, rather than trusting a row of unbounded age.

**Freshness gets cheaper, not dearer** — worth stating because it is
counterintuitive. Today the event's guild is fixed, so a stale cached row for
*that one guild* must be revalidated against Discord or the request is refused
(`MembershipUnavailableError`, `MAX_LIVE_REVALIDATIONS_PER_REQUEST` = 20).
"Does a common server exist" can be answered from whichever rows happen to be
fresh; a live call is only needed when every candidate venue has stale rows.

**Checked on write, not on read.** The invariant is enforced when a roster
changes (create, PATCH's whole-roster replace, add-member) and when an event
is created for the group. It is *not* re-enforced on read: people leave
servers without anyone touching the group, and a group whose intersection has
gone empty must still be readable and editable, or there is no way to repair
it by removing whoever drifted away.

## What a group becomes

```sql
-- Migration NNNN
DROP INDEX idx_groups_guild;
ALTER TABLE groups DROP COLUMN guild_id;
```

Nothing is added. `group_members` is unchanged, and it is already the whole
truth about who is in a group since idea 16 put creators on their own rosters.

Two migration notes:

- **Check `db:verify` on the sandbox before trusting this.** SQLite's
  `DROP COLUMN` rewrites the table definition, and `scripts/verify-schema.mjs`
  compares real schema text against a clean replay of the migrations. This
  repo has three past incidents of exactly that comparison failing for
  cosmetic reasons (see `SETUP.md`), so run `npm run db:verify -- --remote
  --env sandbox` immediately after applying, not at the end of the branch.
- **The backfill is a no-op, and that is checkable.** Every existing group's
  members are all in that group's guild today, by construction — so every
  existing group already satisfies the intersection rule with at least that
  guild in its set. The migration should not need to fix any data, and a
  one-off query asserting zero groups with an empty intersection is worth
  running on production before the deploy rather than assuming it.

## Everything `groups.guild_id` currently holds up

| Use | Where | Replacement |
|---|---|---|
| Roster target validation | `routes/groups.ts`'s `assertValidGroupMemberTargets` | The intersection rule over the proposed roster |
| Group visibility | `routes/me.ts` `/me/groups`, `routes/guilds.ts` `/:guildId/groups` | Membership of the group itself (item 34) |
| Group listing scope | same | `/me/groups` alone; the per-guild listing goes away |
| **Group quota** | `routes/guilds.ts`: `MAX_GROUPS_PER_GUILD` counted `WHERE guild_id = ?` | **Per-owner quota** — see below |
| **Idle-nudge recipients** | `cron/reminders.ts`: joins `user_guild_membership` on `g.guild_id` | Members who are still in the group's common-server set |
| Group creation route | `POST /guilds/:guildId/groups` | `POST /groups` |

Two of those are easy to miss, and both are load-bearing:

**The quota loses its denominator.** `MAX_GROUPS_PER_GUILD` is 100, counted
with `SELECT COUNT(*) FROM groups WHERE guild_id = ?`. With no guild there is
nothing to count against, and an unbounded `groups` table is a resource
question, not a tidiness one. Replace it with a **per-owner cap**
(`WHERE created_by = ?`), which is the only denominator that still exists and
is also the one that matches who is doing the creating. Pick a number that
does not shrink anyone's current headroom: the per-server 100 was generous, so
a per-owner cap of 100 is a strict loosening for everybody except a
hypothetical user who has created more than 100 groups across several servers,
which the migration can check for.

**The idle-nudge sweep filters recipients by guild membership.** It joins
`user_guild_membership ON m.guild_id = g.guild_id` so that someone who left
the server stops being nudged about that server's group. Under this spec the
equivalent is "still in the group's common-server set" — the same query as
above, restricted to the members being nudged. It stays a filter and not a
rejection: the cron must never fail a sweep because a group drifted apart.

## `events.guild_id` stays, and stays `NOT NULL`

This is the decision the whole spec hangs on, and the answer is the
unglamorous one: **the event's guild is the venue.** `voiceChannelLink(guildId,
channelId)` builds `discord.com/channels/{guild}/{channel}` — the actual link
someone clicks to go and play — and `fetchGuildVoiceChannels(botToken,
guildId)` populates the picker. Under the intersection rule the venue is
always a server every member is in, so all five things the column holds up
survive untouched:

1. **The venue** (`cron/reminders.ts`, `lib/discord.ts`).
2. **The invitation boundary** (`lib/eventWrites.ts` — direct invitees
   rejected, group-derived silently dropped).
3. **Control of the event** — `routes/events.ts` requires active guild
   membership to view, edit, cancel, add invitees or RSVP, *on top of* an
   invite row.
4. **Continuing visibility** — `lib/calendar.ts`'s `/me/events` predicate, so
   leaving a server takes its events off your calendar even though the invite
   row survives. Deliberate revocation, not an artefact.
5. **Label, filter, and `specs/0007`'s entire scope.**

An earlier draft of item 36 had this column going nullable and therefore
colliding with 0007's premise, which made 36 urgent to decide before the
noticeboard was built. That was a false choice, and correcting it is what
makes this spec an M rather than an L: **only groups lose their guild.** 0007
is not blocked by this, and the two can be built in either order.

## The four calls this leaves, and what they are decided as

**Which server, when several qualify.** The organizer picks, at event
creation, from the group's current common-server set. Default to the venue of
that group's most recent event; failing that, the only member of the set;
failing that, first by name. The existing New Event server picker (idea 7)
already exists — it narrows its options instead of disappearing.

**Someone leaves the venue server after the event exists.** Leave the event
where it is, and say so on the event page. Do **not** auto-re-anchor: silently
moving where people are meeting is worse than the problem. Do **not** DM the
organizer either — a notification costs the cron's per-tick budget for
something the organizer will see next time they look, and `cron/budget.ts`
exists because that class of "just one more DM" is what broke the tick before.
The event page already lists invitees; a departed one is marked there.

**A group member who left the venue but still shares another server with the
group.** Dropped from *that event* — which is exactly what `resolveInvitees`
already does for group-derived invitees, so this is not a new behaviour — and
never removed from the group. Their membership is still valid: the group's
intersection is non-empty, it just no longer includes the server that event is
being held on.

**Does leaving a server still revoke your view of events you were invited
to?** Yes, unchanged. It stays coherent here, because every member is in the
venue server at creation time by construction.

## Item 34 comes along for free

34 asked whether a server member should see groups they are not in. Decided:
no. Under this spec that stops being a patch and becomes a consequence — with
no `guild_id`, "the groups you can see" and "the groups you are in" are the
same set, and `/me/groups` gains `JOIN group_members gm ON gm.group_id = gr.id
AND gm.user_id = ?` while `GET /guilds/:guildId/groups` is deleted rather than
restricted.

**The consequence to state plainly, in the changelog, in these words: an
organizer can no longer invite a group they are not part of.** The per-guild
route is what feeds the New Event form's invitee picker, and it is going away.
That is the same leak from the other side — inviting twelve people you cannot
name — but it is a visible behaviour change and should not be announced as
"improved privacy".

**34 can also ship on its own, before this spec.** It is a `JOIN` and a
deleted route. If this spec slips, 34 should not slip with it.

## Privacy Policy

The guarantee that survives, and it is worth writing in the policy in these
words: **you are never in a group with someone you share no server with.** The
intersection rule preserves that exactly. It is the sentence the
adder-anchored alternative would have cost, and the reason that alternative
was rejected.

**This is one of the two scheduled items that rewrites the policy, which is
what `IDEAS.md` item 37 is about:** there is currently no mechanism to make
anyone re-agree, so a changed policy simply applies to people who agreed to
the old one. 37 should land before this ships, not after.

What changes in the policy: it can no longer say a group belongs to a server.
A group's roster is visible to its members; a group is valid only while its
members share a server; and an event's server is the venue, chosen from that
shared set.

## Testing

The suite runs real handlers against SQLite built from the migrations, so all
of this is testable without Discord:

- **The rule**: a roster with a common server is accepted; one without is
  rejected; a roster of A–B–C where every *pair* shares a different server is
  **rejected** — this is the test that pins the difference between pairwise
  and intersection, and it is the one that would catch a future refactor
  quietly loosening it.
- **Staleness**: a roster whose only common server has a `verified_at` outside
  `MEMBERSHIP_GRACE_MS` behaves the same way the calendar and cron do, rather
  than inventing a third answer.
- **Repair**: a group whose intersection has gone empty is still readable and
  still editable, and removing the departed member makes it valid again.
- **Event creation** offers only servers in the common set, and refuses one
  outside it.
- **34**: a user in the server but not the group gets a 404 for the group and
  does not see it in `/me/groups`.
- **Quota**: the per-owner cap is enforced, and no existing owner is over it.
- **Nudges**: a member who has drifted out of the common-server set stops
  being nudged, and the sweep does not fail for a group with no common server.

## Rollout

Worker and frontend both change, so this is a mixed branch — which per
`CLAUDE.md` means the sandbox deploys the worker half only, and the frontend
half is verified locally against the sandbox Worker (item 23, still open).
Sequence:

1. Migration + `db:verify --remote --env sandbox` immediately, per the note
   above.
2. Backfill assertion (zero groups with an empty intersection) run against
   **production** before the production deploy, not after.
3. Worker changes to the sandbox; exercise group create/edit with a
   deliberately cross-server roster via `seed:sandbox`.
4. Frontend locally against the sandbox Worker.

## Open questions

1. **Does a group get a display name for its venue set?** "This group can meet
   on: Spacebros, The Pit" is useful when creating an event and possibly
   clutter everywhere else. Leaning: shown on the group page, not in listings.
2. **What does the Groups page show for a group with an empty intersection?**
   It needs to say something more useful than an error — the repair is to
   remove someone, and the page should say which member is unreachable.
   Leaning: list the members who are not in any server the rest share.
3. **Per-owner quota number.** 100 mirrors the old per-guild figure and
   loosens things for everyone, but it was never chosen as a per-*person*
   number. Worth a look at real data before picking.
