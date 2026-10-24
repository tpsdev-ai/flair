/**
 * migrations-unconfirmed-2840.test.ts — real Harper: a write whose post-commit
 * verification read misses the commit is not counted as done, and is named in
 * HealthDetail (flair#2840).
 *
 * The fault is a TEST-ONLY module installed into a private copy of the built
 * component (the auto-promote-incomplete-2714 pattern), not part of the
 * package. It wraps the Memory table for one id at a time, selected by a marker
 * file in FLAIR_TEST_PAUSE_DIR:
 *
 *   arm.verify-miss.<id>      after an update of <id> commits, the second
 *                             committed read (the write's post-commit
 *                             verification) is answered with the pre-write row.
 *                             The first committed read is the write-back's
 *                             pre-commit confirmation; it sees the pre-write
 *                             row for real, so it passes as it does on Harper.
 *   arm.competing-write.<id>  the same miss, and the same instant is used to
 *                             commit another writer's change to <id>: a new
 *                             owner and `shared`. The row is at the migration's
 *                             target, but not because this run verified it.
 *   arm.competing-away.<id>   the same miss, and the same instant is used to
 *                             commit another writer's change to <id>: a new
 *                             owner, `shared`, and the row's source is left
 *                             off the target. The row is no longer this
 *                             migration's work, and it is not at the target.
 *
 * The raw-table paths covered here are the synthetic migration's write-back
 * and embedding-stamp's `.content`-suffix re-embed (the visibility backfill is
 * not exercised). The synthetic path's assertions are made through the
 * runner's progress record as HealthDetail serves it, and through the durable
 * state file; the `.content`-suffix case asserts HealthDetail only.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

const SYNTHETIC_ID = "synthetic-ci-schema-stamp";
const EMBEDDING_STAMP_ID = "embedding-stamp";
const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const CURRENT_MODEL_ID = getModelId();
const FAULT_MODULE_REL = join("dist", "resources", "zz-test-verification-miss-2840.js");

const ROW_CONFIRMED = "unconfirmed-2840-confirmed";
const ROW_MISS = "unconfirmed-2840-miss";
const ROW_COMPETING = "unconfirmed-2840-competing";
const ROW_AWAY = "unconfirmed-2840-away";
const ROW_CONTENT = "unconfirmed-2840-legacy.content";

const FAULT_MODULE_SRC = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const memory = databases.flair.Memory;
const realGet = memory.get;
const realUpdate = memory.update;
const seen = new Map();
const dir = () => process.env.FLAIR_TEST_PAUSE_DIR;
const armed = (kind, id) => !!dir() && existsSync(join(dir(), "arm." + kind + "." + id));
const note = (kind, id) => writeFileSync(join(dir(), "fired." + kind + "." + id), "");
const isSyntheticWrite = (patch) => !!patch && patch.source === ${JSON.stringify(SYNTHETIC_TARGET_MARKER)};
const isEmbeddingWrite = (patch) => !!patch && Array.isArray(patch.embedding);
memory.update = async function (id, patch, ctx) {
  const capture = typeof id === "string" && (
    (armed("verify-miss", id) && (isSyntheticWrite(patch) || isEmbeddingWrite(patch))) ||
    (armed("competing-write", id) && isSyntheticWrite(patch)) ||
    (armed("competing-away", id) && isSyntheticWrite(patch))
  );
  const prior = capture ? await realGet.call(this, id, {}) : null;
  const result = await realUpdate.call(this, id, patch, ctx);
  if (capture) seen.set(id, { prior, reads: 0, competing: armed("competing-write", id), away: armed("competing-away", id) });
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
      if (state.competing && row) {
        // Another writer replaces the row during the verification gap: a new
        // owner, the target value, and a visibility this run never derived.
        await realUpdate.call(this, id, { agentId: "unconfirmed-2840-other-writer", source: ${JSON.stringify(SYNTHETIC_TARGET_MARKER)}, visibility: "shared" });
        note("competing-write", id);
      } else if (state.away && row) {
        // Another writer takes the row over during the gap without bringing it
        // to the target: it leaves the migration's scope, still not done.
        await realUpdate.call(this, id, { agentId: "unconfirmed-2840-other-writer", source: "not-yet", visibility: "shared" });
        note("competing-away", id);
      } else {
        note("verify-miss", id);
      }
      return state.prior;
    }
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

/** A boot from the same install dir and HOME, so the state file is reused. */
async function restartHarper(): Promise<void> {
  await stopHarper(harper, { keepInstallDir: true });
  harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), installDir: harper.installDir, homeDir, serverEnv });
}

/** The synthetic migration's progress row as HealthDetail serves it. */
async function syntheticProgress(): Promise<any> {
  const deadline = Date.now() + 120_000;
  let mig: any = null;
  while (Date.now() < deadline) {
    mig = migration(await healthDetail(), SYNTHETIC_ID);
    if (mig && mig.state !== "idle" && mig.state !== "checking") return mig;
    await new Promise((r) => setTimeout(r, 250));
  }
  return mig;
}

async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

function migration(detail: any, id: string): any {
  return detail?.migrations?.migrations?.find((m: any) => m.id === id);
}

describe("flair#2840 — an unconfirmed write is reported by id, never counted as done (real Harper)", () => {
  beforeAll(async () => {
    faultDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-2840-fault-"));
    appDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-2840-app-"));
    homeDir = mkdtempSync(join(tmpdir(), "flair-unconfirmed-2840-home-"));
    for (const name of ["dist", "schemas", "config.yaml", "package.json"]) {
      if (existsSync(resolve(name))) cpSync(resolve(name), join(appDir, name), { recursive: true });
    }
    if (!existsSync(join(appDir, "dist", "resources", "migrations", "runner.js"))) {
      throw new Error("migrations-unconfirmed-2840: dist/ is not built — run `bun run build` first");
    }
    writeFileSync(join(appDir, FAULT_MODULE_REL), FAULT_MODULE_SRC);
    symlinkSync(resolve("node_modules"), join(appDir, "node_modules"), "dir");

    serverEnv = { FLAIR_ENABLE_TEST_MIGRATIONS: "1", FLAIR_TEST_PAUSE_DIR: faultDir, FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" };
    const first = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), homeDir, serverEnv });
    dataDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    // The synthetic rows carry a current embedding stamp so embedding-stamp
    // leaves them alone; only the `.content` row below is its pending work.
    const createdAt = new Date().toISOString();
    const syntheticRow = (id: string) => ({
      id, agentId: RESERVED_TEST_AGENT_ID, content: `synthetic row ${id}`, source: "not-yet",
      embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL_ID, createdAt,
    });
    await opsCall({
      operation: "insert",
      database: "flair",
      table: "Memory",
      records: [
        syntheticRow(ROW_CONFIRMED),
        syntheticRow(ROW_MISS),
        syntheticRow(ROW_COMPETING),
        syntheticRow(ROW_AWAY),
        {
          id: ROW_CONTENT,
          agentId: "unconfirmed-2840-agent",
          content: "unconfirmed migration row",
          embedding: [0.1, 0.1, 0.1],
          embeddingModel: "ancient-model-v0",
          createdAt,
        },
      ],
    });

    // Arm marker files. The fault module checks each for existence; it does
    // not remove or consume one. The content row's arm stays for all its
    // attempts, so every attempt's verification misses.
    for (const [kind, id] of [["verify-miss", ROW_MISS], ["competing-write", ROW_COMPETING], ["competing-away", ROW_AWAY], ["verify-miss", ROW_CONTENT]] as const) {
      writeFileSync(join(faultDir, `arm.${kind}.${id}`), "");
    }

    // Boot-keyed: the first boot's cycle saw an empty corpus. Restart so a
    // fresh boot's cycle discovers the seeded rows.
    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ cwd: appDir, harperBinDir: process.cwd(), installDir: first.installDir, homeDir, serverEnv });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper).catch(() => {});
    // startHarper removes a tree it created; the second boot reuses the first
    // boot's tree, so remove that one explicitly.
    for (const dir of [appDir, homeDir, faultDir, dataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 4 });
    }
  }, HARPER_STOP_BUDGET_MS);

  it("the raw-table path: rowsDone counts only the confirmed write; the others are named unconfirmed", async () => {
    const deadline = Date.now() + 120_000;
    let detail: any = null;
    let mig: any = null;
    while (Date.now() < deadline) {
      detail = await healthDetail();
      mig = migration(detail, SYNTHETIC_ID);
      if (mig?.state === "completed" || mig?.state === "halted" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // The competing write changed source fields (owner, visibility), so the
    // schema-additive full-envelope gate halts this run; the unconfirmed
    // record is reported on the halted entry all the same.
    expect(mig?.state, JSON.stringify(mig)).toBe("halted");
    expect(String(mig.reason)).toContain("hash envelope mismatch");

    // The three rows the confirmed write did not cover reached the target …
    for (const id of [ROW_CONFIRMED, ROW_MISS, ROW_COMPETING]) {
      expect((await readRow(id)).source).toBe(SYNTHETIC_TARGET_MARKER);
    }
    // … the away row did not: another writer took it over, short of the target.
    expect((await readRow(ROW_AWAY)).source).toBe("not-yet");
    // … the confirmed write alone is counted …
    expect(mig.rowsDone).toBe(1);
    // … and the reported relation accounts for every seeded row.
    expect(mig.rowsDone + mig.rowsUnconfirmed).toBe(4);
    expect(new Set(mig.unconfirmedIds)).toEqual(new Set([ROW_MISS, ROW_COMPETING, ROW_AWAY]));
    expect(mig.rowsRemaining).toBe(0);

    expect(existsSync(join(faultDir, `fired.verify-miss.${ROW_MISS}`))).toBe(true);
    expect(existsSync(join(faultDir, `fired.competing-write.${ROW_COMPETING}`))).toBe(true);
    expect(existsSync(join(faultDir, `fired.competing-away.${ROW_AWAY}`))).toBe(true);

    // The durable record carries the same count and ids.
    const state = JSON.parse(readFileSync(join(dataDir, ".migrations", "state.json"), "utf-8"));
    expect(state[SYNTHETIC_ID].lastOutcome).toBe("halted");
    expect(state[SYNTHETIC_ID].rowsProcessed).toBe(1);
    expect(state[SYNTHETIC_ID].rowsUnconfirmed).toBe(3);
    expect(new Set(state[SYNTHETIC_ID].unconfirmedIds)).toEqual(new Set([ROW_MISS, ROW_COMPETING, ROW_AWAY]));
  }, 150_000);

  it("the content-suffix path: the row is stamped, not counted, and named unconfirmed", async () => {
    const deadline = Date.now() + 120_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      mig = migration(await healthDetail(), EMBEDDING_STAMP_ID);
      if (mig?.state === "completed" || mig?.state === "halted" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(mig?.state, JSON.stringify(mig)).toBe("completed");

    const row = await readRow(ROW_CONTENT);
    expect(row.embeddingModel).toBe(CURRENT_MODEL_ID);
    expect(Array.isArray(row.embedding)).toBe(true);

    expect(mig.rowsDone).toBe(0);
    expect(mig.rowsUnconfirmed).toBe(1);
    expect(mig.unconfirmedIds).toEqual([ROW_CONTENT]);
    expect(existsSync(join(faultDir, `fired.verify-miss.${ROW_CONTENT}`))).toBe(true);
  }, 150_000);

  it("the record survives a no-pending cycle and a restart, and an id clears only at the target", async () => {
    // (a) The boot's follow-up cycle finds nothing pending. The two ids the
    // competing writer brought to the target are cleared; the away row, still
    // short of it, stays recorded with the halted status.
    const statePath = join(dataDir, ".migrations", "state.json");
    const deadline = Date.now() + 90_000;
    let entry: any = null;
    while (Date.now() < deadline) {
      entry = JSON.parse(readFileSync(statePath, "utf-8"))[SYNTHETIC_ID];
      if (entry?.rowsUnconfirmed === 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(entry?.lastOutcome).toBe("halted");
    expect(entry?.rowsUnconfirmed).toBe(1);
    expect(entry?.unconfirmedIds).toEqual([ROW_AWAY]);

    let mig = migration(await healthDetail(), SYNTHETIC_ID);
    expect(mig?.state).toBe("halted");
    expect(mig?.rowsUnconfirmed).toBe(1);
    expect(mig?.unconfirmedIds).toEqual([ROW_AWAY]);

    // (b) A second boot from the same state file seeds the record from it, and
    // the boot cycle re-reads the row, still short of the target.
    await restartHarper();
    mig = await syntheticProgress();
    expect(mig?.state).toBe("halted");
    expect(mig?.rowsUnconfirmed).toBe(1);
    expect(mig?.unconfirmedIds).toEqual([ROW_AWAY]);

    // (c) Bring the row to the target; a cycle that reads it there clears the
    // last recorded id.
    await opsCall({
      operation: "update",
      database: "flair",
      table: "Memory",
      records: [{ id: ROW_AWAY, source: SYNTHETIC_TARGET_MARKER }],
    });
    const clearedDeadline = Date.now() + 90_000;
    let cleared: any = null;
    while (Date.now() < clearedDeadline) {
      cleared = JSON.parse(readFileSync(statePath, "utf-8"))[SYNTHETIC_ID];
      if (cleared?.lastOutcome === "success" && !cleared.rowsUnconfirmed) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(cleared?.lastOutcome, JSON.stringify(cleared)).toBe("success");
    expect(cleared?.rowsUnconfirmed).toBeUndefined();
    expect(cleared?.unconfirmedIds).toBeUndefined();
    expect((await readRow(ROW_AWAY)).source).toBe(SYNTHETIC_TARGET_MARKER);

    const finalMig = await syntheticProgress();
    expect(finalMig?.state).toBe("completed");
    expect(finalMig?.rowsUnconfirmed).toBeUndefined();
  }, 300_000);
});
