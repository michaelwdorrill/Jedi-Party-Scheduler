import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

// What a page does when a request fails (idea 24).
//
// Before this, a page loaded data as
// `api.get(...).then(setThing).finally(() => setLoading(false))` -- no
// `.catch`. `api.get` throws an ApiError on any non-ok response, so the
// rejection went unhandled, the state stayed empty, loading flipped to false,
// and the user was shown the cheerful empty state. A 404, a 500, an expired
// session and an unreachable Worker all rendered identically to a genuinely
// empty calendar.
//
// That is not a hypothetical: the sandbox Worker predated v0.3 and had no
// `/me/events` route, so every calendar request 404'd -- and the app said,
// confidently and in a friendly tone, that there was nothing on. The screen
// whose whole job is to tell you what is happening was the one hiding it.
//
// Two hooks rather than one, because loading and acting fail differently. A
// failed load means the page cannot be drawn, so it takes over the page. A
// failed action means the page is fine and the thing you just clicked is not,
// so it appears next to the controls and leaves the page standing.

/** Turns anything thrown by `api.*` into a sentence to put in front of a user. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    // A 404 is usually a route this build expects and the deployed Worker
    // doesn't -- the sandbox case above. The body is Hono's own "404 Not
    // Found", which tells a user nothing, so it never gets shown.
    if (e.status === 404) {
      return "The server didn't recognise that request. It may be running an older version of the app.";
    }
    if (e.status >= 500) {
      return 'The server ran into a problem. Nothing was changed — try again in a moment.';
    }
    // Every other 4xx the Worker raises is a `c.text(message, status)` written
    // for a person to read (see router.ts's onError, and validate.ts). Those
    // are better than anything generic that could be written here -- but only
    // if they really are one of ours, hence the shape check.
    const body = e.message.trim();
    if (body && body.length <= 200 && !body.startsWith('<')) return body;
    return 'That request was refused.';
  }
  // `fetch` rejects with a TypeError rather than resolving when the Worker
  // cannot be reached at all -- offline, DNS, CORS, a Worker that is down.
  // This is the branch the old code could not have handled even in principle.
  return "Couldn't reach the server. Check your connection and try again.";
}

/**
 * The same, for the one request whose failure decides whether the app renders
 * at all: `GET /me`. Returns `null` for a 401, meaning "say nothing" -- the
 * API client has already refreshed what it could and bounced to the login
 * page, which is the right answer to a session that has genuinely ended.
 *
 * Every other failure is a message, because "we could not find out who you
 * are" and "you are not logged in" are different facts, and only the second
 * one is about the person.
 */
export function describeAuthError(e: unknown): string | null {
  if (e instanceof ApiError && e.status === 401) return null;
  return describeError(e);
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-runs the loader. Passed to the error state's Try again button. */
  reload: () => void;
}

/**
 * Runs `load` on mount and whenever `deps` change, tracking loading and error
 * alongside the data so a page can tell "nothing came back" apart from
 * "nothing is scheduled".
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Guards against a slow earlier request landing after a newer one -- the
  // calendar re-fetches on a timezone change, and the two are not ordered.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    load().then(
      (result) => {
        if (mine !== generation.current) return;
        setData(result);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== generation.current) return;
        // `data` is deliberately left alone: on a failed reload the previous
        // page contents are still the truest thing available, and the error
        // is shown over them rather than blanking the screen first.
        setError(describeError(e));
        setLoading(false);
      },
    );
    // `load` is a fresh closure every render, so it cannot be a dependency --
    // the caller's `deps` are the contract instead, exactly as useEffect's are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload };
}

export interface ActionState {
  error: string | null;
  pending: boolean;
  /** Runs `fn`, capturing any failure. Resolves true on success. */
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  clearError: () => void;
}

/**
 * Wraps a mutation so a rejected request becomes a visible message instead of
 * an unhandled rejection.
 *
 * This is the half of idea 24 that made idea 26 so confusing to hit: the
 * organiser's RSVP buttons POSTed, got a 403, and appeared inert. A button
 * that silently does nothing reads as a broken button, not a refused request.
 */
export function useAction(): ActionState {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    setPending(true);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, pending, run, clearError };
}
