/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, against TWO real
 * Harpers.
 *
 * `flair doctor` probes one instance over HTTP (`--port` / `FLAIR_URL` / the
 * config) and reads the Agent roster and home rows through the ops API.
 * Resolving the two independently let doctor probe instance A while it read the
 * roster from instance B, so it reported B's rows as A's. src/cli.ts's
 * `verifyDoctorRosterInstance` picks the ops endpoint with the pairing rule
 * `flair agent stamp-home` uses (flair#2474/#2491), then VERIFIES the pick: the
 * probed HTTP port and the candidate ops endpoint must report the same
 * `flair.Instance` identity. When they cannot be shown to be the same instance,
 * both checks report NOT RUN (counted as an issue) and nothing is read.
 *
 * Two real instances give the case a real config and real Instance rows: A's
 * config pairs A's two ports; `--port A` with `FLAIR_OPS_PORT=B` names B's ops
 * endpoint, and doctor must refuse rather than read B.
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
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

/** A free loopback port that nothing is listening on (for the drift fixture). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** The pid currently LISTENing on `port`, via lsof (the tool doctor's discovery uses). */
function listeningPidOn(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
    for (const line of out.split("\n")) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
  } catch { /* no listener */ }
  return null;
}

/** Run `flair doctor` with an isolated HOME; returns the process's code + streams. */
function runDoctor(opts: { args: string[]; opsPort?: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      HOME: home,
      FLAIR_URL: "",
      FLAIR_TOKEN: "",
      FLAIR_ADMIN_PASS: ADMIN_PASS,
      NO_COLOR: "1",
    };
    if (opts.opsPort === undefined) delete env.FLAIR_OPS_PORT;
    else env.FLAIR_OPS_PORT = opts.opsPort;
    const child = spawn(process.execPath, [CLI, "doctor", ...opts.args], { env, timeout: 60_000 });
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

/** Seed rows straight through an instance's operations API. */
async function seed(h: HarperInstance, table: string, records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify({ operation: "insert", database: "flair", table, records }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`seed insert into ${table} returned ${res.status}: ${await res.text()}`);
}

const INST_A = "inst-a-2483";
const INST_B = "inst-b-2483";
const BAD_ID_ON_A = "a.roster.bad";
const BAD_ID_ON_B = "b.roster.bad";
const HOMELESS_ON_A = "a-homeless-row";
const HOMELESS_ON_B = "b-homeless-row";

/** `~/.flair/config.yaml` — the per-user file `writeConfig` writes and `readPortFromConfig` reads. */
function writeHomeConfig(body: string): void {
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(join(home, ".flair", "config.yaml"), body);
}

/** `~/.flair/data/hdb.pid` — the PID file doctor's port discovery reads. */
function writeHomePid(pid: number): void {
  mkdirSync(join(home, ".flair", "data"), { recursive: true });
  writeFileSync(join(home, ".flair", "data", "hdb.pid"), `${pid}\n`);
}

beforeAll(async () => {
  [a, b] = await Promise.all([startHarper(), startHarper()]);
  assertOwnInstance(a);
  assertOwnInstance(b);
  home = mkdtempSync(join(tmpdir(), "flair-2483-doctor-home-"));
  // A REAL per-user config pairing A's two ports — the file `flair` itself writes.
  writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
  // One Instance row each, so every endpoint reports a single identity.
  await seed(a, "Instance", [{ id: INST_A, publicKey: "seed-pub-a-2483", role: "hub", status: "active", createdAt: new Date().toISOString() }]);
  await seed(b, "Instance", [{ id: INST_B, publicKey: "seed-pub-b-2483", role: "hub", status: "active", createdAt: new Date().toISOString() }]);
  // Rows that only ever appear if doctor reads that instance: an id outside the
  // shared agent-ID rule (the roster check) and a home-less row (the homes check).
  await seed(a, "Agent", [
    { id: BAD_ID_ON_A, name: BAD_ID_ON_A, role: "agent", status: "active", publicKey: "seed-a-2483", originatorInstanceId: "inst-fixture-2483", createdAt: new Date().toISOString() },
    { id: HOMELESS_ON_A, name: HOMELESS_ON_A, role: "agent", status: "active", publicKey: "seed-a-homeless-2483", createdAt: new Date().toISOString() },
  ]);
  await seed(b, "Agent", [
    { id: BAD_ID_ON_B, name: BAD_ID_ON_B, role: "agent", status: "active", publicKey: "seed-b-2483", originatorInstanceId: "inst-fixture-2483", createdAt: new Date().toISOString() },
    { id: HOMELESS_ON_B, name: HOMELESS_ON_B, role: "agent", status: "active", publicKey: "seed-b-homeless-2483", createdAt: new Date().toISOString() },
  ]);
}, 300_000);

afterAll(async () => {
  if (a) await stopHarper(a);
  if (b) await stopHarper(b);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2483 — doctor refuses the roster and home reads when the ops endpoint is not the probed instance", () => {
  test("two named ports with no complete pair in config: both checks are NOT RUN", async () => {
    // Only the ops port is configured, so the pairing rule has no complete pair
    // to complete — it accepts the two ports the caller named. The verified
    // identity check is what stops the read.
    writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(b) });
    expect(r.stdout, r.stdout).toContain("Agent IDs: NOT RUN");
    expect(r.stdout, r.stdout).toContain("Agent homes: NOT RUN");
    expect(r.stdout, "another instance's roster row was reported").not.toContain(BAD_ID_ON_B);
    expect(r.stdout, "another instance's home-less row was reported").not.toContain(HOMELESS_ON_B);
  }, 90_000);

  test("two named ports matching neither side of the configured pair: both checks are NOT RUN", async () => {
    const otherHttp = await freePort();
    const otherOps = await freePort();
    writeHomeConfig(`port: ${otherHttp}\nopsPort: ${otherOps}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(b) });
    expect(r.stdout, r.stdout).toContain("Agent IDs: NOT RUN");
    expect(r.stdout, r.stdout).toContain("Agent homes: NOT RUN");
    expect(r.stdout).not.toContain(BAD_ID_ON_B);
    expect(r.stdout).not.toContain(HOMELESS_ON_B);
}, 90_000);

  test("PID-discovery drift: the decision uses the port actually probed, not the recorded one", async () => {
    // The config records a dead HTTP port; the PID file names the process
    // actually serving A. Doctor re-probes and finds A's HTTP port, so the
    // decision must use THAT port — which no longer matches the recorded pair,
    // so both checks are refused.
    const dead = await freePort();
    writeHomeConfig(`port: ${dead}\nopsPort: ${opsPort(a)}\n`);
    const pid = listeningPidOn(Number(httpPort(a)));
    expect(pid, "could not find the pid listening on A's HTTP port").not.toBeNull();
    writeHomePid(pid!);

    const refused = await runDoctor({ args: ["--port", String(dead)] });
    expect(refused.stdout, refused.stdout).toContain("Agent IDs: NOT RUN");
    expect(refused.stdout, refused.stdout).toContain("Agent homes: NOT RUN");
    expect(refused.stdout).not.toContain(BAD_ID_ON_A);

    // --fix re-records the coordinates (preserving the ops port), so the pair
    // now names the probed port and both checks run on A's rows.
    const fixedRun = await runDoctor({ args: ["--port", String(dead), "--fix"] });
    expect(fixedRun.stdout, fixedRun.stdout).toContain("Updated config to port");
    expect(fixedRun.stdout, fixedRun.stdout).not.toContain("Agent IDs: NOT RUN");
    expect(fixedRun.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(fixedRun.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(fixedRun.stdout).not.toContain(BAD_ID_ON_B);
    expect(fixedRun.stdout).not.toContain(HOMELESS_ON_B);
  }, 120_000);

  test("a probed HTTP port with its paired ops port: both checks run on the probed instance's rows", async () => {
    writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(a) });
    expect(r.stdout, r.stdout).toContain("Agent IDs");
    expect(r.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(r.stdout, r.stdout).toContain("Agent homes");
    expect(r.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(r.stdout, "B's roster row was reported while reading A").not.toContain(BAD_ID_ON_B);
    expect(r.stdout, "B's home-less row was reported while reading A").not.toContain(HOMELESS_ON_B);
  }, 90_000);
});
