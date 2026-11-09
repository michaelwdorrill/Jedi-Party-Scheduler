import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/router";
import { createSession, SESSION_TOUCH_INTERVAL_MS } from "../src/lib/sessions";
import { signJwt } from "../src/lib/jwt";
import { seedGuild, seedMembership, seedUser, setup } from "./helpers";
import type { Env } from "../src/env";
import type { ShimDatabase } from "./d1shim";

// Pass 24 review, D-01. The privacy policy and the data export both say a
// session records when it was last used. Nothing updated the column after the
// insert, so every row's "last used" was its creation time -- a published
// statement that was false. Michael chose to make it true: an authenticated
// request refreshes it once it is SESSION_TOUCH_INTERVAL_MS old.

afterEach(() => vi.useRealTimers());
const app = buildApp();

async function signedIn(db: ShimDatabase, env: Env) {
  await seedGuild(db);
  await seedUser(db, "u1");
  await seedMembership(db, "u1", "guild-1");
  const { id } = await createSession(env, "u1");
  const token = await signJwt("u1", id, env.JWT_SIGNING_KEY);
  const lastUsed = async () =>
    (await db
      .prepare(`SELECT last_used_at FROM sessions WHERE id = ?`)
      .bind(id)
      .first<{ last_used_at: number }>())!.last_used_at;
  const get = () =>
    app.request(
      "https://worker.test/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
  return { lastUsed, get };
}

describe("a session's last-used time is true (D-01)", () => {
  it("moves forward when the session is used after the touch interval", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    const { db, env } = setup();
    const { lastUsed, get } = await signedIn(db, env);
    const created = await lastUsed();

    vi.setSystemTime(new Date(created + SESSION_TOUCH_INTERVAL_MS + 60_000));
    expect((await get()).status).toBe(200);

    expect(await lastUsed()).toBe(created + SESSION_TOUCH_INTERVAL_MS + 60_000);
  });

  // INVARIANT GUARD for the cost side: inside the interval nothing is written,
  // so most requests pay no extra statement.
  it("is not rewritten on every request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    const { db, env } = setup();
    const { lastUsed, get } = await signedIn(db, env);
    const created = await lastUsed();

    vi.setSystemTime(new Date(created + 60_000));
    expect((await get()).status).toBe(200);

    expect(await lastUsed()).toBe(created);
  });
});
