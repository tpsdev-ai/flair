/**
 * doctor-sections-probed-instance-2520.test.ts — flair#2520, against TWO real
 * Harpers.
 *
 * `flair doctor` probes one instance over HTTP and reports the audit-log
 * (flair#1501), instance-identity (flair#1883), Agent-roster (flair#2359) and
 * Agent-homes (flair#2433) sections through the ops API. The audit-log and
 * instance-identity sections resolved the ops endpoint independently
 * (`resolveOpsPort`), so they could read from an instance other than the one
 * probed. They now read the ONE verified target flair#2483 resolves for the
 * roster and home checks: the candidate ops endpoint whose own configuration
 * records the probed HTTP port, bound on loopback or on all interfaces. When
 * that pair check refuses, all four sections report NOT RUN (counted as an
 * issue) and read nothing; when there is no admin credential the sections keep
 * their own no-credential state.
 *
 * The first test is the clean-install shape the from-scratch gate runs: a
 * paired config, both sections run on the probed instance. The rest prove the
 * bypass cases are refused and read nothing from the other instance, whose two
 * Instance rows are the distinguishable artifact.
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
import nacl from "tweetnacl";
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

const AGENT_A = "doctor-agent-a-2520";
const INST_B1 = "inst-b1-2520";
const INST_B2 = "inst-b2-2520";

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

/** Register a real Ed25519 agent on `h` and write its key where the CLI signs from. */
async function registerAgent(h: HarperInstance, id: string): Promise<void> {
  const kp = nacl.sign.keyPair();
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, `${id}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
  await seed(h, "Agent", [
    { id, name: id, kind: "agent", role: "agent", status: "active", publicKey: Buffer.from(kp.publicKey).toString("base64"), createdAt: new Date().toISOString() },
  ]);
}

beforeAll(async () => {
  [a, b] = await Promise.all([startHarper(), startHarper()]);
  assertOwnInstance(a);
  assertOwnInstance(b);
  home = mkdtempSync(join(tmpdir(), "flair-2520-doctor-home-"));
  // A real per-user config pairing A's two ports — the file `flair` itself writes.
  writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
  // A registered agent on the probed instance: the audit probe signs its writes
  // with this key, so the audit-log section really reaches the ops read.
  await registerAgent(a, AGENT_A);
  // Two Instance rows on the OTHER instance: the distinguishable artifact. Read,
  // they make the identity section report a multiple-rows finding naming both.
  await seed(b, "Instance", [
    { id: INST_B1, publicKey: "seed-pub-b1-2520", role: "hub", status: "active", createdAt: new Date().toISOString() },
    { id: INST_B2, publicKey: "seed-pub-b2-2520", role: "hub", status: "active", createdAt: new Date().toISOString() },
  ]);
}, 300_000);

afterAll(async () => {
  if (a) await stopHarper(a);
  if (b) await stopHarper(b);
  if (home) rmSync(home, { recursive: true, force: true });
});

/** True when neither the audit-log nor the instance-identity section reported NOT RUN. */
function bothSectionsRan(stdout: string): boolean {
  return !stdout.includes("Audit log: NOT RUN") && !stdout.includes("Instance identity: NOT RUN");
}

describe("flair#2520 — the paired instance: both sections run on the probed instance", () => {
  test("the default paired config: the audit-log and instance-identity sections run, and neither reads the other instance", async () => {
    // The shape of the clean-install doctor step: `flair doctor --agent <a> --port P`,
    // the per-user config `flair init` writes, no FLAIR_OPS_PORT.
    writeHomeConfig(`port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`);
    const r = await runDoctor({ args: ["--agent", AGENT_A, "--port", httpPort(a)] });
    expect(bothSectionsRan(r.stdout), r.stdout).toBe(true);
    expect(r.stdout, "the audit-log section did not verify recording on the probed instance").toContain("Audit log: recording");
    expect(r.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B1);
    expect(r.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B2);
  }, 90_000);
});

describe("flair#2520 — --port A with FLAIR_OPS_PORT=B: both sections are NOT RUN and read nothing from B", () => {
  test("the probed port conflicts with the configured pair: both sections report NOT RUN", async () => {
    // Only the ops port is configured, so the pairing rule has no complete pair
    // to complete — it accepts the two ports the caller named. B's own
    // configuration names B's HTTP port, not the probed one, so the
    // configuration check refuses.
    writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
    const r = await runDoctor({ args: ["--agent", AGENT_A, "--port", httpPort(a)], opsPort: opsPort(b) });
    expect(r.stdout, r.stdout).toContain("Audit log: NOT RUN");
    expect(r.stdout, r.stdout).toContain("Instance identity: NOT RUN");
    expect(r.stdout, r.stdout).toContain(`is configured with HTTP port ${httpPort(b)}, not the probed HTTP port ${httpPort(a)}`);
    // Nothing was read from either endpoint: neither an audit verdict nor B's rows.
    expect(r.stdout, "an audit verdict was printed for a NOT RUN check").not.toContain("Audit log: recording");
    expect(r.stdout, "an audit verdict was printed for a NOT RUN check").not.toContain("Audit log NOT RECORDING");
    expect(r.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B1);
    expect(r.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B2);
  }, 90_000);

  test("PID-discovery drift: the check uses the port actually probed, not the recorded one", async () => {
    // The recorded HTTP port is dead; the PID file names the process actually
    // serving A, so doctor probes A's HTTP port. FLAIR_OPS_PORT names B, whose
    // configuration does not name the probed port, so both sections are refused.
    const dead = await freePort();
    const pid = listeningPidOn(Number(httpPort(a)));
    expect(pid, "could not find the pid listening on A's HTTP port").not.toBeNull();
    writeHomePid(pid!);

    writeHomeConfig(`opsPort: ${opsPort(b)}\n`);
    const refused = await runDoctor({ args: ["--agent", AGENT_A, "--port", String(dead)], opsPort: opsPort(b) });
    expect(refused.stdout, refused.stdout).toContain(`responding on port ${httpPort(a)}`);
    expect(refused.stdout, "the audit-log section was not refused").toContain("Audit log: NOT RUN");
    expect(refused.stdout, "the instance-identity section was not refused").toContain("Instance identity: NOT RUN");
    expect(refused.stdout, refused.stdout).toContain(`not the probed HTTP port ${httpPort(a)}`);
    expect(refused.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B1);
    expect(refused.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B2);

    // FLAIR_OPS_PORT names the probed instance: the pair matches, so both
    // sections run on it (against the dead port this would refuse).
    writeHomeConfig(`opsPort: ${opsPort(a)}\n`);
    const ran = await runDoctor({ args: ["--agent", AGENT_A, "--port", String(dead)], opsPort: opsPort(a) });
    expect(bothSectionsRan(ran.stdout), ran.stdout).toBe(true);
    expect(ran.stdout, "the audit-log section did not verify recording on the probed instance").toContain("Audit log: recording");
    expect(ran.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B1);
    expect(ran.stdout, "the other instance's Instance rows were reported").not.toContain(INST_B2);
    rmSync(join(home, ".flair", "data", "hdb.pid"), { force: true });
  }, 120_000);
});
