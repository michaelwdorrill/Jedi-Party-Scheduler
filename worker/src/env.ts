export interface Env {
  DB: D1Database;

  // Non-secret vars (wrangler.toml [vars])
  DISCORD_CLIENT_ID: string;
  FRONTEND_URL: string;
  OWNER_DISCORD_ID: string;
  // 'free' or 'paid' -- which Cloudflare Workers/D1 plan this is deployed on.
  // The two differ by more than an order of magnitude in per-invocation query
  // and outbound-subrequest allowances, and the cron sizes its own work
  // budget from this (see cron/budget.ts). Anything but 'paid' is treated as
  // free, so an unset value degrades to "slower", never to "over the limit".
  WORKERS_PLAN?: string;
  // The Discord *application's* public key, used to verify that an inbound
  // interaction really came from Discord (specs/0010). Per application, so
  // production and the sandbox carry different values -- and not a secret,
  // since it verifies signatures rather than making them, which is why it
  // lives in wrangler.toml's [vars] rather than in `wrangler secret put`.
  //
  // Optional in the type because it is genuinely absent until an operator
  // pastes it in, and the endpoint has to answer that case with a 401 like
  // any other unverifiable request rather than a 500.
  DISCORD_PUBLIC_KEY?: string;
  // 'live' sends real mail through Resend; anything else (including unset --
  // local dev has no reason to set this) stubs the send, logging what would
  // have gone out instead of calling the provider. specs/0015: the sandbox
  // runs 'stub' deliberately, since this flow's only recipient is Michael's
  // own inbox and there's nothing to gain from actually paging it during
  // routine iteration.
  EMAIL_MODE?: string;
  // Where the one email this app ever sends goes, and which Resend-verified
  // address it comes from. Not secrets -- an email address is no more
  // sensitive here than OWNER_DISCORD_ID already is -- but both are only
  // read (and only need to be set) when EMAIL_MODE is 'live'.
  OWNER_EMAIL_ADDRESS?: string;
  EMAIL_FROM_ADDRESS?: string;

  // Secrets (`wrangler secret put ...`, see docs/SETUP.md)
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  JWT_SIGNING_KEY: string;
  // Resend API key (specs/0015). Only read when EMAIL_MODE is 'live';
  // optional in the type for the same reason DISCORD_PUBLIC_KEY is -- it's
  // genuinely unset until Michael provisions Resend, and lib/email.ts has to
  // answer that case (refuse to send, log loudly) rather than crash.
  RESEND_API_KEY?: string;
}

export interface AuthedContext {
  userId: string;
}
