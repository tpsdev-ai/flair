/**
 * agent-home-2433.test.ts — flair#2433, against a REAL Harper.
 *
 * Every path that locally creates an Agent row stamps the creating instance's
 * own federation id (`originatorInstanceId`) as the new row's home, the home is
 * immutable after create, `flair doctor` reports a home-less row, and the named
 * remedy (`flair agent stamp-home`) stamps a home-less row with no federation-sync
 * provenance while LISTING — never stamping — one that carries it.
 *
 * The id a create stamps is the one the shared rule resolves from the REAL
 * `flair.Instance` table (src/lib/instance-identity-row.ts). This file seeds
 * exactly one Instance row, asserts the rule returns its id, then drives the
 * real ops-API create (`seedAgentWithLocalHome`), the real Agent resource (a
 * supplied home is ignored; a stored home survives the update verbs), the real
 * federation merge (a sync-originated home-less row), and the real `flair
 * doctor` CLI subprocess — all against this test's own ephemeral instance.
 *
 * The stamp's decision lives in the Agent resource's OWNED transaction
 * (resources/Agent.ts): the resource STAGES the write of the home and updatedAt, then re-reads
 * the COMMITTED row and aborts (discarding the staged write) when that row gained
 * a home or provenance. The interleaving cases inject a competing commit at the
 * resource's in-transaction pause point (resources/txn-pause-point.ts, enabled
 * for THIS file's Harper by FLAIR_ENABLE_TEST_FAULT_INJECTION +
 * FLAIR_TEST_PAUSE_DIR) — BETWEEN the staged write and the confirmation read — so
 * a decision made from the request's read snapshot (taken before the override
 * ran) would miss it: a competing home, a competing raw provenance update, and
 * another writer's SAME local home. `flair principal add`'s guarded write-back runs the same way
 * (see AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT).
 *
 * The no-canonical-Instance cases change the real `Instance` table — before any
 * id is resolved, and after a resource create and a successful stamp have
 * resolved one — and assert the stamp is refused by name with nothing written
 * (flair#2472).
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime.js";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { seedAgentWithLocalHome } from "../../src/cli.js";
import {
  AGENT_HOME_STAMP_REMEDY,
  agentHomeEndpoint,
  readAgentHomeRows,
  resolveTargetInstanceId,
  runAgentHomeStamp,
} from "../../src/lib/agent-home.js";
import { AGENT_HOME_STAMP_FIELD, AGENT_HOME_STAMP_PAUSE_POINT, AGENT_PRINCIPAL_WRITE_BACK_FIELD, AGENT_PRINCIPAL_WRITE_BACK_NO_ROW_ERROR, AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT } from "../../src/lib/agent-home-fields.js";
import { randomUUID } from "node:crypto";

const ADMIN_PASS = "test123"; // harper-lifecycle's seeded admin pass
const CLI = join(process.cwd(), "dist", "cli.js");
const LOCAL_ID = "inst-local-2433";
const PEER_ID = "peer-hub-2433";
const sfx = Date.now().toString(36);

let harper: HarperInstance;
let cliHome: string;
let pauseDir: string;

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

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

/** An Ed25519 agent identity whose public key is stored on its Agent row, so the
 *  Agent resource resolves a signed request to a VERIFIED (non-admin) agent. */
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

/** `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>` over `<id>:<ts>:<nonce>:<METHOD>:<pathname>`. */
async function sendAs(agent: TestAgent, method: string, path: string, body: unknown): Promise<{ status: number; raw: string }> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agent.id}:${ts}:${nonce}:${method}:${path}`), agent.secretKey);
  const auth = `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, raw: (await res.text()).slice(0, 600) };
}

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
    const env = {
      ...process.env,
      HOME: cliHome,
      FLAIR_URL: harper.httpURL,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_TOKEN: "",
      FLAIR_ADMIN_PASS: ADMIN_PASS,
      NO_COLOR: "1",
    };
    const child = spawn(nodeBin({ env }), [CLI, ...args], {
      env,
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
    const args = ["principal", "add", id, "--ops-port", opsPortArg, "--port", new URL(harper.httpURL).port, "--keys-dir", join(cliHome, "keys"), "--admin-pass", ADMIN_PASS];
    const startedAt = Date.now();
    const env = { ...process.env, HOME: cliHome, FLAIR_TOKEN: "", NO_COLOR: "1" };
    const child = spawn(nodeBin({ env }), [CLI, ...args], {
      env,
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

/** The four marker paths the stamp's in-transaction pause point uses (resources/txn-pause-point.ts). */
function pausePoints(point: string) {
  return {
    arm: join(pauseDir, `arm.${point}`),
    paused: join(pauseDir, `paused.${point}`),
    released: join(pauseDir, `released.${point}`),
    go: join(pauseDir, `go.${point}`),
  };
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
 * Arm the named pause point, run `work`, and once it is paused commit `compete`
 * then release it. The competing commit therefore lands where a decision made
 * from the request's read snapshot would miss it — for the stamp, between the
 * STAGED home write and the confirmation read. Returns the work's result and
 * whether the pause actually fired.
 */
async function withPausedPoint<T, R>(
  point: string,
  work: () => Promise<R>,
  compete: () => Promise<T>,
): Promise<{ result: R; released: string }> {
  const p = pausePoints(point);
  for (const marker of ["claimed", "paused", "go", "released"]) {
    rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  }
  writeFileSync(p.arm, "");
  const pending = work();
  const paused = await waitForFile(p.paused, 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(p.go, "");
  }
  const result = await pending;
  return { result, released: paused ? readFileSync(p.released, "utf8") : "never paused" };
}

async function withPausedStamp<T, R>(
  stamp: () => Promise<R>,
  compete: () => Promise<T>,
): Promise<{ result: R; released: string }> {
  return withPausedPoint<T, R>(AGENT_HOME_STAMP_PAUSE_POINT, stamp, compete);
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2433-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, 30_000);

describe("flair#2433 — the home a create stamps, on a real Harper", () => {
  test("with no canonical Instance row the stamp refuses by name inside the resource and never stamps", async () => {
    // Remove every Instance row: the resource has no id to stamp, so it must
    // refuse by name with nothing written, and never report `stamped`. This case
    // runs before anything in this Harper resolves an id; the two cases after the
    // remedy test below cover the same refusal after a successful stamp has
    // resolved one (flair#2472).
    const id = `noinstance-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-ni-2433", createdAt: new Date().toISOString() }],
    });
    const existing = await ops({ operation: "sql", sql: "SELECT id FROM flair.Instance" });
    for (const r of Array.isArray(existing) ? existing : []) {
      if (r?.id) await ops({ operation: "delete", table: "Instance", ids: [r.id] });
    }
    try {
      const r = await send("PATCH", `/Agent/${id}`, { id, [AGENT_HOME_STAMP_FIELD]: true });
      expect(r.status, r.raw).toBe(409);
      expect(r.raw).toContain("agent_home_stamp_no_instance");
      expect(r.raw).toContain("could not confirm a single canonical Instance row");
      expect(r.raw, "the refused stamp still reported the row stamped").not.toContain("\"stamped\":true");
      expect((await rowIn("Agent", id)).originatorInstanceId ?? null, "the row was stamped with no canonical instance").toBeNull();
    } finally {
      await ops({
        operation: "insert",
        table: "Instance",
        records: [{ id: LOCAL_ID, role: "hub", publicKey: "local-pub-2433", createdAt: new Date().toISOString() }],
      });
    }
  }, 30_000);

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

  test("a resource write cannot supply, change or clear the federation bookkeeping of an existing row", async () => {
    const id = `agent-bookkeeping-${sfx}`;
    // Agent schema required fields (schemas/agent.graphql): name, publicKey, createdAt (id is the key).
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-bk-2433", _syncedFrom: PEER_ID, _originatorInstanceId: PEER_ID, createdAt: new Date().toISOString() }],
    });
    const stays = async (label: string) => {
      const row = await rowIn("Agent", id);
      expect(row._syncedFrom, `${label} changed _syncedFrom`).toBe(PEER_ID);
      expect(row._originatorInstanceId, `${label} changed _originatorInstanceId`).toBe(PEER_ID);
    };

    const patchSet = await send("PATCH", `/Agent/${id}`, { _syncedFrom: "forged", _originatorInstanceId: "forged", displayName: id });
    expect(patchSet.status, patchSet.raw).toBeLessThan(300);
    await stays("a PATCH that supplied them");
    const patchClear = await send("PATCH", `/Agent/${id}`, { _syncedFrom: null, _originatorInstanceId: null, displayName: id });
    expect(patchClear.status, patchClear.raw).toBeLessThan(300);
    await stays("a PATCH that cleared them");

    // Admin Basic PUTs (an Agent PUT is an administrator operation). Each must
    // succeed and store its displayName, so "stays" is checked after a PUT that
    // landed rather than one that was refused.
    const full = { id, name: id, role: "agent", status: "active", publicKey: "pk-bk-2433", createdAt: new Date().toISOString() };
    const putSet = await send("PUT", `/Agent/${id}`, { ...full, displayName: "put-supplied", _syncedFrom: "forged", _originatorInstanceId: "forged" });
    expect(putSet.status, putSet.raw).toBeLessThan(300);
    expect((await rowIn("Agent", id))?.displayName, "the PUT that supplied them did not land").toBe("put-supplied");
    await stays("a PUT that supplied them");
    const putOmit = await send("PUT", `/Agent/${id}`, { ...full, displayName: "put-omitted" });
    expect(putOmit.status, putOmit.raw).toBeLessThan(300);
    expect((await rowIn("Agent", id))?.displayName, "the PUT that omitted them did not land").toBe("put-omitted");
    await stays("a PUT that omitted them");
  }, 30_000);

  test("a resource create cannot set the federation bookkeeping", async () => {
    const id = `agent-bookkeeping-create-${sfx}`;
    const r = await send("POST", "/Agent/", {
      id, name: id, role: "agent", status: "active", publicKey: "pk-bkc-2433",
      _syncedFrom: "forged", _originatorInstanceId: "forged", createdAt: new Date().toISOString(),
    });
    expect(r.status, r.raw).toBeLessThan(300);
    const row = await rowIn("Agent", id);
    expect(row._syncedFrom ?? null).toBeNull();
    expect(row._originatorInstanceId ?? null).toBeNull();
  }, 30_000);

  test("the remedy stamps a home-less row with no federation-sync provenance and lists a sync-originated one", async () => {
    // A home-less row written through the ops API with no home and no
    // federation provenance.
    const localId = `local-nohome-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: localId, name: localId, role: "agent", status: "active", publicKey: "pk-local-2433", createdAt: new Date().toISOString() }],
    });

    // A sync-originated home-less row: landed through the REAL federation merge
    // (a signed batch from a paired peer), so it carries `_syncedFrom` /
    // `_originatorInstanceId`.
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

    const args = { opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 10_000 };

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

  /** Make the Instance table hold exactly `ids` (one row each, same shape as beforeAll's). */
  async function setInstanceRows(ids: string[]): Promise<void> {
    const existing = await ops({ operation: "sql", sql: "SELECT id FROM flair.Instance" });
    for (const r of Array.isArray(existing) ? existing : []) {
      if (r?.id) await ops({ operation: "delete", table: "Instance", ids: [r.id] });
    }
    if (ids.length === 0) return;
    await ops({
      operation: "insert",
      table: "Instance",
      records: ids.map((id) => ({ id, role: "hub", publicKey: `pub-${id}`, createdAt: new Date().toISOString() })),
    });
  }

  /**
   * Warm the resource's process-cached instance id — a resource create (which
   * stamps through `localInstanceId()`) and a successful guarded stamp, both
   * landing LOCAL_ID — then change the Instance table with `change` and send the
   * guarded stamp for a second home-less row. Returns that second response and
   * the second row before and after it. The table is restored to exactly the
   * LOCAL_ID row afterwards. Harper runs ONE worker here (harper-lifecycle's
   * default), so the warmed cache is the one the second request meets.
   */
  async function stampAfterInstanceChange(tag: string, change: () => Promise<void>) {
    const created = `${tag}-created-${sfx}`;
    const warm = `${tag}-warm-${sfx}`;
    const target = `${tag}-target-${sfx}`;
    const create = await send("POST", "/Agent/", { id: created, name: created, role: "agent", status: "active", publicKey: `pk-${created}`, createdAt: new Date().toISOString() });
    expect(create.status, create.raw).toBeLessThan(300);
    expect((await rowIn("Agent", created)).originatorInstanceId, "the create did not resolve this instance's id").toBe(LOCAL_ID);
    await ops({
      operation: "insert",
      table: "Agent",
      records: [warm, target].map((id) => ({ id, name: id, role: "agent", status: "active", publicKey: `pk-${id}`, createdAt: new Date().toISOString() })),
    });
    const first = await send("PATCH", `/Agent/${warm}`, { id: warm, [AGENT_HOME_STAMP_FIELD]: true });
    expect(first.status, first.raw).toBe(200);
    expect(first.raw, "the warm-up stamp did not apply").toContain("\"stamped\":true");
    expect((await rowIn("Agent", warm)).originatorInstanceId).toBe(LOCAL_ID);
    try {
      await change();
      const before = await rowIn("Agent", target);
      const r = await send("PATCH", `/Agent/${target}`, { id: target, [AGENT_HOME_STAMP_FIELD]: true });
      const after = await rowIn("Agent", target);
      return { r, before, after };
    } finally {
      await setInstanceRows([LOCAL_ID]);
    }
  }

  test("after a successful stamp, removing the Instance row makes the next stamp refuse by name (the current table, not a cached id)", async () => {
    // flair#2472 — the guard reads the CURRENT Instance table at write time. A
    // process-cached id from the earlier successful stamp must not answer it.
    const { r, before, after } = await stampAfterInstanceChange("inst-removed", () => setInstanceRows([]));
    expect(r.status, r.raw).toBe(409);
    expect(r.raw).toContain("agent_home_stamp_no_instance");
    expect(r.raw).toContain("could not confirm a single canonical Instance row");
    expect(r.raw, "the refused stamp still reported the row stamped").not.toContain("\"stamped\":true");
    expect(after.originatorInstanceId ?? null, "the row was stamped with no Instance row").toBeNull();
    expect(after, "the refused stamp wrote to the row").toEqual(before);
  }, 30_000);

  test("after a successful stamp, a second Instance row makes the next stamp refuse by name (the current table, not a cached id)", async () => {
    // Several Instance rows: no single canonical id, so the same named refusal.
    const { r, before, after } = await stampAfterInstanceChange("inst-several", () => setInstanceRows([LOCAL_ID, `inst-second-${sfx}`]));
    expect(r.status, r.raw).toBe(409);
    expect(r.raw).toContain("agent_home_stamp_no_instance");
    expect(r.raw).toContain("could not confirm a single canonical Instance row");
    expect(r.raw, "the refused stamp still reported the row stamped").not.toContain("\"stamped\":true");
    expect(after.originatorInstanceId ?? null, "the row was stamped with several Instance rows").toBeNull();
    expect(after, "the refused stamp wrote to the row").toEqual(before);
  }, 30_000);

  test("a home committed after the resource's first read is not overwritten (pause inside the override)", async () => {
    // The stamp's decision is made INSIDE the Agent resource's OWNED transaction.
    // The competing commit is injected at the pause point AFTER the resource's
    // first read and BEFORE its confirmation read — a decision made from the
    // request's read snapshot (taken before this override ran) would miss it.
    const id = `race-home-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-race-h-2433", createdAt: new Date().toISOString() }],
    });
    const { result, released } = await withPausedStamp(
      () => runAgentHomeStamp({ opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 15_000, apply: true }),
      () => ops({ operation: "update", table: "Agent", records: [{ id, originatorInstanceId: PEER_ID }] }),
    );
    expect(released, "the stamp never reached its in-transaction pause").toBe("go");
    expect(result.stamped, "the gained home was overwritten").not.toContain(id);
    expect((await rowIn("Agent", id)).originatorInstanceId, "the gained home was overwritten").toBe(PEER_ID);
  }, 60_000);

  test("a raw provenance update committed after the resource's first read is listed, never stamped", async () => {
    const id = `race-sync-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-race-s-2433", createdAt: new Date().toISOString() }],
    });
    const { result, released } = await withPausedStamp(
      () => runAgentHomeStamp({ opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 15_000, apply: true }),
      () => ops({ operation: "update", table: "Agent", records: [{ id, _syncedFrom: PEER_ID, _originatorInstanceId: PEER_ID }] }),
    );
    expect(released, "the stamp never reached its in-transaction pause").toBe("go");
    expect(result.stamped).not.toContain(id);
    const row = await rowIn("Agent", id);
    expect(row.originatorInstanceId ?? null, "the provenance-updated row was stamped").toBeNull();
    expect(row._syncedFrom).toBe(PEER_ID);
  }, 60_000);

  test("another writer's SAME local home is not reported as this command's stamp", async () => {
    // The row ends with THIS instance's id either way, so the value cannot tell
    // the two apart — only the resource's own `stamped` confirmation can. A
    // read-back that merely sees this instance's home would wrongly count it.
    const id = `race-same-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-race-same-2433", createdAt: new Date().toISOString() }],
    });
    const { result, released } = await withPausedStamp(
      () => runAgentHomeStamp({ opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 15_000, apply: true }),
      () => ops({ operation: "update", table: "Agent", records: [{ id, originatorInstanceId: LOCAL_ID }] }),
    );
    expect(released, "the stamp never reached its in-transaction pause").toBe("go");
    expect(result.stamped, "another writer's home was claimed as this stamp").not.toContain(id);
    expect((await rowIn("Agent", id)).originatorInstanceId).toBe(LOCAL_ID);
  }, 60_000);

  test("provenance committed after the staged stamp, before the confirmation read, aborts it (no home written)", async () => {
    // The resource STAGES the write of the home and updatedAt, then re-reads the COMMITTED row
    // and aborts (discarding the staged write) when that row gained provenance.
    // The competing raw provenance update lands in exactly that gap.
    const id = `race-staged-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-race-staged-2433", createdAt: new Date().toISOString() }],
    });
    const { result, released } = await withPausedStamp(
      () => runAgentHomeStamp({ opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 15_000, apply: true }),
      () => ops({ operation: "update", table: "Agent", records: [{ id, _syncedFrom: PEER_ID, _originatorInstanceId: PEER_ID }] }),
    );
    expect(released, "the stamp never reached its in-transaction pause").toBe("go");
    expect(result.stamped, "the staged stamp was committed over the provenance update").not.toContain(id);
    const row = await rowIn("Agent", id);
    expect(row.originatorInstanceId ?? null, "the staged stamp was not discarded").toBeNull();
    expect(row._syncedFrom).toBe(PEER_ID);
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
      opsUrl: harper.opsURL, httpUrl: harper.httpURL, authHeader: basic(), localInstanceId: LOCAL_ID, timeoutMs: 10_000, apply: true,
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

  test("a stored home differing from the resolved local ID at write-back confirmation aborts it", async () => {
    // The row exists, so the create-only insert is skipped and the record is
    // written back to the Agent RESOURCE in an owned transaction. The competing
    // commit lands between the STAGED write-back and the confirmation read: the
    // resource aborts (`originator_instance_immutable`) and discards the staged
    // write, so neither the home nor any other field of that row is changed.
    const id = `pa-race-${sfx}`;
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", status: "active", publicKey: "pk-pa-race-2433", createdAt: new Date().toISOString() }],
    });
    const { result, released } = await withPausedPoint(
      AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT,
      () => runPrincipalAdd(id, String(opsPort())),
      () => ops({ operation: "update", table: "Agent", records: [{ id, originatorInstanceId: PEER_ID }] }),
    );
    expect(released, "the write-back never reached its in-transaction pause").toBe("go");
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("originator_instance_immutable");
    expect(result.stderr).toContain("the stored home differs from the resolved local ID");
    const row = await rowIn("Agent", id);
    expect(row.originatorInstanceId, "the stored home was overwritten").toBe(PEER_ID);
    expect(row.publicKey, "the aborted write-back still changed the row").toBe("pk-pa-race-2433");
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

describe("flair#2473 — the guarded principal write-back cannot change a stored home", () => {
  // The write-back is the ONE write `flair principal add` sends when its
  // create-only insert was SKIPPED. It runs in the Agent resource's owned
  // transaction and writes back only an EXPLICIT ALLOW-LIST of fields (never a
  // home, never a federation stamp, never `publicKey`), and it is honoured only
  // for an administrator or a trusted internal call. Every one of these cases
  // hits the REAL resource. The administrator case fails if the write-back body
  // is written unfiltered; the non-admin case never enters the write-back branch
  // (it covers the ordinary PATCH path's stripping); the last two fail if a
  // missing row is allowed to be re-created.

  test("a verified non-admin agent's write-back flag is stripped — its own stored home is unchanged", async () => {
    const agent = mkAgent(`wb-agent-${sfx}`);
    const now = new Date().toISOString();
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", admin: false, status: "active", publicKey: agent.publicKey, originatorInstanceId: LOCAL_ID, createdAt: now }],
    });
    // A non-admin agent PATCHing its OWN row with the control field, a DIFFERENT
    // home, and a forged publicKey. As an admitted non-admin, it gets
    // the ordinary PATCH path: the flag is dropped and the home and publicKey a
    // body carries are stripped.
    const r = await sendAs(agent, "PATCH", `/Agent/${agent.id}`, {
      [AGENT_PRINCIPAL_WRITE_BACK_FIELD]: true,
      originatorInstanceId: PEER_ID,
      publicKey: "forged-key-wb-2433",
    });
    expect(r.status, r.raw).toBeLessThan(300);
    const row = await rowIn("Agent", agent.id);
    expect(row.originatorInstanceId, "a non-admin caller changed a stored home through the write-back flag").toBe(LOCAL_ID);
    expect(row.publicKey, "the body's publicKey was written by a non-admin").toBe(agent.publicKey);
  }, 30_000);

  test("the write-back never accepts a home or a publicKey from the body, even from an administrator", async () => {
    const id = `wb-admin-${sfx}`;
    const now = new Date().toISOString();
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", admin: false, status: "active", publicKey: "pk-wb-admin-2433", originatorInstanceId: LOCAL_ID, createdAt: now }],
    });
    // An administrator (the caller `flair principal add` is) supplying a different
    // home and a forged publicKey alongside an allow-listed field. The home and the
    // key stand; the display name is written back.
    const r = await send("PATCH", `/Agent/${id}`, {
      [AGENT_PRINCIPAL_WRITE_BACK_FIELD]: true,
      originatorInstanceId: PEER_ID,
      publicKey: "forged-wb-admin",
      displayName: "wb-renamed",
    });
    expect(r.status, r.raw).toBeLessThan(300);
    const row = await rowIn("Agent", id);
    expect(row.originatorInstanceId, "the write-back accepted a home from the body").toBe(LOCAL_ID);
    expect(row.publicKey, "the write-back accepted a publicKey from the body").toBe("pk-wb-admin-2433");
    expect(row.displayName, "an allow-listed field was not written back").toBe("wb-renamed");
  }, 30_000);

  test("a write-back on a missing row is refused by name and does not re-create the row", async () => {
    const id = `wb-missing-${sfx}`;
    const r = await send("PATCH", `/Agent/${id}`, { [AGENT_PRINCIPAL_WRITE_BACK_FIELD]: true, displayName: id });
    expect(r.status, r.raw).toBe(404);
    expect(r.raw, "the refusal was not by its own name").toContain(AGENT_PRINCIPAL_WRITE_BACK_NO_ROW_ERROR);
    expect(r.raw).toContain("could not confirm a stored agent row");
    expect(await rowIn("Agent", id), "the write-back re-created a row that was not there").toBeNull();
  }, 30_000);

  test("a row deleted between the write-back's staging and its confirmation is not re-created", async () => {
    const id = `wb-del-${sfx}`;
    const now = new Date().toISOString();
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id, name: id, role: "agent", admin: false, status: "active", publicKey: "pk-wb-del-2433", originatorInstanceId: LOCAL_ID, createdAt: now }],
    });
    // Delete the row in the gap between the STAGED write-back and the confirmation
    // read. The resource re-reads the COMMITTED row, finds it gone, and aborts —
    // so the staged `table.update` (which would INSERT the row) is discarded.
    const { result, released } = await withPausedPoint(
      AGENT_PRINCIPAL_WRITE_BACK_PAUSE_POINT,
      () => send("PATCH", `/Agent/${id}`, { [AGENT_PRINCIPAL_WRITE_BACK_FIELD]: true, displayName: id }),
      () => ops({ operation: "delete", table: "Agent", ids: [id] }),
    );
    expect(released, "the write-back never reached its in-transaction pause").toBe("go");
    expect(result.status, result.raw).toBe(404);
    expect(result.raw).toContain(AGENT_PRINCIPAL_WRITE_BACK_NO_ROW_ERROR);
    expect(result.raw).toContain("could not confirm a stored agent row");
    expect(await rowIn("Agent", id), "the staged write-back re-created the deleted row").toBeNull();
  }, 60_000);
});
