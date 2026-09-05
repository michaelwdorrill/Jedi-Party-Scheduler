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
//
// It sat at 1 through v0.5's interactions endpoint (specs/0010), which this
// bump also covers: the Privacy Policy's "it only sends direct messages"
// stopped being true the moment the bot could receive a button press and
// edit its own DM, and nothing bumped this to say so at the time. Recorded
// here rather than silently folded in, since it means this bump discloses
// more than just what prompted it.
//
// Bumped to 2 for specs/0015 and 0016 (v0.7/v0.7.1): a new third-party
// processor (Resend, for the one email idea 9 sends), a new stored request
// record, and an account deletion trigger -- inactivity -- that "how long it
// is kept" didn't previously describe.
//
// The "TEMPORARY, SANDBOX ONLY -- do not merge this commit to main" note that
// used to sit here was the accident IDEAS item 43 records. It was written for
// a scratch commit that bumped this to 2 for real testing, travelled to a
// release branch on an uncommitted edit, and was reverted -- but the comment
// came along and then sat on `main` for four releases telling every reader
// not to merge a commit that had already been merged.
//
// Bumped to 3 for specs/0017 (v0.8), and this one discloses the most of the
// three so far: a new third-party processor (Google), event titles and times
// leaving this service for an external calendar, and -- the part that actually
// changes the app's posture rather than its vendor list -- the first long-lived
// third-party credential it has ever stored. The previous policy's "Discord
// access or refresh tokens ... are not written to the database" was offered as
// a statement about how this service works, not merely about Discord, and a
// stored Google refresh token makes it incomplete. That is exactly the class of
// change this mechanism exists for.
//
// Bumped even though the feature ships dormant (GOOGLE_SYNC_MODE = "off"),
// which is the precedent version 2 set: it shipped for Resend while EMAIL_MODE
// was still "stub". The capability is in the deployed code, and the policy
// should describe the code rather than the config.
//
// It is guarded now: `../../policy-version.txt` has to carry the same number,
// and `npm run check:policy-version` (wired into CI) fails the build if they
// disagree, the same shape check-env-parity.mjs already used for
// wrangler.toml. Bumping this for real means updating both files in the same
// commit, on purpose -- an accidental edit surviving a `git checkout` or a
// stray `git add -A` now fails the build instead of shipping silently.
export const CURRENT_POLICY_VERSION = 3;
