/**
 * doctor-roster-probed-ops-port-2562.test.ts — the fallback ops candidate
 * `flair doctor` derives when neither port is named and the probed instance's
 * configuration records no complete HTTP/ops pair (flair#2562).
 *
 * `resolveDoctorRosterTarget` passes the HTTP port doctor probed to
 * `resolveAgentHomeTarget`, whose fallback (`deriveOps`) derives the ops port
 * when neither port is named and the config records no complete pair. It must
 * derive from the PROBED port, not the configured one, or a probe that differs
 * from the configuration yields a wrong candidate (a false NOT RUN at the
 * pair check). The candidate is still verified by the pair check before the
 * roster and home reads; only the derivation is pinned here.
 *
 * A non-default data directory and an isolated HOME keep the runner's and the
 * developer's `~/.flair/config.yaml` out of the derivation's config rung.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDoctorRosterTarget } from "../../src/cli.js";
import { withHome } from "../../src/lib/home.js";

const HTTP_ONLY = "http:\n  port: 7926\n";

let dataDir: string;
let home: string;
let saved: { FLAIR_URL?: string; FLAIR_OPS_PORT?: string };

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flair-2562-doctor-target-"));
  home = mkdtempSync(join(tmpdir(), "flair-2562-home-"));
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
  rmSync(home, { recursive: true, force: true });
});

describe("resolveDoctorRosterTarget — the fallback ops candidate derives from the probed HTTP port (flair#2562)", () => {
  test("a probed port that differs from the configured one derives the matching candidate", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), HTTP_ONLY);
    // The config records HTTP 7926 only (no complete pair) and doctor probed
    // 8926: the fallback is the probed port minus one, not 7926 minus one.
    withHome(home, () => {
      expect(resolveDoctorRosterTarget({ dataDir }, 8926)).toEqual({ kind: "run", opsPort: 8925 });
    });
  });

  test("a probed port equal to the configured one derives the same candidate as before", () => {
    writeFileSync(join(dataDir, "harper-config.yaml"), HTTP_ONLY);
    withHome(home, () => {
      expect(resolveDoctorRosterTarget({ dataDir }, 7926)).toEqual({ kind: "run", opsPort: 7925 });
    });
  });
});
