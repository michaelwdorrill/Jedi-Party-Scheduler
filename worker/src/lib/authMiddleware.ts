import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { verifyJwt } from './jwt';
import { isSessionActive } from './sessions';

export type AppEnv = { Bindings: Env; Variables: { userId: string; sessionId: string } };

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.text('Unauthorized', 401);

  const payload = await verifyJwt(token, c.env.JWT_SIGNING_KEY);
  if (!payload) return c.text('Unauthorized', 401);

  // A signed, unexpired JWT is necessary but not sufficient -- the session it
  // names must still be active, or logout/account-deletion/revocation would
  // only take effect once the token itself expired.
  if (!(await isSessionActive(c.env, payload.sid, payload.sub))) {
    return c.text('Unauthorized', 401);
  }

  c.set('userId', payload.sub);
  c.set('sessionId', payload.sid);
  await next();
}
