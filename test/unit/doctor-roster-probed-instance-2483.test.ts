/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, the decisions behind
 * which ops endpoint `flair doctor` reads the Agent roster and home rows from.
 *
 * `resolveDoctorRosterTarget` PICKS the candidate ops endpoint with the pairing
 * rule `flair agent stamp-home` uses (flair#2474/#2491, `resolveAgentHomeTarget`):
 * the pair the addressed instance's config records binds the ops port to the
 * probed HTTP port. That rule works from config and named ports and cannot prove
 * which live instance an ops port addresses — it DELIBERATELY trusts two ports
 * the caller names — so doctor VERIFIES the candidate before either read:
 * `decideProbedPairIdentity` (below) decides whether the probed HTTP port and the
 * candidate ops endpoint report the same `flair.Instance` identity.
 *
 * The picking outcomes pinned here:
 *   - the probed HTTP port matches the configured pair → candidate from the
 *     pair's ops port;
 *   - it conflicts with the pair, or exactly one port is named with no complete
 *     pair to take the other from → a refusal (NOT RUN), with doctor's remedy;
 *   - two named ports with no complete pair, or two named ports matching neither
 *     side of the pair, are accepted as given — the identity check refuses those
 *     unless both endpoints report the same instance.
 *
 * The real two-instance seam, including that a refusal on either decision reports
 * BOTH checks NOT RUN and reads nothing, is
 * test/integration/doctor-roster-probed-instance-2483.test.ts.
 *
 * The file-reading cases use a NON-default data directory, so neither the
 * developer's nor the runner's `~/.flair` is read. `FLAIR_URL` and
 * `FLAIR_OPS_PORT` are cleared around each of them and restored afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_ROSTER_TARGET_REMEDY, resolveDoctorRosterTarget } from "../../src/cli.js";
import { decideProbedPairIdentity } from "../../src/lib/agent-home.js";

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

describe("resolveDoctorRosterTarget — the probed HTTP port matches the configured pair: the pair's ops port is the candidate", () => {
  test("a probed HTTP port that matches the pair yields the pair's ops port", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir, port: "7926" })).toEqual({ kind: "run", opsPort: 7925 });
  });

  test("nothing named, with a complete pair, yields the pair's ops port", () => {
    // resolveHttpPort(opts) lands on the configured HTTP port, and the pair
    // supplies the matching ops port.
    writeFileSync(join(dataDir, "harper-config.yaml"), COMPLETE_PAIR);
    expect(resolveDoctorRosterTarget({ dataDir })).toEqual({ kind: "run", opsPort: 7925 });
  });
});

describe("resolveDoctorRosterTarget — a probed HTTP port that conflicts with the configured pair: refused", () => {
  test("the conflict is refused, naming the reason and doctor's remedy, and does not pick the other instance", () => {
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

describe("resolveDoctorRosterTarget — one port named with no complete pair to complete it: refused", () => {
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

describe("decideProbedPairIdentity — the probed HTTP port and the ops endpoint must report the same instance", () => {
  test("two single, equal identities are the same instance", () => {
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "one", id: "inst-a" }))
      .toEqual({ kind: "same", id: "inst-a" });
  });

  test("two single, different identities are different instances", () => {
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "one", id: "inst-b" }))
      .toEqual({ kind: "different", httpId: "inst-a", opsId: "inst-b" });
  });

  test("a side with no single identity is unestablished, naming both sides", () => {
    expect(decideProbedPairIdentity({ kind: "none" }, { kind: "one", id: "inst-b" })).toEqual({
      kind: "unestablished",
      detail: "the probed HTTP port reports no instance identity, the ops endpoint reports one instance identity",
    });
    expect(decideProbedPairIdentity({ kind: "one", id: "inst-a" }, { kind: "multiple", count: 2 }).kind).toBe("unestablished");
    expect(decideProbedPairIdentity({ kind: "unreadable" }, { kind: "unreadable" }).kind).toBe("unestablished");
  });
});
