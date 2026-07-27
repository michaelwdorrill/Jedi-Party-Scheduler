import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A D1Database-shaped adapter over Node's built-in SQLite, used as the test
// runtime for the Worker's real query code.
//
// The reason this exists rather than a Workers-native test pool: D1 caps a
// statement at 100 bound parameters, and exceeding it is a hard rejection.
// That ceiling is the mechanism behind the most consequential availability
// bug this codebase has had, and a test runtime that doesn't enforce it
// cannot catch a regression -- plain SQLite happily accepts thousands. So the
// shim enforces the ceiling itself, which makes "does this query stay inside
// D1's limits?" an assertion rather than a code review question.
//
// Foreign keys are ON, which plain D1 leaves off. That's deliberate too:
// account deletion's statement ordering is only meaningful if something
// actually checks it, and a test that can't fail on a dangling reference
// wouldn't have caught the sessions-FK bug that shipped.

export const D1_MAX_BIND_PARAMS = 100;

export class TooManyParametersError extends Error {}

function assertParamCount(sql: string, values: unknown[]): void {
  if (values.length > D1_MAX_BIND_PARAMS) {
    throw new TooManyParametersError(
      `too many SQL variables: ${values.length} bound parameters exceeds D1's limit of ${D1_MAX_BIND_PARAMS}\n  ${sql.trim().slice(0, 200)}`,
    );
  }
}

// node:sqlite returns null-prototype objects; the Worker code spreads and
// destructures these freely, so normalise to plain objects.
function plain<T>(row: unknown): T {
  return row === undefined || row === null ? (row as T) : ({ ...(row as object) } as T);
}

// node:sqlite rejects booleans and undefined outright.
function normaliseValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class ShimStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ShimStatement {
    assertParamCount(this.sql, values);
    this.values = values.map(normaliseValue);
    return this;
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async first<T>(): Promise<T | null> {
    const row = this.stmt().get(...(this.values as never[]));
    return row === undefined ? null : plain<T>(row);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt().all(...(this.values as never[])).map((r) => plain<T>(r)) };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const res = this.stmt().run(...(this.values as never[]));
    return { meta: { changes: Number(res.changes) } };
  }

  // Used by batch() to execute inside an already-open transaction.
  execute(): void {
    this.stmt().run(...(this.values as never[]));
  }
}

export class ShimDatabase {
  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql);
  }

  // D1 documents batch() as a single transaction: all statements commit or
  // none do. Modelling that faithfully is what makes the account-deletion and
  // event-write atomicity tests mean anything.
  async batch<T = unknown>(statements: ShimStatement[]): Promise<T[]> {
    this.raw.exec('BEGIN');
    try {
      for (const statement of statements) statement.execute();
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
    return [] as T[];
  }
}

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

// Applies every migration in filename order, exactly as docs/SETUP.md
// instructs an operator to. A migration that doesn't apply cleanly on top of
// its predecessors fails the whole suite here rather than in production.
export function applyMigrations(db: DatabaseSync): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return files;
}

export function createTestDb(): ShimDatabase {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  applyMigrations(raw);
  return new ShimDatabase(raw);
}
