import { describe, expect, it } from "vitest";
import { buildApp } from "../src/router";
import { createSession } from "../src/lib/sessions";
import { signJwt } from "../src/lib/jwt";
import { seedUser, setup } from "./helpers";

// Pass 24 review, D-07 (both reviewers). The privacy policy says the download
// returns everything the service holds about you. The export's explicit column
// lists had fallen behind the schema -- each one written when its table was,
// and none updated when a migration later added a column -- so "everything"
// was false in seven places. Michael chose to extend the export rather than
// list the exceptions.
//
// Explicit lists exist for a reason (a wildcard on a table holding OAuth
// credentials would put them in a file people email to themselves), so this
// does not ask for `SELECT *`. It asks that every column of every table read
// with an explicit list be exported, apart from the credentials and the
// user_id that is the export's own key -- checked against the live schema, so
// a column added by a future migration fails here until someone decides.
const EXCLUDED = (column: string) =>
  /_ciphertext$|_iv$/.test(column) || column === "user_id";

// export section -> the table it reads with an explicit column list
const EXPLICIT: Record<string, string> = {
  profile: "users",
  serverMemberships: "user_guild_membership",
  sessions: "sessions",
  googleCalendar: "google_calendar_connections",
  googleCalendarLinks: "google_event_links",
  googlePendingConnections: "google_pending_connections",
  googleOrphanedEntries: "google_orphaned_inserts",
  groupIdleChecks: "group_activity_nudges",
};

describe("the data export leaves nothing out (D-07)", () => {
  it("exports every non-credential column of every table it reads by explicit list", async () => {
    const { db, env } = setup();
    await seedUser(db, "u1");
    // One row in each table, every column filled. Foreign keys are off so the
    // rows need no parents: this is about columns, not relationships.
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const columnsOf = (table: string) =>
      db.raw.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
      }[];
    db.raw
      .prepare(
        `INSERT INTO groups (id, name, created_by, created_at, idle_reminder_days) VALUES ('grp1', 'G', 'u1', 1, 14)`,
      )
      .run();
    for (const table of Object.values(EXPLICIT)) {
      if (table === "users") continue;
      const cols = columnsOf(table);
      const values = cols.map((c) =>
        c.name === "user_id"
          ? "u1"
          : c.name === "group_id"
            ? "grp1"
            : c.name === "status"
              ? "active"
              : /INT/i.test(c.type)
                ? 1
                : `x-${c.name}`,
      );
      db.raw
        .prepare(
          `INSERT INTO ${table} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...(values as (string | number)[]));
    }

    const { id } = await createSession(env, "u1");
    const token = await signJwt("u1", id, env.JWT_SIGNING_KEY);
    const res = await buildApp().request(
      "https://worker.test/me/export",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    for (const [section, table] of Object.entries(EXPLICIT)) {
      const rows = (
        section === "profile" ? [body.profile].flat() : body[section]
      ) as Record<string, unknown>[];
      expect(rows?.length, `${section} came back empty`).toBeGreaterThan(0);
      const exported = new Set(Object.keys(rows[0]));
      const missing = columnsOf(table)
        .map((c) => c.name)
        .filter(
          (name) =>
            !EXCLUDED(name) &&
            !exported.has(name) &&
            !(table === "users" && name === "id" && exported.has("id")),
        );
      expect(
        missing,
        `${table} columns missing from export section "${section}"`,
      ).toEqual([]);
      const leaked = [...exported].filter((name) =>
        /_ciphertext$|_iv$/.test(name),
      );
      expect(leaked, `${section} exports a credential`).toEqual([]);
    }
  });
});
