import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { describeError } from '../src/lib/async';

// The decision this file protects: a failure must never be reportable as
// "nothing is here" (idea 24). Every branch below has to produce a sentence
// that tells the user a request failed.
describe('describeError', () => {
  it('never returns an empty string, whatever it is handed', () => {
    for (const thrown of [
      new ApiError(400, 'title is required'),
      new ApiError(403, 'Not invited to this event'),
      new ApiError(404, '404 Not Found'),
      new ApiError(409, 'This event was changed elsewhere'),
      new ApiError(500, 'Internal error'),
      new TypeError('Failed to fetch'),
      'a bare string',
      null,
      undefined,
    ]) {
      expect(describeError(thrown).length).toBeGreaterThan(0);
    }
  });

  it('passes a 4xx body straight through -- the Worker writes those for people', () => {
    expect(describeError(new ApiError(403, 'Not invited to this event'))).toBe(
      'Not invited to this event',
    );
    expect(describeError(new ApiError(400, 'title is required'))).toBe('title is required');
  });

  // A 404 body is Hono's own "404 Not Found", which tells a user nothing. This
  // is the exact case that cost the v0.4 detour: the sandbox Worker had no
  // /me/events route, so the calendar 404'd and said it was empty.
  it('replaces a 404 body rather than showing it', () => {
    const message = describeError(new ApiError(404, '404 Not Found'));
    expect(message).not.toContain('404 Not Found');
    expect(message).toMatch(/older version/i);
  });

  it('does not repeat a 5xx body at the user', () => {
    const message = describeError(new ApiError(500, 'Internal error'));
    expect(message).toMatch(/server ran into a problem/i);
  });

  // fetch rejects rather than resolving when the Worker cannot be reached at
  // all, so this arrives as a TypeError and never as an ApiError.
  it('describes an unreachable server', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/couldn't reach the server/i);
    expect(describeError(undefined)).toMatch(/couldn't reach the server/i);
  });

  it('refuses to render a body that is not one of ours', () => {
    expect(describeError(new ApiError(400, '<!doctype html><title>Gateway</title>'))).toBe(
      'That request was refused.',
    );
    expect(describeError(new ApiError(400, 'x'.repeat(500)))).toBe('That request was refused.');
    expect(describeError(new ApiError(400, '   '))).toBe('That request was refused.');
  });
});
