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
export const LAST_UPDATED = '9 November 2026';

// The released version of the app, and when that version was published.
//
// Deliberately hand-maintained constants rather than something derived from
// the build (a git SHA, `new Date()` at bundle time): those change on every
// rebuild, including rebuilds that ship no user-visible change at all, which
// would make "published" mean "last redeployed" instead of "last released".
// Bump both together when cutting a release.
export const APP_VERSION = '1.0.1';
export const PUBLISHED_AT = '9 November 2026, 23:04 UTC';

// The person or entity legally responsible for the data ("data controller"
// under GDPR). For a personally-run project this is just your name -- Michael's
// own wording (policy decision F1, 9 Nov 2026): first name, with CONTACT_EMAIL.
export const OPERATOR = 'Michael';

// How long Cloudflare can still restore deleted data from D1's Time Travel:
// 7 days on Workers Free, 30 on Paid (policy decision F6; the account is on
// Free). Change it if the plan changes -- the Privacy Policy states it twice.
export const RECOVERY_DAYS = 7;

// How long Cloudflare keeps the Worker's own log lines (Workers Logs, switched
// on in worker/wrangler.toml's [observability]; policy decision F8). 3 days on
// Workers Free. Check the dashboard if the plan changes.
export const LOG_RETENTION_DAYS = 3;
