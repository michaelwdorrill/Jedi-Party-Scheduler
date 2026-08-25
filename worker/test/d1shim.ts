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
// Foreign keys are ON because D1 enforces them by default, so a test runtime
// that left them off would be *more* permissive than production -- account
// deletion's statement ordering is only meaningful if something actually
// checks it, and a test that can't fail on a dangling reference wouldn't
// have caught the sessions-FK bug that shipped.
// https://developers.cloudflare.com/d1/sql-api/foreign-keys/

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
    private readonly onQuery: () => void,
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
    this.onQuery();
    const row = this.stmt().get(...(this.values as never[]));
    return row === undefined ? null : plain<T>(row);
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.onQuery();
    return { results: this.stmt().all(...(this.values as never[])).map((r) => plain<T>(r)) };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    this.onQuery();
    const res = this.stmt().run(...(this.values as never[]));
    return { meta: { changes: Number(res.changes) } };
  }

  // Used by batch() to execute inside an already-open transaction. Returns
  // the same shape run() does, since real D1 batch() results are also
  // per-statement D1Result objects with .meta.changes -- worker code (event
  // creation's quota guard, the recurring-conversion guard) reads that
  // return value to tell "the guarded write no-opped" apart from every other
  // outcome, so a shim that discarded it couldn't exercise that code at all.
  execute(): { meta: { changes: number } } {
    this.onQuery();
    const res = this.stmt().run(...(this.values as never[]));
    return { meta: { changes: Number(res.changes) } };
  }
}

// Cloudflare also caps the number of queries a single Worker invocation may
// issue against D1 -- 50 on the Free plan, 1,000 on Paid -- separately from
// the per-statement bound-parameter ceiling above. That budget is exactly
// what F-04's remaining findings were about (a valid, in-quota calendar or
// free/busy request whose per-record queries added up past it), and a shim
// that enforces the parameter ceiling but not this would let that whole
// category of regression back in invisibly. `queryCount` is incremented by
// every first()/all()/run()/execute() call -- one increment per statement
// execution, matching how D1 bills a batch() (each statement inside it
// counts individually, not the batch as one call).
export class ShimDatabase {
  queryCount = 0;

  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql, () => {
      this.queryCount++;
    });
  }

  // D1 documents batch() as a single transaction: all statements commit or
  // none do. Modelling that faithfully is what makes the account-deletion and
  // event-write atomicity tests mean anything. The returned array mirrors
  // real D1Result[] -- one entry per statement, each with .meta.changes.
  async batch<T = unknown>(statements: ShimStatement[]): Promise<({ meta: { changes: number } } & Partial<T>)[]> {
    const outcomes: { meta: { changes: number } }[] = [];
    this.raw.exec('BEGIN');
    try {
      for (const statement of statements) outcomes.push(statement.execute());
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
    return outcomes as ({ meta: { changes: number } } & Partial<T>)[];
  }

  // Call at the start of whatever you're measuring (a route handler, a cron
  // sweep) so queryCount reflects just that invocation's cost, not setup/seed
  // queries too.
  resetQueryCount(): void {
    this.queryCount = 0;
  }
}

// Cloudflare's documented per-Worker-invocation D1 query budgets.
// https://developers.cloudflare.com/d1/platform/limits/
export const D1_FREE_PLAN_QUERY_BUDGET = 50;
export const D1_PAID_PLAN_QUERY_BUDGET = 1000;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

// Applies one migration by filename, for a test that needs to see the state
// on either side of it -- a data backfill has nothing to assert unless the
// rows it operates on exist first. Re-running the whole set is not an option
// there: the early migrations are CREATE TABLE.
export function applyMigration(db: DatabaseSync, filename: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, filename), 'utf8'));
}

// Applies every migration in filename order, exactly as docs/SETUP.md
// instructs an operator to. A migration that doesn't apply cleanly on top of
// its predecessors fails the whole suite here rather than in production.
//
// `stopBefore` halts just before the named file, which is the only way to
// test a migration that is *not* re-runnable. `applyMigration` above covers
// the idempotent backfills -- run the whole set, then run the backfill again
// -- but a migration that recreates a table cannot be applied twice (its
// CREATE INDEX would collide), so its "before" state has to be built by not
// applying it in the first place.
export function applyMigrations(db: DatabaseSync, stopBefore?: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (stopBefore && file === stopBefore) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    applied.push(file);
  }
  return applied;
}

export function createTestDb(stopBefore?: string): ShimDatabase {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  applyMigrations(raw, stopBefore);
  return new ShimDatabase(raw);
}
