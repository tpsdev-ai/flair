/**
 * migrations-unconfirmed-throw-2840.test.ts — real Harper: a batch that throws
 * after recording a row as unconfirmed still reports that row (flair#2840).
 *
 * The fault is a TEST-ONLY module installed into a private copy of the built
 * component (the same pattern as migrations-unconfirmed-2840.test.ts). It wraps
 * the Memory table for one id, selected by a marker file in FLAIR_TEST_PAUSE_DIR:
 *
 *   arm.read-throws.<id>  after an update of <id> commits, the second committed
 *                         read (the write's post-commit verification) throws.
 *                         The first committed read is the write-back's
 *                         pre-commit confirmation; it sees the pre-write row for
 *                         real, so it passes as it does on Harper.
 *   arm.retry-throws.<id> the second committed read (the `.content`-suffix
 *                         re-embed's post-commit verification) returns the
 *                         pre-write row, and the retry's fresh read of the row
 *                         then throws. The attempt is unconfirmed, and the
 *                         migration has no batch result to return.
 *
 * Each id's fault is exercised once per attempt; a later cycle replays it.
 * The write-back records the attempt as unconfirmed and rethrows. The migration's
 * batch ends on that throw, so it has no batch result to return; the id must
 * still reach the runner's record (carried on the thrown error), which this test
 * asserts through HealthDetail and the state file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const SYNTHETIC_ID = "synthetic-ci-schema-stamp";
const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const CURRENT_MODEL_ID = getModelId();
const FAULT_MODULE_REL = join("dist", "resources", "zz-test-read-throws-2840.js");
const ROW_THROWS = "unconfirmed-throw-2840";
const EMBEDDING_STAMP_ID = "embedding-stamp";
const ROW_RETRY_THROWS = "unconfirmed-throw-2840-retry.content";

const FAULT_MODULE_SRC = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const memory = databases.flair.Memory;
const realGet = memory.get;
const realUpdate = memory.update;
const seen = new Map();
const dir = () => process.env.FLAIR_TEST_PAUSE_DIR;
const armed = (id) => !!dir() && existsSync(join(dir(), "arm.read-throws." + id));
const retryArmed = (id) => !!dir() && existsSync(join(dir(), "arm.retry-throws." + id));
const note = (kind, id) => writeFileSync(join(dir(), "fired." + kind + "." + id), "");
const isSyntheticWrite = (patch) => !!patch && patch.source === ${JSON.stringify(SYNTHETIC_TARGET_MARKER)};
const isEmbeddingWrite = (patch) => !!patch && Array.isArray(patch.embedding);
memory.update = async function (id, patch, ctx) {
  const capture = typeof id === "string" && (
    (armed(id) && isSyntheticWrite(patch)) ||
    (retryArmed(id) && isEmbeddingWrite(patch))
  );
  const prior = capture ? await realGet.call(this, id, {}) : null;
  const result = await realUpdate.call(this, id, patch, ctx);
  if (capture) seen.set(id, { prior, reads: 0, retry: retryArmed(id), missed: false, thrown: false });
  return result;
};
memory.get = async function (id, ctx, ...rest) {
  const state = typeof id === "string" ? seen.get(id) : undefined;
  const committedRead = ctx && typeof ctx === "object" && Object.keys(ctx).length === 0;
  if (state && committedRead) {
    state.reads += 1;
    if (state.reads === 2) {
      if (state.retry) {
        // The verification read misses this attempt's write; the row is left
        // in the map for the retry's fresh read below.
        state.missed = true;
        note("verify-miss-for-retry", id);
        return state.prior;
      }
      seen.delete(id);
      note("read-throws", id);
      throw new Error("injected post-commit read failure");
    }
  }
  if (state && state.missed && !state.thrown && !committedRead) {
    // The .content-suffix loop's retry reads the row from fresh state.
    state.thrown = true;
    note("retry-throws", id);
    throw new Error("injected retry read failure");
  }
  return realGet.call(this, id, ctx, ...rest);
};
`;

let harper: HarperInstance;
let appDir: string;
let homeDir: string;
let faultDir: string;
let dataDir: string;
let authHeader: string;
let serverEnv: Record<string, string>;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

function migration(detail: any, id: string): any {
  return detail?.migrations?.migrations?.find((m: any) => m.id === id);
}

describe("flair#2840 — a thrown batch keeps its unconfirmed ids (real Harper)", () => {
  beforeAll(async () => {
    faultDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-throw-2840-fault-"));
    appDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-throw-2840-app-"));
    homeDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-throw-2840-home-"));
    for (const name of ["dist", "schemas", "config.yaml", "package.json"]) {
      if (existsSync(resolve(name))) cpSync(resolve(name), join(appDir, name), { recursive: true });
    }
    if (!existsSync(join(appDir, "dist", "resources", "migrations", "runner.js"))) {
      throw new Error("migrations-unconfirmed-throw-2840: dist/ is not built — run `bun run build` first");
    }
    writeFileSync(join(appDir, FAULT_MODULE_REL), FAULT_MODULE_SRC);
    symlinkSync(resolve("node_modules"), join(appDir, "node_modules"), "dir");

    serverEnv = { FLAIR_ENABLE_TEST_MIGRATIONS: "1", FLAIR_TEST_PAUSE_DIR: faultDir, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" };
    const first = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), homeDir, serverEnv });
    dataDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    await opsCall({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [{
        id: ROW_THROWS,
        agentId: RESERVED_TEST_AGENT_ID,
        content: `synthetic row ${ROW_THROWS}`,
        source: "not-yet",
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: CURRENT_MODEL_ID,
        createdAt: new Date().toISOString(),
      }, {
        id: ROW_RETRY_THROWS,
        agentId: "unconfirmed-throw-2840-agent",
        content: "unconfirmed retry row",
        embedding: [0.1, 0.1, 0.1],
        embeddingModel: "ancient-model-v0",
        createdAt: new Date().toISOString(),
      }],
    });
    // Checked for existence, never removed: the id's one write is all this run needs.
    writeFileSync(join(faultDir, `arm.read-throws.${ROW_THROWS}`), "");
    writeFileSync(join(faultDir, `arm.retry-throws.${ROW_RETRY_THROWS}`), "");

    // Boot-keyed: the first boot's cycle saw an empty corpus. Restart so a
    // fresh boot's cycle discovers the seeded row and attempts it.
    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), installDir: first.installDir, homeDir, serverEnv });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper).catch(() => {});
    for (const dir of [appDir, homeDir, faultDir, dataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
    }
  }, HARPER_STOP_BUDGET_MS);

  it("the halted record names the id even though the batch returned no result", async () => {
    const deadline = Date.now() + 120_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      mig = migration(await healthDetail(), SYNTHETIC_ID);
      if (mig?.state === "halted" || mig?.state === "completed" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(mig?.state, JSON.stringify(mig)).toBe("halted");
    expect(String(mig.reason)).toContain("run() threw mid-batch");
    expect(mig.rowsDone).toBe(0);
    expect(mig.rowsUnconfirmed).toBe(1);
    expect(mig.unconfirmedIds).toEqual([ROW_THROWS]);
    expect(existsSync(join(faultDir, `fired.read-throws.${ROW_THROWS}`))).toBe(true);

    const state = JSON.parse(readFileSync(join(dataDir, ".migrations", "state.json"), "utf-8"));
    expect(state[SYNTHETIC_ID].lastOutcome).toBe("halted");
    expect(state[SYNTHETIC_ID].rowsUnconfirmed).toBe(1);
    expect(state[SYNTHETIC_ID].unconfirmedIds).toEqual([ROW_THROWS]);
  }, 150_000);

  it("the `.content`-suffix retry's thrown read still names the unconfirmed id", async () => {
    const deadline = Date.now() + 120_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      mig = migration(await healthDetail(), EMBEDDING_STAMP_ID);
      if (mig?.state === "halted" || mig?.state === "completed" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(mig?.state, JSON.stringify(mig)).toBe("halted");
    expect(String(mig.reason)).toContain("run() threw mid-batch");
    expect(mig.rowsDone).toBe(0);
    expect(mig.rowsUnconfirmed).toBe(1);
    expect(mig.unconfirmedIds).toEqual([ROW_RETRY_THROWS]);
    expect(existsSync(join(faultDir, `fired.verify-miss-for-retry.${ROW_RETRY_THROWS}`))).toBe(true);
    expect(existsSync(join(faultDir, `fired.retry-throws.${ROW_RETRY_THROWS}`))).toBe(true);

    const state = JSON.parse(readFileSync(join(dataDir, ".migrations", "state.json"), "utf-8"));
    expect(state[EMBEDDING_STAMP_ID].lastOutcome).toBe("halted");
    expect(state[EMBEDDING_STAMP_ID].rowsUnconfirmed).toBe(1);
    expect(state[EMBEDDING_STAMP_ID].unconfirmedIds).toEqual([ROW_RETRY_THROWS]);
  }, 150_000);
});
