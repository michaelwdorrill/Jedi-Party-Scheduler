import { describe, expect, it } from "vitest";
import { DELETE_ACCOUNT_CONFIRMATION } from "../src/lib/deleteAccount";

// Release-bar clause 4, Pass 24 review D-09: the deletion confirmation names
// what it does to other people, not only to you.
describe("the account-deletion confirmation", () => {
  it("says organised events vanish for invitees, with their answers, unannounced", () => {
    expect(DELETE_ACCOUNT_CONFIRMATION).toMatch(
      /disappears for everyone invited/,
    );
    expect(DELETE_ACCOUNT_CONFIRMATION).toMatch(
      /with their answers, and nobody is told/,
    );
    expect(DELETE_ACCOUNT_CONFIRMATION).toMatch(/cannot be undone/);
  });
});
