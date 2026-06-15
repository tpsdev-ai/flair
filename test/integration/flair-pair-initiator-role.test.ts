// flair_pair_initiator role — LIVE add_role acceptance (regression guard).
//
// The unit test (federation-pair-role.test.ts) mocks fetch, so it only proves the
// impl SENDS a given spec — it cannot catch Harper rejecting that spec. An earlier
// all-false `flair.tables` block (cluster_user + shorthand table names + missing
// attribute_permissions) passed the mock test but made add_role return 400, which
// silently broke fresh hub provisioning (`flair init --remote` aborts at
// ensureFlairPairInitiatorRole). This test runs the REAL function against a spawned
// Harper so that class of bug can't recur behind the mock.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairPairInitiatorRole } from "../../src/cli";

let harper: HarperInstance;

async function listRoleNames(): Promise<string[]> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ operation: "list_roles" }),
  });
  const roles = (await res.json()) as any[];
  return roles.map((r) => r.role ?? r.name);
}

describe("ensureFlairPairInitiatorRole (live add_role)", () => {
  beforeAll(async () => { harper = await startHarper(); }, 180_000);
  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("add_role accepts the spec and the role is created", async () => {
    // Must not throw — a 400 from add_role (the old bug) surfaces as a thrown error.
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    expect(await listRoleNames()).toContain("flair_pair_initiator");
  }, 60_000);

  test("is idempotent — a second call neither throws nor duplicates", async () => {
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const names = await listRoleNames();
    expect(names.filter((n) => n === "flair_pair_initiator")).toHaveLength(1);
  }, 60_000);
});
