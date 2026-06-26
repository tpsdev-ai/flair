/**
 * cli-node-preflight.test.ts — the Node-version preflight shim must FAIL LOUD,
 * not silently, on an unsupported Node.
 *
 * Background: the Flair CLI bin is `dist/cli-shim.cjs`, a CommonJS preflight
 * that checks process.versions.node before dynamically importing the ESM CLI
 * (dist/cli.js). On an old Node the ESM import graph crashes during linking —
 * BEFORE any in-module guard could run — so a dev got zero output and no
 * ~/.flair (a real Harper-dev onboarding trap). The CJS shim runs top-to-bottom
 * and bails with an actionable message before touching the ESM graph.
 *
 * These tests spawn `node` against the BUILT shim (the thing users actually run)
 * and:
 *   1. simulate an old Node by overriding process.versions.node, asserting the
 *      shim prints the upgrade guidance and exits non-zero — and never loads cli.js;
 *   2. confirm the shim is a NO-OP on the supported Node the suite runs on
 *      (the real CLI handles --version → exit 0);
 *   3. confirm the emitted shim is parse-safe (it loads & runs under plain node).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(__dirname, "..", "..");
const SHIM = join(ROOT, "dist", "cli-shim.cjs");

// Build the CLI (incl. the shim) once if it isn't already present, so the test
// is self-contained whether or not a prior `npm run build:cli` ran.
beforeAll(() => {
  if (!existsSync(SHIM)) {
    execSync("npm run build:cli", { cwd: ROOT, stdio: "ignore" });
  }
});

describe("Node-version preflight shim (dist/cli-shim.cjs)", () => {
  test("the built shim exists (it is the published bin entry)", () => {
    expect(existsSync(SHIM)).toBe(true);
  });

  test("fails LOUD + non-zero on an unsupported (old) Node, without loading the ESM CLI", () => {
    // Harness: override process.versions.node to an old value, then require the
    // shim. If the shim tried to import the ESM cli.js, we'd see CLI output;
    // we assert it never does — only the preflight message appears.
    const dir = mkdtempSync(join(tmpdir(), "flair-preflight-"));
    const harness = join(dir, "harness.cjs");
    writeFileSync(
      harness,
      [
        "Object.defineProperty(process.versions, 'node', { value: '18.20.4', configurable: true });",
        `require(${JSON.stringify(SHIM)});`,
      ].join("\n"),
    );
    try {
      const r = spawnSync("node", [harness], { encoding: "utf8", timeout: 15_000 });
      const out = (r.stderr ?? "") + (r.stdout ?? "");
      expect(r.status).not.toBe(0);
      // Actionable, specific message
      expect(out).toMatch(/Flair requires Node\.js >= 22/);
      expect(out).toMatch(/18\.20\.4/);
      expect(out.toLowerCase()).toMatch(/upgrade|nodejs\.org/);
      // Must NOT have reached the real CLI (no version string, no commander output)
      expect(out).not.toMatch(/^\s*\d+\.\d+\.\d+\s*$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a NO-OP on the supported Node the suite runs on (CLI --version → exit 0)", () => {
    const r = spawnSync("node", [SHIM, "--version"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "") + (r.stderr ?? "")).toMatch(/\d+\.\d+\.\d+/);
    // The preflight error must NOT fire on a supported Node.
    expect((r.stdout ?? "") + (r.stderr ?? "")).not.toMatch(/Flair requires Node\.js/);
  });

  test("the emitted shim is parse-safe under plain node (it is CommonJS, not ESM)", () => {
    // `node --check` parses without executing — proves the shim can be parsed by
    // the Node engine. (CommonJS so it parses on every Node since v0.x.)
    const r = spawnSync("node", ["--check", SHIM], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});
