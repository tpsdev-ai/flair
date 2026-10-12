/**
 * agent-stamp-home-target-2474.test.ts — flair#2474, against TWO real Harpers.
 *
 * `flair agent stamp-home` talks to an ops API (the roster read and each stamp's
 * read-back) AND sends the guarded PATCH to the instance's HTTP port. Resolving
 * the two ports INDEPENDENTLY let `--ops-port` name one instance and `--port`
 * another, so the roster was read from the first and the stamp written to the
 * second — carrying the first instance's id. src/cli.ts's
 * `resolveAgentHomeTarget` pairs them: the derived port must come from the same
 * recorded pair as the named one, so an HTTP port that disagrees with the ops
 * port's instance is refused, while a pair the caller names for BOTH ports is
 * taken as given.
 *
 * Two real instances and a real `~/.flair/config.yaml` (the default install's
 * recorded pair) make the ambiguity concrete: an explicit `--ops-port` that
 * disagrees with the HTTP port's recorded pair is refused by name
 * (`ambiguous_instance_target`), as is an HTTP port that disagrees with the pair
 * its derived ops port came from; a consistent override (or one derived from the
 * config) proceeds, and so does an explicit pair for another instance.
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

let a: HarperInstance;
let b: HarperInstance;
let home: string;

function cliHome(): string {
  return home;
}

/** Run `flair agent stamp-home` (dry run) with the given port flags against an isolated HOME. */
function runStampHome(extra: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["agent", "stamp-home", "--admin-pass", a.admin.password, ...extra];
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: cliHome(), FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TOKEN: "", NO_COLOR: "1" },
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
}, 300_000);

afterAll(async () => {
  if (a) await stopHarper(a);
  if (b) await stopHarper(b);
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2474 — stamp-home addresses ONE instance", () => {
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

  test("omitting --ops-port derives it from the named instance's own config", async () => {
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
    // Both ports named for ONE other instance: the caller verified the pair, so
    // the config's pair for A is not a contradiction.
    const r = await runStampHome(["--port", httpPort(b), "--ops-port", opsPort(b)]);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toBe("");
  }, 40_000);
});
