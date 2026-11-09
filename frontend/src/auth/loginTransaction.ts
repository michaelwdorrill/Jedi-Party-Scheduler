import { API_BASE_URL } from '../api/client';

// The browser's half of the login binding added for R02 in the Pass-11
// security review.
//
// Before it, the Worker finished a login by redirecting to
// `#/auth/callback?token=<jwt>` and this app installed whatever token it found
// there. Nothing tied that token to the browser receiving it, so anyone with a
// session could send someone else a link carrying their own token and silently
// log the visitor into their account -- where anything the visitor then saved
// (personal time, private notes, a connected Google calendar) would be visible
// to the sender.
//
// This is PKCE, applied to the app's own last hop rather than to the Discord
// leg. Before navigating away we mint a random verifier, keep it in
// sessionStorage, and send only its SHA-256 challenge out through the redirect
// chain. The Worker seals that challenge into a login code and hands the code
// back; redeeming it requires the verifier, which never left this browser. A
// code that arrives in a browser that did not start the login has nothing to
// redeem it with.
//
// sessionStorage rather than localStorage deliberately: the verifier is
// meaningful for the few seconds of one login in one tab, and per-tab scope
// means a stray verifier cannot outlive the transaction it belongs to.
const VERIFIER_KEY = 'jps_login_verifier';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// Mints the transaction secret, parks it, and returns the URL to navigate to.
// Called at the moment the person actually starts a login, so a verifier is
// only ever stored for a login that is really being attempted.
export async function beginLogin(): Promise<string> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await challengeFor(verifier);
  return `${API_BASE_URL}/auth/login?challenge=${encodeURIComponent(challenge)}`;
}

export class LoginNotStartedError extends Error {}

// Exchanges the code from the callback URL for the session token. Throws
// LoginNotStartedError when this browser holds no verifier, which is exactly
// the case the finding is about: a callback URL someone else was sent.
export async function redeemLoginCode(code: string): Promise<string> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new LoginNotStartedError('This browser did not start a login.');

  // Cleared before the request rather than after, so a verifier is never left
  // behind by a failed or abandoned redemption.
  sessionStorage.removeItem(VERIFIER_KEY);

  // A plain fetch rather than the shared api client: this is the call that
  // produces the very first token, so there is nothing for the client's
  // refresh-and-retry to refresh, and its bounce-to-login on 401 would send a
  // failed login straight back into another login.
  const res = await fetch(`${API_BASE_URL}/auth/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  });
  if (!res.ok) throw new Error(await res.text());

  const { token } = (await res.json()) as { token: string };
  return token;
}
