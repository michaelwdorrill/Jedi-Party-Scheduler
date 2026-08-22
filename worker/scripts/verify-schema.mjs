#!/usr/bin/env node
// Guardrail 2 from docs/specs/0002-sandbox-and-promotion.md, and the
// automated form of the `pragma_table_info` command docs/SETUP.md tells an
// operator to run by hand after every migration.
//
// SETUP.md documents three separate incidents where `d1_migrations` reported
// every migration applied while the real schema was missing columns --
// including cron_cursors.cursor_key, whose absence silently broke every
// notification the app sends. "The deploy succeeded" and "the schema
// matches the code" turned out to be different facts, and `d1_migrations`
// only ever proves the first one.
//
// This derives the *expected* schema by actually applying every file in
// worker/migrations/ in order to a throwaway in-memory database (the same
// approach worker/test/d1shim.ts uses for the test suite), then diffs that
// against what a real D1 database reports for itself. Deriving the
// expectation from the migration files means it can't drift from them --
// unlike a hand-maintained "expected schema" file, which is one more thing
// to forget to update.
//
// Usage: node scripts/verify-schema.mjs --remote|--local [--env sandbox]

import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
const envIndex = args.indexOf('--env');
const envName = envIndex >= 0 ? args[envIndex + 1] : null;

if (remote === local) {
  // Both or neither -- either is a mistake worth stopping for rather than
  // silently picking one.
  console.error('Usage: verify-schema.mjs --remote|--local [--env sandbox]');
  process.exit(2);
}

const DB_NAME = envName === 'sandbox' ? 'jedi-party-scheduler-db-sandbox' : 'jedi-party-scheduler-db';

function expectedSchema() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  const rows = db
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`)
    .all();
  db.close();
  return rows;
}

const SCHEMA_QUERY = `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`;

// Spawning `npx`/`wrangler` via their platform shim turned out to be a dead
// end on Windows: bare `'npx'` fails with ENOENT (Windows only resolves it
// to the `.cmd` shim npm installs, and execFileSync without a shell only
// finds real executables); `'npx.cmd'` fails with EINVAL (Node's fix for
// CVE-2024-27980 refuses to execute a .bat/.cmd file directly even when
// named explicitly); and `shell: true` "fixes" both by handing the whole
// command to cmd.exe/sh, but neither this option nor execFileSync's docs
// promise it will quote a multi-word array element (SCHEMA_QUERY's spaces)
// back into one shell word -- confirmed empirically, it doesn't on POSIX,
// it just joins everything with spaces and hands the result to the shell.
// That's silent argument corruption, not a platform quirk to route around.
//
// Sidestepping the shim entirely settles all three: invoke wrangler's own
// JS entry point with the current `node` binary. `node`'s own path
// (`process.execPath`) is a real executable with no PATH lookup and no
// shell involved, so the args array reaches wrangler exactly as built --
// no quoting to get right, nothing this CVE fix's restriction applies to.
const wranglerPkgPath = createRequire(import.meta.url).resolve('wrangler/package.json');
const wranglerPkg = JSON.parse(readFileSync(wranglerPkgPath, 'utf8'));
const wranglerBinRelative = typeof wranglerPkg.bin === 'string' ? wranglerPkg.bin : wranglerPkg.bin.wrangler;
const WRANGLER_BIN = join(dirname(wranglerPkgPath), wranglerBinRelative);

function actualSchema() {
  const flag = remote ? '--remote' : '--local';
  // Same rule as every other wrangler d1 command against the sandbox
  // database: --env sandbox is required to resolve a D1 binding declared
  // under [[env.sandbox.d1_databases]], since named environments don't
  // inherit into the unscoped lookup a bare database name would otherwise
  // use (the same reason [vars] doesn't inherit -- see wrangler.toml).
  const envArgs = envName === 'sandbox' ? ['--env', 'sandbox'] : [];
  let output;
  try {
    output = execFileSync(
      process.execPath,
      [WRANGLER_BIN, 'd1', 'execute', DB_NAME, flag, ...envArgs, '--json', '--command', SCHEMA_QUERY],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    console.error(`Failed to query ${DB_NAME} (${flag}) via wrangler d1 execute:`);
    console.error(err.stdout || err.message);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.error(`Could not parse wrangler's --json output for ${DB_NAME} as JSON:\n${output}`);
    process.exit(1);
  }

  // `wrangler d1 execute --json` wraps each executed statement's outcome in
  // an array; one command in, one element out. Handled defensively (with a
  // clear error rather than a crash) since this hasn't been exercised
  // against a live D1 database in development -- only the sandbox deploy
  // workflow, on its first real run, will be.
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result || !Array.isArray(result.results)) {
    console.error(`Unexpected shape from wrangler d1 execute --json for ${DB_NAME}:\n${output}`);
    process.exit(1);
  }
  return result.results;
}

// Strips `-- line comments` and collapses whitespace, so formatting
// differences between how a migration file wrote a statement and how
// SQLite echoes it back from sqlite_master (both legitimate, neither
// canonical) don't register as drift. The comment-stripping part isn't
// cosmetic: confirmed against a real D1 database that it re-serializes a
// CREATE TABLE's stored `sql` without the inline `--` comments the
// migration file used to document individual columns, while local
// node:sqlite preserves the original text verbatim -- without stripping
// them here first, every commented column produced a false "mismatch".
// Safe across every migration file (checked): none of them puts `--`
// inside a string literal, which this would otherwise mangle.
function normalize(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whitespace *around* punctuation, which collapsing runs of whitespace
// above does not touch: `( id` and `(id` both survive that collapse exactly
// as written, and D1 re-serializes a stored CREATE TABLE with different
// padding than the migration file used. Confirmed against production, where
// notification_log differed from its own migration by exactly this and
// nothing else -- `( id` vs `(id`, `) )` vs `))`.
//
// This does also rewrite the inside of string literals (`'a, b'` becomes
// `'a,b'`), which would be wrong if the output were ever executed. It isn't:
// canonicalize() below exists only to compare two schemas to each other, and
// both sides go through the identical transformation.
function tightenPunctuation(sql) {
  return sql.replace(/\s*([(),])\s*/g, '$1');
}

// Splits a CREATE TABLE's parenthesised body into its top-level parts -- one
// per column definition or table constraint -- tracking nesting and quoting
// so the commas inside `CHECK(x IN('a','b'))` and `UNIQUE(a,b)` don't cut a
// definition in half.
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Column *order*, which SQLite does not treat as semantically meaningful --
// nothing in this codebase reads a column positionally, and every schema
// change since 0001 has been an ALTER TABLE ADD COLUMN, which appends.
//
// That combination is what produced two of the four differences this script
// reported against production: a table repaired by hand (see SETUP.md's
// drift incidents, where columns were re-added after later migrations had
// already run) ends up holding the same columns in a different order than a
// clean replay of the migrations produces. Sorting the parts before
// comparing keeps every check that actually matters -- a missing column, an
// extra one, a changed type, default, constraint or foreign key all still
// compare unequal after sorting -- and drops only the one difference that
// cannot affect behaviour.
//
// Deliberately not a fix applied to production instead: making the stored
// column order match would mean a rename-copy-drop of `events` and `groups`
// against live data, which is real risk taken on for a purely cosmetic gain.
function canonicalize(sql) {
  const tightened = tightenPunctuation(normalize(sql));
  const match = /^(CREATE TABLE [^(]*)\((.*)\)$/i.exec(tightened);
  if (!match) return tightened;
  return `${match[1]}(${splitTopLevel(match[2]).sort().join(',')})`;
}

// D1 (and SQLite itself) maintain their own bookkeeping tables alongside
// whatever the app's migrations create -- `d1_migrations` is Wrangler's own
// migration-tracking table, `sqlite_sequence` is SQLite's own (created the
// moment any table uses AUTOINCREMENT), and `_cf_KV` is D1-internal.
// None of them come from worker/migrations/*.sql and none of them ever
// should -- confirmed against a real D1 database that these three, and
// only these three, show up as "unexpected". An exact allowlist rather
// than a `sqlite_`/`_cf_` prefix match on purpose: SQLite itself already
// forbids a real table starting with `sqlite_`, but `_cf_` is only a
// Cloudflare convention, not an enforced one, and this script's whole job
// is to be suspicious of the unexpected rather than pattern-match it away.
const KNOWN_D1_INFRASTRUCTURE_OBJECTS = new Set([
  'table:d1_migrations',
  'table:sqlite_sequence',
  'table:_cf_KV',
]);

function toMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(`${row.type}:${row.name}`, canonicalize(row.sql));
  return map;
}

const expected = toMap(expectedSchema());
const actual = toMap(actualSchema());

const problems = [];
for (const [key, sql] of expected) {
  if (!actual.has(key)) {
    problems.push(`missing in ${DB_NAME}: ${key}`);
  } else if (actual.get(key) !== sql) {
    problems.push(`schema mismatch for ${key}:\n    expected: ${sql}\n    actual:   ${actual.get(key)}`);
  }
}
for (const key of actual.keys()) {
  if (!expected.has(key) && !KNOWN_D1_INFRASTRUCTURE_OBJECTS.has(key)) {
    problems.push(`present in ${DB_NAME} but not produced by any migration file: ${key}`);
  }
}

if (problems.length > 0) {
  console.error(`Schema drift between worker/migrations/*.sql and ${DB_NAME}:\n`);
  for (const p of problems) console.error(` - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`${DB_NAME}: schema matches worker/migrations/*.sql exactly.`);
