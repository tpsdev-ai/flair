// xaa-jti-two-workers-2073.test.ts — REAL Harper with TWO worker threads
// (flair#2073, part of flair#2052's S1b).
//
// The probe's assertions carry UUID `jti` values. Each is recorded once per
// Harper instance (resources/XAA.ts → claimIdJagJti in
// resources/replay-store.ts), so an assertion accepted on one worker is refused
// on the other, and simultaneous presentations of one assertion yield exactly
// one acceptance, on one worker or across both.
//
// HTTP cannot aim a request at a chosen worker (see
// replay-store-two-workers-2061.test.ts), so a private composed copy of the
// built component carries a test-only probe resource
// (test/fixtures/xaa-jti-probe-2073/probe.js). It runs on every worker, serves
// a test IdP's JWKS on an ephemeral loopback port, and calls
// handleJwtBearerGrant, the function the /OAuthToken jwt-bearer grant calls,
// with each step dispatched to a chosen worker over Harper's thread mesh.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, XAA_JTI_PROBE, type ProbeComponent } from "../helpers/component-with-replay-probe";

const WORKERS = 2;
// resources/XAA.ts: CLOCK_SKEW_MS and ID_JAG_REPLAY_RETENTION_S (the unit lane
// pins the latter to the schema's `expiration:`).
const CLOCK_SKEW_MS = 30_000;
const RETENTION_MS = 90_000 * 1000;
const PROBE_DEADLINE_MS = 240_000;
// A production Flair's HTTP and ops API ports: this test must never target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

let harper: HarperInstance | undefined;
let composed: ProbeComponent | undefined;
let result: any;

async function awaitProbe(inst: HarperInstance): Promise<any> {
  const out = join(inst.installDir, XAA_JTI_PROBE.out);
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (existsSync(join(out, "fatal.json"))) {
      throw new Error(`XAA jti probe failed: ${readFileSync(join(out, "fatal.json"), "utf8")}`);
    }
    if (existsSync(join(out, "done.json"))) return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    if (inst.process && inst.process.exitCode !== null) throw new Error(`Harper exited (${inst.process.exitCode}) before the probe finished`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = (inst.getLog?.() ?? "").split("\n").slice(-60).join("\n");
  throw new Error(`XAA jti probe did not finish within ${PROBE_DEADLINE_MS / 1000}s. Harper log tail:\n${tail}`);
}

const REPLAY = { ok: false, status: 400, error: "invalid_grant", description: "token replay detected" };

describe(`XAA ID-JAG jti records are instance-shared across ${WORKERS} Harper workers (flair#2073)`, () => {
  beforeAll(async () => {
    composed = componentWithReplayProbe({ probe: XAA_JTI_PROBE });
    harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot, threads: WORKERS });
    // The instance is our own spawn on ephemeral ports, never a served origin.
    expect(harper.external).toBe(false);
    for (const u of [harper.httpURL, harper.opsURL]) {
      expect(new URL(u).hostname).toBe("127.0.0.1");
      expect(FORBIDDEN_PORTS.has(Number(new URL(u).port))).toBe(false);
    }
    result = await awaitProbe(harper);
    const histogram = (xs: unknown) =>
      Array.isArray(xs) ? xs.reduce((h: Record<number, number>, n: number) => ((h[n] = (h[n] ?? 0) + 1), h), {}) : xs;
    const failedSteps = Object.entries(result).filter(([, v]: [string, any]) => v && typeof v === "object" && "error" in v);
    console.log(
      `xaa-jti-2073 probe: ${JSON.stringify({
        workerCount: result.workerCount,
        tableInfo: result.tableInfo,
        acceptancesPerRound: {
          oneWorker: Array.isArray(result.raceHere) ? result.raceHere.map((w: any) => histogram(w.accepted)) : result.raceHere,
          bothWorkers: histogram(result.raceAll?.acceptedPerRound),
        },
        failedSteps,
      })}`,
    );
  }, PROBE_DEADLINE_MS + 120_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    composed?.cleanup();
  });

  test("the instance runs two workers, the test IdP is ours, and IdJagReplay has the retention expiration", () => {
    expect(result.workerCount).toBe(WORKERS); // assertion: not a vacuous one-worker run
    expect(result.idp.jwksPort).toBeGreaterThan(0);
    expect(FORBIDDEN_PORTS.has(result.idp.jwksPort)).toBe(false);
    expect(FORBIDDEN_PORTS.has(Number(new URL(result.idp.audience).port))).toBe(false);
    for (const info of result.tableInfo) {
      expect(info.present).toBe(true);
      expect(info.expirationMS).toBe(RETENTION_MS);
      expect(info.replicate).not.toBe(false); // replication setting unchanged (not opted out)
      expect([info.tryLock, info.unlock, info.getEntry]).toEqual(["function", "function", "function"]);
    }
  });

  test("an assertion accepted on one worker is refused on the other", () => {
    expect(result.crossWorker.length).toBe(WORKERS * (WORKERS - 1));
    for (const step of result.crossWorker) {
      expect(step.first).toEqual({ ok: true, status: 200, error: null, description: null });
      expect(step.other).toEqual(REPLAY); // assertion: refused on the other worker
      expect(step.again).toEqual(REPLAY);
    }
  });

  test("simultaneous presentations of one assertion on ONE worker yield exactly one acceptance", () => {
    expect(result.raceHere.length).toBe(WORKERS);
    for (const w of result.raceHere) {
      expect(w.attemptsPerRound).toBeGreaterThanOrEqual(4);
      const off = w.accepted.map((n: number, r: number) => [r, n]).filter(([, n]: number[]) => n !== 1);
      expect(off).toEqual([]); // assertion: exactly one acceptance per round, on every worker
    }
  });

  test("simultaneous presentations of one assertion across both workers yield exactly one acceptance", () => {
    const { rounds, attemptsPerRound, acceptedPerRound } = result.raceAll;
    expect(attemptsPerRound).toBeGreaterThanOrEqual(WORKERS * 4);
    expect(acceptedPerRound.length).toBe(rounds);
    const off = acceptedPerRound.map((n: number, r: number) => [r, n]).filter(([, n]: number[]) => n !== 1);
    expect(off).toEqual([]); // assertion: exactly one acceptance per round
  });

  test("a store error refuses the grant with 503 and records nothing", () => {
    const s = result.storeError;
    expect(s.during).toEqual({ ok: false, status: 503, error: "temporarily_unavailable", description: "replay_store_unavailable" }); // assertion: fail closed
    expect(s.entryWhileFailing.present).toBe(false);
    expect(s.sameAssertionAfterRecovery.ok).toBe(true); // nothing was recorded by the failed claim
  });

  test("the record outlives the assertion's validity and survives Harper's expiration scan", () => {
    const r = result.retention;
    expect(r.accepted.ok).toBe(true); // an assertion that expires 24 h ahead
    expect(r.controlBefore.present).toBe(true);
    expect(r.controlAfterScans.present).toBe(false); // assertion: the scan ran and evicted an expired row
    expect(r.entryAfterScans.present).toBe(true); // assertion: the record was kept
    // jose accepts the assertion only before exp + CLOCK_SKEW_MS + 1 s (it
    // compares exp with the current whole second); Harper removes the row no
    // earlier than its expiresAt.
    expect(r.entryAfterScans.expiresAt).toBeGreaterThan(r.exp * 1000 + CLOCK_SKEW_MS + 1000); // assertion: the record outlives the validity
    expect(r.replayOnLastWorker).toEqual(REPLAY);
  });
});
