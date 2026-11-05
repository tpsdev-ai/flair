// agent-patch-race-2696.test.ts — flair#2696, against a REAL Harper.
//
// An agent that is not an administrator updates its own record with PATCH,
// which merges the body into the stored row (an Agent PUT is an administrator
// operation). The PATCH decides in authorizePrincipalWrite from the row it
// reads, then reads and writes in the request's transaction. A change an
// administrator commits after that read stands after the PATCH:
//   (a) the PATCH names `role: "agent"` and an administrator commits
//       `role: "admin"`: the committed role stays "admin" (with `admin: true`),
//       and the PATCH's other field is stored;
//   (b) the PATCH names neither `status` nor an authority field and an
//       administrator commits `status: "deactivated"`: the agent stays
//       deactivated, and the PATCH's other field is stored.
// A competing transaction whose time is taken before the PATCH's first read
// and that commits after it is not exercised here; per-id serialization is
// tracked in flair#2478.
//
// Each interleaving holds the PATCH at its test-only pause point after the
// guard (`agent-patch-pre` in resources/Agent.ts; resources/txn-pause-point.ts,
// enabled for THIS file's Harper only by FLAIR_ENABLE_TEST_FAULT_INJECTION +
// FLAIR_TEST_PAUSE_DIR), commits the administrator's PATCH through the same
// resource, then releases the paused PATCH. The committed row is read through a
// separate operations search_by_id.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

/** The ordinary PATCH's pause point after its guard (resources/Agent.ts). */
const AGENT_PATCH_PRE_PAUSE_POINT = "agent-patch-pre";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const ADMIN = mkAgent("patch2696race-admin");
const STORED_CREATED_AT = "2026-01-02T03:04:05.000Z";

let harper: HarperInstance;
let pauseDir: string;

async function adminOp(op: Record<string, any>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text);
}

async function rowIn(id: string): Promise<any | null> {
  const rows = await adminOp({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function seed(rec: Record<string, any>): Promise<void> {
  await adminOp({ operation: "insert", database: "flair", table: "Agent", records: [rec] });
}

async function patch(path: string, body: unknown, caller: TestAgent): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(caller, "PATCH", path) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm the PATCH's pause point, start the PATCH, and once it is paused commit
 * `compete`, then release it. Returns the PATCH's response and the pause's
 * release marker ("go" only when the pause fired and this test released it).
 */
async function withPausedPatch<R>(
  work: () => Promise<R>,
  compete: () => Promise<void>,
): Promise<{ result: R; released: string }> {
  const point = AGENT_PATCH_PRE_PAUSE_POINT;
  for (const marker of ["claimed", "paused", "go", "released"]) {
    rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  }
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = work();
  const paused = await waitForFile(join(pauseDir, `paused.${point}`), 15_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const result = await pending;
  return { result, released: paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused" };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2696-patch-pause-"));
  harper = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(harper);
  await seed({
    id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, status: "active",
    publicKey: ADMIN.publicKey, createdAt: STORED_CREATED_AT,
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2696 — an administrator's change committed after a non-admin PATCH's guard read stands after that PATCH", () => {
  test("(a) an administrator's role \"admin\" committed while the agent's PATCH naming role \"agent\" is paused stays committed", async () => {
    const agent = mkAgent(`patch2696race-role-${randomUUID().slice(0, 8)}`);
    await seed({
      id: agent.id, name: agent.id, role: "agent", admin: false, status: "active",
      runtime: "stored-runtime", publicKey: agent.publicKey, createdAt: STORED_CREATED_AT,
    });
    const path = `/Agent/${agent.id}`;

    const { result, released } = await withPausedPatch(
      () => patch(path, { role: "agent", runtime: "patched-runtime" }, agent),
      async () => {
        const grant = await patch(path, { role: "admin" }, ADMIN);
        expect(grant.status, `the administrator's PATCH answered ${grant.status}: ${grant.text}`).toBeLessThan(300);
        expect((await rowIn(agent.id))?.role, "the administrator's role did not commit").toBe("admin");
      },
    );

    expect(released, "the PATCH never reached its pause after the guard").toBe("go");
    expect(result.status, `the agent's PATCH answered ${result.status}: ${result.text}`).toBeLessThan(300);
    const after = await rowIn(agent.id);
    expect(after?.role, "the agent's PATCH replaced the role the administrator committed").toBe("admin");
    expect(after?.admin, "the admin mirror does not agree with the committed role").toBe(true);
    expect(after?.runtime, "the agent's PATCH did not store its runtime").toBe("patched-runtime");
  }, 60_000);

  test("(b) an administrator's deactivation committed while the agent's PATCH is paused leaves the agent deactivated", async () => {
    const agent = mkAgent(`patch2696race-status-${randomUUID().slice(0, 8)}`);
    await seed({
      id: agent.id, name: agent.id, role: "agent", admin: false, status: "active",
      runtime: "stored-runtime", publicKey: agent.publicKey, createdAt: STORED_CREATED_AT,
    });
    const path = `/Agent/${agent.id}`;

    const { result, released } = await withPausedPatch(
      () => patch(path, { runtime: "patched-runtime" }, agent),
      async () => {
        const deactivate = await patch(path, { status: "deactivated" }, ADMIN);
        expect(deactivate.status, `the administrator's PATCH answered ${deactivate.status}: ${deactivate.text}`).toBeLessThan(300);
        expect((await rowIn(agent.id))?.status, "the administrator's deactivation did not commit").toBe("deactivated");
      },
    );

    expect(released, "the PATCH never reached its pause after the guard").toBe("go");
    expect(result.status, `the agent's PATCH answered ${result.status}: ${result.text}`).toBeLessThan(300);
    const after = await rowIn(agent.id);
    expect(after?.status, "the agent's PATCH changed the committed status").toBe("deactivated");
    expect(after?.runtime, "the agent's PATCH did not store its runtime").toBe("patched-runtime");
    const next = await patch(path, { runtime: "after-deactivation" }, agent);
    expect(next.status, `a later PATCH by the deactivated agent answered ${next.status}: ${next.text}`).toBeGreaterThanOrEqual(400);
    expect((await rowIn(agent.id))?.runtime, "a deactivated agent's later PATCH was stored").toBe("patched-runtime");
  }, 60_000);
});
