import { api } from '../api/client';

// "Download my data", in one place (R26 in the Pass-11 review).
//
// Both buttons that offer this -- Settings and the policy-rejection screen --
// had their own copy of the same code, and the same bug in it: a raw `fetch`
// carrying whatever token was in storage, bypassing the shared API client
// entirely. Access tokens last thirty minutes while the session behind them
// lasts a week, so any page left open longer than that sent an expired token,
// got back a plain-text `Unauthorized`, and then threw inside `res.json()`
// while trying to parse it. No refresh was ever attempted. On Settings there
// was no catch at all, so the button simply stopped looking busy and produced
// nothing; on the policy gate it surfaced a JSON parser error.
//
// The policy screen is the worse of the two: it exists to let someone who
// declines the new terms take their data with them, and it is a page people
// sit and read on -- which is precisely how the access token expires
// underneath them.
//
// Going through `api` fixes it at the root, because refresh-and-retry lives
// there. GET /me/export is deliberately outside requirePolicyAcceptance on the
// Worker, which is what lets the policy screen use the same path as Settings.
export async function downloadMyData(): Promise<void> {
  const data = await api.get<unknown>('/me/export');

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `uncle-owen-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  } finally {
    // Revoked in a finally so a failed click cannot leak the object URL for
    // the lifetime of the document.
    URL.revokeObjectURL(url);
  }
}
