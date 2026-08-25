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

  // Secrets (`wrangler secret put ...`, see docs/SETUP.md)
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  JWT_SIGNING_KEY: string;
}

export interface AuthedContext {
  userId: string;
}
