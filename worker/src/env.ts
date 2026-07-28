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

  // Secrets (`wrangler secret put ...`, see docs/SETUP.md)
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  JWT_SIGNING_KEY: string;
}

export interface AuthedContext {
  userId: string;
}
