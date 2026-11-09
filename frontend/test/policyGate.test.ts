import { describe, expect, it } from 'vitest';
import { policyAccepted } from '../src/lib/policyGate';
import type { User } from '../src/types';

// The 1.0 launch's first finding: the server list was fetched behind the
// agreement screen, refused, and the error stuck. GuildProvider now waits on
// this instead of on isAuthenticated.
function user(accepted: number, inForce: number): User {
  return {
    id: 'u', username: 'u', globalName: null, avatarHash: null, timezone: 'UTC',
    notificationsEnabled: true, freeBusyVisible: true, isOwner: false,
    policyVersion: inForce, acceptedPolicyVersion: accepted, unseenAnnouncement: null,
  };
}

describe('policyAccepted', () => {
  it('is false while the agreement screen is up -- the launch case: agreed to 2, version 6 in force', () => {
    expect(policyAccepted(true, user(2, 6))).toBe(false);
  });
  it('turns true once the current version is agreed to', () => {
    expect(policyAccepted(true, user(6, 6))).toBe(true);
  });
  it('is false before /me has loaded, and when signed out', () => {
    expect(policyAccepted(true, null)).toBe(false);
    expect(policyAccepted(false, user(6, 6))).toBe(false);
  });
});
