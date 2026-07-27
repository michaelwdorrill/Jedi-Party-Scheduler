#!/usr/bin/env node
// Applies every migration in migrations/, in filename order.
//
// The npm scripts used to name 0001_init.sql literally, which quietly stopped
// being the whole schema at migration 0002 and has been wrong ever since --
// anyone running `npm run db:migrate:remote` got an empty-looking database
// and no indication that eight further files existed. Reading the directory
// means new migrations are picked up by existing.
//
// Re-running is safe for files that are idempotent on their own; it is not a
// substitute for tracking which migrations have already been applied, so on a
// database that is already partway up to date, run only the new files by
// hand (docs/SETUP.md spells this out).

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const workerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(workerDir, 'migrations');

const mode = process.argv.includes('--remote') ? '--remote' : '--local';
const only = process.argv.find((a) => a.startsWith('--from='))?.slice('--from='.length);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => !only || f >= only);

if (files.length === 0) {
  console.error(`No migrations found${only ? ` at or after ${only}` : ''}.`);
  process.exit(1);
}

console.log(`Applying ${files.length} migration(s) ${mode === '--remote' ? 'to the REMOTE database' : 'locally'}:`);
for (const file of files) console.log(`  ${file}`);

for (const file of files) {
  console.log(`\n--- ${file} ---`);
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'jedi-party-scheduler-db', mode, `--file=./migrations/${file}`, '--yes'],
    { cwd: workerDir, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    console.error(`\nMigration ${file} failed. Nothing after it has been applied.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nAll migrations applied.');
