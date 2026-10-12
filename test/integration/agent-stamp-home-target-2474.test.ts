/**
 * agent-stamp-home-target-2474.test.ts — flair#2474, against TWO real Harpers.
 *
 * `flair agent stamp-home` talks to an ops API (the roster read and each stamp's
 * read-back) AND sends the guarded PATCH to the instance's HTTP port;
 * `flair principal add` reads the stored home through the ops API and sends its
 * write-back to the HTTP port. Resolving the two ports INDEPENDENTLY let
 * `--ops-port` name one instance and `--port` another, so the read landed on the
 * first and the write on the second. src/cli.ts's `resolveAgentHomeTarget` pairs
 * them against the configured pair (the ports the instance's config records):
 *   - with a COMPLETE configured pair, a port that matches its side binds the
 *     other to that pair, so a target where exactly one of the two ports matches
 *     is refused by name (`ambiguous_instance_target`); a port left out is taken
 *     from the pair;
 *   - with NO complete configured pair, a target with only ONE port named is
 *     refused by name, before anything is read or written;
 *   - two named ports that match neither side of the configured pair (or with
 *     no complete pair) are used as given, WITHOUT VERIFICATION — nothing
 *     contacts an instance to confirm they belong together.
 *
 * Two real instances and a real `~/.flair/config.yaml` make each case concrete:
 * one HOME whose config pairs A's two ports (a complete pair), and one whose
 * config records only A's HTTP port (an incomplete pair).
 *
 * Build prerequisite: dist/cli.js and dist/resources/*.js
 * (`bun run build && bun run build:cli`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");

let a: HarperInstance;
let b: HarperInstance;
let home: string;
/** A second isolated HOME whose `~/.flair/config.yaml` records ONLY A's HTTP port (an incomplete pair). */
let partialHome: string;

function cliHome(): string {
  return home;
}

/** Run `flair agent stamp-home` (dry run) with the given port flags against an isolated HOME. */
function runStampHome(extra: string[], homeDir: string = cliHome()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["agent", "stamp-home", "--admin-pass", a.admin.password, ...extra];
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: homeDir, FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TOKEN: "", NO_COLOR: "1" },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) { reject(new Error(`stamp-home overran: ${signal}`)); return; }
      resolve({ code, stdout, stderr });
    });
  });
}

const httpPort = (h: HarperInstance) => new URL(h.httpURL).port;
const opsPort = (h: HarperInstance) => new URL(h.opsURL).port;

/** Run `flair principal add <id>` with the given port flags against an isolated HOME. */
function runPrincipalAdd(id: string, extra: string[], homeDir: string = cliHome()): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["principal", "add", id, "--admin-pass", a.admin.password, "--keys-dir", join(homeDir, "keys"), ...extra];
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: homeDir, FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TOKEN: "", NO_COLOR: "1" },
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) { reject(new Error(`principal add overran: ${signal}`)); return; }
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

/** Read one Agent row (the given attributes) straight through an instance's ops API. */
async function readAgentRow(h: HarperInstance, id: string, attributes: string[]): Promise<Record<string, unknown> | null> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: attributes }),
    signal: AbortSignal.timeout(15_000),
  });
  const rows = await res.json() as Array<Record<string, unknown>>;
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

beforeAll(async () => {
  [a, b] = await Promise.all([startHarper(), startHarper()]);
  home = mkdtempSync(join(tmpdir(), "flair-2474-target-"));
  // A REAL per-user config pairing the DEFAULT instance's two ports — the file
  // `flair` itself writes and reads (writeConfig / readOpsPortFromConfig).
  mkdirSync(join(home, ".flair"), { recursive: true });
  writeFileSync(
    join(home, ".flair", "config.yaml"),
    `port: ${httpPort(a)}\nopsPort: ${opsPort(a)}\n`,
  );
  // An INCOMPLETE per-user config: A's HTTP port, no ops port. No Harper config
  // exists under this HOME, so the config records no complete pair.
  partialHome = mkdtempSync(join(tmpdir(), "flair-2474-partial-"));
  mkdirSync(join(partialHome, ".flair"), { recursive: true });
  writeFileSync(join(partialHome, ".flair", "config.yaml"), `port: ${httpPort(a)}\n`);
}, 300_000);

afterAll(async () => {
  if (a) await stopHarper(a);
  if (b) await stopHarper(b);
  if (home) rmSync(home, { recursive: true, force: true });
  if (partialHome) rmSync(partialHome, { recursive: true, force: true });
});

describe("flair#2474 — stamp-home checks its two ports against a complete configured pair", () => {
  test("an ops port that disagrees with the HTTP port's instance is refused by name", async () => {
    const r = await runStampHome(["--port", httpPort(a), "--ops-port", opsPort(b)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("ambiguous_instance_target");
  }, 40_000);

  test("a consistent pair proceeds", async () => {
    const r = await runStampHome(["--port", httpPort(a), "--ops-port", opsPort(a)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
  }, 40_000);

  test("omitting --ops-port takes it from the configured pair the named HTTP port matches", async () => {
    const r = await runStampHome(["--port", httpPort(a)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
  }, 40_000);

  test("an HTTP port that disagrees with the ops port's instance is refused by name", async () => {
    // The config pairs A. Naming B's HTTP port with no ops override would derive
    // the ops port from A's config — the roster read and the stamp would address
    // different instances.
    const r = await runStampHome(["--port", httpPort(b)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("ambiguous_instance_target");
  }, 40_000);

  test("an explicit pair for another instance is accepted", async () => {
    // Both ports named, and neither matches A's configured pair: the resolver uses
    // them as given, WITHOUT verification (here they do belong to one instance, B).
    const r = await runStampHome(["--port", httpPort(b), "--ops-port", opsPort(b)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
  }, 40_000);
});

describe("flair#2474 — principal add checks its two ports against a complete configured pair", () => {
  test("an ops port that disagrees with the HTTP port's instance is refused by name before anything is written", async () => {
    const r = await runPrincipalAdd(`pa-target-${Date.now().toString(36)}`, ["--port", httpPort(a), "--ops-port", opsPort(b)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("ambiguous_instance_target");
  }, 40_000);

  test("a consistent pair runs the SKIPPED-insert write-back and leaves the stored home as it was", async () => {
    // The row already exists on A, so the create-only insert is skipped and the
    // record is written back through A's Agent resource (a real REST PATCH on the
    // HTTP port). The two ports name ONE instance, so the write-back lands where
    // the read came from.
    const id = `pa-two-${Date.now().toString(36)}`;
    await seedAgent(a, [{ id, name: id, role: "agent", admin: false, status: "active", publicKey: "pk-pa-two-2474", originatorInstanceId: null, createdAt: new Date().toISOString() }]);
    const r = await runPrincipalAdd(id, ["--port", httpPort(a), "--ops-port", opsPort(a)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
    // The stored home is untouched (the write-back never accepts one from the body).
    const row = await readAgentRow(a, id, ["id", "originatorInstanceId"]);
    expect(row?.originatorInstanceId ?? null).toBeNull();
  }, 120_000);
});

describe("flair#2474 — a one-sided target with no complete configured pair is refused", () => {
  // The per-user config records only A's HTTP port. Naming B's ops port alone
  // would read B's roster or stored home and send the write to A's HTTP port.
  test("stamp-home: an ops port named alone is refused by name", async () => {
    const r = await runStampHome(["--ops-port", opsPort(b)], partialHome);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("ambiguous_instance_target");
  }, 40_000);

  test("principal add: an ops port named alone is refused by name before any key file or row is written", async () => {
    const id = `pa-partial-${Date.now().toString(36)}`;
    const keysDir = join(partialHome, "keys");
    const r = await runPrincipalAdd(id, ["--ops-port", opsPort(b)], partialHome);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("ambiguous_instance_target");
    expect(existsSync(keysDir) ? readdirSync(keysDir) : [], "a refused target wrote a key file").toEqual([]);
    expect(await readAgentRow(a, id, ["id"]), "a refused target wrote a row on A").toBeNull();
    expect(await readAgentRow(b, id, ["id"]), "a refused target wrote a row on B").toBeNull();
  }, 120_000);

  test("stamp-home: both ports named for one instance proceed (used as given)", async () => {
    const r = await runStampHome(["--port", httpPort(a), "--ops-port", opsPort(a)], partialHome);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
  }, 40_000);
});
