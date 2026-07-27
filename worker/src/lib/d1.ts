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
export function chunkIds<T>(ids: readonly T[], reserved = 0): T[][] {
  const size = Math.max(1, Math.min(DEFAULT_CHUNK_BUDGET, D1_MAX_BIND_PARAMS - reserved) );
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size) as T[]);
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
