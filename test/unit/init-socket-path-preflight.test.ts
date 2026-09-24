import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
// F4: use the REAL helper, not an inline copy. The limit source is one place.
import { socketPathLimit, socketPathTooLongMessage } from "../../src/lib/socket-path-limit.ts";

/**
 * flair#916 — `flair init --data-dir <long>` previously died with a bare
 * `listen EINVAL` from Harper because the ops socket
 * (`<data-dir>/operations-server`) is a Unix domain socket whose path is capped
 * by `sun_path`. This drives the REAL CLI end to end: a data dir long enough
 * to push the socket past the platform limit must be refused BEFORE anything is
 * written to disk, with an actionable message.
 *
 * HOME is a throwaway temp dir (never the real ~/.flair), and the data dir is
 * under a throwaway base dir — and, crucially, we do NOT create it: a refusal
 * must leave the base dir listing exactly as we found it.
 */

const CHILD_DEADLINE_MS = 60_000;

/** Absolute path to the CLI, so the child can run from any cwd. */
const CLI_PATH = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

let isoHome: string;
let baseDir: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-916-init-home-"));
  baseDir = mkdtempSync(join(tmpdir(), "flair-916-init-base-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  // Sweep only the throwaway trees THIS case created.
  rmSync(isoHome, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

// A data dir long enough to push `<dataDir>/operations-server` (a 18-byte
// suffix) well past the platform limit (103 darwin/freebsd / 107 linux). ~200 bytes is
// safely over both, and far inside the OS path-length limit (4096) so the
// unmodified code can actually create it during the red case. Computed from the
// current case's `baseDir` (set in beforeEach) so the module never evaluates it
// before the temp tree exists.
function longDataDir(): string {
  return join(baseDir, "d".repeat(200));
}

function runInit(dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [
        "src/cli.ts", "init",
        "--skip-start", "--no-mcp", "--skip-soul",
        "--data-dir", dataDir,
        "--admin-pass", "test-admin-916",
       ], { cwd: ".", env: { ...process.env, HOME: isoHome }, timeout: CHILD_DEADLINE_MS });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.on("error", (e) => resolve({ code: 1, stdout: out, stderr: err + String(e) }));
    });
}

/** Like runInit, but from an explicit cwd (for the relative --data-dir case). */
function runInitFrom(cwd: string, dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveDone) => {
    const child = spawn("bun", [
        CLI_PATH, "init",
        "--skip-start", "--no-mcp", "--skip-soul",
        "--data-dir", dataDir,
        "--admin-pass", "test-admin-916",
       ], { cwd, env: { ...process.env, HOME: isoHome }, timeout: CHILD_DEADLINE_MS });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolveDone({ code, stdout: out, stderr: err }));
    child.on("error", (e) => resolveDone({ code: 1, stdout: out, stderr: err + String(e) }));
    });
}

describe("flair init — refuse a data dir whose ops socket path exceeds the OS limit (flair#916)", () => {
  it("the fixture is actually too long", () => {
    const socketPath = join(longDataDir(), "operations-server");
    expect(Buffer.byteLength(socketPath, "utf8")).toBeGreaterThan(socketPathLimit(process.platform));
   });

  it("refuses with non-zero exit, an actionable message, and touches nothing on disk", async () => {
    const dataDir = longDataDir();

     // Snapshot the base dir listing before: it must be byte-for-byte identical
    // after a refusal.
    const before = readdirSync(baseDir).sort();

    const { code, stdout, stderr } = await runInit(dataDir);
    const output = stdout + stderr;

     // (1) Non-zero exit — a refusal, not a silent success.
    expect(code).not.toBe(0);

     // (2) The message names the constraint: the socket path, the byte length,
    //     the limit, and the remedy (how many bytes shorter).
    const socketPath = join(dataDir, "operations-server");
    const bytes = Buffer.byteLength(socketPath, "utf8");
    const limit = socketPathLimit(process.platform);
    expect(output).toContain("operations-server");
    expect(output).toContain(socketPath);
    expect(output).toContain(String(bytes));
    expect(output).toContain(String(limit));
    expect(output).toContain(String(bytes - limit)); // how many bytes shorter
    expect(output).toContain("--data-dir");
    expect(/too long/i.test(output)).toBe(true);

     // (3) Nothing was written: the data dir was never created and the base-dir
    //     listing is exactly as we found it.
    expect(existsSync(dataDir)).toBe(false);
    expect(readdirSync(baseDir).sort()).toEqual(before);
    }, CHILD_DEADLINE_MS + 20_000);

  it("a RELATIVE --data-dir is measured RESOLVED: from a deep cwd it refuses", async () => {
    // Harper binds the socket relative to ITS cwd (the flair package dir), which
    // the CLI runs under — so the real socket path is <cwd>/r/operations-server.
    // A guard that measures the raw argument sees only "r/operations-server" and
    // passes. From a deep cwd the resolved path overflows, so it must refuse.
    const deep = join(baseDir, "d".repeat(120));
    mkdirSync(deep, { recursive: true });
    const relDataDir = "r";
    const resolvedSocket = join(deep, relDataDir, "operations-server");
    expect(Buffer.byteLength(resolvedSocket, "utf8")).toBeGreaterThan(socketPathLimit(process.platform));

    const before = readdirSync(baseDir).sort();
    const { code, stdout, stderr } = await runInitFrom(deep, relDataDir);
    const output = stdout + stderr;

    expect(code).not.toBe(0);
    expect(/too long/i.test(output)).toBe(true);
    // The message names the RESOLVED path, not the raw relative argument.
    expect(output).toContain(resolvedSocket);
    // Nothing was written: the relative data dir under the deep cwd never appeared.
    expect(existsSync(join(deep, relDataDir))).toBe(false);
    expect(readdirSync(baseDir).sort()).toEqual(before);
   }, CHILD_DEADLINE_MS + 20_000);
});

describe("flair#916 F2 — the refusal cannot be made to forge log lines", () => {
  it("a path containing a newline is printed on one line (escaped, not raw)", () => {
    const evilSocket = "/tmp/x\nFORGED: everything is fine/operations-server";
    const evilDir = "/tmp/x\nFORGED: everything is fine";
    const check = { ok: false as const, bytes: 200, limit: 107, over: 93 };
    const msg = socketPathTooLongMessage(evilSocket, evilDir, check);
    // The path is rendered via JSON.stringify, so its newline is escaped and the
    // message keeps its fixed line count — nothing the path contains can start a
    // new line.
    expect(msg).toContain(JSON.stringify(evilSocket));
    expect(msg.split("\n").length).toBe(10);
    expect(msg.split("\n").some((l) => l.startsWith("FORGED"))).toBe(false);
  });
});
