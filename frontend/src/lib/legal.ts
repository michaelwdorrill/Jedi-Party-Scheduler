// Single source of truth for the details that appear in the Terms and Privacy
// Policy. Change these here and both documents update.
//
// CONTACT_EMAIL is a legal requirement, not decoration: Discord's Developer
// Terms require users to have an accessible way to ask for their data to be
// modified or deleted, and GDPR/CCPA require a contact route for rights
// requests. The in-app "Delete my account" button is the primary path; this
// address is the fallback for anyone who can no longer log in.
export const CONTACT_EMAIL = 'JediParty@proton.me';

export const SERVICE_NAME = 'Uncle Owen';
export const LAST_UPDATED = '27 July 2026';

// The released version of the app, and when that version was published.
//
// Deliberately hand-maintained constants rather than something derived from
// the build (a git SHA, `new Date()` at bundle time): those change on every
// rebuild, including rebuilds that ship no user-visible change at all, which
// would make "published" mean "last redeployed" instead of "last released".
// Bump both together when cutting a release.
export const APP_VERSION = '0.4.6';
export const PUBLISHED_AT = '25 August 2026, 12:00 UTC';

// The person or entity legally responsible for the data ("data controller"
// under GDPR). For a personally-run project this is just your name.
export const OPERATOR = 'the operator of Uncle Owen';
