// The version of the Terms and Privacy Policy currently in force.
//
// Bump this, deliberately, when a change to either document is substantive.
// Doing so logs everyone out and requires them to agree again before the app
// will answer for them (docs/specs/0012-policy-reacceptance.md).
//
// Three things about it are deliberate:
//
// **It lives in the Worker, not the frontend.** Enforcement is server-side or
// it is decorative -- a client-side check is bypassed by not being the
// client. The frontend reads the number from GET /me rather than holding a
// copy, so there is no second constant to drift.
//
// **It is hand-maintained, not derived from the documents' contents.**
// frontend/src/lib/legal.ts already argues this case for APP_VERSION: a
// derived value makes "published" mean "last redeployed". Hashing the legal
// pages would log out every user for a typo fix.
//
// **One number covers both documents.** They change rarely and nearly always
// together; two counters double the bookkeeping and force the acceptance
// screen to explain which one moved. Splitting them later costs a migration,
// which is cheap here and may never be needed.
// TEMPORARY, SANDBOX ONLY -- do not merge this commit to main.
//
// Bumped by hand to exercise the mechanism somewhere with no real users,
// which is step 3 of spec 0012's rollout. Production ships at 1 and dormant.
export const CURRENT_POLICY_VERSION = 2;
