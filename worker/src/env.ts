export interface Env {
  DB: D1Database;

  // Non-secret vars (wrangler.toml [vars])
  DISCORD_CLIENT_ID: string;
  FRONTEND_URL: string;
  OWNER_DISCORD_ID: string;

  // Secrets (`wrangler secret put ...`, see docs/SETUP.md)
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  JWT_SIGNING_KEY: string;
}

export interface AuthedContext {
  userId: string;
}
