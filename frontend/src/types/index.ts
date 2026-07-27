export interface User {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  timezone: string;
  notificationsEnabled: boolean;
  freeBusyVisible: boolean;
}

export interface Guild {
  id: string;
  name: string;
}

export interface Group {
  id: string;
  guildId: string;
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
  myRsvpStatus: RsvpStatus | null;
  pollDeadlineAt: number | null;
  // Which saved group this event was invited through, if any. Used purely to
  // colour a group's sessions consistently on the calendar.
  groupId: string | null;
}

export interface PersonalEvent {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  timezone: string;
  startAt: number | null;
  endAt: number | null;
  status: 'active' | 'cancelled';
  busy: boolean;
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

// Full detail as returned by GET /events/:eventId
export interface EventDetail extends EventOccurrence {
  guildId: string;
  pollStrategy: PollStrategy | null;
  pollThresholdCount: number | null;
  pollMode: PollMode | null;
  pollResolutionMode: PollResolutionMode | null;
  windowStartAt: number | null;
  windowEndAt: number | null;
  windowBlockMinutes: number | null;
  recurrence: RecurrenceRule | null;
  invites: EventInvite[];
  pollOptions: PollOption[] | null;
}
