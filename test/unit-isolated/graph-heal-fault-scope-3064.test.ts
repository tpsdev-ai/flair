// flair#3064 — the graph-heal fault in the test-only probe
// (test/fixtures/org-event-write-fault-3002/probe.js) applies only to rows
// built inside the corrupt `graph-heal` call. The boot migration cycle can
// write graph-heal OrgEvents while that call is in flight; its rows must not
// get the fault.
//
// This loads the real probe file with real AsyncLocalStorage, holds a corrupt
// call open after its own row was faulted, and runs the graph-heal write path
// (fault hook, then the OrgEvent table's put) from outside that call, as a
// background boot heal would. The `harper` module and the probe's migration
// import are replaced; the fault hook module is the real one.
//
// Process-global module mocks, so this file runs in the isolated lane.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeFaultOrgEventRow, setOrgEventWriteFaultHook } from "../../resources/org-event-write-fault.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROBE = join(ROOT, "test", "fixtures", "org-event-write-fault-3002", "probe.js");
const HOOK_MODULE = join(ROOT, "resources", "org-event-write-fault.ts");

// The probe's relative imports, composed next to a copy of it (the real-Harper
// composer places it under dist/resources the same way). `harper` resolves to
// this checkout's package, so the mock below applies to the copy's import too.
const dir = mkdtempSync(join(tmpdir(), "flair-3064-probe-"));
mkdirSync(join(dir, "node_modules"));
symlinkSync(join(ROOT, "node_modules", "harper"), join(dir, "node_modules", "harper"), "dir");
copyFileSync(PROBE, join(dir, "probe.js"));
writeFileSync(join(dir, "org-event-write-fault.js"), `export * from ${JSON.stringify(HOOK_MODULE)};\n`);
mkdirSync(join(dir, "migrations"));
writeFileSync(join(dir, "migrations", "graph-heal.js"), "export {};\n");
const savedRootPath = process.env.ROOTPATH;
process.env.ROOTPATH = join(dir, "root");

afterAll(() => {
  setOrgEventWriteFaultHook(null);
  if (savedRootPath === undefined) delete process.env.ROOTPATH;
  else process.env.ROOTPATH = savedRootPath;
  rmSync(dir, { recursive: true, force: true });
});

type Row = { id: string; refId: string; summary: unknown };

/** The OrgEvent table: the probe wraps its put; stored rows land here. */
const stored: Row[] = [];
const OrgEvent: { put: (row: Row) => Promise<void> } = {
  async put(row: Row) {
    stored.push({ ...row });
  },
};
mock.module("harper", () => ({ Resource: class {}, databases: { flair: { OrgEvent } } }));

/** Set by a test: the next heal holds open after its row was built and faulted. */
let hold: { built: () => void; release: Promise<void> } | null = null;
let seq = 0;

/** One graph-heal write: build the row, run the fault hook, refuse a non-string summary, put. */
async function healOnce(built: Row[]): Promise<{ processed: number; touchedIds: string[] }> {
  const row: Row = { id: `heal-${++seq}`, refId: "graph-heal", summary: "HNSW graph-heal: recall verified healthy" };
  maybeFaultOrgEventRow("graph-heal", row);
  built.push(row);
  const h = hold;
  hold = null;
  if (h) {
    h.built();
    await h.release;
  }
  if (typeof row.summary === "string") await OrgEvent.put(row);
  return { processed: 0, touchedIds: [] };
}

const probeBuilt: Row[] = [];
mock.module(join(dir, "migrations", "graph-heal.js"), () => ({
  createGraphHealMigration: () => ({ run: () => healOnce(probeBuilt) }),
}));

describe("flair#3064 — the graph-heal fault stays in its own call", () => {
  test("a heal outside a held-open corrupt call keeps its row; the call's own row is corrupted", async () => {
    const { OrgEventWriteProbe } = await import(join(dir, "probe.js"));
    const probe = new OrgEventWriteProbe();

    let built!: () => void;
    let release!: () => void;
    const builtSignal = new Promise<void>((resolve) => { built = resolve; });
    hold = { built, release: new Promise<void>((resolve) => { release = resolve; }) };

    let settled = false;
    const call = probe.post({ action: "graph-heal", corrupt: true }).finally(() => { settled = true; });
    await builtSignal;

    // The corrupt call has built and faulted its own row and is still open.
    expect(probeBuilt).toHaveLength(1);
    expect(probeBuilt[0].summary, "the call's own row must be corrupted").toBe(123);

    // A heal outside the call's async context, while it is held open.
    const background: Row[] = [];
    const bgResult = await healOnce(background);
    expect(bgResult).toEqual({ processed: 0, touchedIds: [] });
    await Promise.resolve();
    expect(settled, "the corrupt call must still be open during the background heal").toBe(false);
    expect(background).toHaveLength(1);
    expect(background[0].summary, "the unrelated row must be unchanged")
      .toBe("HNSW graph-heal: recall verified healthy");
    expect(stored.map((row) => row.id), "the unrelated row must be stored").toEqual([background[0].id]);

    release();
    const res = await call;
    expect(res.corrupt).toBe(true);
    expect(res.faulted, "only the call's own row is faulted").toEqual([{ id: probeBuilt[0].id }]);
    expect(res.staged, "the call's own staged rows exclude the background row").toEqual([]);
    expect(stored.map((row) => row.id), "the call's corrupted row is never stored").toEqual([background[0].id]);
    expect(stored[0].summary).toBe("HNSW graph-heal: recall verified healthy");
  });
});
