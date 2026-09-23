import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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

// The OS sun_path cap, NUL-excluded: darwin 103, linux (and any unknown
// platform) 107. Inlined here so this behavioural test runs against the current
// CLI without depending on the not-yet-shipped helper — a red that proves the
// real bug, not just a missing import.
const socketPathLimit = (platform: string): number =>
  platform === "darwin" ? 103 : 107;

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
// suffix) well past the platform limit (103 darwin / 107 linux). ~200 bytes is
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
});
