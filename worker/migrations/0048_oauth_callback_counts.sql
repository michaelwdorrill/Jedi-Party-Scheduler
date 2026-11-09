-- IDEAS 92 / release-bar clause 3: bounding the three OAuth callbacks.
--
-- Replaces Cloudflare's rate-limiting binding, which the 9 November 2026
-- walkthrough showed never refusing: 25, then 60, then 25 callbacks from one
-- address, every one sharing a key (wrangler tail), all allowed. Cloudflare
-- documents that binding as approximate; for this Worker it did not limit at
-- all. This table is an exact count in the database the app already uses.
--
-- `bucket` is a keyed one-way fingerprint of the caller's address (an HMAC
-- under a server secret -- src/lib/rateLimit.ts), never the address itself,
-- and nothing ties it to an account. `window_start` is the start of the
-- current minute; a row from an earlier minute is reset on its next use, and
-- deleted on the next callback from anyone or the next cron tick, whichever
-- comes first -- so nothing here outlives its minute by more than about
-- fifteen minutes (lib/rateLimit.ts, pruneOAuthCallbackCounts).
CREATE TABLE oauth_callback_counts (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
