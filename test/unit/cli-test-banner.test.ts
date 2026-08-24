/**
 * cli-test-banner.test.ts — flair#1351
 *
 * `flair test` honors FLAIR_URL in its client (`api()`) but used to print
 * `http://127.0.0.1:<port extracted from FLAIR_URL>` in the banner. With
 * FLAIR_URL pointed at a remote, the test ran against the remote while the
 * banner claimed a possibly-dead local instance.
 *
 * The banner must render the same resolved URL the test's own client uses —
 * one value, not a second derivation. These tests spawn the real CLI so the
 * assertion is on the banner text an operator sees.
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [cliPath, ...args], { env, cwd: join(import.meta.dirname, "..", "..") });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const tmpHome = mkdtempSync(join(tmpdir(), "flair1351-home-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpHome,
    ...overrides,
  };
  delete env.FLAIR_TARGET;
  return {
    env,
    cleanup: () => rmSync(tmpHome, { recursive: true, force: true }),
  };
}

describe("flair#1351 — flair test banner prints the resolved target URL", () => {
  test("banner text under FLAIR_URL override contains the override, not the default", async () => {
    // Remote-looking override (the casa-cluster shape): old banner extracted
    // only the port and printed http://127.0.0.1:9926. A localhost mock URL
    // would not catch that host-swap — 127.0.0.1:<extracted-port> looks right.
    const override = "https://casa.example.test:9926";
    const { env, cleanup } = isolatedEnv({ FLAIR_URL: override });
    try {
      const { stdout } = await runCli(["test", "--agent", "test-1351"], env);
      expect(stdout).toContain(`(url: ${override})`);
      expect(stdout).not.toContain("127.0.0.1:9926");
      expect(stdout).not.toContain("127.0.0.1:19926");
    } finally {
      cleanup();
    }
  });

  test("default banner is stock :19926, not the stale :9926 literal (#1347 family sweep)", async () => {
    const { env, cleanup } = isolatedEnv();
    delete env.FLAIR_URL;
    try {
      const { stdout } = await runCli(["test", "--agent", "test-1351"], env);
      expect(stdout).toContain("(url: http://127.0.0.1:19926)");
      // Colon-anchored: ":19926" contains the substring "9926", so a bare
      // contains-check could never catch a flip back to the fossilized spoke
      // port. The leading colon makes ":9926" match ONLY the old literal.
      expect(stdout).toContain(":19926");
      expect(stdout).not.toContain(":9926");
    } finally {
      cleanup();
    }
  });

  test("source sweep: flair test command does not hardcode 127.0.0.1:9926", () => {
    const src = readFileSync(cliPath, "utf-8");
    const start = src.indexOf("// ─── flair test");
    const end = src.indexOf("// ─── flair deploy");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/127\.0\.0\.1:9926/);
    expect(block).not.toMatch(/localhost:9926/);
  });
});
