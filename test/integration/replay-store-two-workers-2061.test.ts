// replay-store-two-workers-2061.test.ts — REAL Harper with TWO worker threads
// (flair#2061, slice S1a of flair#2052).
//
// Agent-auth and federation nonces are recorded once per INSTANCE, so a nonce
// accepted on one worker is refused on every other, and N workers presenting
// the same signed input at one instant yield exactly one acceptance.
//
// Harper routes HTTP to one thread on macOS (no SO_REUSEPORT) and to whichever
// worker the kernel picks on Linux, so HTTP cannot aim a request at a chosen
// worker. The test therefore composes a private copy of the built component
// with a test-only probe resource (test/fixtures/replay-probe-2061/probe.js)
// that runs on every worker and calls the SAME functions the request paths call
// (verifyAgentRequest; verifyFederationRequestBody), with each step dispatched
// to a chosen worker over Harper's thread mesh. The same test run against the
// previous build (per-thread nonce maps) fails its cross-worker and race cases.
//
// THREADS_COUNT is set explicitly, which Harper honours on every platform (its
// darwin default of one worker applies only when no count is given).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, PROBE_OUT_REL, type ProbeComponent } from "../helpers/component-with-replay-probe";

const WORKERS = 2;
const PROBE_DEADLINE_MS = 240_000;

let harper: HarperInstance | undefined;
let composed: ProbeComponent | undefined;
let result: any;

async function awaitProbe(inst: HarperInstance): Promise<any> {
  const out = join(inst.installDir, PROBE_OUT_REL);
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (existsSync(join(out, "fatal.json"))) {
      throw new Error(`replay probe failed: ${readFileSync(join(out, "fatal.json"), "utf8")}`);
    }
    if (existsSync(join(out, "done.json"))) return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    if (inst.process && inst.process.exitCode !== null) throw new Error(`Harper exited (${inst.process.exitCode}) before the probe finished`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = (inst.getLog?.() ?? "").split("\n").slice(-60).join("\n");
  throw new Error(`replay probe did not finish within ${PROBE_DEADLINE_MS / 1000}s. Harper log tail:\n${tail}`);
}

describe(`replay stores are instance-shared across ${WORKERS} Harper workers (flair#2061)`, () => {
  beforeAll(async () => {
    composed = componentWithReplayProbe();
    harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot, threads: WORKERS });
    result = await awaitProbe(harper);
    const histogram = (xs: number[]) => xs.reduce((h: Record<number, number>, n) => ((h[n] = (h[n] ?? 0) + 1), h), {});
    console.log(
      `replay-2061 probe: ${JSON.stringify({
        api: result.api,
        workerCount: result.workerCount,
        race: {
          rounds: result.race.rounds,
          attemptsPerRound: result.race.attemptsPerRound,
          agentAcceptancesPerRound: histogram(result.race.agentAcceptedPerRound),
          federationAcceptancesPerRound: histogram(result.race.federationAcceptedPerRound),
        },
        latency: result.latency,
      })}`,
    );
  }, PROBE_DEADLINE_MS + 120_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    composed?.cleanup();
  });

  test("the instance really runs two workers, and the replay table is local with the production expiration", () => {
    expect(result.workerCount).toBe(WORKERS); // assertion: not a vacuous one-worker run
    expect(result.workers.map((w: any) => w.threadId).every((t: number) => t > 0)).toBe(true);
    for (const info of result.tableInfo) {
      expect(info.present).toBe(true);
      expect(info.replicate).toBe(false); // assertion: never replicated
      expect(info.expirationMS).toBe(120_000);
      expect([info.tryLock, info.unlock, info.getEntry]).toEqual(["function", "function", "function"]); // assertion: the store contract holds on the pinned Harper
      expect(info.bootGaps).toEqual([]);
    }
  });

  test("agent auth: a nonce accepted on one worker is refused on the other", () => {
    expect(result.crossWorker.agent.length).toBe(WORKERS * (WORKERS - 1));
    for (const step of result.crossWorker.agent) {
      // first: accepted on the worker it was first presented to; other: the same
      // signed request on the other worker; again: back on the first worker.
      expect(step).toEqual({ acceptedOn: step.acceptedOn, retriedOn: step.retriedOn, first: true, other: false, again: false }); // assertion: refused on the other worker
    }
  });

  test("federation: a body nonce accepted on one worker is refused on the other", () => {
    expect(result.crossWorker.federation.length).toBe(WORKERS * (WORKERS - 1));
    for (const step of result.crossWorker.federation) {
      expect(step).toEqual({
        acceptedOn: step.acceptedOn,
        retriedOn: step.retriedOn,
        first: { ok: true, reason: null },
        other: { ok: false, reason: "replay" },
      }); // assertion: refused on the other worker
    }
  });

  test("N simultaneous presentations of one signed input across workers yield exactly one acceptance", () => {
    const { rounds, attemptsPerRound, agentAcceptedPerRound, federationAcceptedPerRound } = result.race;
    expect(attemptsPerRound).toBeGreaterThanOrEqual(WORKERS * 2);
    const offRounds = (xs: number[]) => xs.map((n, r) => [r, n]).filter(([, n]) => n !== 1);
    expect(agentAcceptedPerRound.length).toBe(rounds);
    expect(offRounds(agentAcceptedPerRound)).toEqual([]); // assertion: exactly one agent-auth acceptance per round
    expect(offRounds(federationAcceptedPerRound)).toEqual([]); // assertion: exactly one federation acceptance per round
  });

  test("a signature failure does not record the nonce", () => {
    expect(result.sigFail.badAccepted).toBe(false);
    expect(result.sigFail.entryAfterBad).toEqual({ present: false }); // assertion: nothing recorded for the refused request
    expect(result.sigFail.goodAcceptedOnOther).toBe(true); // assertion: the nonce was not burned
    expect(result.sigFail.goodRetriedOnFirst).toBe(false);
  });

  test("a store error refuses the request, and records nothing", () => {
    expect(result.storeError.skipped).toBeNull();
    expect(result.storeError.acceptedWhileFailing).toBe(false); // assertion: fail closed
    expect(result.storeError.entryWhileFailing).toEqual({ present: false });
    expect(result.storeError.sameNonceAfterRecovery).toBe(true);
  });

  test("an in-window entry survives Harper's expiration scan", () => {
    const e = result.eviction;
    expect(e.accepted).toBe(true);
    expect(e.controlBefore).toEqual({ present: true });
    expect(e.controlAfterScans).toEqual({ present: false }); // assertion: the scan ran and evicted an expired row
    expect(e.entryAfterScans).toEqual({ present: true }); // assertion: the in-window entry was kept
    expect(e.replayOnLastWorker).toBe(false); // assertion: and still refuses the replay on the worker that scans
  });
});
