import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { verifyJwt } from './jwt';
import { isSessionActive } from './sessions';
import { CURRENT_POLICY_VERSION } from './policy';

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: string; sessionId: string; acceptedPolicyVersion?: number };
};

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

// Refuses everything until the caller has agreed to the current Terms and
// Privacy Policy (docs/specs/0012-policy-reacceptance.md).
//
// Sits *after* requireAuth, on the same route groups, with four deliberate
// holes in it -- GET /me, GET /me/export, DELETE /me and
// POST /me/accept-policy. Those exemptions are the reason this is a gate
// rather than only a logout: the export and the deletion endpoints are behind
// requireAuth, so a logged-out person cannot take their data with them or
// leave properly. "Agree or you cannot use the app" has to keep the exit door
// reachable for someone who genuinely will not agree.
//
// The refusal is a machine-readable 403 rather than a bare one, so the
// frontend's shared error handling can recognise it centrally and render the
// acceptance screen instead of every call site learning about consent.
export async function requirePolicyAcceptance(c: Context<AppEnv>, next: Next) {
  const accepted = c.get('acceptedPolicyVersion');
  if (accepted !== undefined && accepted >= CURRENT_POLICY_VERSION) return next();

  const row = await c.env.DB.prepare(`SELECT accepted_policy_version AS v FROM users WHERE id = ?`)
    .bind(c.get('userId'))
    .first<{ v: number }>();

  if (row && row.v >= CURRENT_POLICY_VERSION) {
    c.set('acceptedPolicyVersion', row.v);
    return next();
  }

  return c.json(
    { error: 'policy_acceptance_required', policyVersion: CURRENT_POLICY_VERSION },
    403,
  );
}
