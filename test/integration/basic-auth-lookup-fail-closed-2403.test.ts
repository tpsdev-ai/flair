// basic-auth-lookup-fail-closed-2403.test.ts — flair#2403.
//
// A credentialed Basic-auth path reads the Agent row to decide whether the caller
// is admitted. When that read FAILS (a throw, a timeout, an unreadable result) the
// request is refused with the named `agent_lookup_failed` error, and never mapped
// to an absent/null principal that is then admitted. A read that SUCCEEDS still
// decides as before: an active principal is admitted, an absent row is not refused
// by the failed-read rule.
//
// Real Harper: booted from a private copy of the built component with one test-only
// resource added (test/fixtures/basic-auth-lookup-fail-2403/probe.js, composed by
// test/helpers/component-with-replay-probe.ts). The probe makes the Agent-table read
// reject for exactly one principal id, so a Basic request for that principal reaches
// the auth code with a failed lookup. Every other id reads normally.
//
// MODEL: test/integration/agent-status-admin-only.test.ts (composed built component +
// real Harper) and test/integration/auth-middleware-e2e.test.ts (real HTTP, real auth).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

const PROBE: ProbeFiles = {
  source: join("test", "fixtures", "basic-auth-lookup-fail-2403", "probe.js"),
  target: join("dist", "resources", "zz-basic-auth-lookup-fail-2403.js"),
  out: "basic-auth-lookup-fail-2403", // unused: the probe answers over HTTP and writes no files
};

// The id whose Agent read the probe makes FAIL (reject).
const FAIL_USER = "basic-lookup-fail-2403";
// A super_user with an ACTIVE Agent row (read succeeds).
const ACTIVE_USER = "basic-lookup-active-2403";
// A super_user with NO Agent row (read succeeds and finds nothing).
const ABSENT_USER = "basic-lookup-absent-2403";
const PASS = "pw-2403";

let harper: HarperInstance;
let composed: ProbeComponent | undefined;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

async function adminOp(h: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

const basic = (user: string, pass: string) => "Basic " + btoa(`${user}:${pass}`);

describe("flair#2403 — a failed Agent lookup on the Basic-auth path is refused", () => {
  let armed = false;

  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("basic-auth-lookup-fail-closed-2403 requires an isolated Harper instance; unset HARPER_HTTP_URL");
    composed = componentWithReplayProbe({ probe: PROBE });
    harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
    assertOwnInstance(harper);

    // A super_user role, then the three principals.
    const role = "lookup2403_super";
    const roleRes = await adminOp(harper, { operation: "add_role", role, permission: { super_user: true } });
    expect([200, 409], `add_role returned ${roleRes.status}`).toContain(roleRes.status);
    for (const username of [FAIL_USER, ACTIVE_USER, ABSENT_USER]) {
      const res = await adminOp(harper, { operation: "add_user", username, password: PASS, role, active: true });
      expect([200, 409], `add_user ${username} returned ${res.status}`).toContain(res.status);
    }

    // ACTIVE_USER gets an Agent row, status active. FAIL_USER and ABSENT_USER
    // deliberately get no Agent row.
    const seedRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: ACTIVE_USER, name: ACTIVE_USER, role: "agent", status: "active", publicKey: Buffer.alloc(32, 7).toString("base64"), createdAt: new Date().toISOString() }],
    });
    expect(seedRes.status, `seed ACTIVE_USER returned ${seedRes.status}: ${await seedRes.text()}`).toBe(200);

    // Arm the fault for FAIL_USER.
    const arm = await fetch(`${harper.httpURL}/BasicAuthLookupFail2403`, {
      method: "POST",
      headers: { Authorization: basic(harper.admin.username, harper.admin.password) },
    });
    const armBody = await arm.json().catch(() => null);
    expect(arm.status, `arm returned ${arm.status}: ${JSON.stringify(armBody)}`).toBe(200);
    armed = armBody?.installed === true;
    expect(armed, "the probe could not install the Agent-lookup fault").toBe(true);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    composed?.cleanup();
  });

  test("a FAILED lookup for a credentialed Basic request is refused with agent_lookup_failed", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`, {
      headers: { Authorization: basic(FAIL_USER, PASS) },
    });
    const body = await res.json();
    // On origin/main the failed read mapped to a null principal and the request was
    // admitted (Harper then served the super_user 200); the fix refuses by name.
    expect(res.status, `expected the named refusal, got ${res.status}: ${JSON.stringify(body)}`).toBe(500);
    expect(body.error).toBe("agent_lookup_failed");
  }, 30_000);

  test("an ACTIVE principal is still admitted on the same path (read succeeded)", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`, {
      headers: { Authorization: basic(ACTIVE_USER, PASS) },
    });
    expect(res.status, "an active principal must not be refused by the failed-read rule").toBe(200);
  }, 30_000);

  test("an ABSENT row still behaves as before: not refused by the failed-read rule", async () => {
    const res = await fetch(`${harper.httpURL}/Agent`, {
      headers: { Authorization: basic(ABSENT_USER, PASS) },
    });
    expect(res.status, "an absent row is not a failed read").toBe(200);
  }, 30_000);
});
