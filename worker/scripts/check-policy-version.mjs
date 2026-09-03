#!/usr/bin/env node
// IDEAS item 43: CURRENT_POLICY_VERSION (src/lib/policy.ts) is the one
// constant in this codebase whose entire design principle is "this must
// never change unintentionally" -- bumping it logs out every session in
// production and puts a re-acceptance gate in front of everyone
// (docs/specs/0012-policy-reacceptance.md). It had nothing at all guarding
// it: an uncommitted scratch-branch bump survived a `git checkout` and was
// swept into an unrelated commit by `git add -A`, and would have shipped
// silently if it hadn't been caught by reading the diff afterwards.
//
// This makes it impossible to change CURRENT_POLICY_VERSION by accident: a
// change only takes effect if policy-version.txt is bumped to match in the
// same commit, on purpose. Two files disagreeing is a build failure, not a
// silent success -- the same shape check-env-parity.mjs uses for
// wrangler.toml, applied to a single number instead of a config file.
//
// Deliberately not derived from a hash of the legal documents' own content
// (policy.ts's own comment already makes this case for CURRENT_POLICY_VERSION
// itself): a derived value would fail this exact check on every typo fix to
// the Terms or Privacy Policy page, training whoever hit it to bump the
// sidecar reflexively rather than to ask whether the change is substantive.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_TS_PATH = join(__dirname, '..', 'src', 'lib', 'policy.ts');
const SIDECAR_PATH = join(__dirname, '..', 'policy-version.txt');

const policyTs = readFileSync(POLICY_TS_PATH, 'utf8');
const match = policyTs.match(/export const CURRENT_POLICY_VERSION\s*=\s*(\d+)\s*;/);
if (!match) {
  console.error(`Could not find "export const CURRENT_POLICY_VERSION = <number>;" in ${POLICY_TS_PATH}.`);
  process.exit(1);
}
const codeVersion = match[1];
const sidecarVersion = readFileSync(SIDECAR_PATH, 'utf8').trim();

if (codeVersion !== sidecarVersion) {
  console.error(
    `CURRENT_POLICY_VERSION (src/lib/policy.ts) is ${codeVersion}, but policy-version.txt says ${sidecarVersion}.\n\n` +
      'These are required to match on purpose (IDEAS item 43): the sidecar exists so this number can never move by ' +
      'accident, since bumping it logs every session in production out. If this bump is intentional, update ' +
      `policy-version.txt to ${codeVersion} in the same commit. If it isn't, revert the change to policy.ts.`,
  );
  process.exit(1);
}

console.log(`policy-version.txt matches CURRENT_POLICY_VERSION (${codeVersion}). OK.`);
