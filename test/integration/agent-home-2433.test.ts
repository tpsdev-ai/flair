/**
 * agent-home-2433.test.ts — flair#2433, against a REAL Harper.
 *
 * Every path that locally creates an Agent row stamps the creating instance's
 * own federation id (`originatorInstanceId`) as the new row's home, the home is
 * immutable after create, `flair doctor` reports a home-less row, and the named
 * remedy (`flair agent stamp-home`) stamps a provably local row while LISTING —
 * never stamping — one that arrived through federation.
 *
 * The id a create stamps is the one the shared rule resolves from the REAL
 * `flair.Instance` table (src/lib/instance-identity-row.ts). This file seeds
 * exactly one Instance row, asserts the rule returns its id, then drives the
 * real ops-API create (`seedAgentWithLocalHome`), the real Agent resource (a
 * supplied home is ignored; a stored home survives the update verbs), the real
 * federation merge (a sync-originated home-less row), and the real `flair
 * doctor` CLI subprocess — all against this test's own ephemeral instance.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { seedAgentWithLocalHome } from "../../src/cli.js";
import {
  AGENT_HOME_STAMP_REMEDY,
  agentHomeEndpoint,
  readAgentHomeRows,
  resolveTargetInstanceId,
  runAgentHomeStamp,
} from "../../src/lib/agent-home.js";

const ADMIN_PASS = "test123"; // harper-lifecycle's seeded admin pass
const CLI = join(process.cwd(), "dist", "cli.js");
const LOCAL_ID = "inst-local-2433";
const PEER_ID = "peer-hub-2433";
const sfx = Date.now().toString(36);

let harper: HarperInstance;
let cliHome: string;

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
const opsPort = () => Number(new URL(harper.opsURL).port);

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function send(method: string, path: string, body: unknown): Promise<{ status: number; raw: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, raw: (await res.text()).slice(0, 600) };
}

/** Run `flair doctor` against this instance, with an isolated HOME. */
function runDoctor(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["doctor", "--port", new URL(harper.httpURL).port];
    const startedAt = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: cliHome,
        FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: new URL(harper.opsURL).port,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: ADMIN_PASS,
        NO_COLOR: "1",
      },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 30_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run `flair principal add <id>` as a real subprocess, with an isolated HOME. */
function runPrincipalAdd(id: string, opsPortArg: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["principal", "add", id, "--ops-port", opsPortArg, "--keys-dir", join(cliHome, "keys"), "--admin-pass", ADMIN_PASS];
    const startedAt = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: cliHome, FLAIR_TOKEN: "", NO_COLOR: "1" },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 30_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/** A loopback port with nothing listening: bind an ephemeral port, then release it. */
async function closedPort(): Promise<string> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(String(port)));
    });
  });
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-2433-home-"));
  // Make this instance's identity unambiguous: exactly one Instance row.
  const existing = await ops({ operation: "sql", sql: "SELECT id FROM flair.Instance" });
  for (const r of Array.isArray(existing) ? existing : []) {
    if (r?.id) await ops({ operation: "delete", table: "Instance", ids: [r.id] });
  }
  await ops({
    operation: "insert",
    table: "Instance",
    records: [{ id: LOCAL_ID, role: "hub", publicKey: "local-pub-2433", createdAt: new Date().toISOString() }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("flair#2433 — the home a create stamps, on a real Harper", () => {
  test("the shared rule resolves this instance's own id from the real Instance table", async () => {
    const id = await resolveTargetInstanceId(agentHomeEndpoint(opsPort(), harper.admin.username, harper.admin.password));
    expect(id).toBe(LOCAL_ID);
  }, 30_000);

  test("seedAgentWithLocalHome creates an Agent row whose home is the local instance", async () => {
    const id = `agent-ops-${sfx}`;
    await seedAgentWithLocalHome(opsPort(), id, "pubkey-ops-2433", harper.admin.username, harper.admin.password);
    const row = await rowIn("Agent", id);
    expect(row?.id).toBe(id);
    expect(row?.originatorInstanceId).toBe(LOCAL_ID);
  }, 30_000);

  test("the Agent resource ignores a request-supplied home on create", async () => {
    const id = `agent-res-${sfx}`;
    const r = await send("POST", "/Agent/", {
      id, name: id, role: "agent", status: "active", publicKey: "pk-res-2433",
      originatorInstanceId: PEER_ID, createdAt: new Date().toISOString(),
    });
    expect(r.status, r.raw).toBeLessThan(300);
    const row = await rowIn("Agent", id);
    expect(row?.originatorInstanceId, "a supplied home was written").toBe(LOCAL_ID);
    expect(row?.originatorInstanceId).not.toBe(PEER_ID);
  }, 30_000);

  test("a stored home is not changed by the resource PATCH verb", async () => {
    const id = `agent-immutable-${sfx}`;
    const now = new Date().toISOString();
    await send("POST", "/Agent/", { id, name: id, role: "agent", status: "active", publicKey: "pk-imm-2433", createdAt: now });
    expect((await rowIn("Agent", id))?.originatorInstanceId).toBe(LOCAL_ID);

    // PATCH merges (Harper partial update), so the stored home stands and a body
    // value neither replaces nor clears it.
    const patch = await send("PATCH", `/Agent/${id}`, { originatorInstanceId: PEER_ID, displayName: id });
    expect(patch.status, patch.raw).toBeLessThan(300);
    expect((await rowIn("Agent", id))?.originatorInstanceId, "PATCH changed the stored home").toBe(LOCAL_ID);
  }, 30_000);

  test("the remedy stamps a provably local home-less row and lists a sync-originated one", async () => {
    // A provably local home-less row: written through the ops API with no home
    // and no federation provenance.
    const localId = `local-nohome-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: localId, name: localId, role: "agent", status: "active", publicKey: "pk-local-2433", createdAt: new Date().toISOString() }],
    });

    // A sync-originated home-less row: landed through the REAL federation merge
    // (a signed batch from a paired peer), so it carries `_syncedFrom` /
    // `_originatorInstanceId` and nothing about it is local.
    const syncId = `synced-nohome-${sfx}`;
    const hub = nacl.sign.keyPair();
    await ops({
      operation: "insert",
      table: "Peer",
      records: [{ id: PEER_ID, publicKey: Buffer.from(hub.publicKey).toString("base64url"), role: "hub", status: "active", createdAt: new Date().toISOString() }],
    });
    const ts = new Date().toISOString();
    const body = signBodyFresh({
      instanceId: PEER_ID,
      lamportClock: Date.now(),
      records: [{ table: "Agent", id: syncId, updatedAt: ts, originatorInstanceId: PEER_ID, data: { id: syncId, name: syncId, role: "agent", status: "active", publicKey: "pk-synced-2433", createdAt: ts } }],
    }, hub.secretKey);
    const syncRes = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const syncRaw = await syncRes.text();
    expect(syncRes.status, `FederationSync returned ${syncRes.status}: ${syncRaw.slice(0, 300)}`).toBe(200);
    const syncRow = await rowIn("Agent", syncId);
    expect(syncRow, "the sync-originated row did not land").not.toBeNull();
    expect(syncRow.originatorInstanceId ?? null).toBeNull();
    expect(syncRow._syncedFrom, "the receiver did not stamp sync provenance").toBe(PEER_ID);

    const args = { opsUrl: harper.opsURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 10_000 };

    // Dry run writes nothing.
    const dry = await runAgentHomeStamp({ ...args, apply: false });
    expect(dry.ok).toBe(true);
    expect(dry.stamped).toEqual([]);
    expect(dry.plan.stampable).toContain(localId);
    expect(dry.plan.sync).toContain(syncId);
    expect((await rowIn("Agent", localId)).originatorInstanceId ?? null, "a dry run wrote a home").toBeNull();

    // Apply stamps the local row and leaves the sync-originated one unstamped.
    const applied = await runAgentHomeStamp({ ...args, apply: true });
    expect(applied.ok).toBe(true);
    expect(applied.stamped).toContain(localId);
    expect(applied.stamped).not.toContain(syncId);
    expect((await rowIn("Agent", localId)).originatorInstanceId).toBe(LOCAL_ID);
    expect((await rowIn("Agent", syncId)).originatorInstanceId ?? null, "the sync-originated row was stamped").toBeNull();
    expect((await rowIn("Agent", syncId))._syncedFrom).toBe(PEER_ID);
  }, 60_000);

  test("flair doctor reports the home-less row it can see, with the named remedy", async () => {
    // A fresh home-less row, distinct from the one stamped above.
    const id = `doctor-nohome-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-doctor-2433", createdAt: new Date().toISOString() }],
    });

    const r = await runDoctor();
    expect(r.stderr, r.stderr).toBe("");
    expect(r.stdout, "the home-less row was not reported").toContain(id);
    expect(r.stdout).toContain("Agent homes");
    expect(r.stdout).toContain(AGENT_HOME_STAMP_REMEDY);
    expect(r.stdout, "the seeded identity was not used").toContain(`can be stamped with this instance's id (${LOCAL_ID})`);

    // An advisory: removing the only home-less rows leaves the issue count unchanged.
    const before = r.stdout.match(/(\d+) issues? found/)?.[1] ?? "0";
    const stamped = await runAgentHomeStamp({
      opsUrl: harper.opsURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 10_000, apply: true,
    });
    expect(stamped.ok).toBe(true);
    const after = (await runDoctor()).stdout.match(/(\d+) issues? found/)?.[1] ?? "0";
    expect(after, "the home-less row counted toward doctor's issue total").toBe(before);
  }, 60_000);
});

describe("flair#2433 — `flair principal add` over an existing row (real subprocess)", () => {
  // Agent schema required fields (schemas/agent.graphql): name, publicKey, createdAt (id is the key).
  test("a stored home that differs from the local id is refused and left as it was", async () => {
    const id = `pa-other-home-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-pa-other-2433", originatorInstanceId: PEER_ID, createdAt: new Date().toISOString() }],
    });
    const r = await runPrincipalAdd(id, String(opsPort()));
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("originator_instance_immutable");
    const row = await rowIn("Agent", id);
    expect(row.originatorInstanceId, "the stored home changed").toBe(PEER_ID);
    expect(row.publicKey, "the refused write still changed the row").toBe("pk-pa-other-2433");
  }, 60_000);

  test("a home-less row carrying federation provenance stays home-less", async () => {
    const id = `pa-synced-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-pa-synced-2433", _syncedFrom: PEER_ID, createdAt: new Date().toISOString() }],
    });
    const before = await rowIn("Agent", id);
    expect(before._syncedFrom, "the seeded provenance was not stored").toBe(PEER_ID);
    expect(before.originatorInstanceId ?? null).toBeNull();

    const r = await runPrincipalAdd(id, String(opsPort()));
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const after = await rowIn("Agent", id);
    expect(after.originatorInstanceId ?? null, "principal add attributed a home-less row to this instance").toBeNull();
    expect(after._syncedFrom).toBe(PEER_ID);
  }, 60_000);

  test("an unreadable read refuses and writes nothing", async () => {
    const id = `pa-unreadable-${sfx}`;
    const r = await runPrincipalAdd(id, await closedPort());
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(`could not read agent '${id}'`);
    expect(await rowIn("Agent", id), "a row was written").toBeNull();
  }, 60_000);
});

describe("flair#2433 — the doctor roster read is the remedy's input", () => {
  test("readAgentHomeRows returns the home-less row and its sync provenance", async () => {
    const rows = await readAgentHomeRows({ opsUrl: harper.opsURL, authHeader: basic(), timeoutMs: 10_000 });
    expect(rows, "the roster read failed against the live instance").not.toBeNull();
    const ids = rows!.map((r) => r.id);
    expect(ids).toContain(`synced-nohome-${sfx}`);
    const syncRow = rows!.find((r) => r.id === `synced-nohome-${sfx}`)!;
    expect(syncRow._syncedFrom).toBe(PEER_ID);
  }, 30_000);
});
