/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, against TWO real
 * Harpers.
 *
 * `flair doctor` probes one instance over HTTP (`--port` / `FLAIR_URL` / the
 * config) and reads the Agent roster and home rows through the ops API.
 * Resolving the two independently let doctor probe instance A while it read the
 * roster from instance B, so it reported B's rows as A's. src/cli.ts's
 * `resolveDoctorRosterTarget` resolves the ops endpoint through the same pairing
 * rule `flair agent stamp-home` uses (flair#2474/#2491): the pair the addressed
 * instance's config records binds the ops port to the probed HTTP port. A probed
 * port that does not match that pair is refused, and the checks are reported as
 * NOT RUN — not as a result about the other instance.
 *
 * Two real instances and a real `~/.flair/config.yaml` make the case concrete:
 * the config pairs A's two ports, and doctor is pointed at A's HTTP port while an
 * ops port naming B is set.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123"; // matches harper-lifecycle's seeded admin pass

let a: HarperInstance;
let b: HarperInstance;
let home: string;

const httpPort = (h: HarperInstance) => new URL(h.httpURL).port;
const opsPort = (h: HarperInstance) => new URL(h.opsURL).port;

/** Refuse to talk to anything but this test's own ephemeral instances. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

/** Run `flair doctor` against A's HTTP port with an explicit ops port, isolated HOME. */
function runDoctor(opsPortArg: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["doctor", "--port", httpPort(a)];
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        FLAIR_URL: "",
        FLAIR_OPS_PORT: opsPortArg,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: ADMIN_PASS,
        NO_COLOR: "1",
      },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) { reject(new Error(`flair doctor overran: ${signal}`)); return; }
      resolve({ code, stdout, stderr });
    });
  });
}

/** Seed an Agent row straight through an instance's operations API. */
async function seedAgent(h: HarperInstance, records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`seed insert returned ${res.status}: ${await res.text()}`);
}

const BAD_ID_ON_A = "a.roster.bad";
const BAD_ID_ON_B = "b.roster.bad";

beforeAll(async () => {
  [a, b] = await Promise.all([startHarper(), startHarper()]);
  assertOwnInstance(a);
  assertOwnInstance(b);
  home = mkdtempSync(join(tmpdir(), "flair-2483-doctor-home-"));
  // A REAL per-user config pairing the DEFAULT instance's two ports — the file
  // `flair` itself writes and reads (writeConfig / readOpsPortFromConfig).
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(join(home, ".flair", "config.yaml"), `port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
  // A row on B outside the shared agent-ID rule. If doctor ever reads B's roster
  // while probing A, this id is what it would report as A's.
  await seedAgent(b, [{ id: BAD_ID_ON_B, name: BAD_ID_ON_B, role: "agent", status: "active", publicKey: "seed-b-2483", originatorInstanceId: "inst-fixture-2483", createdAt: new Date().toISOString() }]);
}, 300_000);

afterAll(async () => {
  if (a) await stopHarper(a);
  if (b) await stopHarper(b);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2483 — doctor refuses the roster read when the ops port names another instance", () => {
  test("a probed HTTP port with an ops port naming another instance: the roster check is NOT RUN and does not show that instance's rows", async () => {
    const r = await runDoctor(opsPort(b));
    expect(r.stderr, r.stderr).toBe("");
    expect(r.stdout, "the roster check was not reported as NOT RUN").toContain("Agent IDs: NOT RUN");
    expect(r.stdout, "the reason was not named").toContain("conflicts with the configured pair");
    expect(r.stdout, `the other instance's row was reported as this instance's`).not.toContain(BAD_ID_ON_B);
    expect(r.stdout, "the roster check reported a result anyway").not.toContain("No stored agent id is outside");
  }, 60_000);

  test("a probed HTTP port with its paired ops port: the roster check runs on the probed instance's rows", async () => {
    // A's own roster is clean, so the check runs and finds nothing — and B's row
    // is absent because it lives on B.
    const clean = await runDoctor(opsPort(a));
    expect(clean.stderr, clean.stderr).toBe("");
    expect(clean.stdout).toContain("No stored agent id is outside");
    expect(clean.stdout).not.toContain(BAD_ID_ON_B);

    // A row outside the rule on A itself is reported, proving the read is A's.
    await seedAgent(a, [{ id: BAD_ID_ON_A, name: BAD_ID_ON_A, role: "agent", status: "active", publicKey: "seed-a-2483", originatorInstanceId: "inst-fixture-2483", createdAt: new Date().toISOString() }]);
    const reported = await runDoctor(opsPort(a));
    expect(reported.stdout, "A's own out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(reported.stdout, "B's row was reported while reading A").not.toContain(BAD_ID_ON_B);
  }, 90_000);
});
