// Cloudflare D1 enforces a hard ceiling on how many `?` parameters a single
// statement may bind. Exceeding it isn't a slow query -- the statement is
// rejected outright, so any code path that builds an `IN (?, ?, ...)` list
// from a user-influenced collection turns into a server error the moment that
// collection gets large enough. Several of this app's own configured maxima
// (100 invitees, 200 group members, 300 resolved invitees) sit at or above
// that ceiling, which is why every dynamic identifier list in this codebase
// goes through chunkIds() rather than being bound in one statement.
//
// https://developers.cloudflare.com/d1/platform/limits/
export const D1_MAX_BIND_PARAMS = 100;

// The per-chunk budget deliberately leaves headroom below the hard limit so a
// caller can bind a few fixed parameters (a guild ID, a user ID, a timestamp)
// alongside the chunked list without having to reason about the exact total.
// Callers with more than a handful of fixed parameters should pass an
// explicit `reserved` count.
export const DEFAULT_CHUNK_BUDGET = 80;

// Splits `ids` into chunks small enough that `chunk.length + reserved` stays
// within the per-statement parameter budget. Returns an empty array for an
// empty input, so callers can `for (const chunk of chunkIds(ids))` without a
// separate emptiness check -- the loop body simply never runs.
//
// Deliberately de-duplicates first. Every caller passes a list of row
// identifiers where a repeat is meaningless to the query but not free: a
// caller that collects IDs from a join (e.g. free/busy, which sees one row
// per event *per relevant user*) can hand over the same event ID dozens of
// times, and without this the chunker faithfully turns those duplicates into
// real extra queries -- 100 users sharing 100 events became 125 recurrence
// queries instead of 2. Normalising here rather than at each call site means
// a future loader can't reintroduce that by forgetting to.
export function chunkIds<T>(ids: readonly T[], reserved = 0): T[][] {
  const size = Math.max(1, Math.min(DEFAULT_CHUNK_BUDGET, D1_MAX_BIND_PARAMS - reserved) );
  const unique = [...new Set(ids)];
  const out: T[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    out.push(unique.slice(i, i + size) as T[]);
  }
  return out;
}

// `?, ?, ?` for an IN list of the given length.
export function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

// Splits rows destined for a multi-row INSERT into groups small enough that
// `rows * paramsPerRow + reserved` stays inside the parameter budget.
//
// Multi-row inserts matter here for a second reason beyond parameters: D1
// also caps how many *statements* one Worker invocation may issue, and the
// obvious one-INSERT-per-row shape turns a 300-invitee event into 300
// statements in a single batch. Folding ~13 rows into each statement keeps
// both ceilings comfortably out of reach.
export function chunkRows<T>(rows: readonly T[], paramsPerRow: number, reserved = 0): T[][] {
  const perStatement = Math.max(1, Math.floor((DEFAULT_CHUNK_BUDGET - reserved) / paramsPerRow));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    out.push(rows.slice(i, i + perStatement) as T[]);
  }
  return out;
}

// Builds the SQL for a multi-row INSERT whose rows are written only if a
// guard row exists, as `INSERT ... SELECT * FROM (VALUES-ish) WHERE EXISTS`.
//
// Two requirements meet here, and neither shape satisfies both on its own:
//
//   multi-row VALUES      keeps a 300-invitee or 50-option write from
//                         becoming one D1 statement per row, which alone
//                         exceeds the Free plan's 50-statement invocation
//                         ceiling.
//   WHERE EXISTS on the   makes every child conditional on the guarded parent
//   parent event          insert having actually happened. Without it, a
//                         create that loses the quota race sends its children
//                         at a parent that was never written -- and since D1
//                         enforces foreign keys, that aborts the batch with an
//                         opaque FK error instead of the intended clean no-op
//                         and friendly quota message.
//
// `VALUES (...)` cannot carry a WHERE, so the rows are expressed as a
// UNION ALL of single-row SELECTs and filtered as a subquery. The first arm
// names the columns so the subquery's shape is explicit.
//
// The trailing WHERE is also what makes an `ON CONFLICT` suffix parse: SQLite
// requires an INSERT ... SELECT upsert to have a WHERE clause, so the parser
// can tell the conflict target from the selected rows.
export function conditionalRowsSql(
  table: string,
  columns: readonly string[],
  rowCount: number,
  guardTable: string,
  onConflict = '',
): string {
  const arms = Array.from({ length: rowCount }, (_, i) =>
    i === 0
      ? `SELECT ${columns.map((c) => `? AS ${c}`).join(', ')}`
      : `SELECT ${columns.map(() => '?').join(', ')}`,
  ).join(' UNION ALL ');
  return `INSERT INTO ${table} (${columns.join(', ')})
     SELECT * FROM (${arms})
     WHERE EXISTS (SELECT 1 FROM ${guardTable} WHERE id = ?)
     ${onConflict}`;
}

// Runs `fn` once per chunk and concatenates the results. The chunks run
// sequentially rather than in parallel: D1 also caps how many queries a
// single Worker invocation may issue, and a fan-out here would multiply that
// against every other query the request already makes.
export async function queryInChunks<T, R>(
  ids: readonly T[],
  reserved: number,
  fn: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunkIds(ids, reserved)) {
    out.push(...(await fn(chunk)));
  }
  return out;
}
