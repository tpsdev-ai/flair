// oauth-single-use-two-workers-2145.test.ts — REAL Harper with TWO worker
// threads (flair#2145).
//
// A redeemed authorization code, and a rotated refresh token, are recorded once
// per Harper instance (resources/OAuth.ts → claimOAuthSingleUse in
// resources/replay-store.ts), so a code or refresh token accepted on one worker
// is refused on the other, and simultaneous presentations of one yield exactly
// one acceptance, on one worker or across both. The injected prewrite store
// error refuses with 503 and leaves no row. A `jti` the store cannot encode as a
// key is another store error, so that grant refuses with 503 too.
//
// HTTP cannot aim a request at a chosen worker (see
// replay-store-two-workers-2061.test.ts), so a private composed copy of the
// built component carries a test-only probe resource
// (test/fixtures/oauth-single-use-probe-2145/probe.js). It runs on every
// worker, mints the values, and calls OAuthToken.post and handleJwtBearerGrant
// — the functions the /OAuthToken grants call — with each step dispatched to a
// chosen worker over Harper's thread mesh.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, OAUTH_SINGLE_USE_PROBE, type ProbeComponent } from "../helpers/component-with-replay-probe";

const WORKERS = 2;
// resources/OAuth.ts: OAUTH_SINGLE_USE_RETENTION_S.
const RETENTION_MS = 691_200 * 1000;
const PROBE_DEADLINE_MS = 300_000;
// A production Flair's HTTP and ops API ports: this test must never target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

let harper: HarperInstance | undefined;
let composed: ProbeComponent | undefined;
let result: any;

async function awaitProbe(inst: HarperInstance): Promise<any> {
  const out = join(inst.installDir, OAUTH_SINGLE_USE_PROBE.out);
  const deadline = Date.now() + PROBE_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (existsSync(join(out, "fatal.json"))) {
      throw new Error(`OAuth single-use probe failed: ${readFileSync(join(out, "fatal.json"), "utf8")}`);
    }
    if (existsSync(join(out, "done.json"))) return JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    if (inst.process && inst.process.exitCode !== null) throw new Error(`Harper exited (${inst.process.exitCode}) before the probe finished`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = (inst.getLog?.() ?? "").split("\n").slice(-60).join("\n");
  throw new Error(`OAuth single-use probe did not finish within ${PROBE_DEADLINE_MS / 1000}s. Harper log tail:\n${tail}`);
}

const CODE_USED = { ok: false, status: 400, error: "invalid_grant", description: "code already used" };
const TOKEN_REVOKED = { ok: false, status: 400, error: "invalid_grant", description: "token revoked" };
const ACCEPTED = { ok: true, status: 200, error: null, description: null };
const UNAVAILABLE = { ok: false, status: 503, error: "temporarily_unavailable", description: "replay_store_unavailable" };

describe(`OAuth single-use records are instance-shared across ${WORKERS} Harper workers (flair#2145)`, () => {
  beforeAll(async () => {
    composed = componentWithReplayProbe({ probe: OAUTH_SINGLE_USE_PROBE });
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
      `oauth-single-use-2145 probe: ${JSON.stringify({
        workerCount: result.workerCount,
        tableInfo: result.tableInfo,
        acceptancesPerRound: {
          oneWorker: Array.isArray(result.raceHere) ? result.raceHere.map((w: any) => `${w.kind}/w${w.worker}: ${JSON.stringify(histogram(w.accepted))}`) : result.raceHere,
          bothWorkers: Array.isArray(result.raceAll) ? result.raceAll.map((w: any) => `${w.kind}: ${JSON.stringify(histogram(w.acceptedPerRound))}`) : result.raceAll,
        },
        longJti: result.longJti,
        failedSteps,
      })}`,
    );
  }, PROBE_DEADLINE_MS + 120_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    composed?.cleanup();
  });

  test("the instance runs two workers, and OAuthSingleUse has the retention expiration and the store's methods", () => {
    expect(result.workerCount).toBe(WORKERS); // assertion: not a vacuous one-worker run
    for (const info of result.tableInfo) {
      expect(info.present).toBe(true);
      expect(info.expirationMS).toBe(RETENTION_MS);
      expect(info.replicate).not.toBe(false); // replication setting unchanged (not opted out)
      expect([info.tryLock, info.unlock, info.getEntry]).toEqual(["function", "function", "function"]);
    }
  });

  test("a code redeemed on one worker is refused on the other, and again on the first", () => {
    expect(result.codeCrossWorker.length).toBe(WORKERS * (WORKERS - 1));
    for (const step of result.codeCrossWorker) {
      expect(step.first).toEqual(ACCEPTED);
      expect(step.other).toEqual(CODE_USED); // assertion: refused on the other worker
      expect(step.again).toEqual(CODE_USED);
      expect(step.entry.present).toBe(true); // assertion: the record row is in the shared table
      expect(step.key.startsWith("c:")).toBe(true);
    }
  });

  test("a refresh token rotated on one worker is refused on the other", () => {
    expect(result.refreshCrossWorker.length).toBe(WORKERS * (WORKERS - 1));
    for (const step of result.refreshCrossWorker) {
      expect(step.first).toEqual(ACCEPTED);
      expect(step.other).toEqual(TOKEN_REVOKED); // assertion: refused on the other worker
      expect(step.again).toEqual(TOKEN_REVOKED);
      expect(step.entry.present).toBe(true);
      expect(step.key.startsWith("r:")).toBe(true);
    }
  });

  test("simultaneous redemptions of one value on ONE worker yield exactly one acceptance", () => {
    expect(result.raceHere.length).toBe(WORKERS * 2); // both kinds, every worker
    for (const w of result.raceHere) {
      expect(w.attemptsPerRound).toBeGreaterThanOrEqual(4);
      const off = w.accepted.map((n: number, r: number) => [r, n]).filter(([, n]: number[]) => n !== 1);
      expect(off).toEqual([]); // assertion: exactly one acceptance per round, on every worker, for both kinds
    }
  });

  test("simultaneous redemptions of one value across both workers yield exactly one acceptance", () => {
    expect(result.raceAll.length).toBe(2); // both kinds
    for (const race of result.raceAll) {
      expect(race.attemptsPerRound).toBeGreaterThanOrEqual(WORKERS * 4);
      expect(race.acceptedPerRound.length).toBe(race.rounds);
      const off = race.acceptedPerRound.map((n: number, r: number) => [r, n]).filter(([, n]: number[]) => n !== 1);
      expect(off).toEqual([]); // assertion: exactly one acceptance per round, for both kinds
    }
  });

  test("an injected prewrite store error refuses with 503, leaves no row, and permits redemption after recovery", () => {
    for (const kind of ["code", "refresh"]) {
      const s = result.storeError[kind];
      expect(s.during).toEqual(UNAVAILABLE); // assertion: fail closed
      expect(s.entryWhileFailing.present).toBe(false); // assertion: nothing was recorded
      expect(s.sameValueAfterRecovery).toEqual(ACCEPTED); // assertion: the failed claim recorded nothing
    }
  });

  test("a jti the store cannot encode as a key refuses the grant with 503", () => {
    const s = result.longJti;
    expect(s.length).toBe(4096); // the length the probe used: the store cannot encode a key this long
    expect(s.normalJtiAccepted).toEqual(ACCEPTED); // assertion: the same path accepts an ordinary jti
    expect(s.accepted).toEqual(UNAVAILABLE); // assertion: fail closed on the store error
    expect(s.entry.present).not.toBe(true); // no row is readable under a key that long (the read itself fails)
  });
});
