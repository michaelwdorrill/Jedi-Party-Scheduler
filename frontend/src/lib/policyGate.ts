import type { User } from '../types';

// Whether this account may use the policy-gated API yet: signed in, /me
// loaded, and the policy version in force agreed to.
//
// Found on the 1.0 launch (9 Nov 2026): GuildProvider fetched /guilds as soon
// as someone was signed in -- while the version-6 agreement screen was still
// up -- so the Worker answered 403, the error stuck, and the first thing every
// returning user saw after agreeing was "Couldn't load your server list" until
// they pressed Try again. Anything that loads gated data at app level has to
// wait on this, not on isAuthenticated alone.
export function policyAccepted(isAuthenticated: boolean, user: User | null): boolean {
  return isAuthenticated && user !== null && user.acceptedPolicyVersion >= user.policyVersion;
}
