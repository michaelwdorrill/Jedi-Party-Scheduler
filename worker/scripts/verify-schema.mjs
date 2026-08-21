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

// Collapses whitespace so formatting differences between how a migration
// file wrote a statement and how SQLite echoes it back from sqlite_master
// (both legitimate, neither canonical) don't register as drift.
function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function toMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(`${row.type}:${row.name}`, normalize(row.sql));
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
  if (!expected.has(key)) {
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
