/**
 * embedding-space-guard-unknown-2530.test.ts — flair#2530 (real Harper).
 *
 * The guard runs INSIDE the spawned Harper worker; its scans read stamps
 * through Harper's Memory table resource and its verdict is unknown until a
 * scan reaches one. This holds the boot pre-warm's FIRST scan at the test-only
 * `space-guard-scan` pause point (resources/txn-pause-point.ts), armed before
 * Harper starts and gated by FLAIR_ENABLE_TEST_FAULT_INJECTION=1 in the
 * environment the spawned Harper inherits.
 *
 * With the scan parked, `_uniform` is still undefined, so the guard's verdict is
 * UNKNOWN. The policy is FAIL CLOSED: a consult must not wait for the scan — it
 * reports the unknown verdict now, and the recall serves keyword-only with the
 * "not yet verified" warning (never the mixed-stamps wording). /Health carries
 * the same state for `flair doctor`. The scan is released by this test.
 *
 * Mutation check (fails on an assertion): make the guard answer "uniform" while
 * its verdict is unknown (the pre-fix behavior — `return _uniform ?? true`) and
 * the recall's `_warning` disappears, so the "not yet verified" assertion goes
 * red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

const POINT = "space-guard-scan";
const AGENT = "guard-unknown-agent";

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function basicAuthOf(h: HarperInstance): string {
  return "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);
}

describe("embedding-space-guard unknown verdict inside a real Harper worker (flair#2530)", () => {
  let harper: HarperInstance | undefined;
  let pauseDir = "";

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2530-pause-"));
    // Armed before Harper starts, so the first scan to reach the boot pause
    // parks there rather than reading.
    writeFileSync(join(pauseDir, `arm.${POINT}`), "");
    harper = await startHarper({ serverEnv: { [TEST_FAULT_INJECTION_ENV]: "1", [TEST_PAUSE_DIR_ENV]: pauseDir } });
    // This test only runs against the Harper it spawned in this process.
    expect(harper.external).toBe(false);
    expect(harper.ownsInstallDir).toBe(true);
  }, 180_000);

  afterAll(async () => {
    if (pauseDir) writeFileSync(join(pauseDir, `go.${POINT}`), ""); // never leave a scan parked
    if (harper) await stopHarper(harper); // removes the install dir it owns
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 30_000);

  test("a recall during the held first scan returns the not-yet-verified warning", async () => {
    const h = harper!;
    expect(
      await waitFor(join(pauseDir, `paused.${POINT}`), 30_000),
      "no scan reached the boot pause (the boot pre-warm should have)",
    ).toBe(true);
    // The parked scan has not resumed yet.
    expect(readFileSync(join(pauseDir, `released.${POINT}`), "utf8")).toBe("");
    try {
      // /Health carries the guard state for `flair doctor`; while the scan is
      // parked it is unverified.
      const health = await fetch(`${h.httpURL}/Health`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { embeddingSpace?: { state?: unknown } };
      expect(healthBody.embeddingSpace?.state).toBe("unverified");

      // A recall consults the guard while the scan is still parked. It must fail
      // closed and name the not-yet-verified state — never the mixed wording.
      const res = await fetch(`${h.httpURL}/SemanticSearch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
        body: JSON.stringify({ agentId: AGENT, q: "any keyword", queryEmbedding: [1, 0, 0, 0] }),
      });
      const text = await res.text();
      expect(res.status, `SemanticSearch returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
      const warning = JSON.parse(text)._warning;
      expect(String(warning)).toContain("embedding space not yet verified");
      expect(String(warning)).not.toContain("non-current embedding model stamp was observed");
    } finally {
      writeFileSync(join(pauseDir, `go.${POINT}`), "");
    }
  }, 120_000);
});
