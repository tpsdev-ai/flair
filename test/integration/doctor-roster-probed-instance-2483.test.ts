/**
 * doctor-roster-probed-instance-2483.test.ts — flair#2483, against TWO real
 * Harpers.
 *
 * `flair doctor` probes one instance over HTTP (`--port` / `FLAIR_URL` / the
 * config) and reads the Agent roster and home rows through the ops API.
 * Resolving the two independently let doctor probe instance A while it read the
 * roster from instance B, so it reported B's rows as A's. src/cli.ts's
 * `verifyDoctorRosterInstance` picks the ops endpoint with the pairing rule
 * `flair agent stamp-home` uses (flair#2474/#2491), then, before either read,
 * asks that ops endpoint for its configuration and the live process id serving
 * it (src/lib/local-instance-pair.ts, the check the local delete paths use): it
 * must record that ops port and the HTTP port doctor actually probed, bound on
 * loopback or on all interfaces, and be the same running Harper process. After
 * that check passes, two different Instance ids on the two endpoints also
 * refuse. A refusal, or a pair check that cannot complete, reports both checks
 * NOT RUN (counted as an issue) and reads no Agent row.
 *
 * The first block runs with NO Instance row on either instance, as on a fresh
 * install: the default paired case must run, and every refusal there comes
 * from the pair check alone (a configured-port match no longer establishes the
 * pair when the live processes differ), except recorded-pair PID drift, which
 * the pairing rule refuses earlier. The second block seeds one Instance row
 * on each instance: the paired case still runs, and an ops endpoint whose
 * configuration names the probed port while another process serves it is
 * refused by the pair check.
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

/** Run one operation against an instance's operations API. */
async function ops(h: HarperInstance, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${String(body.operation)} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Seed rows straight through an instance's operations API. */
async function seed(h: HarperInstance, table: string, records: Record<string, unknown>[]): Promise<void> {
  await ops(h, { operation: "insert", database: "flair", table, records });
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
  // NO Instance row yet: the first block runs as a fresh install does. The
  // second block seeds one each (seedInstanceRows).
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

/** True when a section ran (it printed neither NOT RUN line). */
function bothChecksRan(stdout: string): boolean {
  return !stdout.includes("Agent IDs: NOT RUN") && !stdout.includes("Agent homes: NOT RUN");
}

let instanceRowsSeeded = false;
/** One Instance row on each instance, for the second block. */
async function seedInstanceRows(): Promise<void> {
  if (instanceRowsSeeded) return;
  await seed(a, "Instance", [{ id: INST_A, publicKey: "seed-pub-a-2483", role: "hub", status: "active", createdAt: new Date().toISOString() }]);
  await seed(b, "Instance", [{ id: INST_B, publicKey: "seed-pub-b-2483", role: "hub", status: "active", createdAt: new Date().toISOString() }]);
  instanceRowsSeeded = true;
}

describe("flair#2483 — no Instance row on either instance (a fresh install): no Instance id to compare", () => {
  test("the default paired config with no Instance row: both checks run and read the probed instance's rows", async () => {
    // The shape of the clean-VM gate's doctor step: `flair doctor --port P`, the
    // per-user config `flair init` writes, no FLAIR_OPS_PORT, no Instance row.
    writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)] });
    expect(bothChecksRan(r.stdout), r.stdout).toBe(true);
    expect(r.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(r.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(r.stdout, "B's roster row was reported while reading A").not.toContain(BAD_ID_ON_B);
    expect(r.stdout, "B's home-less row was reported while reading A").not.toContain(HOMELESS_ON_B);
  }, 90_000);

  test("--port A with FLAIR_OPS_PORT=B and no complete pair in config: both checks are NOT RUN", async () => {
    // Only the ops port is configured, so the pairing rule has no complete pair
    // to complete — it accepts the two ports the caller named. B's own
    // configuration names B's HTTP port, not the probed one, so the
    // configuration check refuses.
    writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(b) });
    expect(r.stdout, r.stdout).toContain("Agent IDs: NOT RUN");
    expect(r.stdout, r.stdout).toContain("Agent homes: NOT RUN");
    expect(r.stdout, r.stdout).toContain(`is configured with HTTP port ${httpPort(b)}, not the probed HTTP port ${httpPort(a)}`);
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

  test("PID-discovery drift: the check uses the port actually probed, not the recorded one", async () => {
    // The recorded HTTP port is dead; the PID file names the process actually
    // serving A, so doctor probes A's HTTP port. Both ports are named and the
    // config records no complete pair, so the pairing rule accepts them and the
    // configuration check decides against A's port.
    const dead = await freePort();
    const pid = listeningPidOn(Number(httpPort(a)));
    expect(pid, "could not find the pid listening on A's HTTP port").not.toBeNull();
    writeHomePid(pid!);

    // FLAIR_OPS_PORT names B: B's configuration names B's HTTP port, not the
    // probed one (A's), so both checks are refused.
    writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
    const refused = await runDoctor({ args: ["--port", String(dead)], opsPort: opsPort(b) });
    expect(refused.stdout, refused.stdout).toContain(`responding on port ${httpPort(a)}`);
    expect(refused.stdout, refused.stdout).toContain("Agent IDs: NOT RUN");
    expect(refused.stdout, refused.stdout).toContain("Agent homes: NOT RUN");
    expect(refused.stdout, refused.stdout).toContain(`not the probed HTTP port ${httpPort(a)}`);
    expect(refused.stdout).not.toContain(BAD_ID_ON_B);
    expect(refused.stdout).not.toContain(HOMELESS_ON_B);

    // FLAIR_OPS_PORT names A: A's configuration names the probed port, so both
    // checks run on A's rows (checked against the dead port, this would refuse).
    writeHomeConfig(`opsPort: ${opsPort(a)}\n`);
    const ran = await runDoctor({ args: ["--port", String(dead)], opsPort: opsPort(a) });
    expect(bothChecksRan(ran.stdout), ran.stdout).toBe(true);
    expect(ran.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(ran.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(ran.stdout).not.toContain(BAD_ID_ON_B);
  }, 120_000);

  test("PID-discovery drift against a recorded pair: refused until --fix re-records it", async () => {
    // The config pairs a dead HTTP port with A's ops port. Doctor re-probes and
    // finds A's HTTP port, which conflicts with the recorded pair, so the
    // pairing rule refuses both checks.
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
    expect(bothChecksRan(fixedRun.stdout), fixedRun.stdout).toBe(true);
    expect(fixedRun.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(fixedRun.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(fixedRun.stdout).not.toContain(BAD_ID_ON_B);
    expect(fixedRun.stdout).not.toContain(HOMELESS_ON_B);
    rmSync(join(home, ".flair", "data", "hdb.pid"), { force: true });
  }, 120_000);

  test("a stale configuration naming the probed HTTP port while another process serves it: both checks are NOT RUN", async () => {
    // B's config FILE now records A's HTTP port (no restart, so B keeps serving
    // its own). The configured ports agree with the probe, but the two endpoints
    // are different running processes. No Instance row exists yet, so the pair
    // check is what refuses — a port match alone no longer establishes the pair.
    await ops(b, { operation: "set_configuration", http_port: Number(httpPort(a)) });
    try {
      writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
      const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(b) });
      expect(r.stdout, r.stdout).toContain("Agent IDs: NOT RUN");
      expect(r.stdout, r.stdout).toContain("Agent homes: NOT RUN");
      expect(r.stdout, r.stdout).toContain("not the same running instance");
      expect(r.stdout, "A's out-of-rule row was read through the stale endpoint").not.toContain(BAD_ID_ON_A);
      expect(r.stdout, "another instance's roster row was reported").not.toContain(BAD_ID_ON_B);
      expect(r.stdout, "another instance's home-less row was reported").not.toContain(HOMELESS_ON_B);
    } finally {
      await ops(b, { operation: "set_configuration", http_port: Number(httpPort(b)) });
    }
  }, 90_000);
});

describe("flair#2483 — one Instance row on each instance", () => {
  test("a probed HTTP port with its paired ops port: both checks run on the probed instance's rows", async () => {
    await seedInstanceRows();
    writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
    const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(a) });
    expect(bothChecksRan(r.stdout), r.stdout).toBe(true);
    expect(r.stdout, "A's out-of-rule row was not reported").toContain(BAD_ID_ON_A);
    expect(r.stdout, "A's home-less row was not reported").toContain(HOMELESS_ON_A);
    expect(r.stdout, "B's roster row was reported while reading A").not.toContain(BAD_ID_ON_B);
    expect(r.stdout, "B's home-less row was reported while reading A").not.toContain(HOMELESS_ON_B);
  }, 90_000);

  test("an ops endpoint whose configuration names the probed port while another instance serves it: both checks are NOT RUN", async () => {
    await seedInstanceRows();
    // B's config FILE now records A's HTTP port (no restart, so B keeps serving
    // its own). The two endpoints report different running processes, so the
    // pair check refuses before any Instance-id comparison.
    await ops(b, { operation: "set_configuration", http_port: Number(httpPort(a)) });
    try {
      writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
      const r = await runDoctor({ args: ["--port", httpPort(a)], opsPort: opsPort(b) });
      expect(r.stdout, r.stdout).toContain("Agent IDs: NOT RUN");
      expect(r.stdout, r.stdout).toContain("Agent homes: NOT RUN");
      expect(r.stdout, r.stdout).toContain("not the same running instance");
      expect(r.stdout, "another instance's roster row was reported").not.toContain(BAD_ID_ON_B);
      expect(r.stdout, "another instance's home-less row was reported").not.toContain(HOMELESS_ON_B);
    } finally {
      await ops(b, { operation: "set_configuration", http_port: Number(httpPort(b)) });
    }
  }, 90_000);
});
