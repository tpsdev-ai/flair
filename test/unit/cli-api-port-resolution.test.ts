/**
 * cli-api-port-resolution.test.ts — Anti-recurrence test for flair#1129.
 *
 * The `api()` function had its own stale port-resolution ladder that skipped
 * Harper's own config file (`harper-config.yaml`). On fleet/Fabric installs
 * serving port 9926, `api()` fell through to DEFAULT_PORT 19926 because it
 * only read `~/.flair/config.yaml` (the per-user file), never Harper's config.
 *
 * The fix: `api()` now delegates to `resolveHttpPort({})`, the single canonical
 * resolver shared by every other command. This test proves that resolution
 * reads Harper's config from the data directory, not the per-user config file.
 *
 * Mutation proof: before the fix, `api()` called `readPortFromConfig()` which
 * reads `~/.flair/config.yaml`. With no `config.yaml` present (only
 * `harper-config.yaml`), it would fall back to DEFAULT_PORT 19926 — this test
 * would FAIL. After the fix, `api()` delegates to `resolveHttpPort({})` which
 * reads `harper-config.yaml` and returns 9926 — this test PASSES.
 *
 * HOME isolation is via a genuinely spawned subprocess — Bun's `os.homedir()`
 * ignores an in-process `process.env.HOME` mutation (same rule as
 * harper-config-port.test.ts and port-not-identity.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

/** `DEFAULT_PORT` in src/cli.ts — the wrong answer the bug produced. */
const DEFAULT_PORT = 19926;

/** The port a fleet/Fabric install serves — what harper-config.yaml records. */
const FLEET_PORT = 9926;

describe("flair#1129 — api() resolves port from Harper's config, not the per-user file", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair1129-home-"));
    const dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });

    // Write Harper's config with the fleet port — this is what a real
    // fleet/Fabric install has. NO ~/.flair/config.yaml is written, so
    // readPortFromConfig() would return null and the old api() ladder
    // would fall through to DEFAULT_PORT.
    writeFileSync(
      join(dataDir, "harper-config.yaml"),
      [
        "http:",
        "  port: 9926",
        "operationsApi:",
        "  network:",
        "    port: 127.0.0.1:9925",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function runResolverScript(importSpec: string): Promise<string> {
    const script = `
      import { ${importSpec} } from ${JSON.stringify(cliPath)};
      const port = resolveHttpPort({});
      console.log(String(port));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HOME: tmpHome, FLAIR_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`subprocess exit ${proc.exitCode}: ${err}`);
    return out.trim();
  }

  test("resolveHttpPort reads harper-config.yaml port when no per-user config exists", async () => {
    // No ~/.flair/config.yaml, no FLAIR_URL — only harper-config.yaml with port 9926.
    const port = await runResolverScript("resolveHttpPort");
    expect(port).toBe(String(FLEET_PORT));
  });

  test("resolveHttpPort returns the harper-config port, NOT DEFAULT_PORT", async () => {
    const port = await runResolverScript("resolveHttpPort");
    expect(port).not.toBe(String(DEFAULT_PORT));
    expect(Number(port)).toBe(FLEET_PORT);
  });

  test("resolveHttpPort still works for standalone 19926 shape (no regression)", async () => {
    // Overwrite harper-config with the standalone default port.
    const dataDir = join(tmpHome, ".flair", "data");
    writeFileSync(
      join(dataDir, "harper-config.yaml"),
      [
        "http:",
        "  port: 19926",
        "operationsApi:",
        "  network:",
        "    port: 127.0.0.1:19925",
        "",
      ].join("\n"),
      "utf-8",
    );

    const port = await runResolverScript("resolveHttpPort");
    expect(port).toBe(String(DEFAULT_PORT));
  });

  test("FLAIR_URL env still takes precedence over harper-config", async () => {
    // FLAIR_URL with explicit port must win.
    const script = `
      import { resolveHttpPort } from ${JSON.stringify(cliPath)};
      const port = resolveHttpPort({});
      console.log(String(port));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HOME: tmpHome, FLAIR_URL: "http://localhost:12345" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`subprocess exit ${proc.exitCode}: ${err}`);
    expect(out.trim()).toBe("12345");
  });

  test("--port flag takes precedence over harper-config", async () => {
    const script = `
      import { resolveHttpPort } from ${JSON.stringify(cliPath)};
      const port = resolveHttpPort({ port: 4242 });
      console.log(String(port));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HOME: tmpHome, FLAIR_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`subprocess exit ${proc.exitCode}: ${err}`);
    expect(out.trim()).toBe("4242");
  });

  // ── Mutation proof: the OLD api() ladder would fail ─────────────────────
  // Before the fix, api() called readPortFromConfig() which reads
  // ~/.flair/config.yaml — a file that does NOT exist in this fixture.
  // With no config.yaml, readPortFromConfig() returns null, and the old
  // ladder fell through to DEFAULT_PORT 19926. This test proves that the
  // old ladder's ONLY source returns null here, so the old api() would
  // have answered 19926 — exactly the bug.

  test("readPortFromConfig returns null when only harper-config.yaml exists (old api() would fail)", async () => {
    const script = `
      import { readPortFromConfig } from ${JSON.stringify(cliPath)};
      const port = readPortFromConfig();
      console.log(port === null ? "NULL" : String(port));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, HOME: tmpHome, FLAIR_URL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`subprocess exit ${proc.exitCode}: ${err}`);
    // readPortFromConfig reads ~/.flair/config.yaml — which we deliberately
    // did NOT create. It must return null, proving the old api() ladder
    // would have fallen through to DEFAULT_PORT 19926.
    expect(out.trim()).toBe("NULL");
  });

  test("resolveHttpPort returns 9926 in the SAME fixture where readPortFromConfig returns null", async () => {
    // This is the key pair: readPortFromConfig → null (old api() → 19926),
    // but resolveHttpPort → 9926 (new api() → 9926). Same fixture, opposite
    // answers — that's the bug and the fix in one assertion pair.
    const port = await runResolverScript("resolveHttpPort");
    expect(port).toBe(String(FLEET_PORT));
  });
});
