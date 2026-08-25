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

export interface Group {
  id: string;
  guildId: string;
  // GET /me/groups spans every server, so it names the one each group
  // belongs to. It is the only group listing there is since v0.4.3.
  guildName?: string;
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
}

export type EventType = 'single' | 'poll';
export type EventStatus = 'active' | 'cancelled' | 'resolved';
export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'tentative';
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

export interface PollOption {
  id: string;
  startAt: number; // unix ms UTC
  endAt: number;
  displayOrder: number;
  confirmedAt: number | null;
  confirmedUsers: { userId: string; username: string; globalName: string | null }[];
  tally: { yes: number; no: number; maybe: number };
  myVote: PollVote | null;
}

export interface WindowSubmission {
  userId: string;
  username: string;
  globalName: string | null;
  startAt: number;
  endAt: number;
}

// As returned by GET /events/:eventId/window
export interface WindowInfo {
  windowStartAt: number | null;
  windowEndAt: number | null;
  windowBlockMinutes: number | null;
  mySubmission: { startAt: number; endAt: number } | null;
  submissions: WindowSubmission[];
  bestCandidate: { startAt: number; endAt: number; count: number } | null;
}

export interface EventInvite {
  userId: string;
  username: string;
  globalName: string | null;
  invitedVia: 'individual' | 'group';
  sourceGroupId: string | null;
  rsvpStatus: RsvpStatus;
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
  pollStrategy: PollStrategy | null;
  pollThresholdCount: number | null;
  pollMode: PollMode | null;
  pollResolutionMode: PollResolutionMode | null;
  windowStartAt: number | null;
  windowEndAt: number | null;
  windowBlockMinutes: number | null;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
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
