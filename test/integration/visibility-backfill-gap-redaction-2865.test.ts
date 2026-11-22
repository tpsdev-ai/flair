/**
 * visibility-backfill-gap-redaction-2865.test.ts — real Harper: the
 * visibility backfill's actual write path (`run()` -> `writeBackCommittedRow`)
 * reports a row whose post-commit verification read missed the commit as
 * unconfirmed (flair#2865, following #2846/#2840), and /HealthDetail redacts
 * that id from a verified non-admin caller.
 *
 * The gap is forced with the same TEST-ONLY fault module the synthetic and
 * embedding-stamp paths use: a private copy of the built component gets a
 * module that wraps the Memory table's get/update, and each marker file in
 * FLAIR_TEST_PAUSE_DIR arms one id (test/integration/migrations-unconfirmed-
 * 2840.test.ts's FAULT_MODULE_SRC and its arm.verify-miss.<id>). The first
 * committed read is the write-back's pre-commit confirmation; it sees the
 * pre-write row for real and passes. The second committed read is the
 * post-commit verification; this module answers it with the pre-write row, so
 * the attempt is unconfirmed. The plan is idempotent, so the helper retries,
 * finds `visibility` already present, and skips; run() then reports the id,
 * as the synthetic path's and the `.content`-suffix path's assertions in that
 * file do.
 *
 * The visibility write is matched by the `visibility` field the plan stages
 * (write-back.ts's applyFieldUpdate -> table.update), scoped to the armed id.
 *
 * No FLAIR_ENABLE_TEST_MIGRATIONS here: the synthetic CI migration is not
 * registered, so this file exercises the production registry.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const VISIBILITY_BACKFILL_ID = "visibility-backfill";
const ROW_ID = "backfill-gap-2865";
const CURRENT_MODEL_ID = getModelId();
const FAULT_MODULE_REL = join("dist", "resources", "zz-test-visibility-gap-2865.js");

const FAULT_MODULE_SRC = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const memory = databases.flair.Memory;
const realGet = memory.get;
const realUpdate = memory.update;
const seen = new Map();
const dir = () => process.env.FLAIR_TEST_PAUSE_DIR;
const armed = (id) => !!dir() && existsSync(join(dir(), "arm.verify-miss." + id));
const note = (kind, id) => writeFileSync(join(dir(), "fired." + kind + "." + id), "");
const isVisibilityWrite = (patch) => !!patch && Object.prototype.hasOwnProperty.call(patch, "visibility");
memory.update = async function (id, patch, ctx) {
  const capture = typeof id === "string" && armed(id) && isVisibilityWrite(patch);
  const prior = capture ? await realGet.call(this, id, {}) : null;
  const result = await realUpdate.call(this, id, patch, ctx);
  if (capture) seen.set(id, { prior, reads: 0 });
  return result;
};
memory.get = async function (id, ctx, ...rest) {
  const state = typeof id === "string" ? seen.get(id) : undefined;
  const committedRead = ctx && typeof ctx === "object" && Object.keys(ctx).length === 0;
  if (state && committedRead) {
    state.reads += 1;
    if (state.reads === 2) {
      const row = await realGet.call(this, id, ctx, ...rest);
      seen.delete(id);
      note("verify-miss", id);
      return state.prior ?? row;
    }
  }
  return realGet.call(this, id, ctx, ...rest);
};
`;

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

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

let harper: HarperInstance;
let appDir: string;
let homeDir: string;
let faultDir: string;
let dataDir: string;
let authHeader: string;
let serverEnv: Record<string, string>;
const nonAdmin = mkAgent("gap-2865-nonadmin");
const admin = mkAgent("gap-2865-admin");

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function readRow(id: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

function migration(detail: any, id: string): any {
  return detail?.migrations?.migrations?.find((m: any) => m.id === id);
}

async function adminHealthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) throw new Error(`admin /HealthDetail failed: HTTP ${res.status}`);
  return res.json();
}

/** The boot cycle that saw an empty corpus has finished. */
async function waitForEmptyBootCycle(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const detail = await adminHealthDetail();
    if (detail?.migrations?.cyclePhase === "done") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the first boot's migration cycle did not reach done");
}

async function waitForUnconfirmed(): Promise<any> {
  const deadline = Date.now() + 120_000;
  let mig: any = null;
  while (Date.now() < deadline) {
    mig = migration(await adminHealthDetail(), VISIBILITY_BACKFILL_ID);
    if (mig?.state === "completed" || mig?.state === "halted" || mig?.state === "failed") return mig;
    await new Promise((r) => setTimeout(r, 250));
  }
  return mig;
}

describe("flair#2865 — visibility backfill's verification gap and non-admin HealthDetail redaction (real Harper)", () => {
  beforeAll(async () => {
    faultDir = mkdtempSync(join(tmpdir(), "flair-visibility-2865-fault-"));
    appDir = mkdtempSync(join(tmpdir(), "flair-visibility-2865-app-"));
    homeDir = mkdtempSync(join(tmpdir(), "flair-visibility-2865-home-"));
    for (const name of ["dist", "schemas", "config.yaml", "package.json"]) {
      if (existsSync(resolve(name))) cpSync(resolve(name), join(appDir, name), { recursive: true });
    }
    if (!existsSync(join(appDir, "dist", "resources", "migrations", "runner.js"))) {
      throw new Error("visibility-backfill-gap-redaction-2865: dist/ is not built — run `bun run build` first");
    }
    writeFileSync(join(appDir, FAULT_MODULE_REL), FAULT_MODULE_SRC);
    symlinkSync(resolve("node_modules"), join(appDir, "node_modules"), "dir");

    serverEnv = { FLAIR_TEST_PAUSE_DIR: faultDir, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" };
    const first = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), homeDir, serverEnv });
    dataDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    // Seed only after the empty-corpus boot cycle has finished, so the row is
    // discovered by the SECOND boot's cycle and not by a cycle already in
    // flight.
    await waitForEmptyBootCycle();

    const createdAt = new Date().toISOString();
    for (const agent of [nonAdmin, admin]) {
      const res = await opsCall({
        operation: "insert",
        database: "flair",
        table: "Agent",
        records: [{
          id: agent.id,
          name: agent.id,
          role: agent === admin ? "admin" : "agent",
          publicKey: agent.publicKey,
          createdAt,
        }],
      });
      if (!Array.isArray(res) && res?.inserted !== undefined && res.inserted === 0) {
        throw new Error(`Agent insert failed for ${agent.id}`);
      }
    }

    await opsCall({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [{
        id: ROW_ID,
        agentId: "gap-2865-agent",
        content: "row the visibility backfill must stamp",
        durability: "permanent",
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: CURRENT_MODEL_ID,
        createdAt,
      }],
    });

    writeFileSync(join(faultDir, `arm.verify-miss.${ROW_ID}`), "");

    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), installDir: first.installDir, homeDir, serverEnv });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper).catch(() => {});
    for (const dir of [appDir, homeDir, faultDir, dataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
    }
  }, HARPER_STOP_BUDGET_MS);

  it("the row is stamped, not counted as done, and named unconfirmed", async () => {
    const mig = await waitForUnconfirmed();
    expect(mig?.state, JSON.stringify(mig)).toBe("completed");
    expect(mig.rowsDone).toBe(0);
    expect(mig.rowsUnconfirmed).toBe(1);
    expect(mig.unconfirmedIds).toEqual([ROW_ID]);
    expect(existsSync(join(faultDir, `fired.verify-miss.${ROW_ID}`))).toBe(true);

    const row = await readRow(ROW_ID);
    expect(row.visibility).toBe("shared");

    const state = JSON.parse(readFileSync(join(dataDir, ".migrations", "state.json"), "utf-8"));
    expect(state[VISIBILITY_BACKFILL_ID].lastOutcome).toBe("success");
    expect(state[VISIBILITY_BACKFILL_ID].rowsProcessed).toBe(0);
    expect(state[VISIBILITY_BACKFILL_ID].rowsUnconfirmed).toBe(1);
    expect(state[VISIBILITY_BACKFILL_ID].unconfirmedIds).toEqual([ROW_ID]);
  }, 180_000);

  it("a verified non-admin /HealthDetail omits the unconfirmed id; an admin sees it", async () => {
    const mig = await waitForUnconfirmed();
    expect(mig?.unconfirmedIds).toEqual([ROW_ID]);
    const nonAdminRes = await fetch(`${harper.httpURL}/HealthDetail`, {
      headers: { Authorization: ed25519Header(nonAdmin, "GET", "/HealthDetail") },
    });
    const nonAdminText = await nonAdminRes.text();
    expect(nonAdminRes.status, `non-admin GET /HealthDetail returned ${nonAdminRes.status}: ${nonAdminText.slice(0, 300)}`).toBe(200);
    const nonAdminBody = JSON.parse(nonAdminText);
    expect(nonAdminBody.caller.isAdmin).toBe(false);
    expect(nonAdminText).not.toContain(ROW_ID);
    const nonAdminMig = migration(nonAdminBody, VISIBILITY_BACKFILL_ID);
    expect(nonAdminMig.rowsUnconfirmed).toBe(1);
    expect(nonAdminMig.unconfirmedIds).toBeUndefined();

    const adminBody = await adminHealthDetail();
    expect(adminBody.caller.isAdmin).toBe(true);
    const adminMig = migration(adminBody, VISIBILITY_BACKFILL_ID);
    expect(adminMig.rowsUnconfirmed).toBe(1);
    expect(adminMig.unconfirmedIds).toEqual([ROW_ID]);
    expect(JSON.stringify(adminBody)).toContain(ROW_ID);
  }, 60_000);
});
