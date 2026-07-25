import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { verifyJwt } from './jwt';

export type AppEnv = { Bindings: Env; Variables: { userId: string } };

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.text('Unauthorized', 401);

  const payload = await verifyJwt(token, c.env.JWT_SIGNING_KEY);
  if (!payload) return c.text('Unauthorized', 401);

  c.set('userId', payload.sub);
  await next();
}
