// fleet-verify.test.ts — Integration tests for `flair fleet verify`
// (src/fleet-verify.ts, flair#636) against a REAL spawned Harper instance.
//
// Confirms the whole real round trip for the case every Fabric fleet starts
// as: a single origin node with zero federation peers on file. sweepFleet()
// must report the origin row from a REAL /Health + /HealthDetail round trip
// (not a mock), and a wrong --expect-version must be caught as a real skew,
// not just something the unit tests assert about mocked probes.
//
// No two-instance federation-pairing test harness exists yet in this repo
// (test/integration/federation-sync-e2e.test.ts's own header notes it's
// still a "transitional" test against simulated Peer/Memory stores, not a
// real second spawned Harper) — see flair#636's own report for what a
// follow-up two-node harness would need. This file covers the single-origin
// case for real; peer-classification logic (skew/unreachable/unverifiable)
// is covered against mocked probes in test/unit/fleet-verify.test.ts.
//
// HOME isolation: startHarper() sets HOME only in the spawned Harper's OWN
// child-process env (test/helpers/harper-lifecycle.ts) — this test process's
// HOME is never touched, and no real ~/.flair file is ever read here.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { sweepFleet, FLEET_EXIT_OK, FLEET_EXIT_PEER_SKEW } from "../../src/fleet-verify";

let harper: HarperInstance;
let realVersion: string;

describe("sweepFleet against a real spawned Harper — single origin, zero peers (flair#636)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    // Read the SAME package.json resources/health.ts's resolveVersion() will
    // find, instead of hardcoding a version string that drifts on release
    // (same approach as test/integration/probe-instance.test.ts).
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    realVersion = pkg.version;
    expect(typeof realVersion).toBe("string");
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("reports the origin row correctly with the real running version, zero peers, exit OK", async () => {
    const result = await sweepFleet({
      target: harper.httpURL,
      fabricUser: harper.admin.username,
      fabricPassword: harper.admin.password,
      timeoutMs: 15_000,
    });

    expect(result.origin.role).toBe("origin");
    expect(result.origin.method).toBe("direct");
    expect(result.origin.healthy).toBe(true);
    expect(result.origin.authenticated).toBe(true);
    expect(result.origin.version).toBe(realVersion);
    expect(result.origin.status).toBe("ok");
    expect(result.peers).toEqual([]);
    expect(result.peerEnumerationError).toBeNull();
    // No explicit --expect-version was given: the baseline is derived from
    // the origin's own real reported version, not a mock.
    expect(result.expectVersionSource).toBe("origin");
    expect(result.expectVersion).toBe(realVersion);
    expect(result.exitCode).toBe(FLEET_EXIT_OK);
  }, 30_000);

  test("a wrong --expect-version against the real origin yields the skew exit code", async () => {
    const result = await sweepFleet({
      target: harper.httpURL,
      fabricUser: harper.admin.username,
      fabricPassword: harper.admin.password,
      expectVersion: "999.999.999-definitely-not-installed",
      timeoutMs: 15_000,
    });

    expect(result.origin.healthy).toBe(true);
    expect(result.origin.authenticated).toBe(true);
    expect(result.origin.version).toBe(realVersion);
    expect(result.origin.versionMatch).toBe(false);
    expect(result.origin.status).toBe("skew");
    expect(result.expectVersionSource).toBe("explicit");
    // An ORIGIN mismatching an explicit expectation is ORIGIN_FAILED, not
    // PEER_SKEW — ORIGIN_FAILED is asserted in the unit tests' priority-order
    // coverage; ensure the real round trip agrees the origin itself is what's
    // flagged (not silently swallowed as a peer concern with zero peers).
    expect(result.exitCode).not.toBe(FLEET_EXIT_OK);
    expect(result.exitCode).not.toBe(FLEET_EXIT_PEER_SKEW);
  }, 30_000);

  test("wrong Fabric credentials against the real origin are reported as auth-failed, not a false pass", async () => {
    const result = await sweepFleet({
      target: harper.httpURL,
      fabricUser: harper.admin.username,
      fabricPassword: "definitely-the-wrong-password",
      timeoutMs: 15_000,
    });

    expect(result.origin.healthy).toBe(true); // /Health is public, unaffected by bad creds
    expect(result.origin.authenticated).toBe(false);
    expect(result.origin.status).toBe("auth-failed");
    expect(result.exitCode).not.toBe(FLEET_EXIT_OK);
  }, 30_000);
});
