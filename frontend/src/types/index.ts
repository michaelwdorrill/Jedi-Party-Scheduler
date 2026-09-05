export interface User {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  timezone: string;
  notificationsEnabled: boolean;
  freeBusyVisible: boolean;
  isOwner: boolean;
  // The policy version in force, and the one this person last agreed to
  // (docs/specs/0012). The server owns the first: a client-side copy of it
  // would be a second constant that has to agree with the Worker's, which is
  // exactly the drift this avoids having at all.
  policyVersion: number;
  acceptedPolicyVersion: number;
}

export interface Guild {
  id: string;
  name: string;
}

// IDEAS item 2 / docs/specs/0017. `configured` is about the deployment, not
// the person: it is false when the operator hasn't provisioned Google yet, and
// the Settings card hides itself entirely rather than offering a button that
// can only 503.
export interface GoogleCalendarStatus {
  configured: boolean;
  connected: boolean;
  accountEmail?: string | null;
  calendarId?: string;
  syncEnabled?: boolean;
  // 'disconnecting' while the cron removes the entries already written, before
  // the credential is revoked and the connection dropped.
  status?: 'active' | 'disconnecting';
  lastSyncedAt?: number | null;
  // Why sync stopped, shown to the user because "it silently stopped working"
  // is this feature's most likely failure.
  lastError?: string | null;
}

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

export interface CommonServer {
  id: string;
  name: string;
}

export interface Group {
  id: string;
  // specs/0011 / IDEAS item 36: a group no longer belongs to one server --
  // this is every server currently containing all of its members, in
  // display order. Empty means the group has no venue right now (someone
  // drifted apart from the rest) and can't be used to create a new event
  // until that's fixed.
  commonServers: CommonServer[];
  name: string;
  game: string | null;
  idleReminderDays: number;
  createdBy: string;
  members: Friend[];
}

export interface Friend {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  // Only present when GET /me/friends is called without guild_id (the group
  // picker's shape) -- which of the *caller's own* servers this person also
  // currently shares. Used to narrow candidates client-side as a roster is
  // built; never includes a server the caller isn't in.
  guildIds?: string[];
}

export type EventType = 'single' | 'poll';
export type EventStatus = 'active' | 'cancelled' | 'resolved';
// specs/0014: attendance is per occurrence now, and there's no 'pending'
// value any more -- the absence of an answer (myRsvpStatus / rsvpStatus
// being null) *is* "no answer", rather than an explicit status meaning it.
export type RsvpStatus = 'accepted' | 'declined' | 'tentative';
export type PollStrategy = 'threshold' | 'most_votes';
export type PollVote = 'yes' | 'no' | 'maybe';
export type PollMode = 'options' | 'window';
export type PollResolutionMode = 'single_winner' | 'multi_winner';
export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type RecurrenceEndType = 'never' | 'on_date' | 'after_count';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  byWeekday: number[] | null; // 0=Mon..6=Sun
  byMonthDay: number | null;
  startDate: string; // ISO date
  startTime: string; // HH:MM
  durationMinutes: number;
  endType: RecurrenceEndType;
  endDate: string | null;
  endCount: number | null;
}

// IDEAS item 49: one voter's answer on one option -- their vote, cast
// whenever, plus their current RSVP where one exists (item 51's
// override rule: an RSVP recorded after voting outranks the vote it
// disagrees with). Null before the poll resolves, since there is nothing
// to RSVP to yet.
export interface PollVoter {
  userId: string;
  username: string;
  globalName: string | null;
  vote: PollVote;
  currentRsvpStatus: RsvpStatus | null;
}

export interface PollOption {
  id: string;
  startAt: number; // unix ms UTC
  endAt: number;
  displayOrder: number;
  confirmedAt: number | null;
  confirmedUsers: { userId: string; username: string; globalName: string | null }[];
  // Everyone who voted on this option, not just the confirmed set above --
  // visible whether or not the poll (or this option) has resolved.
  voters: PollVoter[];
  tally: { yes: number; no: number; maybe: number };
  myVote: PollVote | null;
}

export interface WindowSubmission {
  userId: string;
  username: string;
  globalName: string | null;
  startAt: number;
  endAt: number;
  // Same override as PollVoter.currentRsvpStatus, for the same reason.
  currentRsvpStatus: RsvpStatus | null;
}

// One candidate of a windowed poll (specs/0013). A poll used to have exactly
// one window; it now has one per candidate, each answered separately.
export interface WindowCandidateInfo {
  optionId: string;
  windowStartAt: number;
  windowEndAt: number;
  displayOrder: number;
  confirmedAt: number | null;
  mySubmission: { startAt: number; endAt: number } | null;
  submissions: WindowSubmission[];
  bestCandidate: { startAt: number; endAt: number; count: number } | null;
}

// As returned by GET /events/:eventId/window
export interface WindowInfo {
  // The minimum session length for the whole poll -- the floor every
  // candidate's best span has to clear.
  blockMinutes: number;
  candidates: WindowCandidateInfo[];
}

export interface EventInvite {
  userId: string;
  username: string;
  globalName: string | null;
  invitedVia: 'individual' | 'group';
  sourceGroupId: string | null;
  rsvpStatus: RsvpStatus | null;
}

// A single occurrence as returned by GET /guilds/:guildId/events?from=&to=
export interface EventOccurrence {
  occurrenceId: string; // `${eventId}::${date}` for recurring, eventId otherwise
  eventId: string;
  title: string;
  description: string | null;
  game: string | null;
  eventType: EventType;
  status: EventStatus;
  timezone: string;
  startAt: number | null; // null for unresolved polls
  endAt: number | null;
  isRecurring: boolean;
  isPersonal: boolean;
  // A candidate day on a poll that has not resolved -- something that might
  // happen, not something that will (idea 41).
  isProvisional?: boolean;
  organizerId: string;
  // Which server this event belongs to, for labelling and filtering on the
  // cross-guild calendar (spec 0006). Null for personal time, which isn't
  // guild-scoped.
  guildId: string | null;
  guildName: string | null;
  myRsvpStatus: RsvpStatus | null;
  pollDeadlineAt: number | null;
  // Which saved group this event was invited through, if any. Used purely to
  // colour a group's sessions consistently on the calendar.
  groupId: string | null;
}

export type PersonalAvailability = 'busy' | 'considering' | 'free';

export interface PersonalEvent {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  timezone: string;
  startAt: number | null;
  endAt: number | null;
  status: 'active' | 'cancelled';
  availability: PersonalAvailability;
  isRecurring: boolean;
  recurrence: RecurrenceRule | null;
}

// A single person's opaque availability, as returned by the scheduling
// assistant. `busy` carries times and nothing else -- no titles, ever.
export interface FreeBusyEntry {
  userId: string;
  username: string;
  globalName: string | null;
  visible: boolean;
  busy: { startAt: number; endAt: number }[];
}

export interface VoiceChannel {
  id: string;
  name: string;
}

// Full detail as returned by GET /events/:eventId
export interface EventDetail extends EventOccurrence {
  guildId: string;
  organizerUsername: string | null;
  organizerGlobalName: string | null;
  // Optimistic-concurrency token: send this back unchanged on PATCH so the
  // server can tell a stale edit from a current one (F-08-B).
  revision: number;
  // '' for a non-recurring event; for a recurring one, whichever occurrence
  // this response is about -- the ?occurrence= query param if one was sent,
  // otherwise the server's own next-upcoming-occurrence default (specs/0014
  // decision 6b). Echoed back so a bare link's default is known, and read
  // back into the RSVP POST body.
  occurrenceDate: string;
  pollStrategy: PollStrategy | null;
  pollThresholdCount: number | null;
  pollMode: PollMode | null;
  pollResolutionMode: PollResolutionMode | null;
  windowStartAt: number | null;
  windowEndAt: number | null;
  windowBlockMinutes: number | null;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
  // specs/0014 stage 3, decision 4 / IDEAS item 54. Available on both
  // recurring and non-recurring single events now -- which of the two
  // deadline fields below applies is decided by isRecurring.
  minimumAttendees: number | null;
  autoCancelBelowMinimum: boolean;
  minimumAttendeesDeadlineAt: number | null;
  minimumAttendeesDeadlineHoursBefore: number | null;
  recurrence: RecurrenceRule | null;
  invites: EventInvite[];
  pollOptions: PollOption[] | null;
}

// Invitee change requests (docs/specs/0003-event-change-requests.md).
export type ChangeRequestKind = 'time_change' | 'add_invitee';
export type ChangeRequestStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';

// As returned by GET /events/:eventId/change-requests. What a given viewer
// sees is asymmetric server-side -- see the spec -- so this shape is the
// same for organizer and invitee callers, just a different subset of rows.
export interface ChangeRequestView {
  id: string;
  kind: ChangeRequestKind;
  requesterId: string;
  requesterUsername: string;
  requesterGlobalName: string | null;
  proposedStartAt: number | null;
  proposedEndAt: number | null;
  occurrenceDate: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetGlobalName: string | null;
  message: string | null;
  status: ChangeRequestStatus;
  decisionNote: string | null;
  eventRevision: number;
  voteThresholdCount: number | null;
  voteDeadlineAt: number | null;
  // Aggregate only -- never a per-voter breakdown, mirroring PollOption's tally.
  tally: { yes: number; no: number; maybe: number } | null;
  myVote: PollVote | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  // Advisory: the event has moved since this request was filed. Never true
  // for a recurring time_change, whose accept path doesn't consult it.
  stale: boolean;
}
