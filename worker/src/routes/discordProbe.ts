import { Hono } from 'hono';

// A temporary diagnostic, not part of the app. `specs/0010-interactive-bot.md`
// makes this the first thing built, before the rest of v0.5 is planned:
// Discord signs every interaction with Ed25519, and whether workerd exposes
// Ed25519 through WebCrypto at this Worker's `compatibility_date`
// (2024-09-25) decides whether verification is a dozen lines of
// `crypto.subtle` or a userland implementation of the curve. Workers grew a
// native `Ed25519` after an earlier implementation named `NODE-ED25519`, and
// which one a given compatibility date gets is a question to put to a
// deployed Worker rather than to a doc page -- so this route answers it from
// the sandbox and then goes away, replaced by the real
// `/discord/interactions` endpoint it exists to size.
//
// It reads no secrets, touches no D1 and writes nothing, so it is inert
// wherever it runs. It should still not reach `main`.

// A fixed vector, generated once with `node:crypto`'s Ed25519 and committed
// rather than generated per request. Generating a keypair in the probe would
// test `generateKey` as much as `importKey`/`verify`, and would leave a
// failure ambiguous between "this Worker can't do Ed25519" and "the probe
// built a bad signature". With the vector fixed, `test/discordProbe.test.ts`
// proves it is a valid signature under an independent implementation, so a
// `false` from the sandbox means workerd and nothing else.
//
// The message is shaped like the real thing -- Discord verifies over
// `X-Signature-Timestamp` concatenated with the raw request body, and a PING
// body is exactly `{"type":1}`.
const PUBLIC_KEY_HEX = 'ebcfd3e1aeb7beaa83f059862648d445e40ddef03132654562d8dc1c97bddc2d';
const MESSAGE = '1756132800{"type":1}';
const SIGNATURE_HEX =
  '51bc695ea55d60f1200350d5ad8ba13966ea710c10dbbc1b7e25c5e0db759a4fa' +
  'fb10a96df1d4acd61716c447eabb2c9b4197c21255b871ce685fc3f0c46d50a';

export interface ProbeResult {
  algorithm: string;
  imported: boolean;
  // null when the key never imported, so there was nothing to verify with.
  acceptsValidSignature: boolean | null;
  rejectsTamperedSignature: boolean | null;
  error: string | null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Both halves matter. A `verify` that accepts the good signature but also
// accepts a tampered one is worse than no Ed25519 at all -- it would look
// like a working endpoint while authenticating anybody -- so the probe
// reports the rejection as its own result rather than assuming it.
export async function probeAlgorithm(name: string): Promise<ProbeResult> {
  const result: ProbeResult = {
    algorithm: name,
    imported: false,
    acceptsValidSignature: null,
    rejectsTamperedSignature: null,
    error: null,
  };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(PUBLIC_KEY_HEX),
      { name },
      false,
      ['verify'],
    );
    result.imported = true;

    const message = new TextEncoder().encode(MESSAGE);
    const signature = hexToBytes(SIGNATURE_HEX);
    result.acceptsValidSignature = await crypto.subtle.verify({ name }, key, signature, message);

    const tampered = hexToBytes(SIGNATURE_HEX);
    tampered[0] ^= 0x01;
    result.rejectsTamperedSignature = !(await crypto.subtle.verify(
      { name },
      key,
      tampered,
      message,
    ));
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  return result;
}

export const ALGORITHMS = ['Ed25519', 'NODE-ED25519'];

export async function runProbe(): Promise<{ usable: string | null; results: ProbeResult[] }> {
  const results: ProbeResult[] = [];
  for (const name of ALGORITHMS) results.push(await probeAlgorithm(name));
  const usable =
    results.find((r) => r.acceptsValidSignature === true && r.rejectsTamperedSignature === true)
      ?.algorithm ?? null;
  return { usable, results };
}

export const discordProbeRoutes = new Hono();

discordProbeRoutes.get('/ed25519-probe', async (c) => {
  const { usable, results } = await runProbe();
  return c.json({
    // What the rest of specs/0010 is waiting on: a name here means
    // signature verification is `crypto.subtle` and nothing more; null means
    // the release carries a userland Ed25519 implementation.
    usable,
    results,
  });
});
