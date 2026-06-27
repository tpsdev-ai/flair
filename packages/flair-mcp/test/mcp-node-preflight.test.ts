/**
 * mcp-node-preflight.test.ts — the Node-version preflight shim must FAIL LOUD,
 * not silently, on an unsupported Node.
 *
 * Background: the flair-mcp bin is `dist/mcp-shim.cjs`, a CommonJS preflight
 * that checks process.versions.node before dynamically importing the ESM MCP
 * server (dist/index.js). On an old Node the ESM import graph crashes during
 * linking — BEFORE any in-module guard could run — so a user wiring
 * `npx -y @tpsdev-ai/flair-mcp` on an old Node gets zero output and a dead
 * server (the same exposure flair's CLI had before #524). The CJS shim runs
 * top-to-bottom and bails with an actionable message before touching the ESM
 * graph.
 *
 * These tests spawn `node` against the BUILT shim (the thing users actually run)
 * and:
 *   1. simulate an old Node by overriding process.versions.node, asserting the
 *      shim prints the upgrade guidance and exits non-zero — and never loads the
 *      ESM server (no flair-mcp runtime output);
 *   2. confirm the shim is a NO-OP on the supported Node the suite runs on: it
 *      hands off to runMcp(), which (with no FLAIR_AGENT_ID) reaches the server's
 *      own env-check — proving the preflight passed and the real entry ran;
 *   3. confirm the emitted shim is parse-safe (it loads & runs under plain node).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PKG = join(__dirname, "..");
const SHIM = join(PKG, "dist", "mcp-shim.cjs");

// Build flair-mcp (incl. the shim) once if it isn't already present, so the test
// is self-contained whether or not a prior `npm run build` ran.
beforeAll(() => {
  if (!existsSync(SHIM)) {
    execSync("npm run build", { cwd: PKG, stdio: "ignore" });
  }
});

describe("Node-version preflight shim (dist/mcp-shim.cjs)", () => {
  test("the built shim exists (it is the published bin entry)", () => {
    expect(existsSync(SHIM)).toBe(true);
  });

  test("fails LOUD + non-zero on an unsupported (old) Node, without loading the ESM server", () => {
    // Harness: override process.versions.node to an old value, then require the
    // shim. If the shim tried to import the ESM index.js, we'd see server output
    // or an import crash; we assert it never does — only the preflight message
    // appears.
    const dir = mkdtempSync(join(tmpdir(), "flair-mcp-preflight-"));
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
      // Actionable, specific message naming the running version + upgrade path.
      expect(out).toMatch(/flair-mcp requires Node\.js >= 22/);
      expect(out).toMatch(/18\.20\.4/);
      expect(out.toLowerCase()).toMatch(/upgrade|nodejs\.org/);
      // Must NOT have reached the real server (no env-check message, no SDK output).
      expect(out).not.toMatch(/FLAIR_AGENT_ID is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a NO-OP on the supported Node the suite runs on (hands off to runMcp)", () => {
    // On a supported Node the preflight passes and the shim hands off to
    // runMcp(). With FLAIR_AGENT_ID unset, runMcp() reaches the server's own
    // env-check and exits 1 with the FLAIR_AGENT_ID message — which is proof the
    // preflight did NOT fire and the real entry point actually ran. Closing
    // stdin (no input) keeps the run deterministic and offline.
    const env = { ...process.env };
    delete env.FLAIR_AGENT_ID;
    const r = spawnSync("node", [SHIM], { encoding: "utf8", timeout: 20_000, input: "", env });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    // The preflight error must NOT fire on a supported Node.
    expect(out).not.toMatch(/flair-mcp requires Node\.js/);
    // The real server entry ran (its own env-check is the deterministic landmark).
    expect(out).toMatch(/FLAIR_AGENT_ID is required/);
    expect(r.status).toBe(1);
  });

  test("the emitted shim is parse-safe under plain node (it is CommonJS, not ESM)", () => {
    // `node --check` parses without executing — proves the shim can be parsed by
    // the Node engine. (CommonJS so it parses on every Node since v0.x.)
    const r = spawnSync("node", ["--check", SHIM], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
  });
});
