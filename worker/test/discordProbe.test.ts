import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/router';
import { probeAlgorithm, runProbe } from '../src/routes/discordProbe';
import type { Env } from '../src/env';

const app = buildApp();

// The probe answers a question about *workerd*, which this harness is not --
// it runs on Node (see test/tsconfig.json). So these tests deliberately do
// not assert what the sandbox will say. What they pin is the thing that
// would otherwise make the sandbox's answer unreadable: that the committed
// vector in routes/discordProbe.ts is a genuinely valid Ed25519 signature
// under an independent implementation. With that established, a `false` from
// the deployed Worker is evidence about the platform rather than a possible
// mistake in the fixture.
describe('the Ed25519 probe vector', () => {
  it('verifies under Node WebCrypto, and rejects a tampered signature', async () => {
    const result = await probeAlgorithm('Ed25519');
    expect(result.error).toBeNull();
    expect(result.imported).toBe(true);
    expect(result.acceptsValidSignature).toBe(true);
    expect(result.rejectsTamperedSignature).toBe(true);
  });

  it('reports an unavailable algorithm as an error rather than throwing', async () => {
    const result = await probeAlgorithm('Ed448-does-not-exist');
    expect(result.imported).toBe(false);
    expect(result.acceptsValidSignature).toBeNull();
    expect(result.error).toMatch(/./);
  });

  it('names an algorithm as usable only when both halves passed', async () => {
    const { usable, results } = await runProbe();
    expect(results.map((r) => r.algorithm)).toEqual(['Ed25519', 'NODE-ED25519']);
    if (usable !== null) {
      const chosen = results.find((r) => r.algorithm === usable);
      expect(chosen?.acceptsValidSignature).toBe(true);
      expect(chosen?.rejectsTamperedSignature).toBe(true);
    }
  });
});

describe('GET /discord/ed25519-probe', () => {
  it('answers without auth, since an interaction carries none', async () => {
    // FRONTEND_URL is the only env the middleware stack reads on this path
    // (CORS); the probe itself reads no env, no secrets and no D1.
    const env = { FRONTEND_URL: 'https://uncleowen.space' } as unknown as Env;
    const res = await app.request('https://worker.test/discord/ed25519-probe', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usable: string | null; results: unknown[] };
    expect(body.results).toHaveLength(2);
    expect(body).toHaveProperty('usable');
  });
});
