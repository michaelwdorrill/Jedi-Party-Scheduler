#!/usr/bin/env node
// Guardrail 1 from docs/specs/0002-sandbox-and-promotion.md.
//
// Wrangler does not inherit top-level [vars] (or bindings, or triggers) into
// a named environment -- adding a var to [vars] and forgetting the matching
// [env.sandbox.vars] entry leaves the sandbox Worker silently running
// without it. WORKERS_PLAN is the sharpest version of this: get it wrong and
// the sandbox's cron budget stops matching production's, which is exactly
// the class of difference that makes a sandbox lie to you. This script fails
// the build instead of leaving that to be noticed by hand.
//
// It also refuses to let env.sandbox's D1 database_id equal production's --
// that one would be a sandbox deploy migrating and writing straight into
// prod, and it's cheap to make impossible.
//
// This is NOT a general-purpose TOML parser. It understands exactly the
// subset of TOML worker/wrangler.toml actually uses -- [section] and
// [[array.of.tables]] headers, `key = "string"` / `key = ['a', 'b']` /
// `key = 123` / `key = true` lines, and `#` comments -- because this script
// only ever reads the one file this repo owns the shape of. A file that grew
// real TOML features (multi-line strings, inline tables, dotted keys) would
// need a real parser; wrangler.toml has never needed any of those.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(__dirname, '..', 'wrangler.toml');

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => parseValue(s.trim()));
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

// Returns a map keyed by dotted section path ('' for the top level). A
// `[[table]]` header's path maps to an array of objects (one per occurrence
// in file order); a `[table]` header's path maps to a single object.
function parseWranglerToml(text) {
  const sections = { '': {} };
  let currentPath = '';

  for (const rawLine of text.split('\n')) {
    // Naive comment stripping: fine here because none of wrangler.toml's
    // values contain a literal `#`.
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]$/);
    const tableHeader = line.match(/^\[([^\]]+)\]$/);
    if (arrayHeader) {
      currentPath = arrayHeader[1].trim();
      (sections[currentPath] ??= []).push({});
      continue;
    }
    if (tableHeader) {
      currentPath = tableHeader[1].trim();
      sections[currentPath] ??= {};
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = parseValue(rawValue);
    const target = sections[currentPath];
    if (Array.isArray(target)) target[target.length - 1][key] = value;
    else target[key] = value;
  }
  return sections;
}

const config = parseWranglerToml(readFileSync(TOML_PATH, 'utf8'));

const prodVars = config['vars'] ?? {};
const sandboxVars = config['env.sandbox.vars'] ?? {};
const errors = [];

const prodKeys = new Set(Object.keys(prodVars));
const sandboxKeys = new Set(Object.keys(sandboxVars));
const missingInSandbox = [...prodKeys].filter((k) => !sandboxKeys.has(k));
const missingInProd = [...sandboxKeys].filter((k) => !prodKeys.has(k));
if (missingInSandbox.length > 0 || missingInProd.length > 0) {
  errors.push(
    '[vars] and [env.sandbox.vars] have different key sets.' +
      (missingInSandbox.length ? ` Missing from [env.sandbox.vars]: ${missingInSandbox.join(', ')}.` : '') +
      (missingInProd.length ? ` Missing from [vars]: ${missingInProd.join(', ')}.` : ''),
  );
}

if (String(prodVars.WORKERS_PLAN) !== String(sandboxVars.WORKERS_PLAN)) {
  errors.push(
    `WORKERS_PLAN differs between environments: [vars] says "${prodVars.WORKERS_PLAN}", ` +
      `[env.sandbox.vars] says "${sandboxVars.WORKERS_PLAN}". The cron budget (src/cron/budget.ts) ` +
      `would size itself differently in sandbox than it will in production.`,
  );
}

const prodD1 = (config['d1_databases'] ?? [])[0];
const sandboxD1 = (config['env.sandbox.d1_databases'] ?? [])[0];
if (!prodD1 || !sandboxD1) {
  errors.push('Expected exactly one [[d1_databases]] block and one [[env.sandbox.d1_databases]] block.');
} else if (prodD1.database_id === sandboxD1.database_id) {
  errors.push(
    `env.sandbox's D1 database_id ("${sandboxD1.database_id}") is the same as production's. ` +
      `A sandbox deploy would migrate and write straight into the production database.`,
  );
}

if (errors.length > 0) {
  console.error('wrangler.toml environment parity check failed:\n');
  for (const e of errors) console.error(` - ${e}`);
  console.error('');
  process.exit(1);
}

console.log('wrangler.toml: sandbox/production parity OK.');
