/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, the decision behind
 * which ops endpoint `flair doctor` reads the Agent roster and home rows from.
 *
 * Doctor probes one instance over HTTP and reads those rows through the ops API.
 * `resolveDoctorRosterTarget` resolves the ops endpoint through the SAME pairing
 * rule `flair agent stamp-home` uses (flair#2474/#2491,
 * `resolveAgentHomeTarget`): the pair the addressed instance's config records
 * binds the ops port to the probed HTTP port. This file pins the three outcomes
 * doctor acts on:
 *   - the probed HTTP port matches the configured pair → the check RUNS, from the
 *     pair's ops port;
 *   - the probed HTTP port does not match the configured pair → NOT RUN, with the
 *     reason and doctor's remedy;
 *   - the config records no complete pair → NOT RUN.
 *
 * The file-reading cases use a NON-default data directory, so neither the
 * developer's nor the runner's `~/.flair` is read. `FLAIR_URL` and
 * `FLAIR_OPS_PORT` are cleared around each of them and restored afterwards.
 * The real two-instance seam is
 * test/integration/doctor-roster-probed-instance-2483.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_ROSTER_TARGET_REMEDY, resolveDoctorRosterTarget } from "../../src/cli.js";

const COMPLETE_PAIR = "http:\n  port: 7926\noperationsApi:\n  network:\n    port: 7925\n";
const HTTP_ONLY = "http:\n  port: 7926\n";

let dataDir: string;
let saved: { FLAIR_URL?: string; FLAIR_OPS_PORT?: string };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flair-2483-doctor-target-"));
  saved = { FLAIR_URL: process.env.FLAIR_URL, FLAIR_OPS_PORT: process.env.FLAIR_OPS_PORT };
  delete process.env.FLAIR_URL;
  delete process.env.FLAIR_OPS_PORT;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resolveDoctorRosterTarget — the probed HTTP port matches the configured pair: the check runs", () => {
  test("a probed HTTP port that matches the pair reads from the pair's ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("nothing named, with a complete pair, reads from the pair's ops port", () => {
    // resolveHttpPort(opts) lands on the configured HTTP port, and the pair
    // supplies the matching ops port.
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir })).toEqual({ kind: "run", opsPort: 7925 });
  });
});

describe("resolveDoctorRosterTarget — a probed HTTP port that does not match the configured pair: NOT RUN", () => {
  test("the mismatch is refused, naming the reason and doctor's remedy, and does not read the other instance", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    const decision = resolveDoctorRosterTarget({ dataDir, port: "8926" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind !== "not-run") return;
    expect(decision.reason).toContain("conflicts with the configured pair");
    // The stamp-home-shaped remedy in the resolver's message is dropped; doctor
    // has no --ops-port flag, so its own remedy is the one shown.
    expect(decision.reason).not.toContain("--ops-port");
    expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });
});

describe("resolveDoctorRosterTarget — a port named with no complete pair to complete it: NOT RUN", () => {
  test("only the HTTP port is configured; a probed HTTP port alone cannot establish the ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), HTTP_ONLY);
    const decision = resolveDoctorRosterTarget({ dataDir, port: "7926" });
    expect(decision.kind).toBe("not-run");
    if (decision.kind !== "not-run") return;
    expect(decision.remedy).toBe(DOCTOR_ROSTER_TARGET_REMEDY);
  });

  test("only the ops port is configured; the probed HTTP port cannot be taken from a pair", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), "operationsApi:\n  network:\n    port: 7925\n");
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" }).kind).toBe("not-run");
  });

  test("the config cannot be read, so no pair is resolved", () => {
    mkdirSync(join(dataDir, "harper-config.yaml"));
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" }).kind).toBe("not-run");
  });
});
