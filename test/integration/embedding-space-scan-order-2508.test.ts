/**
 * embedding-space-scan-order-2508.test.ts — flair#2508 (real Harper).
 *
 * The guard runs INSIDE the spawned Harper worker, and its scans read the
 * stamps through Harper's Memory table resource (`databases.flair.Memory`,
 * queried with `search({ select: ["embeddingModel"] })` in
 * resources/embedding-space-guard.ts scan()). Nothing in this file replaces
 * that read or the guard's module state.
 *
 * The overlap is the in-tree pairing: the boot pre-warm (a one-shot
 * `recomputeLatch()`, which calls `scan()` directly) against a consult scan
 * (`isEmbeddingSpaceUniform()`, here from a recall).
 *
 *   1. The `scan-verdict` pause point (resources/txn-pause-point.ts) is armed
 *      before Harper starts, and its test-only opt-in is set in the
 *      environment the spawned Harper inherits. No fixture SQL, insert or
 *      recall request is sent until a scan has parked there (startHarper
 *      itself polls /health during startup).
 *   2. The store is confirmed empty, then a current-space row and a
 *      foreign-space row are inserted through the administrator operations API.
 *   3. A recall consults the guard while that scan is still parked. No consult
 *      scan started before the barrier (startHarper's /health polls read only
 *      the guard's snapshot), so the parked scan is the boot pre-warm, the only
 *      other in-tree scan starter. The consult does not wait
 *      for a scan (flair#2530 fails closed): the first recall reports the
 *      not-yet-verified state and starts a consult scan, which started later.
 *      That scan publishes "not uniform"; a later recall, still sent while the
 *      pre-warm is parked, reports it, and its `_warning` names exactly the
 *      current and the foreign stamp. The current stamp can reach that list
 *      only through a scan's read (the write-maintained latch records foreign
 *      stamps only), so the verdict comes from the resource read.
 *   4. The pre-warm is released by this test. Its older verdict does not
 *      replace the newer one, a later recall still names both stamps, and the
 *      refusal is named in Harper's log.
 *
 * The own-instance check (test/helpers/own-harper-instance.ts) runs before
 * every Memory row insert. A separate case runs it in a subprocess against the
 * instance the REAL `startHarper` external branch returns.
 *
 * Mutation checks (each fails on an assertion): drop the scan-order check in
 * scan() and the pre-warm overwrites the newer verdict, so the final recall
 * has no `_warning`; change the scan's `select` field and the consult reads no
 * stamps, so the recall during the pause has no `_warning`; let
 * `assertOwnInstance` accept an external instance and the external-mode case
 * fails on its refusal message.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { assertOwnInstance, basicAuthOf, insertMemoryRows } from "../helpers/own-harper-instance";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";
import { getModelId } from "../../resources/embeddings-provider.ts";

const POINT = "scan-verdict";
const AGENT = "scan-order-agent";
// The worker's current space: the spawned Harper inherits this process's
// environment, so its getModelId() is this one.
const CURRENT = getModelId();
const FOREIGN = "other-engine:not-the-current-space";
const EXTERNAL_FIXTURE = join(import.meta.dir, "..", "fixtures", "external-harper-insert-2508.ts");

function memoryRow(id: string, embeddingModel: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return { id, agentId: AGENT, content: `${id} row`, visibility: "shared", embeddingModel, createdAt: now, updatedAt: now };
}

/** The ids of every Memory row, read through the operations API. */
async function memoryRowIds(h: HarperInstance): Promise<string[]> {
  assertOwnInstance(h);
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify({ operation: "sql", sql: "SELECT id FROM flair.Memory" }),
  });
  const text = await res.text();
  expect(res.status, `sql returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`sql returned a non-array body: ${text.slice(0, 200)}`);
  return rows.map((r: { id: string }) => r.id).sort();
}

/** The guard's mixed-space report from a recall that consults it, or undefined
 *  when the guard reports the store uniform. A caller-supplied
 *  `queryEmbedding` forces the semantic leg without an embedding model. */
async function recallWarning(h: HarperInstance): Promise<string | undefined> {
  const res = await fetch(`${h.httpURL}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify({ agentId: AGENT, q: "any keyword", queryEmbedding: [1, 0, 0, 0] }),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text)._warning;
}

/** Recall until the guard reports a mixed store (the consult scan published),
 *  or the deadline passes; returns the last `_warning`. */
async function recallUntilMixed(h: HarperInstance, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let warning = await recallWarning(h);
  while (!String(warning).includes("mixed embedding spaces") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    warning = await recallWarning(h);
  }
  return warning;
}

/** The stamps a mixed-space `_warning` names: `current` and the sorted `found` list. */
function namedStamps(warning: string | undefined): { current: string; found: string[] } | undefined {
  const m = /\(current: ([^;]*); found: ([^)]*)\)/.exec(String(warning ?? ""));
  return m ? { current: m[1], found: m[2].split(", ").filter(Boolean).sort() } : undefined;
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** The release marker's text once written ("go" or "timeout"); null on timeout. */
async function releaseText(path: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(path, "utf8");
      if (text) return text;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function logShows(h: HarperInstance, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((h.getLog?.() ?? "").includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("the own-instance check against the real external-mode helper (flair#2508)", () => {
  test("the instance startHarper returns in external mode is refused before any Memory row insert request", async () => {
    // A local server stands in for an external Harper. It answers only
    // GET /health and records every request it receives.
    const requests: { method: string; path: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push({ method: req.method, path });
        return req.method === "GET" && path === "/health" ? new Response("ok") : new Response("not found", { status: 404 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // HARPER_HTTP_URL is read when harper-lifecycle.ts loads, so the REAL
      // external branch runs in a subprocess. The operations URL points at the
      // same server, so an insert request would be recorded too.
      const child = Bun.spawn([process.execPath, EXTERNAL_FIXTURE], {
        env: { ...process.env, HARPER_HTTP_URL: base, HARPER_OPS_URL: `${base}/operations` },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `fixture exited ${code}: ${stderr.slice(-500)}`).toBe(0);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      expect(line, `no RESULT line in the fixture output: ${stdout.slice(-500)}`).toBeDefined();
      const result = JSON.parse(line!.slice("RESULT ".length));
      // The helper's external branch ran: an external instance, no spawned process.
      expect(result.external).toBe(true);
      expect(result.process).toBeNull();
      // Its own health probe is a read, counted apart from everything else.
      const healthReads = requests.filter((r) => r.method === "GET" && r.path === "/health");
      const otherRequests = requests.filter((r) => !(r.method === "GET" && r.path === "/health"));
      expect(healthReads.length).toBeGreaterThan(0);
      // No insert, and no other request, reached the server.
      expect(otherRequests).toEqual([]);
      expect(result.refusal).toMatch(/refusing an external Harper/);
    } finally {
      server.stop(true);
    }
  }, 90_000);
});

describe("embedding-space-guard scan ordering inside a real Harper worker (flair#2508)", () => {
  let harper: HarperInstance | undefined;
  let pauseDir = "";

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2508-pause-"));
    // Armed before Harper starts, so the first scan to reach the verdict pause
    // parks there; step 3 of the case shows it is the boot pre-warm.
    writeFileSync(join(pauseDir, `arm.${POINT}`), "");
    const saved = { [TEST_FAULT_INJECTION_ENV]: process.env[TEST_FAULT_INJECTION_ENV], [TEST_PAUSE_DIR_ENV]: process.env[TEST_PAUSE_DIR_ENV] };
    process.env[TEST_FAULT_INJECTION_ENV] = "1";
    process.env[TEST_PAUSE_DIR_ENV] = pauseDir;
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
  }, 180_000);

  afterAll(async () => {
    if (pauseDir) writeFileSync(join(pauseDir, `go.${POINT}`), ""); // never leave a scan parked
    if (harper) await stopHarper(harper); // removes the install dir it owns
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 30_000);

  test("a boot pre-warm that finishes after a consult scan refuses its verdict; the verdict comes from the resource read", async () => {
    const h = harper!;
    const released = join(pauseDir, `released.${POINT}`);
    // 1. Barrier: a scan has read the corpus and parked.
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "no scan reached the verdict pause (the boot pre-warm should have)").toBe(true);
    expect(readFileSync(released, "utf8"), "the parked scan's pause ended before the test reached it").toBe("");

    let during: string | undefined;
    try {
      // 2. The store holds no row yet; it becomes mixed: a current-space row,
      //    then a foreign-space row.
      expect(await memoryRowIds(h)).toEqual([]);
      await insertMemoryRows(h, [memoryRow("m-current-1", CURRENT)]);
      await insertMemoryRows(h, [memoryRow("m-foreign-1", FOREIGN)]);

      // 3. The first recall fails closed without waiting and starts the consult
      //    scan; that scan reads both stamps and publishes first, and a later
      //    recall reports it while the parked scan is still parked.
      const first = await recallWarning(h);
      expect(String(first), "the first consult did not fail closed").toContain("embedding space not yet verified");
      during = await recallUntilMixed(h, 15_000);
      expect(readFileSync(released, "utf8"), "the parked scan resumed before the consult scan published").toBe("");
    } finally {
      writeFileSync(join(pauseDir, `go.${POINT}`), "");
    }
    expect(String(during), "the consult scan did not report the mixed store").toContain("mixed embedding spaces");
    expect(namedStamps(during)).toEqual({ current: CURRENT, found: [CURRENT, FOREIGN].sort() });

    // 4. The pre-warm resumes, released by this test rather than its time limit.
    //    Its older verdict does not replace the newer one, and its refusal is named.
    expect(await releaseText(released, 30_000), "the pre-warm's pause ended by its time limit").toBe("go");
    const after = await recallWarning(h);
    expect(String(after), "the older verdict overwrote the newer one").toContain("mixed embedding spaces");
    expect(namedStamps(after)).toEqual({ current: CURRENT, found: [CURRENT, FOREIGN].sort() });
    expect(await logShows(h, "stale scan verdict refused", 15_000), "no refusal in the Harper log").toBe(true);
  }, 120_000);
});
