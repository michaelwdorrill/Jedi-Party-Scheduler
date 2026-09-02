import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendOwnerEmail } from '../src/lib/email';
import { setup, stubFetch, type FetchStub } from './helpers';

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

// specs/0015's stubbing decision: EMAIL_MODE gates whether this calls Resend
// at all. makeEnv() (test/helpers.ts) sets no EMAIL_MODE, which -- like local
// dev and the sandbox -- must behave as "stub", not silently as "live".
describe('sendOwnerEmail', () => {
  it('stubs the send when EMAIL_MODE is not "live"', async () => {
    const { env } = setup();
    fetchStub = stubFetch([]); // any real fetch call throws (Unstubbed fetch)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendOwnerEmail(env, { subject: 'Test', text: 'body' });

    expect(fetchStub.calls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[email:stub]'));
    logSpy.mockRestore();
  });

  it('refuses to send live without RESEND_API_KEY/OWNER_EMAIL_ADDRESS/EMAIL_FROM_ADDRESS configured', async () => {
    const { env } = setup();
    env.EMAIL_MODE = 'live';
    fetchStub = stubFetch([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendOwnerEmail(env, { subject: 'Test', text: 'body' });

    expect(fetchStub.calls).toHaveLength(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('calls Resend when live and fully configured', async () => {
    const { env } = setup();
    env.EMAIL_MODE = 'live';
    env.RESEND_API_KEY = 'test-key';
    env.OWNER_EMAIL_ADDRESS = 'owner@example.test';
    env.EMAIL_FROM_ADDRESS = 'bot@example.test';
    fetchStub = stubFetch([{ match: 'api.resend.com', status: 200, body: { id: 'email-1' } }]);

    await sendOwnerEmail(env, { subject: 'Test', text: 'body' });

    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toContain('api.resend.com');
    const sentBody = JSON.parse(fetchStub.bodies[0]!);
    expect(sentBody.to).toEqual(['owner@example.test']);
    expect(sentBody.from).toBe('bot@example.test');
  });

  it('does not throw when Resend itself fails', async () => {
    const { env } = setup();
    env.EMAIL_MODE = 'live';
    env.RESEND_API_KEY = 'test-key';
    env.OWNER_EMAIL_ADDRESS = 'owner@example.test';
    env.EMAIL_FROM_ADDRESS = 'bot@example.test';
    fetchStub = stubFetch([{ match: 'api.resend.com', status: 500, body: { message: 'nope' } }]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendOwnerEmail(env, { subject: 'Test', text: 'body' })).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
