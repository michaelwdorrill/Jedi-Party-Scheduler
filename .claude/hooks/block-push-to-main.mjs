#!/usr/bin/env node
// PreToolUse hook: intercept any Bash command that would push to `main`.
//
// Why this exists: CLAUDE.md has said "there's a sandbox, use it" since the
// sandbox was built, and v0.3 still went feature-branch -> main with no
// sandbox deploy in between. The instructions were in context and were not
// applied. Documentation cannot fire at the moment of the mistake; this can.
//
// It asks rather than denies. The rule in CLAUDE.md is not "never push to
// main" -- it's "sandbox first unless you say out loud that this release is
// skipping it and get a yes for that release". A prompt carrying the reason
// is exactly that conversation, mechanised. A hard deny would instead invite
// working around it, which is the failure mode `deploy-worker.yml` already
// warns about for guardrail 3.
//
// Escape hatch for a deliberate, already-agreed override:
//   UO_ALLOW_MAIN_PUSH=1 git push origin main

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROTECTED = new Set(['main', 'master']);

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Split a compound shell command into the individual commands it runs, so
// `cd worker && git push origin main` is still seen as a push.
function segments(command) {
  return command.split(/&&|\|\||;|\n|\|/g).map((s) => s.trim()).filter(Boolean);
}

function isGitPush(segment) {
  return /(^|\s)git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+push(\s|$)/.test(segment);
}

// The branch a refspec lands on at the remote: the half after ':' if there is
// one, else the whole thing. `+` is the force prefix.
function destinationOf(refspec, branch) {
  const dest = (refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec)
    .replace(/^\+/, '')
    .replace(/^refs\/heads\//, '');
  return dest === 'HEAD' ? branch : dest;
}

function targets(segment, branch) {
  const tokens = segment.replace(/["']/g, '').split(/\s+/);
  const pushIndex = tokens.indexOf('push');
  if (pushIndex === -1) return [];

  const args = tokens
    .slice(pushIndex + 1)
    .filter((t) => !t.startsWith('-'));

  // `git push` / `git push origin` with no refspec pushes the current branch.
  const refspecs = args.slice(1);
  if (refspecs.length === 0) return [branch];

  return refspecs.map((r) => destinationOf(r, branch));
}

const input = readStdin();
const command = input?.tool_input?.command;
if (!command || !/git/.test(command)) process.exit(0);
if (process.env.UO_ALLOW_MAIN_PUSH === '1') process.exit(0);

const cwd = input.cwd || process.cwd();
const branch = currentBranch(cwd);

const hits = segments(command)
  .filter(isGitPush)
  .flatMap((segment) => targets(segment, branch))
  .filter((dest) => PROTECTED.has(dest));

if (hits.length === 0) process.exit(0);

const reason = [
  `This pushes to \`${hits[0]}\`, which deploys straight to production.`,
  '',
  'CLAUDE.md: the default route is feature branch -> sandbox -> verify ->',
  'merge to main. Before this push there should be:',
  '  1. a push of this commit to the `sandbox` branch',
  "     (`git push --force-with-lease origin HEAD:sandbox`) -- this runs on",
  '     repository secrets, so a cloud session can do it too, and',
  '  2. Michael actually clicking through the deployed sandbox Worker.',
  '',
  'If this release is deliberately skipping the sandbox, that is a call for',
  'Michael to make for this specific release -- say so and get a yes first.',
].join('\n');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  })
);
process.exit(0);
