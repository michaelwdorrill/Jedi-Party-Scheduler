import { buildApp } from './router';
import type { Env } from './env';
import { runReminderSweep } from './cron/reminders';

const app = buildApp();

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminderSweep(env));
  },
};
